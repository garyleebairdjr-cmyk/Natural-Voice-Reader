#!/usr/bin/env python3
"""Download KittenTTS or OmniVoice weights into a Hugging Face cache, with progress."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

PINS = {
    "kittentts": {
        "kind": "hf",
        "repo": os.environ.get("KITTEN_MODEL", "KittenML/kitten-tts-mini-0.8"),
        "files": ("config.json", "kitten_tts_mini_v0_8.onnx", "voices.npz"),
        "label": "KittenTTS",
    },
    "omnivoice": {
        "kind": "hf",
        "repo": os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice"),
        "files": None,  # snapshot; several GB, CC-BY-NC weights
        "label": "OmniVoice",
    },
    "kokoro": {
        "kind": "tarball",
        "label": "Kokoro",
        "url": os.environ.get(
            "KOKORO_MODEL_URL",
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2",
        ),
        "dirname": "kokoro-int8-multi-lang-v1_0",
        "check_file": "model.int8.onnx",
    },
}


def status_path(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit)
    if os.environ.get("NVR_STATUS_FILE"):
        return Path(os.environ["NVR_STATUS_FILE"])
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("USERPROFILE") or str(Path.home())
        return Path(base) / "nvr" / "status.json"
    return Path.home() / ".cache" / "nvr" / "status.json"


def write_status(path: Path, **payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)



def sherpa_cache() -> Path:
    if os.environ.get("NVR_SHERPA_CACHE"):
        return Path(os.environ["NVR_SHERPA_CACHE"]).expanduser()
    return Path.home() / ".cache" / "nvr" / "sherpa"


def kokoro_ready(spec: dict) -> bool:
    root = sherpa_cache() / spec["dirname"]
    return (root / spec["check_file"]).is_file()


def download_tarball(spec: dict, status: Path, label: str) -> None:
    import tarfile
    import urllib.request

    dest_dir = sherpa_cache()
    dest_dir.mkdir(parents=True, exist_ok=True)
    archive = dest_dir / Path(spec["url"]).name
    write_status(status, state="downloading", model="kokoro", percent=0, message=f"Downloading {label}. You can keep using the reader.")

    def hook(block, block_size, total):
        got = block * block_size
        percent = int(got * 100 / total) if total else None
        write_status(
            status,
            state="downloading",
            model="kokoro",
            percent=percent,
            downloadedBytes=min(got, total or got),
            totalBytes=total,
            message=f"Downloading {label} voice model. You can keep using the reader.",
        )

    urllib.request.urlretrieve(spec["url"], archive, hook)
    write_status(status, state="downloading", model="kokoro", percent=95, message=f"Unpacking {label}...")
    with tarfile.open(archive) as tf:
        tf.extractall(dest_dir)
    archive.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Download Natural Voice Reader TTS weights.")
    parser.add_argument("--model", choices=sorted(PINS), default="kittentts")
    parser.add_argument("--cache-dir", default=os.environ.get("HF_HOME") or os.environ.get("HUGGINGFACE_HUB_CACHE"))
    parser.add_argument("--status-file", default=None)
    parser.add_argument("--check", action="store_true", help="Exit 0 if the model is already cached.")
    args = parser.parse_args()

    spec = PINS[args.model]
    repo = spec.get("repo") or spec.get("url") or args.model
    label = spec["label"]
    status = status_path(args.status_file)
    cache_dir = args.cache_dir

    if spec.get("kind") == "tarball":
        if args.check:
            if kokoro_ready(spec):
                print(f"{label} is already in the cache.")
                return 0
            print(f"{label} is not in the cache.")
            return 1
        try:
            if kokoro_ready(spec):
                write_status(status, state="ready", model=args.model, percent=100, message=f"{label} voice model is ready.")
                print(f"{label} is already in the cache.")
                return 0
            download_tarball(spec, status, label)
        except Exception as err:
            write_status(status, state="error", model=args.model, message=f"Could not download {label}: {err}")
            raise
        if not kokoro_ready(spec):
            write_status(status, state="error", model=args.model, message=f"{label} unpacked without the expected model file.")
            print(f"{label} did not unpack correctly.", file=sys.stderr)
            return 1
        write_status(status, state="ready", model=args.model, percent=100, message=f"{label} voice model is ready.")
        print(f"{label} is ready.")
        return 0

    try:
        from huggingface_hub import hf_hub_download, snapshot_download
        from huggingface_hub.utils import tqdm as hf_tqdm
    except ImportError:
        print(
            "huggingface_hub is not installed. Use VoiceStudio's virtualenv or: uv pip install huggingface_hub",
            file=sys.stderr,
        )
        return 2

    class StatusTqdm(hf_tqdm):  # type: ignore[misc]
        def display(self, msg=None, pos=None):  # noqa: ANN001
            result = super().display(msg=msg, pos=pos)
            total = getattr(self, "total", None)
            n = getattr(self, "n", 0)
            percent = int(n * 100 / total) if total else None
            write_status(
                status,
                state="downloading",
                model=args.model,
                repo=repo,
                percent=percent,
                downloadedBytes=n,
                totalBytes=total,
                message=f"Downloading {label} voice model. You can keep using the reader.",
            )
            return result

    if args.check:
        try:
            if spec["files"]:
                for name in spec["files"]:
                    hf_hub_download(repo_id=repo, filename=name, cache_dir=cache_dir, local_files_only=True)
            else:
                snapshot_download(repo_id=repo, cache_dir=cache_dir, local_files_only=True)
            print(f"{label} is already in the cache.")
            return 0
        except Exception:
            print(f"{label} is not in the cache.")
            return 1

    write_status(
        status,
        state="downloading",
        model=args.model,
        repo=repo,
        percent=0,
        message=f"Downloading {label} voice model. You can keep using the reader.",
    )
    try:
        try:
            if spec["files"]:
                for name in spec["files"]:
                    hf_hub_download(
                        repo_id=repo,
                        filename=name,
                        cache_dir=cache_dir,
                        tqdm_class=StatusTqdm,
                    )
            else:
                snapshot_download(repo_id=repo, cache_dir=cache_dir, tqdm_class=StatusTqdm)
        except TypeError:
            if spec["files"]:
                for name in spec["files"]:
                    hf_hub_download(repo_id=repo, filename=name, cache_dir=cache_dir)
            else:
                snapshot_download(repo_id=repo, cache_dir=cache_dir)
    except Exception as err:
        write_status(
            status,
            state="error",
            model=args.model,
            repo=repo,
            message=f"Could not download {label}: {err}",
        )
        raise

    write_status(
        status,
        state="ready",
        model=args.model,
        repo=repo,
        percent=100,
        message=f"{label} voice model is ready.",
    )
    print(f"{label} is ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
