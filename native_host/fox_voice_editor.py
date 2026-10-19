#!/usr/bin/env python3
"""Prototype Native Messaging host for local recording and transcription."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import selectors
import signal
import struct
import subprocess
import sys
import tempfile
import time
import uuid

HOST_NAME = "fox_voice_editor"
MAX_MESSAGE_BYTES = 65536
MAX_RECORD_SECONDS = 30
WHISPER_TIMEOUT_SECONDS = 60
CONVERT_TIMEOUT_SECONDS = 10
WHISPER_ROOT = Path(__file__).resolve().parents[2] / "whisper.cpp"
ARECORD = Path("/usr/bin/arecord")
FFMPEG = Path("/usr/bin/ffmpeg")
WHISPER_CLI = WHISPER_ROOT / "build/bin/whisper-cli"
MODEL = WHISPER_ROOT / "models/ggml-base.bin"


def send(message: dict) -> None:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(payload)) + payload)
    sys.stdout.buffer.flush()


class Session:
    def __init__(self) -> None:
        self.recording_id: str | None = None
        self.phase = "idle"
        self.process: subprocess.Popen | None = None
        self.temp: tempfile.TemporaryDirectory | None = None
        self.started_at = 0.0
        self.stop_requested_at: float | None = None
        self.recording_ended_at: float | None = None
        self.phase_started_at = 0.0

    def _path(self, name: str) -> Path:
        assert self.temp is not None
        return Path(self.temp.name) / name

    def _launch(self, command: list[str], *, stdout=None) -> None:
        with self._path("stderr.log").open("ab") as err:
            self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout or subprocess.DEVNULL, stderr=err)
        self.phase_started_at = time.monotonic()

    def _terminate(self) -> None:
        process = self.process
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=0.5)

    def _clear(self) -> None:
        self._terminate()
        self.process = None
        if self.temp is not None:
            self.temp.cleanup()
            self.temp = None
        self.recording_id = None
        self.phase = "idle"
        self.stop_requested_at = None
        self.recording_ended_at = None

    def close(self) -> None:
        self._clear()

    def _error(self, code: str, message: str) -> None:
        recording_id = self.recording_id
        self._clear()
        send({"event": "error", "recordingId": recording_id, "code": code, "message": message})

    def handle(self, request: object) -> None:
        if not isinstance(request, dict) or set(request) != {"action"} or not isinstance(request["action"], str):
            send({"event": "error", "recordingId": None, "code": "INVALID_REQUEST", "message": "要求形式が正しくありません。"})
            return
        action = request["action"]
        if action == "get_status":
            state = "stopping" if self.phase == "recording" and self.stop_requested_at is not None else self.phase
            send({"event": "status", "recordingId": self.recording_id, "state": state})
        elif action == "start_recording":
            if self.phase != "idle":
                send({"event": "error", "recordingId": self.recording_id, "code": "BUSY", "message": "録音または認識中です。"})
                return
            try:
                if not ARECORD.is_file() or not FFMPEG.is_file() or not WHISPER_CLI.is_file() or not MODEL.is_file():
                    raise FileNotFoundError("録音・認識に必要なコマンドまたはモデルが見つかりません。")
                self.temp = tempfile.TemporaryDirectory(prefix="fox-voice-editor-")
                self.recording_id = uuid.uuid4().hex
                self._launch([str(ARECORD), "-q", "-d", str(MAX_RECORD_SECONDS), "-f", "cd", str(self._path("recorded.wav"))])
                self.phase = "recording"
                self.started_at = time.monotonic()
                send({"event": "started", "recordingId": self.recording_id, "state": self.phase})
            except (OSError, subprocess.SubprocessError) as exc:
                self._error("RECORDING_FAILED", f"録音を開始できませんでした: {exc}")
        elif action == "stop_recording":
            if self.phase != "recording":
                send({"event": "error", "recordingId": self.recording_id, "code": "NOT_RECORDING", "message": "録音中ではありません。"})
                return
            if self.stop_requested_at is None:
                self.stop_requested_at = time.monotonic()
                if self.process is not None and self.process.poll() is None:
                    self.process.send_signal(signal.SIGINT)
            send({"event": "stopping", "recordingId": self.recording_id, "state": "stopping"})
        elif action == "cancel_recording":
            if self.phase == "idle":
                send({"event": "status", "recordingId": None, "state": "idle"})
                return
            recording_id = self.recording_id
            self._clear()
            send({"event": "cancelled", "recordingId": recording_id, "state": "idle"})
        else:
            send({"event": "error", "recordingId": None, "code": "UNKNOWN_ACTION", "message": "許可されていない操作です。"})

    def tick(self) -> None:
        process = self.process
        if process is None or self.phase == "idle":
            return
        now = time.monotonic()
        returncode = process.poll()
        if self.phase == "recording":
            if self.stop_requested_at is not None and returncode is None and now - self.stop_requested_at > 2:
                self._error("RECORDING_FAILED", "録音を停止できませんでした。")
                return
            if returncode is None:
                return
            if self.stop_requested_at is None and returncode != 0:
                self._error("RECORDING_FAILED", "録音に失敗しました。マイクを確認してください。")
                return
            self.recording_ended_at = now
            try:
                self._launch([str(FFMPEG), "-y", "-loglevel", "error", "-i", str(self._path("recorded.wav")),
                              "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(self._path("converted.wav"))])
                self.phase = "converting"
                send({"event": "processing", "recordingId": self.recording_id, "state": self.phase})
            except OSError as exc:
                self._error("CONVERSION_FAILED", f"音声を変換できませんでした: {exc}")
        elif self.phase == "converting":
            if returncode is None:
                if now - self.phase_started_at > CONVERT_TIMEOUT_SECONDS:
                    self._error("CONVERSION_TIMEOUT", "音声変換が時間内に終わりませんでした。")
                return
            if returncode != 0 or not self._path("converted.wav").is_file():
                self._error("CONVERSION_FAILED", "音声変換に失敗しました。")
                return
            try:
                self._launch([str(WHISPER_CLI), "-m", str(MODEL), "-f", str(self._path("converted.wav")),
                              "-l", "ja", "-nt", "-np", "-otxt", "-of", str(self._path("transcript"))])
                self.phase = "recognizing"
                send({"event": "processing", "recordingId": self.recording_id, "state": self.phase})
            except OSError as exc:
                self._error("RECOGNITION_FAILED", f"文字起こしを開始できませんでした: {exc}")
        elif self.phase == "recognizing":
            if returncode is None:
                if now - self.phase_started_at > WHISPER_TIMEOUT_SECONDS:
                    self._error("RECOGNITION_TIMEOUT", "文字起こしが時間内に終わりませんでした。")
                return
            transcript = self._path("transcript.txt")
            if returncode != 0 or not transcript.is_file():
                self._error("RECOGNITION_FAILED", "文字起こしに失敗しました。")
                return
            try:
                text = transcript.read_text(encoding="utf-8").strip()
            except (OSError, UnicodeError):
                self._error("RECOGNITION_FAILED", "認識結果を読み取れませんでした。")
                return
            if not text:
                self._error("EMPTY_RESULT", "音声から文字を認識できませんでした。")
                return
            recording_id = self.recording_id
            elapsed_ms = round((now - (self.stop_requested_at or self.recording_ended_at or self.started_at)) * 1000)
            timing_log = self._path("stderr.log").read_text(encoding="utf-8", errors="replace")
            load_times = re.findall(r"whisper_print_timings:\s+load time =\s+([\d.]+) ms", timing_log)
            model_load_ms = float(load_times[-1]) if load_times else None
            self._clear()
            send({"event": "result", "recordingId": recording_id, "text": text,
                  "elapsedMs": elapsed_ms, "modelLoadMs": model_load_ms})


def main() -> int:
    session = Session()
    closing = False

    def on_termination(_signum, _frame) -> None:
        nonlocal closing
        closing = True

    signal.signal(signal.SIGTERM, on_termination)
    buffer = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(sys.stdin.buffer, selectors.EVENT_READ)
        try:
            while not closing:
                for _key, _mask in selector.select(timeout=0.1):
                    chunk = os.read(sys.stdin.fileno(), 65536)
                    if not chunk:
                        return 0
                    buffer.extend(chunk)
                    while len(buffer) >= 4:
                        size = struct.unpack("=I", buffer[:4])[0]
                        if size > MAX_MESSAGE_BYTES:
                            return 1
                        if len(buffer) < size + 4:
                            break
                        payload = bytes(buffer[4:size + 4])
                        del buffer[:size + 4]
                        try:
                            request = json.loads(payload)
                        except (UnicodeError, json.JSONDecodeError):
                            send({"event": "error", "recordingId": None, "code": "INVALID_REQUEST", "message": "JSONを読み取れませんでした。"})
                        else:
                            session.handle(request)
                session.tick()
        finally:
            session.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
