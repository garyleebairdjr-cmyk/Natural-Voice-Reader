#!/usr/bin/env python3
"""Speak text to an audio file using Natural Voice Reader's local engines.

This CLI calls the same VoiceStudio and Kokoro HTTP APIs the reader uses.
It does not start those engines itself; use scripts/nvr-say.sh or `nvr say`.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_VOICE_ID = "leo"
DEFAULT_MODEL = "kittentts"
DEFAULT_VOICESTUDIO_URL = "http://127.0.0.1:3900"
DEFAULT_KOKORO_URL = "http://127.0.0.1:3901"
MAX_CHARS = 4096
FORBIDDEN_MODELS = frozenset({"voxcpm2", "tts-1", "tts-1-hd", "gpt-4o-mini-tts"})
PINNED_MODELS = ("kittentts", "omnivoice")

# Official reader voices. Leo is the default.
VOICE_IDS = (
    "butler",
    "mira",
    "arjun",
    "leo",
    "eve",
    "rex",
    "sal",
    "ara",
    "orion",
    "helix",
    "luna",
    "sirius",
    "aurora",
    "atlas",
    "rigel",
    "naksh",
    "lumen",
    "iris",
    "castor",
)

REMOVED_VOICE_IDS = frozenset({"aiko", "haru", "lena", "jonas"})

# Specialty voices go to Kokoro so the accent is preserved.
KOKORO_SPEAKERS = {
    "butler": "bm_george",
    "mira": "hf_alpha",
    "arjun": "hm_omega",
}

# KittenTTS has eight presets. Map the reader voices onto them, same as the app.
KITTEN_VOICE = {
    "butler": "expr-voice-2-m",
    "mira": "expr-voice-5-f",
    "arjun": "expr-voice-3-m",
    "leo": "expr-voice-2-m",
    "eve": "expr-voice-2-f",
    "rex": "expr-voice-3-m",
    "sal": "expr-voice-3-f",
    "ara": "expr-voice-4-f",
    "orion": "expr-voice-4-m",
    "helix": "expr-voice-5-m",
    "luna": "expr-voice-5-f",
    "sirius": "expr-voice-2-f",
    "aurora": "expr-voice-3-f",
    "atlas": "expr-voice-2-m",
    "rigel": "expr-voice-4-f",
    "naksh": "expr-voice-3-m",
    "lumen": "expr-voice-5-m",
    "iris": "expr-voice-5-f",
    "castor": "expr-voice-4-m",
}

VOICE_NOTES = {
    "butler": "Jarvis-style butler. Generic RP; not a film or actor voice.",
    "mira": "Clear, natural Indian English.",
    "arjun": "Calm, natural Indian English.",
    "leo": "Steady, British (default)",
    "eve": "Bright, British",
    "rex": "Clear and direct",
    "sal": "Smooth midrange",
    "ara": "Warm and close",
    "orion": "Cinematic read",
    "helix": "Commentary punch",
    "luna": "Patient and soft",
    "sirius": "Quick and playful",
    "aurora": "Calm and even",
    "atlas": "Low and sure",
    "rigel": "Precise, Australian",
    "naksh": "Thoughtful, Indian",
    "lumen": "Warm educator",
    "iris": "Upbeat and light",
    "castor": "Easygoing",
}


def canonical_voice_id(raw: object) -> str:
    if not isinstance(raw, str) or not raw.strip():
        return DEFAULT_VOICE_ID
    voice_id = raw.strip().lower()
    if voice_id in REMOVED_VOICE_IDS:
        return DEFAULT_VOICE_ID
    if voice_id in VOICE_IDS:
        return voice_id
    return DEFAULT_VOICE_ID


def kitten_voice_id(voice_id: str) -> str:
    return KITTEN_VOICE.get(voice_id, "expr-voice-2-m")


def requested_model(raw: object) -> str:
    if isinstance(raw, str):
        model = raw.strip().lower()
        if model in FORBIDDEN_MODELS:
            return DEFAULT_MODEL
        if model in PINNED_MODELS:
            return model
    env = (os.environ.get("VOICESTUDIO_TTS_MODEL") or os.environ.get("NVR_TTS_MODEL") or "").strip().lower()
    if env and env not in FORBIDDEN_MODELS and env in PINNED_MODELS:
        return env
    return DEFAULT_MODEL


def clamp_speed(raw: object) -> float:
    if isinstance(raw, bool):
        return 1.0
    if isinstance(raw, (int, float)):
        value = float(raw)
    elif isinstance(raw, str) and raw.strip():
        try:
            value = float(raw)
        except ValueError:
            return 1.0
    else:
        return 1.0
    if value != value:  # NaN
        return 1.0
    return min(1.5, max(0.7, value))


def normalize_text(raw: object) -> str:
    if not isinstance(raw, str):
        return ""
    return " ".join(raw.split()).strip()


def resolve_route(voice_id: str, selected_model: str) -> dict[str, object]:
    voice_id = canonical_voice_id(voice_id)
    model = requested_model(selected_model)
    kokoro = KOKORO_SPEAKERS.get(voice_id)
    if kokoro:
        return {
            "provider": "kokoro",
            "model": "kokoro",
            "voice": kokoro,
            "voice_id": voice_id,
            "slow": False,
            "label": "Kokoro",
        }
    return {
        "provider": "voicestudio",
        "model": model,
        "voice": kitten_voice_id(voice_id) if model == "kittentts" else "default",
        "voice_id": voice_id,
        "slow": model == "omnivoice",
        "label": "OmniVoice" if model == "omnivoice" else "KittenTTS",
    }


def voice_studio_base() -> str:
    return (os.environ.get("VOICESTUDIO_URL") or DEFAULT_VOICESTUDIO_URL).rstrip("/")


def kokoro_base() -> str:
    return (os.environ.get("KOKORO_URL") or os.environ.get("NVR_KOKORO_URL") or DEFAULT_KOKORO_URL).rstrip("/")


def voice_studio_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    api_key = (os.environ.get("VOICESTUDIO_API_KEY") or os.environ.get("OMNIVOICE_API_KEY") or "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def http_json(url: str, payload: dict | None = None, timeout: float = 8, headers: dict[str, str] | None = None) -> tuple[int, bytes, str]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
    request = urllib.request.Request(url, data=body, headers=req_headers, method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(), response.headers.get("Content-Type") or ""
    except urllib.error.HTTPError as err:
        return err.code, err.read() if err.fp else b"", err.headers.get("Content-Type") if err.headers else ""


def ping_health(url: str, timeout: float = 5) -> bool:
    try:
        status, _, _ = http_json(url, timeout=timeout)
        return 200 <= status < 300
    except Exception:
        return False


def looks_like_wav(data: bytes) -> bool:
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def looks_like_mp3(data: bytes) -> bool:
    if len(data) < 3:
        return False
    if data[:3] == b"ID3":
        return True
    return data[0] == 0xFF and (data[1] & 0xE0) == 0xE0


def convert_to_mp3(data: bytes) -> bytes:
    if looks_like_mp3(data) and not looks_like_wav(data):
        return data
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to write MP3 when the engine returns WAV.")
    with tempfile.TemporaryDirectory(prefix="nvr-say-") as tmp:
        src = Path(tmp) / ("input.wav" if looks_like_wav(data) else "input.bin")
        dest = Path(tmp) / "output.mp3"
        src.write_bytes(data)
        result = subprocess.run(
            [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(src), "-codec:a", "libmp3lame", "-q:2", str(dest)],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0 or not dest.is_file() or dest.stat().st_size < 64:
            detail = (result.stderr or result.stdout or "ffmpeg failed").strip()
            raise RuntimeError(detail)
        return dest.read_bytes()


def write_output(path: str, data: bytes) -> None:
    if path == "-":
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        return
    dest = Path(path).expanduser()
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.tmp")
    tmp.write_bytes(data)
    tmp.replace(dest)


def list_voices_text() -> str:
    lines = ["id        engine    note"]
    for voice_id in VOICE_IDS:
        engine = "kokoro" if voice_id in KOKORO_SPEAKERS else "kittentts"
        note = VOICE_NOTES.get(voice_id, "")
        lines.append(f"{voice_id:<9} {engine:<9} {note}")
    return "\n".join(lines) + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nvr say",
        description="Create an MP3 (or WAV) from text using Natural Voice Reader's local voices.",
    )
    parser.add_argument("--text", "-t", help="Text to speak. If omitted, remaining arguments or stdin are used.")
    parser.add_argument("--out", "-o", help="Output file, or - for raw audio on stdout.")
    parser.add_argument("--voice", "-v", default=DEFAULT_VOICE_ID, help=f"Reader voice id (default: {DEFAULT_VOICE_ID}).")
    parser.add_argument("--model", default=None, help="kittentts (default) or omnivoice. Ignored for Butler, Mira, and Arjun.")
    parser.add_argument("--speed", type=float, default=1.0, help="Playback speed from 0.7 to 1.5 (default: 1).")
    parser.add_argument("--list-voices", action="store_true", help="List built-in voice ids and exit.")
    parser.add_argument("--route-only", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("words", nargs="*", help="Optional text if --text is not set.")
    return parser


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


def resolve_text(args: argparse.Namespace, stdin_text: str | None = None) -> str:
    if args.text and args.words:
        raise ValueError("Pass the text with --text or as arguments, not both.")
    if args.text:
        return normalize_text(args.text)
    if args.words:
        return normalize_text(" ".join(args.words))
    if stdin_text is not None:
        return normalize_text(stdin_text)
    return ""


def pin_voicestudio(model: str, timeout: float = 8) -> str | None:
    try:
        status, body, _ = http_json(
            f"{voice_studio_base()}/engines/select",
            {"family": "tts", "backend_id": model},
            timeout=timeout,
            headers=voice_studio_headers(),
        )
    except Exception:
        return "Could not pin the voice engine yet."
    if status >= 300:
        return f"Could not pin {model} ({status})."
    try:
        payload = json.loads(body.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        payload = {}
    active = payload.get("active") if isinstance(payload, dict) else None
    if model == "omnivoice" and isinstance(active, str) and active and active != model:
        return f"VoiceStudio is using {active} as the active engine, not OmniVoice."
    return None


def speak(route: dict[str, object], text: str, speed: float, timeout: float) -> tuple[bytes, str]:
    if route["provider"] == "kokoro":
        status, body, content_type = http_json(
            f"{kokoro_base()}/v1/audio/speech",
            {
                "model": "kokoro",
                "input": text,
                "voice": route["voice"],
                "speed": speed,
            },
            timeout=timeout,
        )
        if status == 503:
            raise RuntimeError("The Kokoro voice helper is still starting.")
        if status >= 300 or len(body) < 64:
            raise RuntimeError(f"Kokoro error ({status})." if status >= 300 else "Kokoro came back empty.")
        return body, (content_type.split(";")[0].strip() if content_type else "audio/wav")

    pin_error = pin_voicestudio(str(route["model"]))
    if pin_error and route["model"] == "omnivoice":
        raise RuntimeError(pin_error)
    payload: dict[str, object] = {
        "model": route["model"],
        "input": text,
        "voice": route["voice"],
        "response_format": "mp3",
        "speed": speed,
        "language": "en",
        "denoise": True,
    }
    status, body, content_type = http_json(
        f"{voice_studio_base()}/v1/audio/speech",
        payload,
        timeout=timeout,
        headers=voice_studio_headers(),
    )
    if status >= 300 or len(body) < 64:
        if status >= 500 or status == 429:
            raise RuntimeError(f"VoiceStudio is busy ({status}).")
        raise RuntimeError(f"VoiceStudio error ({status})." if status >= 300 else "VoiceStudio came back empty.")
    return body, (content_type.split(";")[0].strip() if content_type else "audio/mpeg")


def wants_mp3(path: str) -> bool:
    if path == "-":
        return True
    return Path(path).suffix.lower() in {".mp3", ".mpeg", ".mpga", ""}


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 1

    if args.list_voices:
        sys.stdout.write(list_voices_text())
        return 0

    voice_id = canonical_voice_id(args.voice)
    if isinstance(args.voice, str) and args.voice.strip() and canonical_voice_id(args.voice) == DEFAULT_VOICE_ID:
        requested = args.voice.strip().lower()
        if requested not in VOICE_IDS and requested not in REMOVED_VOICE_IDS and requested != DEFAULT_VOICE_ID:
            print(f"Unknown voice {args.voice!r}. Using {DEFAULT_VOICE_ID}. Try --list-voices.", file=sys.stderr)

    route = resolve_route(voice_id, args.model)
    if args.route_only:
        json.dump(route, sys.stdout)
        sys.stdout.write("\n")
        return 0

    if not args.out:
        print("An output path is required. Use --out file.mp3, or --out - for stdout.", file=sys.stderr)
        return 2

    stdin_text = None
    if not args.text and not args.words and not sys.stdin.isatty():
        stdin_text = sys.stdin.read()
    try:
        text = resolve_text(args, stdin_text)
    except ValueError as err:
        print(str(err), file=sys.stderr)
        return 2
    if not text:
        print("Nothing to read. Pass --text, arguments, or pipe text on stdin.", file=sys.stderr)
        return 2
    if len(text) > MAX_CHARS:
        print(f"A spoken piece is too long (max {MAX_CHARS} characters).", file=sys.stderr)
        return 2

    speed = clamp_speed(args.speed)
    timeout = 180 if route["slow"] or route["provider"] == "voicestudio" else 90

    if route["provider"] == "kokoro" and not ping_health(f"{kokoro_base()}/health"):
        print(
            "The Kokoro voice helper is not running. Use `nvr say` so it can be started, or start the reader with nvr.",
            file=sys.stderr,
        )
        return 3
    if route["provider"] == "voicestudio" and not ping_health(f"{voice_studio_base()}/health"):
        print(
            "VoiceStudio is not running. Use `nvr say` so it can be started, or start the reader with nvr.",
            file=sys.stderr,
        )
        return 3

    try:
        audio, mime = speak(route, text, speed, timeout)
        if wants_mp3(args.out) or "mpeg" in mime or "mp3" in mime:
            audio = convert_to_mp3(audio)
        write_output(args.out, audio)
    except Exception as err:
        print(str(err), file=sys.stderr)
        return 1

    if args.out != "-":
        print(f"Wrote {args.out} with {route['label']} ({route['voice_id']}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
