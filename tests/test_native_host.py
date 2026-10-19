"""Exercise the real Native Messaging framing and process lifecycle with fake tools."""

from __future__ import annotations

import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import tempfile
import time
import unittest

HOST = Path(__file__).resolve().parents[1] / "native_host/fox_voice_editor.py"


class HostProcessTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.pid_file = root / "recorder.pid"
        recorder = root / "record.py"
        recorder.write_text("""#!/usr/bin/env python3
import os, signal, sys, time
from pathlib import Path
Path(os.environ['TEST_RECORDER_PID']).write_text(str(os.getpid()))
Path(sys.argv[-1]).write_bytes(b'fake audio')
signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
while True: time.sleep(0.05)
""", encoding="utf-8")
        converter = root / "convert.py"
        converter.write_text("""#!/usr/bin/env python3
import sys
from pathlib import Path
Path(sys.argv[-1]).write_bytes(b'converted audio')
""", encoding="utf-8")
        recognizer = root / "recognize.py"
        recognizer.write_text("""#!/usr/bin/env python3
import sys
from pathlib import Path
Path(sys.argv[sys.argv.index('-of') + 1] + '.txt').write_text('テスト成功\\n', encoding='utf-8')
print('whisper_print_timings:     load time =   113.30 ms', file=sys.stderr)
""", encoding="utf-8")
        model = root / "model.bin"
        model.write_bytes(b"fake model")
        for path in (recorder, converter, recognizer):
            path.chmod(0o700)
        bootstrap = """import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
import fox_voice_editor as host
host.ARECORD = Path(sys.argv[2])
host.FFMPEG = Path(sys.argv[3])
host.WHISPER_CLI = Path(sys.argv[4])
host.MODEL = Path(sys.argv[5])
sys.exit(host.main())
"""
        env = dict(os.environ, TEST_RECORDER_PID=str(self.pid_file))
        self.host = subprocess.Popen(
            [sys.executable, "-u", "-c", bootstrap, str(HOST), str(recorder), str(converter), str(recognizer), str(model)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        )
        self.addCleanup(self._close_host)

    def _close_host(self) -> None:
        if self.host.stdin and not self.host.stdin.closed:
            self.host.stdin.close()
        if self.host.poll() is None:
            try:
                self.host.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.host.kill()
                self.host.wait(timeout=3)
        for pipe in (self.host.stdout, self.host.stderr):
            if pipe:
                pipe.close()

    def _send(self, action: str) -> None:
        payload = json.dumps({"action": action}).encode()
        assert self.host.stdin is not None
        self.host.stdin.write(struct.pack("=I", len(payload)) + payload)
        self.host.stdin.flush()

    def _read(self, timeout: float = 5) -> dict:
        assert self.host.stdout is not None
        ready, _, _ = select.select([self.host.stdout], [], [], timeout)
        self.assertTrue(ready, "host did not respond")
        header = self.host.stdout.read(4)
        self.assertEqual(len(header), 4)
        payload = self.host.stdout.read(struct.unpack("=I", header)[0])
        return json.loads(payload)

    def _wait_for_recorder(self) -> int:
        deadline = time.monotonic() + 2
        while not self.pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(self.pid_file.exists())
        return int(self.pid_file.read_text())

    def _assert_process_gone(self, pid: int) -> None:
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_start_stop_result(self) -> None:
        self._send("start_recording")
        started = self._read()
        self.assertEqual(started["event"], "started")
        recording_id = started["recordingId"]
        self._wait_for_recorder()
        self._send("stop_recording")
        self._send("get_status")
        stopping = self._read()
        self.assertEqual(stopping["event"], "stopping")
        self.assertEqual(stopping["state"], "stopping")
        status = self._read()
        self.assertEqual(status["event"], "status")
        self.assertEqual(status["state"], "stopping")
        self.assertEqual(status["recordingId"], recording_id)
        events = [self._read() for _ in range(3)]
        self.assertEqual([event["event"] for event in events], ["processing", "processing", "result"])
        self.assertEqual(events[-1]["recordingId"], recording_id)
        self.assertEqual(events[-1]["text"], "テスト成功")
        self.assertEqual(events[-1]["modelLoadMs"], 113.3)
        self._send("get_status")
        self.assertEqual(self._read()["state"], "idle")

    def test_cancel_and_disconnect_cleanup(self) -> None:
        self._send("start_recording")
        self.assertEqual(self._read()["event"], "started")
        pid = self._wait_for_recorder()
        self._send("cancel_recording")
        self.assertEqual(self._read()["event"], "cancelled")
        self._assert_process_gone(pid)
        self.pid_file.unlink()
        self._send("start_recording")
        self.assertEqual(self._read()["event"], "started")
        pid = self._wait_for_recorder()
        assert self.host.stdin is not None
        self.host.stdin.close()
        self.host.wait(timeout=3)
        self._assert_process_gone(pid)

    def test_host_termination_stops_recorder(self) -> None:
        self._send("start_recording")
        self.assertEqual(self._read()["event"], "started")
        pid = self._wait_for_recorder()
        self.host.terminate()
        self.host.wait(timeout=3)
        self._assert_process_gone(pid)


if __name__ == "__main__":
    unittest.main()
