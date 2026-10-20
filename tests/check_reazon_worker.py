#!/usr/bin/env python3
"""Run the real model three times in one worker, then check worker shutdown."""

from __future__ import annotations

import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT.parent / "reazonspeech"
PYTHON = MODEL_DIR / ".venv/bin/python"
WORKER = ROOT / "native_host/reazon_worker.py"


def read_event(process: subprocess.Popen, timeout: float = 45) -> dict:
    assert process.stdout is not None
    ready, _, _ = select.select([process.stdout], [], [], timeout)
    if not ready:
        raise TimeoutError("Workerの応答がありません。")
    line = process.stdout.readline()
    if not line:
        raise RuntimeError(f"Workerが終了しました: {process.poll()}")
    return json.loads(line)


def assert_exited(pid: int) -> None:
    for _ in range(50):
        proc_stat = Path(f"/proc/{pid}/stat")
        if not proc_stat.exists() or proc_stat.read_text().split()[2] == "Z":
            return
        time.sleep(0.1)
    raise AssertionError(f"Worker {pid} が終了していません。")


def main() -> None:
    if not PYTHON.is_file():
        raise FileNotFoundError(PYTHON)
    worker = subprocess.Popen(
        [str(PYTHON), str(WORKER), str(MODEL_DIR)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1,
    )
    try:
        ready = read_event(worker)
        assert ready["event"] == "ready" and ready["loadCount"] == 1, ready
        print(f"初期化: {ready['initializationMs']} ms", flush=True)
        for index in range(1, 4):
            assert worker.stdin is not None
            worker.stdin.write(json.dumps({
                "action": "recognize", "requestId": str(index),
                "wavPath": str(MODEL_DIR / "test_wavs" / f"{index}.wav"),
            }) + "\n")
            worker.stdin.flush()
            result = read_event(worker)
            assert result["event"] == "result" and result["requestId"] == str(index), result
            assert result["loadCount"] == 1 and result["text"], result
            print(f"認識{index}: {result['recognitionMs']} ms / {result['text']}", flush=True)
    finally:
        if worker.stdin and not worker.stdin.closed:
            worker.stdin.close()
        try:
            worker.wait(timeout=5)
        except subprocess.TimeoutExpired:
            worker.kill()
            worker.wait()
        assert_exited(worker.pid)
        assert worker.returncode == 0, worker.stderr.read()
    print("通常終了: OK", flush=True)

    # The supervisor is the worker's direct parent. Killing it must also stop
    # the worker, even though it cannot send a shutdown request.
    supervisor_code = """import subprocess, sys, time
p = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
print(p.stdout.readline().strip(), flush=True)
print(p.pid, flush=True)
while True: time.sleep(1)
"""
    supervisor = subprocess.Popen(
        [sys.executable, "-c", supervisor_code, str(PYTHON), str(WORKER), str(MODEL_DIR)],
        stdout=subprocess.PIPE, text=True,
    )
    try:
        assert supervisor.stdout is not None
        event = json.loads(supervisor.stdout.readline())
        assert event["event"] == "ready", event
        worker_pid = int(supervisor.stdout.readline())
        supervisor.kill()
        supervisor.wait(timeout=5)
        assert_exited(worker_pid)
        print("親プロセス強制終了後のWorker回収: OK", flush=True)
    finally:
        if supervisor.poll() is None:
            supervisor.kill()
            supervisor.wait()


if __name__ == "__main__":
    main()
