#!/usr/bin/env python3
"""One ReazonSpeech recognizer per Native Host connection.

The parent owns this process. Input and output are newline-delimited JSON on
stdin and stdout; diagnostic output belongs on stderr.
"""

from __future__ import annotations

from array import array
import ctypes
import json
import os
from pathlib import Path
import signal
import sys
import time
import wave


def send(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def watch_parent() -> None:
    """Ask Linux to terminate us even if the Host is killed without cleanup."""
    parent = os.getppid()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise OSError(ctypes.get_errno(), "PR_SET_PDEATHSIG failed")
    if os.getppid() != parent:
        os.kill(os.getpid(), signal.SIGTERM)


def read_audio(path: Path) -> tuple[int, list[float]]:
    with wave.open(str(path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getcomptype() != "NONE":
            raise ValueError("16-bit mono PCM WAVが必要です。")
        sample_rate = audio.getframerate()
        if sample_rate != 16000 or audio.getnframes() > sample_rate * 30:
            raise ValueError("16 kHz・30秒以内の音声が必要です。")
        samples = array("h")
        samples.frombytes(audio.readframes(audio.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    return sample_rate, [sample / 32768.0 for sample in samples]


def main() -> int:
    if len(sys.argv) != 2:
        return 2
    watch_parent()
    model_dir = Path(sys.argv[1])
    try:
        import sherpa_onnx

        started = time.monotonic_ns()
        recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(model_dir / "encoder-epoch-99-avg-1.int8.onnx"),
            decoder=str(model_dir / "decoder-epoch-99-avg-1.onnx"),
            joiner=str(model_dir / "joiner-epoch-99-avg-1.int8.onnx"),
            tokens=str(model_dir / "tokens.txt"),
            num_threads=2,
        )
        send({"event": "ready", "loadCount": 1,
              "initializationMs": round((time.monotonic_ns() - started) / 1_000_000)})
    except Exception as exc:
        send({"event": "error", "code": "MODEL_PREPARATION_FAILED", "message": str(exc)})
        return 1

    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or set(request) != {"action", "requestId", "wavPath"} or request["action"] != "recognize":
                raise ValueError("要求形式が正しくありません。")
            if not isinstance(request["requestId"], str) or not isinstance(request["wavPath"], str):
                raise ValueError("要求形式が正しくありません。")
            sample_rate, samples = read_audio(Path(request["wavPath"]))
            started = time.monotonic_ns()
            stream = recognizer.create_stream()
            stream.accept_waveform(sample_rate, samples)
            recognizer.decode_stream(stream)
            text = stream.result.text.strip()
            send({"event": "result", "requestId": request["requestId"], "text": text,
                  "recognitionMs": round((time.monotonic_ns() - started) / 1_000_000), "loadCount": 1})
        except Exception as exc:
            send({"event": "error", "requestId": request.get("requestId") if isinstance(request, dict) else None,
                  "code": "RECOGNITION_FAILED", "message": str(exc)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
