#!/usr/bin/env bash
# First-run bootstrap for Linux and macOS.
# VoiceStudio is cloned as a separate pinned dependency (AGPL-3.0) and is not vendored.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/nvr-lib.sh"
nvr_load_pins "${SCRIPT_DIR}"

DRY_RUN=0
WITH_OMNIVOICE=0
for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    --with-omnivoice) WITH_OMNIVOICE=1 ;;
    -h|--help)
      cat << 'HELP'
Usage: install.sh [--dry-run] [--with-omnivoice]

Checks for, and if missing installs, Node.js 22+, uv, Python 3.11,
Natural Voice Reader npm dependencies, and a pinned VoiceStudio checkout.
KittenTTS (the default voice pack) downloads on demand into the per-user data directory
(~/.local/share/nvr on Linux, ~/Library/Application Support/nvr on macOS).
Optional packs such as Kokoro and OmniVoice are installed later from Settings
or with `nvr voices install <id>`. OmniVoice (several GB, CC-BY-NC) can also
be fetched now with --with-omnivoice.

--dry-run  Detect what is already present and print the plan. Make no changes.
HELP
      exit 0
      ;;
    *)
      echo "Unknown option: ${arg}" >&2
      exit 2
      ;;
  esac
done

NVR_ROOT="${NVR_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
VS_ROOT="$(nvr_default_vs_root)"
nvr_apply_data_env
STATUS_FILE="$(nvr_default_status_file)"
UNAME="$(uname -s)"

log() { printf '%s\n' "$*"; }
skip() { log "  skip: $*"; }
plan() { log "  would: $*"; }
need() { log "  need: $*"; }

if [[ "${UNAME}" != "Linux" && "${UNAME}" != "Darwin" ]]; then
  log "This script supports Linux and macOS. On Windows run install.ps1 (untested)."
  exit 1
fi

if [[ "${DRY_RUN}" -eq 1 ]]; then
  log "Dry run. Nothing will be installed or changed."
fi

CHANGES=0

# --- Node.js ---
log "Checking Node.js ${NODE_MAJOR}+..."
if nvr_has_cmd node; then
  MAJOR="$(nvr_node_major)"
  if [[ -n "${MAJOR}" && "${MAJOR}" -ge "${NODE_MAJOR}" ]]; then
    skip "Node.js $(node -v) at $(command -v node)"
  else
    need "Node.js ${NODE_MAJOR}+ (found $(node -v))"
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      plan "Install Node.js ${NODE_MAJOR} into ~/.local/nvr/node (or via Homebrew on macOS)."
    else
      if [[ "${UNAME}" == "Darwin" ]] && nvr_has_cmd brew; then
        brew install node@22 || brew install node
      else
        ARCH="$(uname -m)"
        case "${ARCH}" in
          x86_64) NODE_ARCH=x64 ;;
          aarch64|arm64) NODE_ARCH=arm64 ;;
          *) log "Unsupported architecture: ${ARCH}"; exit 1 ;;
        esac
        OS_NAME="linux"
        [[ "${UNAME}" == "Darwin" ]] && OS_NAME="darwin"
        VER="$(curl -fsSL https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt | awk '/node-v[0-9.]+-'"${OS_NAME}-${NODE_ARCH}"'.tar.xz/{print; exit}' | sed -n 's/.*node-v\([0-9.]*\)-.*/\1/p')"
        [[ -n "${VER}" ]] || { log "Could not resolve a Node.js ${NODE_MAJOR} version."; exit 1; }
        DEST="${HOME}/.local/nvr/node"
        mkdir -p "${HOME}/.local/nvr"
        TMP="$(mktemp -d)"
        curl -fL "https://nodejs.org/dist/v${VER}/node-v${VER}-${OS_NAME}-${NODE_ARCH}.tar.xz" -o "${TMP}/node.tar.xz"
        tar -xJf "${TMP}/node.tar.xz" -C "${TMP}"
        rm -rf "${DEST}"
        mv "${TMP}/node-v${VER}-${OS_NAME}-${NODE_ARCH}" "${DEST}"
        mkdir -p "${HOME}/.local/bin"
        ln -sfn "${DEST}/bin/node" "${HOME}/.local/bin/node"
        ln -sfn "${DEST}/bin/npm" "${HOME}/.local/bin/npm"
        ln -sfn "${DEST}/bin/npx" "${HOME}/.local/bin/npx"
        export PATH="${DEST}/bin:${PATH}"
        rm -rf "${TMP}"
        log "  installed Node.js $(node -v) into ${DEST}"
      fi
    fi
    CHANGES=1
  fi
else
  need "Node.js ${NODE_MAJOR}+ is not on PATH"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    plan "Install Node.js ${NODE_MAJOR} into ~/.local/nvr/node (or via Homebrew on macOS)."
  else
    if [[ "${UNAME}" == "Darwin" ]] && nvr_has_cmd brew; then
      brew install node@22 || brew install node
    else
      ARCH="$(uname -m)"
      case "${ARCH}" in
        x86_64) NODE_ARCH=x64 ;;
        aarch64|arm64) NODE_ARCH=arm64 ;;
        *) log "Unsupported architecture: ${ARCH}"; exit 1 ;;
      esac
      OS_NAME="linux"
      [[ "${UNAME}" == "Darwin" ]] && OS_NAME="darwin"
      VER="$(curl -fsSL https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt | awk '/node-v[0-9.]+-'"${OS_NAME}-${NODE_ARCH}"'.tar.xz/{print; exit}' | sed -n 's/.*node-v\([0-9.]*\)-.*/\1/p')"
      [[ -n "${VER}" ]] || { log "Could not resolve a Node.js ${NODE_MAJOR} version."; exit 1; }
      DEST="${HOME}/.local/nvr/node"
      mkdir -p "${HOME}/.local/nvr"
      TMP="$(mktemp -d)"
      curl -fL "https://nodejs.org/dist/v${VER}/node-v${VER}-${OS_NAME}-${NODE_ARCH}.tar.xz" -o "${TMP}/node.tar.xz"
      tar -xJf "${TMP}/node.tar.xz" -C "${TMP}"
      rm -rf "${DEST}"
      mv "${TMP}/node-v${VER}-${OS_NAME}-${NODE_ARCH}" "${DEST}"
      mkdir -p "${HOME}/.local/bin"
      ln -sfn "${DEST}/bin/node" "${HOME}/.local/bin/node"
      ln -sfn "${DEST}/bin/npm" "${HOME}/.local/bin/npm"
      ln -sfn "${DEST}/bin/npx" "${HOME}/.local/bin/npx"
      export PATH="${DEST}/bin:${PATH}"
      rm -rf "${TMP}"
      log "  installed Node.js $(node -v) into ${DEST}"
    fi
  fi
  CHANGES=1
fi

# --- uv / Python ---
log "Checking uv and Python ${PYTHON_VERSION}..."
if nvr_has_cmd uv; then
  skip "uv at $(command -v uv)"
else
  need "uv"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    plan "Install uv with the official installer into ~/.local/bin."
  else
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="${HOME}/.local/bin:${PATH}"
    log "  installed uv at $(command -v uv)"
  fi
  CHANGES=1
fi

if nvr_has_cmd uv && uv python list 2>/dev/null | grep -q "${PYTHON_VERSION}"; then
  skip "Python ${PYTHON_VERSION} is available through uv"
elif nvr_has_cmd python3 && python3 -c "import sys; raise SystemExit(0 if sys.version_info[:2]==(3,11) else 1)" 2>/dev/null; then
  skip "python3 is already 3.11 ($(python3 -V))"
else
  need "Python ${PYTHON_VERSION}"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    plan "uv python install ${PYTHON_VERSION}"
  else
    if nvr_has_cmd uv; then
      uv python install "${PYTHON_VERSION}"
    else
      log "uv is required to install Python ${PYTHON_VERSION}."
      exit 1
    fi
  fi
  CHANGES=1
fi

# --- VoiceStudio (separate AGPL repo, pinned) ---
log "Checking VoiceStudio (pinned ${VOICESTUDIO_COMMIT:0:9}, not vendored)..."
if [[ -d "${VS_ROOT}/.git" ]]; then
  CURRENT="$(git -C "${VS_ROOT}" rev-parse HEAD 2>/dev/null || true)"
  if [[ "${CURRENT}" == "${VOICESTUDIO_COMMIT}" ]]; then
    skip "VoiceStudio at ${VS_ROOT} (${CURRENT:0:9})"
  else
    need "VoiceStudio at ${VS_ROOT} is ${CURRENT:0:9}, not the pinned commit"
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      plan "Leave the existing checkout in place. Fetch ${VOICESTUDIO_COMMIT:0:9} only into a missing tree."
    else
      log "  existing checkout is not the pin; leaving it unchanged so local work is not reset."
      log "  To use the pin, run: git -C ${VS_ROOT} fetch origin && git -C ${VS_ROOT} checkout ${VOICESTUDIO_COMMIT}"
    fi
  fi
  if [[ -x "${VS_ROOT}/.venv/bin/python" ]]; then
    skip "VoiceStudio virtualenv at ${VS_ROOT}/.venv"
  else
    need "VoiceStudio virtualenv"
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      plan "cd ${VS_ROOT} && uv sync --no-dev"
    else
      (cd "${VS_ROOT}" && uv sync --no-dev)
    fi
    CHANGES=1
  fi
else
  need "VoiceStudio clone at ${VS_ROOT}"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    plan "git clone ${VOICESTUDIO_REPO} ${VS_ROOT} && git checkout ${VOICESTUDIO_COMMIT} && uv sync --no-dev"
  else
    mkdir -p "$(dirname "${VS_ROOT}")"
    git clone "${VOICESTUDIO_REPO}" "${VS_ROOT}"
    git -C "${VS_ROOT}" checkout --detach "${VOICESTUDIO_COMMIT}"
    (cd "${VS_ROOT}" && uv sync --no-dev)
    log "  cloned VoiceStudio ${VOICESTUDIO_COMMIT:0:9} into ${VS_ROOT}"
  fi
  CHANGES=1
fi

# --- Reader deps ---
log "Checking Natural Voice Reader npm dependencies..."
if [[ -d "${NVR_ROOT}/node_modules" ]]; then
  skip "node_modules already present in ${NVR_ROOT}"
else
  need "npm ci in ${NVR_ROOT}"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    plan "npm ci"
  else
    (cd "${NVR_ROOT}" && npm ci)
  fi
  CHANGES=1
fi

# --- Launcher symlink ---
log "Checking the nvr launcher..."
mkdir -p "${HOME}/.local/bin"
if [[ -L "${HOME}/.local/bin/nvr" || -f "${HOME}/.local/bin/nvr" ]]; then
  TARGET="$(readlink -f "${HOME}/.local/bin/nvr" 2>/dev/null || readlink "${HOME}/.local/bin/nvr" || true)"
  if [[ "${TARGET}" == "${NVR_ROOT}/scripts/nvr.sh" ]]; then
    skip "nvr already points at ${NVR_ROOT}/scripts/nvr.sh"
  else
    need "nvr symlink currently points at ${TARGET:-something else}"
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      plan "ln -sfn ${NVR_ROOT}/scripts/nvr.sh ${HOME}/.local/bin/nvr"
    else
      ln -sfn "${NVR_ROOT}/scripts/nvr.sh" "${HOME}/.local/bin/nvr"
      log "  linked ~/.local/bin/nvr"
    fi
    CHANGES=1
  fi
else
  need "nvr symlink"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    plan "ln -sfn ${NVR_ROOT}/scripts/nvr.sh ${HOME}/.local/bin/nvr"
  else
    ln -sfn "${NVR_ROOT}/scripts/nvr.sh" "${HOME}/.local/bin/nvr"
    log "  linked ~/.local/bin/nvr"
  fi
  CHANGES=1
fi

# --- nvr-say symlink ---
log "Checking the nvr-say launcher..."
if [[ -L "${HOME}/.local/bin/nvr-say" || -f "${HOME}/.local/bin/nvr-say" ]]; then
  SAY_TARGET="$(readlink -f "${HOME}/.local/bin/nvr-say" 2>/dev/null || readlink "${HOME}/.local/bin/nvr-say" || true)"
  if [[ "${SAY_TARGET}" == "${NVR_ROOT}/scripts/nvr-say.sh" ]]; then
    skip "nvr-say already points at ${NVR_ROOT}/scripts/nvr-say.sh"
  else
    need "nvr-say symlink currently points at ${SAY_TARGET:-something else}"
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      plan "ln -sfn ${NVR_ROOT}/scripts/nvr-say.sh ${HOME}/.local/bin/nvr-say"
    else
      ln -sfn "${NVR_ROOT}/scripts/nvr-say.sh" "${HOME}/.local/bin/nvr-say"
      log "  linked ~/.local/bin/nvr-say"
    fi
    CHANGES=1
  fi
else
  need "nvr-say symlink"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    plan "ln -sfn ${NVR_ROOT}/scripts/nvr-say.sh ${HOME}/.local/bin/nvr-say"
  else
    ln -sfn "${NVR_ROOT}/scripts/nvr-say.sh" "${HOME}/.local/bin/nvr-say"
    log "  linked ~/.local/bin/nvr-say"
  fi
  CHANGES=1
fi

# --- Models ---

VS_PY="$(nvr_vs_python "${VS_ROOT}")"
PACKS="${SCRIPT_DIR}/voice-packs.py"
nvr_migrate_data
log "Checking the default KittenTTS voice pack..."
if [[ -n "${VS_PY}" ]] && "${VS_PY}" "${PACKS}" check kittentts >/dev/null 2>&1; then
  skip "KittenTTS is already installed"
else
  need "KittenTTS voice pack (${KITTEN_MODEL})"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    plan "Install the default KittenTTS pack (about 80 MB, Apache-2.0)."
  else
    nvr_write_status "${STATUS_FILE}" '{"state":"downloading","model":"kittentts","percent":0,"message":"Downloading KittenTTS voice model. You can keep using the reader."}'
    "${VS_PY}" "${PACKS}" install kittentts --status-file "${STATUS_FILE}"
  fi
  CHANGES=1
fi

log "Checking optional voice packs..."
if [[ -n "${VS_PY}" ]] && "${VS_PY}" "${PACKS}" check omnivoice >/dev/null 2>&1; then
  skip "OmniVoice is already installed"
elif [[ "${WITH_OMNIVOICE}" -eq 1 ]]; then
  need "OmniVoice weights (several GB, CC-BY-NC, not for commercial use)"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    plan "Install the OmniVoice pack."
  else
    "${VS_PY}" "${PACKS}" install omnivoice --status-file "${STATUS_FILE}"
  fi
  CHANGES=1
else
  skip "OmniVoice is optional. Install it later from Settings or with: nvr voices install omnivoice"
fi

if [[ -n "${VS_PY}" ]] && "${VS_PY}" "${PACKS}" check kokoro >/dev/null 2>&1; then
  skip "Kokoro is already installed"
else
  skip "Kokoro is optional (Butler and Indian English). Install it later from Settings or with: nvr voices install kokoro"
fi

log ""
if [[ "${DRY_RUN}" -eq 1 ]]; then
  if [[ "${CHANGES}" -eq 0 ]]; then
    log "Dry run complete. Every required component is already present."
  else
    log "Dry run complete. The steps marked 'would' would be performed on a real install."
  fi
else
  nvr_write_status "${STATUS_FILE}" '{"state":"ready","percent":100,"message":"Install is complete."}'
  log "Install is complete. Launch with:"
  log "  nvr"
  log "or:"
  log "  ${NVR_ROOT}/scripts/nvr.sh"
  log "To speak text to an MP3 without opening the reader:"
  log "  nvr say --text \"Hello.\" --out ~/Music/hello.mp3"
  log "VoiceStudio remains a separate AGPL-3.0 project at ${VS_ROOT}."
fi
