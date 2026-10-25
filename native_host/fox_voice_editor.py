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
MAX_MESSAGE_BYTES = 1024 * 1024
MAX_RECORD_SECONDS = 30
WHISPER_TIMEOUT_SECONDS = 60
CONVERT_TIMEOUT_SECONDS = 10
WHISPER_ROOT = Path(__file__).resolve().parents[2] / "whisper.cpp"
ARECORD = Path("/usr/bin/arecord")
FFMPEG = Path("/usr/bin/ffmpeg")
WHISPER_CLI = WHISPER_ROOT / "build/bin/whisper-cli"
MODEL = WHISPER_ROOT / "models/ggml-base.bin"
REAZON_ROOT = Path(__file__).resolve().parents[2] / "reazonspeech"
REAZON_PYTHON = REAZON_ROOT / ".venv/bin/python"
REAZON_WORKER = Path(__file__).resolve().with_name("reazon_worker.py")
ENGINE_PREPARE_TIMEOUT_SECONDS = 45
REAZON_TIMEOUT_SECONDS = 60
AMIXER = Path("/usr/bin/amixer")
MICROPHONE_CONFIG = Path.home() / ".config/fox-voice-editor/microphone.json"
MICROPHONE_CARD = "PCH"
MICROPHONE_CONTROL = "Internal Mic Boost"
AMIXER_TIMEOUT_SECONDS = 2
LIBRARY_PATH = Path.home() / ".local/share/fox-voice-editor/library-v1.json"
LIBRARY_SCHEMA_VERSION = 1
LIBRARY_ITEM_LIMIT = 500
LIBRARY_TEXT_LIMIT = 4096


def empty_library() -> dict:
    return {"schemaVersion": LIBRARY_SCHEMA_VERSION, "history": [], "templates": []}


def validate_library(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "history", "templates"} or value["schemaVersion"] != LIBRARY_SCHEMA_VERSION:
        raise ValueError("定型・履歴データの形式が正しくありません。")
    normalized: dict[str, object] = {"schemaVersion": LIBRARY_SCHEMA_VERSION}
    for collection in ("history", "templates"):
        entries = value[collection]
        if not isinstance(entries, list) or len(entries) > LIBRARY_ITEM_LIMIT:
            raise ValueError("定型・履歴データの件数が正しくありません。")
        ids: set[str] = set()
        checked = []
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {"id", "text", "pinned", "lastUsedAt", "useCount"}:
                raise ValueError("定型・履歴の項目形式が正しくありません。")
            entry_id, text = entry["id"], entry["text"]
            if not isinstance(entry_id, str) or not entry_id or len(entry_id) > 128 or entry_id in ids:
                raise ValueError("定型・履歴のIDが正しくありません。")
            if not isinstance(text, str) or not text or len(text) > LIBRARY_TEXT_LIMIT:
                raise ValueError("定型・履歴の文字列が正しくありません。")
            if type(entry["pinned"]) is not bool or (entry["lastUsedAt"] is not None and not isinstance(entry["lastUsedAt"], str)) or type(entry["useCount"]) is not int or entry["useCount"] < 0:
                raise ValueError("定型・履歴の項目値が正しくありません。")
            ids.add(entry_id)
            checked.append({key: entry[key] for key in ("id", "text", "pinned", "lastUsedAt", "useCount")})
        normalized[collection] = checked
    return normalized


def load_library() -> tuple[dict, bool]:
    try:
        raw = json.loads(LIBRARY_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return empty_library(), False
    return validate_library(raw), True


def save_library(value: object) -> None:
    library = validate_library(value)
    LIBRARY_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=LIBRARY_PATH.parent, prefix=".library-", delete=False) as stream:
        json.dump(library, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
        staged = Path(stream.name)
    try:
        staged.chmod(0o600)
        os.replace(staged, LIBRARY_PATH)
        directory_fd = os.open(LIBRARY_PATH.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        staged.unlink(missing_ok=True)


def boost_fix_enabled() -> bool:
    try:
        config = json.loads(MICROPHONE_CONFIG.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return False
    if not isinstance(config, dict) or set(config) != {"boost_fix"} or type(config["boost_fix"]) is not bool:
        raise ValueError("マイク補正のローカル設定が正しくありません。")
    return config["boost_fix"]


def read_boost() -> tuple[int, int]:
    result = subprocess.run(
        [str(AMIXER), "-c", MICROPHONE_CARD, "sget", MICROPHONE_CONTROL],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, check=True,
        timeout=AMIXER_TIMEOUT_SECONDS, env={**os.environ, "LC_ALL": "C"},
    )
    lines = result.stdout.splitlines()
    if not lines or lines[0].strip() != f"Simple mixer control '{MICROPHONE_CONTROL}',0":
        raise ValueError("対象のマイクブースト制御を確認できません。")
    channels = {}
    for line in lines[1:]:
        match = re.fullmatch(r"\s*Front (Left|Right):\s*(\d+)\s+\[[^\]]+\](?:\s+\[[^\]]+\])*\s*", line)
        if match:
            channel = match.group(1)
            if channel in channels:
                raise ValueError("マイクブーストのチャンネルが重複しています。")
            channels[channel] = int(match.group(2))
    if set(channels) != {"Left", "Right"}:
        raise ValueError("左右のマイクブースト値を読み取れません。")
    return channels["Left"], channels["Right"]


def prepare_microphone() -> str:
    if not boost_fix_enabled():
        return "skipped"
    if not AMIXER.is_file():
        raise FileNotFoundError("amixerが見つかりません。")
    before = read_boost()
    if before == (0, 0):
        return "unchanged"
    subprocess.run(
        [str(AMIXER), "-c", MICROPHONE_CARD, "sset", MICROPHONE_CONTROL, "0"],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, check=True,
        timeout=AMIXER_TIMEOUT_SECONDS, env={**os.environ, "LC_ALL": "C"},
    )
    if read_boost() != (0, 0):
        raise ValueError("補正後も左右のマイクブースト値が0ではありません。")
    return "adjusted"


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
        self.stop_requested_ns: int | None = None
        self.recording_ended_at: float | None = None
        self.recording_ended_ns: int | None = None
        self.phase_started_at = 0.0
        self.conversion_ms: int | None = None
        self.whisper_started_ns: int | None = None
        self.microphone_ready = False
        self.engine = "whisper"
        self.engine_status = "ready"
        self.engine_generation = 0
        self.worker: subprocess.Popen | None = None
        self.worker_buffer = bytearray()
        self.worker_started_at = 0.0
        self.ignored_worker_requests: set[str] = set()

    def _path(self, name: str) -> Path:
        assert self.temp is not None
        return Path(self.temp.name) / name

    def _launch(self, command: list[str], *, stdout=None, env=None) -> None:
        with self._path("stderr.log").open("ab") as err:
            self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout or subprocess.DEVNULL, stderr=err, env=env)
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
        self.stop_requested_ns = None
        self.recording_ended_at = None
        self.recording_ended_ns = None
        self.conversion_ms = None
        self.whisper_started_ns = None

    def close(self) -> None:
        self._clear()
        self._stop_worker()

    def _stop_worker(self) -> None:
        worker = self.worker
        self.worker = None
        self.worker_buffer.clear()
        self.ignored_worker_requests.clear()
        if worker is None:
            return
        if worker.stdin:
            worker.stdin.close()
        if worker.poll() is None:
            try:
                worker.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                worker.terminate()
                try:
                    worker.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    worker.kill()
                    worker.wait(timeout=0.5)
        if worker.stdout:
            worker.stdout.close()

    def _engine_event(self, status: str, **extra: object) -> None:
        send({"event": "engine_prepared", "engine": self.engine,
              "engineStatus": status, "engineGeneration": self.engine_generation, **extra})

    def _worker_failed(self, code: str, message: str) -> None:
        self._stop_worker()
        self.engine_status = "error"
        if self.phase != "idle":
            self._error(code, message)
        self._engine_event("error", code=code, message=message)

    def _prepare_engine(self, engine: str) -> None:
        if self.phase != "idle":
            self._engine_event("error", code="BUSY", message="録音または認識中は切り替えできません。")
            return
        if engine not in ("whisper", "reazonspeech_k2"):
            send({"event": "error", "recordingId": None, "code": "UNKNOWN_ENGINE", "message": "認識エンジンが不正です。"})
            return
        if engine == self.engine and self.engine_status in ("ready", "preparing"):
            self._engine_event(self.engine_status)
            return
        self._stop_worker()
        if engine != self.engine or self.engine_status == "error":
            self.engine_generation += 1
        self.engine = engine
        if engine == "whisper":
            self.engine_status = "ready"
            self._engine_event("ready", initializationMs=0)
            return
        missing = [str(path) for path, exists in (
            (REAZON_ROOT, REAZON_ROOT.is_dir()),
            (REAZON_PYTHON, REAZON_PYTHON.is_file()),
            (REAZON_WORKER, REAZON_WORKER.is_file()),
        ) if not exists]
        if missing:
            self.engine_status = "error"
            self._engine_event("error", code="ENGINE_FILES_MISSING",
                               message="ReazonSpeechの実行環境が見つかりません: " + ", ".join(missing))
            return
        try:
            self.worker = subprocess.Popen(
                [str(REAZON_PYTHON), str(REAZON_WORKER), str(REAZON_ROOT)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            )
            assert self.worker.stdout is not None
            os.set_blocking(self.worker.stdout.fileno(), False)
            self.worker_started_at = time.monotonic()
            self.engine_status = "preparing"
            self._engine_event("preparing")
        except OSError as exc:
            self._worker_failed("ENGINE_START_FAILED", str(exc))

    def _read_worker(self) -> None:
        worker = self.worker
        if worker is None or worker.stdout is None:
            return
        try:
            chunk = os.read(worker.stdout.fileno(), 65536)
        except BlockingIOError:
            chunk = None
        except OSError as exc:
            self._worker_failed("ENGINE_IO_FAILED", str(exc))
            return
        if chunk:
            self.worker_buffer.extend(chunk)
            if len(self.worker_buffer) > MAX_MESSAGE_BYTES:
                self._worker_failed("ENGINE_PROTOCOL_ERROR", "Workerの応答が大きすぎます。")
                return
            while b"\n" in self.worker_buffer:
                line, _, rest = self.worker_buffer.partition(b"\n")
                self.worker_buffer = bytearray(rest)
                try:
                    event = json.loads(line)
                except (UnicodeError, json.JSONDecodeError):
                    self._worker_failed("ENGINE_PROTOCOL_ERROR", "Workerの応答を読み取れません。")
                    return
                if not isinstance(event, dict):
                    self._worker_failed("ENGINE_PROTOCOL_ERROR", "Workerの応答形式が不正です。")
                    return
                if isinstance(event.get("requestId"), str) and event["requestId"] in self.ignored_worker_requests and event.get("event") in ("result", "error"):
                    self.ignored_worker_requests.discard(event["requestId"])
                    continue
                if event.get("event") == "ready" and self.engine_status == "preparing":
                    self.engine_status = "ready"
                    self._engine_event("ready", initializationMs=event.get("initializationMs"))
                elif event.get("event") == "result" and self.phase == "recognizing" and event.get("requestId") == self.recording_id:
                    text = event.get("text", "").strip()
                    if not text:
                        self._error("EMPTY_RESULT", "音声から文字を認識できませんでした。")
                    else:
                        recording_id = self.recording_id
                        elapsed_ms = round((time.monotonic() - (self.stop_requested_at or self.recording_ended_at or self.started_at)) * 1000)
                        conversion_ms = self.conversion_ms
                        self._clear()
                        send({"event": "result", "recordingId": recording_id, "engine": self.engine,
                              "engineGeneration": self.engine_generation, "text": text,
                              "elapsedMs": elapsed_ms, "conversionMs": conversion_ms,
                              "modelStartupMs": None, "recognitionMs": event.get("recognitionMs"),
                              "modelName": "ReazonSpeech K2 INT8"})
                elif event.get("event") == "error":
                    self._worker_failed(event.get("code", "ENGINE_FAILED"), event.get("message", "認識エンジンでエラーが発生しました。"))
                    return
                else:
                    self._worker_failed("ENGINE_PROTOCOL_ERROR", "Workerの応答が予期しない状態です。")
                    return
        if chunk == b"" or (worker.poll() is not None and self.worker is worker):
            self._worker_failed("ENGINE_EXITED", "ReazonSpeech Workerが終了しました。")

    def _error(self, code: str, message: str) -> None:
        recording_id = self.recording_id
        self._clear()
        send({"event": "error", "recordingId": recording_id, "code": code, "message": message})

    def handle(self, request: object) -> None:
        if not isinstance(request, dict) or "action" not in request or not isinstance(request["action"], str):
            send({"event": "error", "recordingId": None, "code": "INVALID_REQUEST", "message": "要求形式が正しくありません。"})
            return
        action = request["action"]
        expected_keys = {"action", "engine"} if action == "prepare_engine" else {"action", "library"} if action == "save_library" else {"action"}
        if set(request) != expected_keys:
            send({"event": "error", "recordingId": None, "code": "INVALID_REQUEST", "message": "要求形式が正しくありません。"})
            return
        if action == "load_library":
            try:
                library, exists = load_library()
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                send({"event": "library_error", "code": "LIBRARY_LOAD_FAILED", "message": str(exc)})
            else:
                send({"event": "library_loaded", "library": library, "exists": exists})
            return
        if action == "save_library":
            try:
                save_library(request["library"])
            except (OSError, ValueError) as exc:
                send({"event": "library_error", "code": "LIBRARY_SAVE_FAILED", "message": str(exc)})
            else:
                send({"event": "library_saved"})
            return
        if action == "prepare_engine":
            self._prepare_engine(request["engine"])
        elif action == "prepare_microphone":
            if self.phase != "idle":
                send({"event": "microphone_prepared", "status": "error", "code": "BUSY", "message": "録音または認識中はマイクを再確認できません。"})
                return
            self.microphone_ready = False
            try:
                status = prepare_microphone()
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                send({"event": "microphone_prepared", "status": "error", "code": "MICROPHONE_PREPARATION_FAILED", "message": str(exc)})
            else:
                self.microphone_ready = True
                send({"event": "microphone_prepared", "status": status})
        elif action == "get_status":
            state = "stopping" if self.phase == "recording" and self.stop_requested_at is not None else self.phase
            send({"event": "status", "recordingId": self.recording_id, "state": state,
                  "microphoneReady": self.microphone_ready, "engine": self.engine,
                  "engineStatus": self.engine_status, "engineGeneration": self.engine_generation})
        elif action == "start_recording":
            if self.phase != "idle":
                send({"event": "error", "recordingId": self.recording_id, "code": "BUSY", "message": "録音または認識中です。"})
                return
            if not self.microphone_ready:
                send({"event": "error", "recordingId": None, "code": "MICROPHONE_NOT_READY", "message": "マイクの確認が完了していません。"})
                return
            if self.engine_status != "ready" or (self.engine == "reazonspeech_k2" and (self.worker is None or self.worker.poll() is not None)):
                send({"event": "error", "recordingId": None, "code": "ENGINE_NOT_READY", "message": "認識エンジンの準備が完了していません。"})
                return
            try:
                if not ARECORD.is_file() or not FFMPEG.is_file() or (self.engine == "whisper" and (not WHISPER_CLI.is_file() or not MODEL.is_file())):
                    raise FileNotFoundError("録音・認識に必要なコマンドまたはモデルが見つかりません。")
                self.temp = tempfile.TemporaryDirectory(prefix="fox-voice-editor-")
                self.recording_id = uuid.uuid4().hex
                self._launch([str(ARECORD), "-q", "-d", str(MAX_RECORD_SECONDS), "-f", "cd", str(self._path("recorded.wav"))])
                self.phase = "recording"
                self.started_at = time.monotonic()
                send({"event": "started", "recordingId": self.recording_id, "state": self.phase,
                      "engine": self.engine, "engineGeneration": self.engine_generation})
            except (OSError, subprocess.SubprocessError) as exc:
                self._error("RECORDING_FAILED", f"録音を開始できませんでした: {exc}")
        elif action == "stop_recording":
            if self.phase != "recording":
                send({"event": "error", "recordingId": self.recording_id, "code": "NOT_RECORDING", "message": "録音中ではありません。"})
                return
            if self.stop_requested_at is None:
                self.stop_requested_ns = time.monotonic_ns()
                self.stop_requested_at = self.stop_requested_ns / 1_000_000_000
                if self.process is not None and self.process.poll() is None:
                    self.process.send_signal(signal.SIGINT)
            send({"event": "stopping", "recordingId": self.recording_id, "state": "stopping"})
        elif action == "cancel_recording":
            if self.phase == "idle":
                send({"event": "status", "recordingId": None, "state": "idle"})
                return
            recording_id = self.recording_id
            if self.engine == "reazonspeech_k2" and self.phase == "recognizing" and recording_id:
                self.ignored_worker_requests.add(recording_id)
            self._clear()
            send({"event": "cancelled", "recordingId": recording_id, "state": "idle"})
        else:
            send({"event": "error", "recordingId": None, "code": "UNKNOWN_ACTION", "message": "許可されていない操作です。"})

    def tick(self) -> None:
        self._read_worker()
        if self.engine_status == "preparing" and time.monotonic() - self.worker_started_at > ENGINE_PREPARE_TIMEOUT_SECONDS:
            self._worker_failed("ENGINE_PREPARATION_TIMEOUT", "モデル準備が時間内に終わりませんでした。")
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
            self.recording_ended_ns = time.monotonic_ns()
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
            converted_ns = time.monotonic_ns()
            conversion_start_ns = self.stop_requested_ns or self.recording_ended_ns
            self.conversion_ms = round((converted_ns - conversion_start_ns) / 1_000_000) if conversion_start_ns else None
            try:
                if self.engine == "reazonspeech_k2":
                    if self.worker is None or self.worker.poll() is not None or self.worker.stdin is None:
                        self._worker_failed("ENGINE_EXITED", "ReazonSpeech Workerが終了しました。")
                        return
                    payload = json.dumps({"action": "recognize", "requestId": self.recording_id,
                                          "wavPath": str(self._path("converted.wav"))}) + "\n"
                    self.worker.stdin.write(payload.encode("utf-8"))
                    self.worker.stdin.flush()
                    self.phase = "recognizing"
                    self.phase_started_at = time.monotonic()
                    send({"event": "processing", "recordingId": self.recording_id, "state": self.phase})
                    return
                self.whisper_started_ns = time.monotonic_ns()
                self._launch([str(WHISPER_CLI), "-m", str(MODEL), "-f", str(self._path("converted.wav")),
                              "-l", "ja", "-nt", "-np", "-otxt", "-of", str(self._path("transcript"))],
                             env={**os.environ, "WHISPER_CLI_TIMING_MARKERS": "1"})
                self.phase = "recognizing"
                send({"event": "processing", "recordingId": self.recording_id, "state": self.phase})
            except OSError as exc:
                self._error("RECOGNITION_FAILED", f"文字起こしを開始できませんでした: {exc}")
        elif self.phase == "recognizing":
            if self.engine == "reazonspeech_k2":
                if now - self.phase_started_at > REAZON_TIMEOUT_SECONDS:
                    self._worker_failed("RECOGNITION_TIMEOUT", "文字起こしが時間内に終わりませんでした。")
                return
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
            ready_match = re.search(r"(?m)^whisper_cli_timing: model_ready_ns = (\d+)$", timing_log)
            done_match = re.search(r"(?m)^whisper_cli_timing: recognition_done_ns = (\d+)$", timing_log)
            model_startup_ms = recognition_ms = None
            if ready_match and done_match and self.whisper_started_ns is not None:
                ready_ns, done_ns = int(ready_match.group(1)), int(done_match.group(1))
                if self.whisper_started_ns <= ready_ns <= done_ns <= time.monotonic_ns():
                    model_startup_ms = round((ready_ns - self.whisper_started_ns) / 1_000_000)
                    recognition_ms = round((done_ns - ready_ns) / 1_000_000)
            conversion_ms = self.conversion_ms
            self._clear()
            send({"event": "result", "recordingId": recording_id, "engine": self.engine,
                  "engineGeneration": self.engine_generation, "text": text,
                  "elapsedMs": elapsed_ms, "conversionMs": conversion_ms,
                  "modelStartupMs": model_startup_ms, "recognitionMs": recognition_ms,
                  "modelName": MODEL.name})


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
