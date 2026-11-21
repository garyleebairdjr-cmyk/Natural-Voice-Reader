#!/usr/bin/env python3
"""Install, verify, and remove Natural Voice Reader voice packs from the catalog."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

PACK_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{1,63}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
HF_REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")


def repo_root() -> Path:
    if os.environ.get("NVR_ROOT"):
        return Path(os.environ["NVR_ROOT"]).expanduser()
    return Path(__file__).resolve().parent.parent


def official_catalog_path() -> Path:
    return repo_root() / "voices" / "catalog.json"


def overlay_dir() -> Path:
    if os.environ.get("NVR_VOICES_D"):
        return Path(os.environ["NVR_VOICES_D"]).expanduser()
    if os.name == "nt":
        base = os.environ.get("APPDATA") or os.environ.get("LOCALAPPDATA") or str(Path.home())
        return Path(base) / "nvr" / "voices.d"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "nvr" / "voices.d"


def state_path() -> Path:
    if os.environ.get("NVR_VOICE_STATE"):
        return Path(os.environ["NVR_VOICE_STATE"]).expanduser()
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("USERPROFILE") or str(Path.home())
        return Path(base) / "nvr" / "voice-packs.json"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "nvr" / "voice-packs.json"


def status_path(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit)
    if os.environ.get("NVR_VOICE_STATUS"):
        return Path(os.environ["NVR_VOICE_STATUS"]).expanduser()
    if os.environ.get("NVR_STATUS_FILE"):
        return Path(os.environ["NVR_STATUS_FILE"]).with_name("voice-pack-status.json")
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("USERPROFILE") or str(Path.home())
        return Path(base) / "nvr" / "voice-pack-status.json"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "nvr" / "voice-pack-status.json"


def sherpa_cache() -> Path:
    if os.environ.get("NVR_SHERPA_CACHE"):
        return Path(os.environ["NVR_SHERPA_CACHE"]).expanduser()
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("USERPROFILE") or str(Path.home())
        return Path(base) / "nvr" / "sherpa"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "nvr" / "sherpa"


def hf_hub_dir() -> Path:
    if os.environ.get("HUGGINGFACE_HUB_CACHE"):
        return Path(os.environ["HUGGINGFACE_HUB_CACHE"]).expanduser()
    if os.environ.get("HF_HOME"):
        return Path(os.environ["HF_HOME"]).expanduser() / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def write_status(path: Path, **payload: object) -> None:
    write_json(path, payload)


def read_state() -> dict[str, Any]:
    path = state_path()
    if not path.is_file():
        return {"version": 1, "installed": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"version": 1, "installed": {}}
    installed = data.get("installed") if isinstance(data, dict) else None
    if not isinstance(installed, dict):
        installed = {}
    clean = {}
    for key, value in installed.items():
        if PACK_ID_RE.match(str(key)) and isinstance(value, dict):
            clean[key] = value
    return {"version": 1, "installed": clean}


def write_state(state: dict[str, Any]) -> None:
    write_json(state_path(), state)


def mark_installed(pack_id: str, revision: str | None = None) -> None:
    state = read_state()
    entry: dict[str, Any] = {"installedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if revision:
        entry["revision"] = revision
    state["installed"][pack_id] = entry
    write_state(state)


def mark_removed(pack_id: str) -> None:
    state = read_state()
    state["installed"].pop(pack_id, None)
    write_state(state)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def official_ids(official: list[dict[str, Any]]) -> set[str]:
    return {str(p.get("id")) for p in official if isinstance(p, dict) and PACK_ID_RE.match(str(p.get("id") or ""))}


def iter_overlay_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted(p for p in directory.iterdir() if p.suffix == ".json")


def load_catalog() -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    official_path = official_catalog_path()
    if not official_path.is_file():
        raise SystemExit(f"Official catalog is missing: {official_path}")
    official_doc = load_json(official_path)
    official = list(official_doc.get("packs") or [])
    packs: list[dict[str, Any]] = list(official)
    reserved = official_ids(official)
    seen = set(reserved)
    for file in iter_overlay_files(overlay_dir()):
        try:
            doc = load_json(file)
        except (OSError, json.JSONDecodeError) as err:
            warnings.append(f"Skipping {file}: {err}")
            continue
        for pack in doc.get("packs") or []:
            if not isinstance(pack, dict):
                continue
            pack_id = str(pack.get("id") or "")
            if not PACK_ID_RE.match(pack_id):
                warnings.append(f"Skipping invalid pack id in {file}.")
                continue
            if pack_id in reserved:
                warnings.append(f"Ignoring overlay pack '{pack_id}' from {file}: that id is reserved.")
                continue
            if pack_id in seen:
                warnings.append(f"Ignoring duplicate overlay pack '{pack_id}' from {file}.")
                continue
            seen.add(pack_id)
            pack = dict(pack)
            pack["_overlay"] = str(file)
            packs.append(pack)
    return packs, warnings


def get_pack(pack_id: str) -> dict[str, Any]:
    if not PACK_ID_RE.match(pack_id):
        raise SystemExit(f"Refused pack id '{pack_id}'.")
    packs, _warnings = load_catalog()
    for pack in packs:
        if pack.get("id") == pack_id:
            return pack
    raise SystemExit(f"Unknown voice pack '{pack_id}'. Use an id from the catalog or a valid overlay.")


def format_size(num: int | float) -> str:
    n = float(num)
    if n >= 1024**3:
        return f"{n / 1024**3:.1f} GB"
    if n >= 1024**2:
        return f"{round(n / 1024**2)} MB"
    if n >= 1024:
        return f"{round(n / 1024)} KB"
    return f"{int(n)} B"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_files(root: Path, files: list[dict[str, Any]], label: str) -> None:
    for item in files:
        name = item.get("name")
        if not isinstance(name, str) or "/" in name or "\\" in name or ".." in name:
            raise RuntimeError(f"{label} lists an unsafe file name.")
        target = root / name
        if not target.is_file():
            raise RuntimeError(f"{label} is missing {name}.")
        expected = item.get("sha256")
        if isinstance(expected, str) and SHA256_RE.match(expected):
            actual = sha256_file(target)
            if actual != expected:
                raise RuntimeError(f"Checksum failed for {name} in {label}.")


def hf_snapshot(repo: str, revision: str | None) -> Path | None:
    slug = "models--" + repo.replace("/", "--")
    base = hf_hub_dir() / slug
    if revision:
        snap = base / "snapshots" / revision
        if snap.is_dir():
            return snap
    refs = base / "refs" / "main"
    if refs.is_file():
        sha = refs.read_text(encoding="utf-8").strip()
        snap = base / "snapshots" / sha
        if snap.is_dir():
            return snap
    snaps = base / "snapshots"
    if snaps.is_dir():
        kids = [p for p in snaps.iterdir() if p.is_dir()]
        if kids:
            return kids[0]
    return None


def pack_present(pack: dict[str, Any]) -> bool:
    source = pack.get("source") or {}
    kind = source.get("kind")
    files = source.get("files") or []
    if kind == "tarball":
        root = sherpa_cache() / str(source.get("dirName") or "")
        if not files:
            return (root / "model.int8.onnx").is_file()
        return all((root / f["name"]).is_file() for f in files if isinstance(f, dict) and "name" in f)
    if kind == "huggingface":
        repo = source.get("repo")
        if not isinstance(repo, str):
            return False
        snap = hf_snapshot(repo, source.get("revision") if isinstance(source.get("revision"), str) else None)
        if snap is None:
            return False
        if not files:
            return True
        return all((snap / f["name"]).is_file() for f in files if isinstance(f, dict) and "name" in f)
    return False


def pack_installed(pack: dict[str, Any]) -> bool:
    if pack["id"] in read_state()["installed"]:
        return True
    return pack_present(pack)


def sync_detected() -> None:
    packs, _ = load_catalog()
    for pack in packs:
        if pack_present(pack) and pack["id"] not in read_state()["installed"]:
            revision = None
            source = pack.get("source") or {}
            if source.get("kind") == "huggingface" and isinstance(source.get("revision"), str):
                revision = source["revision"]
            mark_installed(pack["id"], revision)


def cmd_list(as_json: bool) -> int:
    packs, warnings = load_catalog()
    sync_detected()
    rows = []
    for pack in packs:
        installed = pack_installed(pack)
        rows.append(
            {
                "id": pack.get("id"),
                "name": pack.get("name"),
                "engine": pack.get("engine"),
                "license": pack.get("license"),
                "commercialUse": pack.get("commercialUse"),
                "installByDefault": pack.get("installByDefault"),
                "sizeBytes": pack.get("sizeBytes"),
                "installed": installed,
                "voices": [v.get("id") for v in pack.get("voices") or [] if isinstance(v, dict)],
            }
        )
    if as_json:
        print(json.dumps({"packs": rows, "warnings": warnings}, indent=2))
        return 0
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    if not rows:
        print("No voice packs found.")
        return 0
    width = max(len(str(r["id"])) for r in rows)
    for row in rows:
        flag = "installed" if row["installed"] else "not installed"
        extra = []
        if row.get("installByDefault"):
            extra.append("default")
        if row.get("commercialUse") is False:
            extra.append("non-commercial")
        size = format_size(row["sizeBytes"] or 0)
        suffix = f"  ({', '.join(extra)})" if extra else ""
        print(f"{row['id']:<{width}}  {row['name']}  {size}  {row['license']}  {flag}{suffix}")
    return 0


def download_tarball(pack: dict[str, Any], status: Path) -> Path:
    source = pack["source"]
    url = source["url"]
    dir_name = source["dirName"]
    if not isinstance(url, str) or not url.startswith("https://"):
        raise RuntimeError("Tarball URL must be https.")
    if not isinstance(dir_name, str) or "/" in dir_name or "\\" in dir_name or ".." in dir_name:
        raise RuntimeError("Unsafe tarball directory name.")
    dest_dir = sherpa_cache()
    dest_dir.mkdir(parents=True, exist_ok=True)
    label = pack.get("name") or pack["id"]
    write_status(status, state="downloading", packId=pack["id"], percent=0, message=f"Downloading {label}. You can keep using the reader.")

    def hook(block: int, block_size: int, total: int) -> None:
        got = block * block_size
        percent = int(got * 100 / total) if total else None
        write_status(
            status,
            state="downloading",
            packId=pack["id"],
            percent=percent,
            downloadedBytes=min(got, total or got),
            totalBytes=total,
            message=f"Downloading {label}. You can keep using the reader.",
        )

    with tempfile.TemporaryDirectory(prefix="nvr-pack-") as tmp:
        archive = Path(tmp) / Path(url).name
        urllib.request.urlretrieve(url, archive, hook)
        write_status(status, state="verifying", packId=pack["id"], percent=95, message=f"Unpacking {label}...")
        with tarfile.open(archive) as tf:
            # Python 3.12+ supports filter=; fall back on older runtimes.
            try:
                tf.extractall(dest_dir, filter="data")
            except TypeError:
                tf.extractall(dest_dir)
    root = dest_dir / dir_name
    verify_files(root, source.get("files") or [], label)
    return root


def download_huggingface(pack: dict[str, Any], status: Path) -> Path:
    try:
        from huggingface_hub import hf_hub_download, snapshot_download
        from huggingface_hub.utils import tqdm as hf_tqdm
    except ImportError as err:
        raise RuntimeError(
            "huggingface_hub is not installed. Use VoiceStudio's virtualenv or: uv pip install huggingface_hub"
        ) from err

    source = pack["source"]
    repo = source["repo"]
    if not isinstance(repo, str) or not HF_REPO_RE.match(repo):
        raise RuntimeError("Invalid Hugging Face repo id.")
    revision = source.get("revision") if isinstance(source.get("revision"), str) else None
    files = source.get("files") or []
    label = pack.get("name") or pack["id"]
    write_status(status, state="downloading", packId=pack["id"], percent=0, message=f"Downloading {label}. You can keep using the reader.")

    class StatusTqdm(hf_tqdm):  # type: ignore[misc]
        def display(self, msg=None, pos=None):  # noqa: ANN001
            result = super().display(msg=msg, pos=pos)
            total = getattr(self, "total", None)
            n = getattr(self, "n", 0)
            percent = int(n * 100 / total) if total else None
            write_status(
                status,
                state="downloading",
                packId=pack["id"],
                repo=repo,
                percent=percent,
                downloadedBytes=n,
                totalBytes=total,
                message=f"Downloading {label}. You can keep using the reader.",
            )
            return result

    if files:
        last = None
        for item in files:
            name = item["name"]
            last = Path(
                hf_hub_download(
                    repo_id=repo,
                    filename=name,
                    revision=revision,
                    tqdm_class=StatusTqdm,
                )
            )
        assert last is not None
        root = last.parent
        verify_files(root, files, label)
        return root
    snapshot_download(repo_id=repo, revision=revision, tqdm_class=StatusTqdm)
    snap = hf_snapshot(repo, revision)
    if snap is None:
        raise RuntimeError(f"{label} downloaded but the snapshot was not found.")
    return snap


def cmd_install(pack_id: str, status_file: str | None) -> int:
    pack = prepare_pack(pack_id)
    status = status_path(status_file)
    label = pack.get("name") or pack_id
    if pack_present(pack):
        mark_installed(pack_id, (pack.get("source") or {}).get("revision") if isinstance((pack.get("source") or {}).get("revision"), str) else None)
        write_status(status, state="ready", packId=pack_id, percent=100, message=f"{label} is already installed.")
        print(f"{label} is already installed.")
        return 0
    try:
        source = pack.get("source") or {}
        if source.get("kind") == "tarball":
            download_tarball(pack, status)
        elif source.get("kind") == "huggingface":
            download_huggingface(pack, status)
        else:
            raise RuntimeError(f"Unsupported source kind: {source.get('kind')}")
    except Exception as err:
        write_status(status, state="error", packId=pack_id, message=f"Could not install {label}: {err}")
        print(f"Could not install {label}: {err}", file=sys.stderr)
        return 1
    mark_installed(pack_id, source.get("revision") if isinstance(source.get("revision"), str) else None)
    write_status(status, state="ready", packId=pack_id, percent=100, message=f"{label} is installed.")
    print(f"{label} is installed.")
    return 0


def remove_huggingface(repo: str) -> None:
    if not HF_REPO_RE.match(repo):
        raise RuntimeError("Invalid Hugging Face repo id.")
    slug = "models--" + repo.replace("/", "--")
    root = hf_hub_dir() / slug
    if root.is_dir():
        shutil.rmtree(root)


def cmd_remove(pack_id: str, status_file: str | None) -> int:
    pack = get_pack(pack_id)
    status = status_path(status_file)
    label = pack.get("name") or pack_id
    write_status(status, state="removing", packId=pack_id, percent=None, message=f"Removing {label}...")
    source = pack.get("source") or {}
    try:
        if source.get("kind") == "tarball":
            dir_name = source.get("dirName")
            if not isinstance(dir_name, str) or "/" in dir_name or ".." in dir_name:
                raise RuntimeError("Unsafe tarball directory name.")
            root = sherpa_cache() / dir_name
            if root.is_dir():
                shutil.rmtree(root)
        elif source.get("kind") == "huggingface":
            repo = source.get("repo")
            if not isinstance(repo, str):
                raise RuntimeError("Missing Hugging Face repo id.")
            remove_huggingface(repo)
        else:
            raise RuntimeError(f"Unsupported source kind: {source.get('kind')}")
    except Exception as err:
        write_status(status, state="error", packId=pack_id, message=f"Could not remove {label}: {err}")
        print(f"Could not remove {label}: {err}", file=sys.stderr)
        return 1
    mark_removed(pack_id)
    write_status(status, state="ready", packId=pack_id, percent=100, message=f"{label} was removed.")
    print(f"{label} was removed.")
    return 0



DEFAULT_COMMUNITY_INDEX = (
    "https://raw.githubusercontent.com/garyleebairdjr-cmyk/Natural-Voice-Reader/main/voices/community-catalog.json"
)
DEFAULT_CATALOG_HOSTS = (
    "huggingface.co",
    "github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "media.githubusercontent.com",
    "codeload.github.com",
)
COMMUNITY_INDEX_MAX_BYTES = 1_048_576


def catalog_allow_local() -> bool:
    return os.environ.get("NVR_CATALOG_ALLOW_LOCAL", "").strip().lower() in {"1", "true", "yes"}


def default_community_index() -> str:
    return os.environ.get("NVR_COMMUNITY_INDEX", "").strip() or DEFAULT_COMMUNITY_INDEX


def catalog_indexes_path() -> Path:
    if os.environ.get("NVR_CATALOG_INDEXES"):
        return Path(os.environ["NVR_CATALOG_INDEXES"]).expanduser()
    if os.name == "nt":
        base = os.environ.get("APPDATA") or os.environ.get("LOCALAPPDATA") or str(Path.home())
        return Path(base) / "nvr" / "catalog-indexes.json"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "nvr" / "catalog-indexes.json"


def _host_allowed(host: str, hosts: tuple[str, ...] = DEFAULT_CATALOG_HOSTS) -> bool:
    name = host.lower()
    return any(name == allowed or name.endswith("." + allowed) for allowed in hosts)


def _is_private_host(host: str) -> bool:
    name = host.lower()
    if name in {"localhost", "127.0.0.1", "::1", "0.0.0.0"} or name.endswith(".localhost"):
        return True
    if re.match(r"^10\.", name) or re.match(r"^192\.168\.", name) or re.match(r"^172\.(1[6-9]|2\d|3[0-1])\.", name):
        return True
    return name.endswith(".internal") or name.endswith(".local")


def is_allowed_catalog_url(raw: str, allow_local: bool | None = None) -> bool:
    if allow_local is None:
        allow_local = catalog_allow_local()
    if allow_local and raw.startswith("/") and "://" not in raw:
        return True
    try:
        parsed = urllib.parse.urlparse(raw)
    except ValueError:
        return False
    if parsed.username or parsed.password:
        return False
    if parsed.scheme == "file":
        return allow_local
    if parsed.scheme in {"http", "https"}:
        host = parsed.hostname or ""
        if _is_private_host(host):
            return allow_local
        if parsed.scheme != "https":
            return False
        return _host_allowed(host)
    return False


def read_catalog_index_urls() -> list[str]:
    fallback = default_community_index()
    path = catalog_indexes_path()
    extra: list[str] = []
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            urls = data.get("urls") if isinstance(data, dict) else []
            if isinstance(urls, list):
                extra = [str(url).strip() for url in urls if str(url).strip() and str(url).strip() != fallback]
        except (OSError, json.JSONDecodeError):
            extra = []
    return [fallback, *extra]


def _read_limited(url: str) -> bytes:
    if not is_allowed_catalog_url(url):
        raise RuntimeError("Refused a catalog URL that is not https on an allowed host.")
    if catalog_allow_local() and url.startswith("/") and "://" not in url:
        data = Path(url).read_bytes()
        if len(data) > COMMUNITY_INDEX_MAX_BYTES:
            raise RuntimeError("That catalog index is larger than the 1 MB limit.")
        return data
    if catalog_allow_local() and url.startswith("file:"):
        data = Path(urllib.parse.urlparse(url).path).read_bytes()
        if len(data) > COMMUNITY_INDEX_MAX_BYTES:
            raise RuntimeError("That catalog index is larger than the 1 MB limit.")
        return data
    request = urllib.request.Request(url, headers={"User-Agent": "Natural-Voice-Reader", "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        final = str(response.geturl() or url)
        if not is_allowed_catalog_url(final):
            raise RuntimeError("The catalog index redirected to a host that is not allowed.")
        length = response.headers.get("Content-Length")
        if length and int(length) > COMMUNITY_INDEX_MAX_BYTES:
            raise RuntimeError("That catalog index is larger than the 1 MB limit.")
        data = response.read(COMMUNITY_INDEX_MAX_BYTES + 1)
        if len(data) > COMMUNITY_INDEX_MAX_BYTES:
            raise RuntimeError("That catalog index is larger than the 1 MB limit.")
        return data


def _community_pack_ok(pack: dict[str, Any]) -> bool:
    if not isinstance(pack, dict) or not PACK_ID_RE.match(str(pack.get("id") or "")):
        return False
    source = pack.get("source") or {}
    if not isinstance(source, dict):
        return False
    files = source.get("files") or []
    if not isinstance(files, list) or not files:
        return False
    if not all(isinstance(item, dict) and SHA256_RE.match(str(item.get("sha256") or "")) for item in files):
        return False
    if source.get("kind") == "tarball":
        return isinstance(source.get("url"), str) and is_allowed_catalog_url(str(source.get("url")))
    if source.get("kind") == "huggingface":
        return isinstance(source.get("repo"), str) and HF_REPO_RE.match(str(source.get("repo")))
    return False


def load_community_packs() -> tuple[list[dict[str, Any]], list[str]]:
    official, _ = load_catalog()
    reserved = official_ids(official)
    packs: list[dict[str, Any]] = []
    warnings: list[str] = []
    seen: set[str] = set()
    for url in read_catalog_index_urls():
        try:
            doc = json.loads(_read_limited(url).decode("utf-8"))
        except Exception as err:
            warnings.append(f"{url}: {err}")
            continue
        if not isinstance(doc, dict) or doc.get("version") != 1 or not isinstance(doc.get("packs"), list):
            warnings.append(f"{url}: catalog version must be 1 with a packs array.")
            continue
        for pack in doc.get("packs") or []:
            if not _community_pack_ok(pack if isinstance(pack, dict) else {}):
                warnings.append(f"{url}: skipped a pack that failed community validation.")
                continue
            pack_id = str(pack["id"])
            if pack_id in reserved:
                warnings.append(f"{url}: ignored reserved official id '{pack_id}'.")
                continue
            if pack_id in seen:
                continue
            seen.add(pack_id)
            item = dict(pack)
            item["_index"] = url
            packs.append(item)
    return packs, warnings


def write_community_overlay(pack: dict[str, Any]) -> Path:
    directory = overlay_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"community-{pack['id']}.json"
    payload = {
        "version": 1,
        "packs": [
            {
                "id": pack["id"],
                "name": pack.get("name"),
                "description": pack.get("description"),
                "engine": pack.get("engine"),
                "installByDefault": False,
                "commercialUse": pack.get("commercialUse"),
                "license": pack.get("license"),
                "licenseNote": pack.get("licenseNote"),
                "sizeBytes": pack.get("sizeBytes"),
                "source": pack.get("source"),
                "voices": pack.get("voices") or [],
                "community": True,
            }
        ],
    }
    write_json(path, payload)
    return path


def _matches_query(pack: dict[str, Any], query: str) -> bool:
    if not query:
        return True
    hay = " ".join(
        [
            str(pack.get("id") or ""),
            str(pack.get("name") or ""),
            str(pack.get("description") or ""),
            str(pack.get("engine") or ""),
            str(pack.get("license") or ""),
            " ".join(
                str(voice.get(key) or "")
                for voice in pack.get("voices") or []
                if isinstance(voice, dict)
                for key in ("id", "name", "language", "accent", "note", "gender")
            ),
        ]
    ).lower()
    return query in hay


def cmd_browse(query: str, as_json: bool) -> int:
    packs, warnings = load_community_packs()
    local, _ = load_catalog()
    local_ids = {str(pack.get("id")) for pack in local}
    query = (query or "").strip().lower()
    matched = [pack for pack in packs if _matches_query(pack, query)]
    if as_json:
        print(json.dumps({"packs": matched, "warnings": warnings}, indent=2))
        return 0
    if warnings:
        for warning in warnings:
            print(warning, file=sys.stderr)
    if not matched:
        print("No community packs matched." if query else "No community packs were listed.")
        return 0
    for pack in matched:
        pack_id = str(pack.get("id"))
        size = format_size(pack.get("sizeBytes") or 0)
        license_id = pack.get("license") or "unknown"
        flag = "installed" if pack_id in local_ids and pack_present(pack) else ("in library" if pack_id in local_ids else "available")
        commercial = "" if pack.get("commercialUse") else "  (non-commercial)"
        print(f"{pack_id:24}  {pack.get('name')}  {size}  {license_id}  {flag}{commercial}")
    print("Install with: nvr voices install <id>")
    return 0


def prepare_pack(pack_id: str) -> dict[str, Any]:
    if not PACK_ID_RE.match(pack_id):
        raise SystemExit(f"Refused pack id '{pack_id}'.")
    packs, _warnings = load_catalog()
    for pack in packs:
        if pack.get("id") == pack_id:
            return pack
    community, warnings = load_community_packs()
    for pack in community:
        if pack.get("id") == pack_id:
            write_community_overlay(pack)
            return get_pack(pack_id)
    extra = f" ({'; '.join(warnings)})" if warnings else ""
    raise SystemExit(f"Unknown voice pack '{pack_id}'. Use an id from the catalog, an overlay, or nvr voices browse.{extra}")


def cmd_check(pack_id: str) -> int:
    pack = get_pack(pack_id)
    if pack_present(pack):
        print(f"{pack.get('name') or pack_id} is installed.")
        return 0
    print(f"{pack.get('name') or pack_id} is not installed.")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage Natural Voice Reader voice packs.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    list_p = sub.add_parser("list", help="List catalog packs and install state.")
    list_p.add_argument("--json", action="store_true")
    inst = sub.add_parser("install", help="Download and verify a pack from the catalog.")
    inst.add_argument("id")
    inst.add_argument("--status-file")
    rem = sub.add_parser("remove", help="Delete an installed pack to free disk space.")
    rem.add_argument("id")
    rem.add_argument("--status-file")
    chk = sub.add_parser("check", help="Exit 0 if a pack is present on disk.")
    chk.add_argument("id")
    brw = sub.add_parser("browse", help="Search the community catalog index.")
    brw.add_argument("query", nargs="?", default="")
    brw.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.cmd == "list":
        return cmd_list(args.json)
    if args.cmd == "install":
        return cmd_install(args.id, args.status_file)
    if args.cmd == "remove":
        return cmd_remove(args.id, args.status_file)
    if args.cmd == "check":
        return cmd_check(args.id)
    if args.cmd == "browse":
        return cmd_browse(args.query, args.json)
    return 2


if __name__ == "__main__":
    sys.exit(main())
