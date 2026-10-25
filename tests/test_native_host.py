"""Exercise the real Native Messaging framing and process lifecycle with fake tools."""

from __future__ import annotations

import json
import os
from pathlib import Path
import select
import signal
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
import os, sys, time
from pathlib import Path
if os.environ.get('WHISPER_CLI_TIMING_MARKERS') == '1':
    print(f'whisper_cli_timing: model_ready_ns = {time.monotonic_ns()}', file=sys.stderr)
time.sleep(0.02)
if os.environ.get('WHISPER_CLI_TIMING_MARKERS') == '1':
    print(f'whisper_cli_timing: recognition_done_ns = {time.monotonic_ns()}', file=sys.stderr)
Path(sys.argv[sys.argv.index('-of') + 1] + '.txt').write_text('テスト成功\\n', encoding='utf-8')
""", encoding="utf-8")
        model = root / "model.bin"
        model.write_bytes(b"fake model")
        self.microphone_config = root / "microphone.json"
        self.library_path = root / "library-v1.json"
        self.amixer_state = root / "amixer-state.json"
        self.amixer_state.write_text(json.dumps({"left": 3, "right": 3, "mode": "normal", "calls": []}))
        amixer = root / "amixer.py"
        amixer.write_text("""#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
path = Path(os.environ['TEST_AMIXER_STATE'])
state = json.loads(path.read_text())
state['calls'].append(sys.argv[1:])
path.write_text(json.dumps(state))
if state['mode'] == 'timeout': time.sleep(10)
if state['mode'] == 'failure': sys.exit(1)
if sys.argv[3] == 'sset' and state['mode'] != 'unchanged_after_set':
    state['left'] = state['right'] = 0
    path.write_text(json.dumps(state))
if state['mode'] == 'malformed': print('unexpected output'); sys.exit(0)
print("Simple mixer control 'Internal Mic Boost',0")
print('  Capabilities: volume')
print(f"  Front Left: {state['left']} [100%] [30.00dB]")
print(f"  Front Right: {state['right']} [100%] [30.00dB]")
""", encoding="utf-8")
        for path in (recorder, converter, recognizer, amixer):
            path.chmod(0o700)
        bootstrap = """import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
import fox_voice_editor as host
host.ARECORD = Path(sys.argv[2])
host.FFMPEG = Path(sys.argv[3])
host.WHISPER_CLI = Path(sys.argv[4])
host.MODEL = Path(sys.argv[5])
host.AMIXER = Path(sys.argv[6])
host.MICROPHONE_CONFIG = Path(sys.argv[7])
host.LIBRARY_PATH = Path(sys.argv[8])
sys.exit(host.main())
"""
        env = dict(os.environ, TEST_RECORDER_PID=str(self.pid_file), TEST_AMIXER_STATE=str(self.amixer_state))
        self.host = subprocess.Popen(
            [sys.executable, "-u", "-c", bootstrap, str(HOST), str(recorder), str(converter), str(recognizer), str(model), str(amixer), str(self.microphone_config), str(self.library_path)],
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
        self._send_request({"action": action})

    def _send_request(self, request: dict) -> None:
        payload = json.dumps(request).encode()
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

    def _prepare(self) -> dict:
        self._send("prepare_microphone")
        return self._read()

    def _set_amixer_state(self, **changes) -> None:
        state = json.loads(self.amixer_state.read_text())
        state.update(changes)
        self.amixer_state.write_text(json.dumps(state))

    def test_microphone_prepare_is_required_and_disabled_config_skips_mixer(self) -> None:
        self._send("start_recording")
        self.assertEqual(self._read()["code"], "MICROPHONE_NOT_READY")
        self.assertEqual(self._prepare()["status"], "skipped")
        self.assertEqual(json.loads(self.amixer_state.read_text())["calls"], [])

    def test_library_survives_host_reconnect_and_rejects_invalid_payload(self) -> None:
        self._send("load_library")
        initial = self._read()
        self.assertEqual(initial["event"], "library_loaded")
        self.assertFalse(initial["exists"])
        library = {
            "schemaVersion": 1,
            "history": [{"id": "history-1", "text": "履歴", "pinned": False, "lastUsedAt": None, "useCount": 1}],
            "templates": [{"id": "template-1", "text": "定型", "pinned": False, "lastUsedAt": None, "useCount": 1}],
        }
        self._send_request({"action": "save_library", "library": library})
        self.assertEqual(self._read()["event"], "library_saved")
        self.assertEqual(oct(self.library_path.stat().st_mode & 0o777), "0o600")
        self._send("load_library")
        restored = self._read()
        self.assertTrue(restored["exists"])
        self.assertEqual(restored["library"], library)
        self._send_request({"action": "save_library", "library": {"schemaVersion": 1, "history": [], "templates": [{"text": "不正"}]}})
        self.assertEqual(self._read()["code"], "LIBRARY_SAVE_FAILED")

    def test_microphone_adjusts_once_and_manual_recheck_finds_zero(self) -> None:
        self.microphone_config.write_text('{"boost_fix": true}')
        self.assertEqual(self._prepare()["status"], "adjusted")
        state = json.loads(self.amixer_state.read_text())
        self.assertEqual((state["left"], state["right"]), (0, 0))
        self.assertEqual([call[2] for call in state["calls"]], ["sget", "sset", "sget"])
        self.assertEqual(self._prepare()["status"], "unchanged")
        self.assertEqual([call[2] for call in json.loads(self.amixer_state.read_text())["calls"]], ["sget", "sset", "sget", "sget"])

    def test_microphone_failure_blocks_recording_until_retry(self) -> None:
        self.microphone_config.write_text('{"boost_fix": true}')
        self._set_amixer_state(mode="malformed")
        self.assertEqual(self._prepare()["status"], "error")
        self._send("start_recording")
        self.assertEqual(self._read()["code"], "MICROPHONE_NOT_READY")
        self._set_amixer_state(mode="normal")
        self.assertEqual(self._prepare()["status"], "adjusted")

    def test_microphone_set_failure_and_invalid_config(self) -> None:
        self.microphone_config.write_text('{"boost_fix": true}')
        self._set_amixer_state(mode="unchanged_after_set")
        self.assertEqual(self._prepare()["status"], "error")
        self.microphone_config.write_text('{"boost_fix": "true"}')
        self.assertEqual(self._prepare()["status"], "error")

    def test_microphone_adjusts_when_only_one_channel_is_boosted(self) -> None:
        self.microphone_config.write_text('{"boost_fix": true}')
        self._set_amixer_state(left=0, right=3)
        self.assertEqual(self._prepare()["status"], "adjusted")
        state = json.loads(self.amixer_state.read_text())
        self.assertEqual((state["left"], state["right"]), (0, 0))

    def test_microphone_timeout_keeps_recording_disabled(self) -> None:
        self.microphone_config.write_text('{"boost_fix": true}')
        self._set_amixer_state(mode="timeout")
        self.assertEqual(self._prepare()["status"], "error")
        self._send("start_recording")
        self.assertEqual(self._read()["code"], "MICROPHONE_NOT_READY")

    def test_start_stop_result(self) -> None:
        self.assertEqual(self._prepare()["status"], "skipped")
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
        result = events[-1]
        self.assertEqual(result["modelName"], "model.bin")
        self.assertGreaterEqual(result["conversionMs"], 0)
        self.assertGreaterEqual(result["modelStartupMs"], 0)
        self.assertGreaterEqual(result["recognitionMs"], 20)
        self.assertGreaterEqual(result["elapsedMs"] + 3, result["conversionMs"] + result["modelStartupMs"] + result["recognitionMs"])
        self._send("get_status")
        self.assertEqual(self._read()["state"], "idle")

    def test_cancel_and_disconnect_cleanup(self) -> None:
        self.assertEqual(self._prepare()["status"], "skipped")
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
        self.assertEqual(self._prepare()["status"], "skipped")
        self._send("start_recording")
        self.assertEqual(self._read()["event"], "started")
        pid = self._wait_for_recorder()
        self.host.terminate()
        self.host.wait(timeout=3)
        self._assert_process_gone(pid)

    def test_reazon_worker_is_reused_for_three_recordings(self) -> None:
        model_dir = HOST.parents[2] / "reazonspeech"
        if not (model_dir / ".venv/bin/python").is_file() or not (model_dir / "test_wavs/1.wav").is_file():
            self.skipTest("ReazonSpeechのローカル実行環境がありません。")
        converter = Path(self.temp.name) / "convert.py"
        converter.write_text(f"""#!/usr/bin/env python3
import shutil, sys
shutil.copyfile({str(model_dir / 'test_wavs/1.wav')!r}, sys.argv[-1])
""", encoding="utf-8")
        self.assertEqual(self._prepare()["status"], "skipped")
        self._send_request({"action": "prepare_engine", "engine": "reazonspeech_k2"})
        preparing = self._read()
        self.assertEqual(preparing["engineStatus"], "preparing")
        ready = self._read(timeout=45)
        self.assertEqual(ready["engineStatus"], "ready")
        generation = ready["engineGeneration"]
        child_list = Path(f"/proc/{self.host.pid}/task/{self.host.pid}/children")
        worker_pid = int(child_list.read_text().split()[0])
        self._send_request({"action": "prepare_engine", "engine": "reazonspeech_k2"})
        repeated = self._read()
        self.assertEqual(repeated["engineStatus"], "ready")
        self.assertEqual(repeated["engineGeneration"], generation)
        self.assertEqual(int(child_list.read_text().split()[0]), worker_pid)
        for _ in range(3):
            self.pid_file.unlink(missing_ok=True)
            self._send("start_recording")
            started = self._read()
            self.assertEqual(started["event"], "started")
            self.assertEqual(started["engineGeneration"], generation)
            self._wait_for_recorder()
            self._send("stop_recording")
            self.assertEqual(self._read()["event"], "stopping")
            self.assertEqual([self._read()["event"] for _ in range(2)], ["processing", "processing"])
            result = self._read(timeout=30)
            self.assertEqual(result["event"], "result")
            self.assertEqual(result["engine"], "reazonspeech_k2")
            self.assertEqual(result["engineGeneration"], generation)
            self.assertTrue(result["text"])
            self.assertGreaterEqual(result["recognitionMs"], 0)
            self.assertEqual(int(child_list.read_text().split()[0]), worker_pid)
        self.pid_file.unlink(missing_ok=True)
        self._send("start_recording")
        self.assertEqual(self._read()["event"], "started")
        self._wait_for_recorder()
        self._send("stop_recording")
        self.assertEqual(self._read()["event"], "stopping")
        self.assertEqual([self._read()["event"] for _ in range(2)], ["processing", "processing"])
        self._send("cancel_recording")
        self.assertEqual(self._read()["event"], "cancelled")
        time.sleep(0.7)
        self._send("get_status")
        status = self._read()
        self.assertEqual(status["state"], "idle")
        self.assertEqual(status["engineStatus"], "ready")
        self.assertEqual(int(child_list.read_text().split()[0]), worker_pid)
        self._send_request({"action": "prepare_engine", "engine": "unknown"})
        self.assertEqual(self._read()["code"], "UNKNOWN_ENGINE")
        os.kill(worker_pid, signal.SIGKILL)
        self.assertEqual(self._read()["engineStatus"], "error")
        self._send("start_recording")
        self.assertEqual(self._read()["code"], "ENGINE_NOT_READY")
        self._send_request({"action": "prepare_engine", "engine": "reazonspeech_k2"})
        self.assertEqual(self._read()["engineStatus"], "preparing")
        recovered = self._read(timeout=45)
        self.assertEqual(recovered["engineStatus"], "ready")
        self.assertGreater(recovered["engineGeneration"], generation)
        replacement_pid = int(child_list.read_text().split()[0])
        self.assertNotEqual(replacement_pid, worker_pid)
        self._send_request({"action": "prepare_engine", "engine": "whisper"})
        switched = self._read()
        self.assertEqual(switched["engineStatus"], "ready")
        self.assertGreater(switched["engineGeneration"], recovered["engineGeneration"])
        self._assert_process_gone(replacement_pid)
        self.host.stdin.close()
        self.host.wait(timeout=5)
        self._assert_process_gone(worker_pid)


if __name__ == "__main__":
    unittest.main()
