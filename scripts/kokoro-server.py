#!/usr/bin/env python3
"""Local Kokoro TTS helper for Natural Voice Reader (sherpa-onnx, CPU).

VoiceStudio's sherpa adapter only wires VITS/Piper, and its Kokoro path is
Apple-only mlx-audio. This small loopback server loads the official
Kokoro-82M int8 pack once and serves OpenAI-style /v1/audio/speech.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Official kokoro-multi-lang-v1_0 speaker ids (hexgrad/Kokoro-82M).
VOICES = {
    "bm_george": 26,
    "bm_lewis": 27,
    "bm_daniel": 24,
    "bm_fable": 25,
    "hf_alpha": 31,
    "hf_beta": 32,
    "hm_omega": 33,
    "hm_psi": 34,
    "jf_alpha": 37,
    "jm_kumo": 41,
}

DEFAULT_CACHE = Path.home() / ".cache" / "nvr" / "sherpa" / "kokoro-int8-multi-lang-v1_0"

_tts = None
_model_dir = None


def model_paths(root: Path) -> dict[str, str]:
    model = root / "model.int8.onnx"
    if not model.is_file():
        model = root / "model.onnx"
    voices = root / "voices.bin"
    tokens = root / "tokens.txt"
    data_dir = root / "espeak-ng-data"
    gb = root / "lexicon-gb-en.txt"
    us = root / "lexicon-us-en.txt"
    zh = root / "lexicon-zh.txt"
    lex_en = gb if gb.is_file() else us
    lexicon_parts = [str(p) for p in (lex_en, zh) if p.is_file()]
    if not model.is_file() or not voices.is_file() or not tokens.is_file():
        raise FileNotFoundError(f"Kokoro model files are missing in {root}")
    return {
        "model": str(model),
        "voices": str(voices),
        "tokens": str(tokens),
        "data_dir": str(data_dir) if data_dir.is_dir() else "",
        "lexicon": ",".join(lexicon_parts),
    }


def load_tts(root: Path, threads: int):
    global _tts, _model_dir
    import sherpa_onnx

    paths = model_paths(root)
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=paths["model"],
                voices=paths["voices"],
                tokens=paths["tokens"],
                data_dir=paths["data_dir"],
                lexicon=paths["lexicon"],
            ),
            num_threads=max(1, threads),
            provider="cpu",
        )
    )
    if not cfg.validate():
        raise RuntimeError("Kokoro config is invalid. Check the model directory.")
    _tts = sherpa_onnx.OfflineTts(cfg)
    _model_dir = str(root)
    return _tts


def pcm16_wav(samples, rate: int) -> bytes:
    import numpy as np

    audio = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm = (audio * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(rate))
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def resolve_sid(voice: str) -> int:
    raw = (voice or "").strip()
    if raw.isdigit():
        return int(raw)
    if raw in VOICES:
        return VOICES[raw]
    return VOICES["bm_george"]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A003
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, code: int, payload: dict) -> None:
        self._send(code, json.dumps(payload).encode("utf-8"), "application/json")

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] in ("/health", "/v1/health"):
            self._send_json(
                200,
                {
                    "status": "ok" if _tts is not None else "loading",
                    "engine": "kokoro",
                    "model_dir": _model_dir,
                    "voices": sorted(VOICES),
                },
            )
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] != "/v1/audio/speech":
            self._send_json(404, {"error": "not found"})
            return
        if _tts is None:
            self._send_json(503, {"error": "Kokoro is still loading."})
            return
        length = int(self.headers.get("Content-Length") or "0")
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Invalid JSON."})
            return
        text = " ".join(str(data.get("input") or data.get("text") or "").split()).strip()
        if not text:
            self._send_json(400, {"error": "Nothing to read."})
            return
        if len(text) > 4096:
            self._send_json(400, {"error": "A spoken piece is too long."})
            return
        sid = resolve_sid(str(data.get("voice") or "bm_george"))
        try:
            speed = float(data.get("speed") or 1.0)
        except (TypeError, ValueError):
            speed = 1.0
        speed = min(1.5, max(0.7, speed))
        try:
            audio = _tts.generate(text, sid=sid, speed=speed)
        except Exception as err:
            self._send_json(500, {"error": f"Kokoro failed: {err}"})
            return
        wav = pcm16_wav(audio.samples, audio.sample_rate)
        self._send(200, wav, "audio/wav")


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve Kokoro TTS on loopback.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("KOKORO_PORT", "3901")))
    parser.add_argument("--model-dir", default=os.environ.get("NVR_KOKORO_MODEL_DIR", str(DEFAULT_CACHE)))
    parser.add_argument("--threads", type=int, default=int(os.environ.get("NVR_CPU_THREADS", "4")))
    args = parser.parse_args()
    root = Path(args.model_dir).expanduser()
    print(f"Loading Kokoro from {root} with {args.threads} threads...", flush=True)
    load_tts(root, args.threads)
    # One short warm pass so the first user request is closer to steady-state.
    _tts.generate("The voice engine is ready.", sid=VOICES["bm_george"], speed=1.0)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Kokoro is ready on http://{args.host}:{args.port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
