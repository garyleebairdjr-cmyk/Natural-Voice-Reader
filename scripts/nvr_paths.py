"""Canonical per-user data paths for Natural Voice Reader.

Voice packs and model downloads live in the XDG data directory (or the
platform equivalent), not the cache. Hugging Face and sherpa downloads for
our packs use a private tree under that directory. This module also moves
files out of the legacy cache locations once.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path
from typing import Iterable, Mapping

Env = Mapping[str, str]

OFFICIAL_HF_REPOS = (
    "KittenML/kitten-tts-mini-0.8",
    "k2-fsa/OmniVoice",
)

_migrated = False


def _env(environ: Env | None = None) -> Env:
    return environ if environ is not None else os.environ


def _home(home: str | Path | None = None, environ: Env | None = None) -> Path:
    if home is not None:
        return Path(home)
    env = _env(environ)
    explicit = env.get("HOME") or env.get("USERPROFILE")
    if explicit:
        return Path(explicit)
    return Path.home()


def _platform(platform: str | None = None) -> str:
    if platform:
        return platform
    if sys.platform == "darwin":
        return "darwin"
    if sys.platform.startswith("win"):
        return "win32"
    return "linux"


def data_dir(
    environ: Env | None = None,
    home: str | Path | None = None,
    platform: str | None = None,
) -> Path:
    env = _env(environ)
    if env.get("NVR_DATA_HOME"):
        return Path(env["NVR_DATA_HOME"]).expanduser()
    plat = _platform(platform)
    home_p = _home(home, env)
    if plat == "win32":
        base = env.get("LOCALAPPDATA") or env.get("USERPROFILE") or str(home_p)
        return Path(base) / "nvr"
    if plat == "darwin":
        return home_p / "Library" / "Application Support" / "nvr"
    xdg = env.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg).expanduser() / "nvr"
    return home_p / ".local" / "share" / "nvr"


def sherpa_cache(
    environ: Env | None = None,
    home: str | Path | None = None,
    platform: str | None = None,
) -> Path:
    env = _env(environ)
    if env.get("NVR_SHERPA_CACHE"):
        return Path(env["NVR_SHERPA_CACHE"]).expanduser()
    return data_dir(env, home, platform) / "sherpa"


def hf_home(
    environ: Env | None = None,
    home: str | Path | None = None,
    platform: str | None = None,
) -> Path:
    env = _env(environ)
    if env.get("NVR_HF_HOME"):
        return Path(env["NVR_HF_HOME"]).expanduser()
    return data_dir(env, home, platform) / "huggingface"


def hf_hub_dir(
    environ: Env | None = None,
    home: str | Path | None = None,
    platform: str | None = None,
) -> Path:
    env = _env(environ)
    if env.get("NVR_HF_HUB"):
        return Path(env["NVR_HF_HUB"]).expanduser()
    return hf_home(env, home, platform) / "hub"


def state_path(
    environ: Env | None = None,
    home: str | Path | None = None,
    platform: str | None = None,
) -> Path:
    env = _env(environ)
    if env.get("NVR_VOICE_STATE"):
        return Path(env["NVR_VOICE_STATE"]).expanduser()
    return data_dir(env, home, platform) / "voice-packs.json"


def status_path(
    explicit: str | None = None,
    environ: Env | None = None,
    home: str | Path | None = None,
    platform: str | None = None,
) -> Path:
    if explicit:
        return Path(explicit)
    env = _env(environ)
    if env.get("NVR_VOICE_STATUS"):
        return Path(env["NVR_VOICE_STATUS"]).expanduser()
    if env.get("NVR_STATUS_FILE"):
        return Path(env["NVR_STATUS_FILE"]).expanduser().with_name("voice-pack-status.json")
    return data_dir(env, home, platform) / "voice-pack-status.json"


def bootstrap_status_path(
    environ: Env | None = None,
    home: str | Path | None = None,
    platform: str | None = None,
) -> Path:
    env = _env(environ)
    if env.get("NVR_STATUS_FILE"):
        return Path(env["NVR_STATUS_FILE"]).expanduser()
    return data_dir(env, home, platform) / "status.json"


def kokoro_model_dir(
    environ: Env | None = None,
    home: str | Path | None = None,
    platform: str | None = None,
) -> Path:
    env = _env(environ)
    if env.get("NVR_KOKORO_MODEL_DIR"):
        return Path(env["NVR_KOKORO_MODEL_DIR"]).expanduser()
    name = env.get("KOKORO_MODEL_DIR_NAME") or "kokoro-int8-multi-lang-v1_0"
    return sherpa_cache(env, home, platform) / name


def legacy_nvr_cache_dirs(
    environ: Env | None = None,
    home: str | Path | None = None,
    platform: str | None = None,
) -> list[Path]:
    env = _env(environ)
    home_p = _home(home, env)
    plat = _platform(platform)
    if plat == "win32":
        return []
    found: list[Path] = []
    if env.get("XDG_CACHE_HOME"):
        found.append(Path(env["XDG_CACHE_HOME"]).expanduser() / "nvr")
    default = home_p / ".cache" / "nvr"
    if default not in found:
        found.append(default)
    return found


def legacy_hf_hub_dirs(
    environ: Env | None = None,
    home: str | Path | None = None,
    platform: str | None = None,
) -> list[Path]:
    env = _env(environ)
    home_p = _home(home, env)
    found: list[Path] = []
    if env.get("XDG_CACHE_HOME"):
        found.append(Path(env["XDG_CACHE_HOME"]).expanduser() / "huggingface" / "hub")
    default = home_p / ".cache" / "huggingface" / "hub"
    if default not in found:
        found.append(default)
    return found


def hf_repo_slug(repo: str) -> str:
    return "models--" + repo.replace("/", "--")


def _read_json(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _repos_from_catalog(payload: object) -> set[str]:
    repos: set[str] = set()
    if not isinstance(payload, dict):
        return repos
    packs = payload.get("packs")
    if not isinstance(packs, list):
        return repos
    for pack in packs:
        if not isinstance(pack, dict):
            continue
        source = pack.get("source")
        if not isinstance(source, dict):
            continue
        if source.get("kind") != "huggingface":
            continue
        repo = source.get("repo")
        if isinstance(repo, str) and "/" in repo and ".." not in repo:
            repos.add(repo)
    return repos


def _repos_from_state(payload: object) -> set[str]:
    repos: set[str] = set()
    if not isinstance(payload, dict):
        return repos
    installed = payload.get("installed")
    if not isinstance(installed, dict):
        return repos
    for item in installed.values():
        if not isinstance(item, dict):
            continue
        repo = item.get("repo")
        if isinstance(repo, str) and "/" in repo and ".." not in repo:
            repos.add(repo)
    return repos


def huggingface_repos_to_migrate(
    environ: Env | None = None,
    home: str | Path | None = None,
    platform: str | None = None,
    repo_root: Path | None = None,
) -> set[str]:
    env = _env(environ)
    repos = set(OFFICIAL_HF_REPOS)
    root = repo_root
    if root is None:
        root_env = env.get("NVR_ROOT")
        root = Path(root_env) if root_env else Path(__file__).resolve().parent.parent
    catalog = root / "voices" / "catalog.json"
    payload = _read_json(catalog)
    if payload is not None:
        repos |= _repos_from_catalog(payload)
    for path in (state_path(env, home, platform),):
        payload = _read_json(path)
        if payload is not None:
            repos |= _repos_from_state(payload)
    for legacy in legacy_nvr_cache_dirs(env, home, platform):
        payload = _read_json(legacy / "voice-packs.json")
        if payload is not None:
            repos |= _repos_from_state(payload)
    return repos


def _same_path(a: Path, b: Path) -> bool:
    try:
        return a.resolve() == b.resolve()
    except OSError:
        return os.path.normpath(str(a)) == os.path.normpath(str(b))


def _move_path(src: Path, dest: Path, notes: list[str]) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest))
    notes.append(f"moved {src} -> {dest}")


def move_tree(src: Path, dest: Path, notes: list[str]) -> None:
    """Move src to dest. If dest exists, move missing children only; never delete dest."""
    if not src.exists():
        return
    if _same_path(src, dest):
        return
    if not dest.exists():
        _move_path(src, dest, notes)
        return
    if src.is_file() or src.is_symlink():
        notes.append(f"left {src} in place because {dest} already exists")
        return
    if not dest.is_dir():
        notes.append(f"left {src} in place because {dest} already exists")
        return
    for child in list(src.iterdir()):
        move_tree(child, dest / child.name, notes)
    try:
        src.rmdir()
        notes.append(f"removed empty {src}")
    except OSError:
        notes.append(f"left leftover files in {src}")


def apply_process_env(
    environ: dict[str, str] | None = None,
    home: str | Path | None = None,
    platform: str | None = None,
) -> dict[str, str]:
    """Point this process (and children) at the app data tree for HF/sherpa."""
    target = environ if environ is not None else os.environ
    data = data_dir(target, home, platform)
    updates = {
        "NVR_DATA_HOME": str(data),
        "NVR_SHERPA_CACHE": str(sherpa_cache(target, home, platform)),
        "NVR_HF_HOME": str(hf_home(target, home, platform)),
        "HF_HOME": str(hf_home(target, home, platform)),
        "HUGGINGFACE_HUB_CACHE": str(hf_hub_dir(target, home, platform)),
        "NVR_VOICE_STATE": str(state_path(target, home, platform)),
        "NVR_VOICE_STATUS": str(status_path(None, target, home, platform)),
        "NVR_STATUS_FILE": str(bootstrap_status_path(target, home, platform)),
        "NVR_KOKORO_MODEL_DIR": str(kokoro_model_dir(target, home, platform)),
    }
    # Recompute after first writes so overrides already in target are kept.
    if target.get("NVR_DATA_HOME"):
        updates["NVR_DATA_HOME"] = str(Path(target["NVR_DATA_HOME"]).expanduser())
    if target.get("NVR_SHERPA_CACHE"):
        updates["NVR_SHERPA_CACHE"] = str(Path(target["NVR_SHERPA_CACHE"]).expanduser())
        if not target.get("NVR_KOKORO_MODEL_DIR"):
            name = target.get("KOKORO_MODEL_DIR_NAME") or "kokoro-int8-multi-lang-v1_0"
            updates["NVR_KOKORO_MODEL_DIR"] = str(Path(updates["NVR_SHERPA_CACHE"]) / name)
    if target.get("NVR_HF_HOME"):
        updates["NVR_HF_HOME"] = str(Path(target["NVR_HF_HOME"]).expanduser())
        updates["HF_HOME"] = updates["NVR_HF_HOME"]
        if not target.get("NVR_HF_HUB"):
            updates["HUGGINGFACE_HUB_CACHE"] = str(Path(updates["NVR_HF_HOME"]) / "hub")
    if target.get("NVR_HF_HUB"):
        updates["HUGGINGFACE_HUB_CACHE"] = str(Path(target["NVR_HF_HUB"]).expanduser())
    if target.get("NVR_VOICE_STATE"):
        updates["NVR_VOICE_STATE"] = str(Path(target["NVR_VOICE_STATE"]).expanduser())
    if target.get("NVR_VOICE_STATUS"):
        updates["NVR_VOICE_STATUS"] = str(Path(target["NVR_VOICE_STATUS"]).expanduser())
    if target.get("NVR_STATUS_FILE"):
        updates["NVR_STATUS_FILE"] = str(Path(target["NVR_STATUS_FILE"]).expanduser())
        if not target.get("NVR_VOICE_STATUS"):
            updates["NVR_VOICE_STATUS"] = str(Path(updates["NVR_STATUS_FILE"]).with_name("voice-pack-status.json"))
    if target.get("NVR_KOKORO_MODEL_DIR"):
        updates["NVR_KOKORO_MODEL_DIR"] = str(Path(target["NVR_KOKORO_MODEL_DIR"]).expanduser())
    target.update(updates)
    return updates



def repair_hf_repo_refs(hub_dir: Path, notes: list[str]) -> None:
    """If a moved repo has a single snapshot but no refs/main, write one so huggingface_hub can find it."""
    if not hub_dir.is_dir():
        return
    for repo_dir in sorted(hub_dir.glob("models--*")):
        if not repo_dir.is_dir():
            continue
        refs_main = repo_dir / "refs" / "main"
        if refs_main.is_file():
            continue
        snaps = repo_dir / "snapshots"
        if not snaps.is_dir():
            continue
        kids = [child for child in snaps.iterdir() if child.is_dir()]
        if len(kids) != 1:
            continue
        refs_main.parent.mkdir(parents=True, exist_ok=True)
        refs_main.write_text(kids[0].name + "\n", encoding="utf-8")
        notes.append(f"wrote {refs_main} -> {kids[0].name}")


def migrate_legacy_data(
    environ: Env | None = None,
    home: str | Path | None = None,
    platform: str | None = None,
    repo_root: Path | None = None,
    force: bool = False,
) -> list[str]:
    """Move (not copy) legacy cache trees into the data directory. Idempotent."""
    global _migrated
    if _migrated and not force:
        return []
    env = _env(environ)
    notes: list[str] = []
    dest = data_dir(env, home, platform)
    dest.mkdir(parents=True, exist_ok=True)
    for src in legacy_nvr_cache_dirs(env, home, platform):
        if src.exists() and not _same_path(src, dest):
            move_tree(src, dest, notes)
    new_hub = hf_hub_dir(env, home, platform)
    repos = huggingface_repos_to_migrate(env, home, platform, repo_root)
    for old_hub in legacy_hf_hub_dirs(env, home, platform):
        if not old_hub.exists() or _same_path(old_hub, new_hub):
            continue
        for repo in sorted(repos):
            slug = hf_repo_slug(repo)
            src = old_hub / slug
            dst = new_hub / slug
            if src.exists() and not _same_path(src, dst):
                move_tree(src, dst, notes)
    repair_hf_repo_refs(new_hub, notes)
    _migrated = True
    return notes


def reset_migration_flag() -> None:
    global _migrated
    _migrated = False


def main(argv: Iterable[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    cmd = args[0] if args else "data-dir"
    apply_process_env()
    if cmd in ("data-dir", "path"):
        print(data_dir())
        return 0
    if cmd == "migrate":
        notes = migrate_legacy_data(force=True)
        for line in notes:
            print(line)
        return 0
    print(f"Unknown command '{cmd}'. Use data-dir or migrate.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
