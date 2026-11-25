#!/usr/bin/env bash
# Get a Linux or macOS machine ready to build the installed app (src-tauri/).
# Checks for each build tool and offers to install what is missing, so a
# fresh clone builds instead of failing with a compiler error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/nvr-lib.sh"
nvr_load_pins "${SCRIPT_DIR}"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUST_MIN_VERSION="${RUST_MIN_VERSION:-1.90}"

DRY_RUN=0
ASSUME_YES=0
BUILD=0
for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --build) BUILD=1 ;;
    -h|--help)
      cat << 'HELP'
Usage: setup-app-build.sh [--dry-run] [--yes] [--build]

Checks for, and offers to install, what building the Natural Voice Reader
app needs:

  - Node.js 22+ and the project's npm packages
  - Rust 1.90+ (through rustup)
  - Linux: WebKitGTK 4.1, GTK, librsvg, a C compiler, and GStreamer plugins,
    using apt, dnf, pacman, or zypper (asks before using sudo)
  - macOS: the Xcode Command Line Tools

--dry-run  Show what is present and what would be installed. Change nothing.
--yes      Install without asking (sudo may still ask for your password).
--build    Build the installers when setup finishes (npm run app:build).
HELP
      exit 0
      ;;
    *) echo "Unknown option: ${arg}" >&2; exit 2 ;;
  esac
done

UNAME="$(uname -s)"
if [[ "${UNAME}" != "Linux" && "${UNAME}" != "Darwin" ]]; then
  echo "This script supports Linux and macOS. On Windows run scripts\\setup-app-build.ps1."
  exit 1
fi

log() { printf '%s\n' "$*"; }
ok() { log "  ok:   $*"; }
need() { log "  need: $*"; }
plan() { log "  would: $*"; }

# Ask before changing the system. Returns 0 for yes.
confirm() {
  [[ "${ASSUME_YES}" -eq 1 ]] && return 0
  if [[ ! -t 0 ]]; then
    log "  (no terminal to ask; re-run with --yes to install automatically)"
    return 1
  fi
  local reply
  read -r -p "  $1 [Y/n] " reply
  [[ -z "${reply}" || "${reply}" =~ ^[Yy] ]]
}

version_ge() {
  # version_ge 1.91.0 1.90 -> true
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

# Tools this script (or install.sh / rustup) installed earlier may not be on
# PATH in a new shell yet. Look there first so they are not installed twice.
ORIGINAL_PATH="${PATH}"
[[ -d "${HOME}/.local/nvr/node/bin" ]] && PATH="${HOME}/.local/nvr/node/bin:${PATH}"
[[ -d "${HOME}/.cargo/bin" ]] && PATH="${HOME}/.cargo/bin:${PATH}"
export PATH

SUDO=(sudo)
[[ "$(id -u)" -eq 0 ]] && SUDO=()

MISSING=0
skipped() { MISSING=1; log "  skipped. Install it later and run this script again."; }

[[ "${DRY_RUN}" -eq 1 ]] && log "Dry run. Nothing will be installed or changed."

# --- System libraries and compilers (first: they include curl) --------------
if [[ "${UNAME}" == "Darwin" ]]; then
  log "Checking Xcode Command Line Tools..."
  if xcode-select -p >/dev/null 2>&1; then
    ok "Command Line Tools at $(xcode-select -p)"
  else
    need "Xcode Command Line Tools (C compiler and SDK)"
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      plan "xcode-select --install"
    elif confirm "Install the Xcode Command Line Tools? A macOS window will open."; then
      xcode-select --install || true
      log "  Finish the install in the window that opened, then run this script again."
      exit 0
    else
      skipped
    fi
  fi
else
  log "Checking WebKitGTK and build tools..."
  have_libs() {
    nvr_has_cmd cc && nvr_has_cmd pkg-config && nvr_has_cmd file \
      && pkg-config --exists webkit2gtk-4.1 libsoup-3.0 javascriptcoregtk-4.1 librsvg-2.0 openssl 2>/dev/null
  }
  if have_libs; then
    ok "WebKitGTK $(pkg-config --modversion webkit2gtk-4.1), GTK, librsvg, OpenSSL, C compiler"
  else
    PM_INSTALL=()
    PM_PKGS=()
    if nvr_has_cmd apt-get; then
      PM_INSTALL=(apt-get install -y)
      PM_PKGS=(build-essential pkg-config curl ca-certificates xz-utils wget file libwebkit2gtk-4.1-dev libsoup-3.0-dev
        libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev
        gstreamer1.0-plugins-base gstreamer1.0-plugins-good)
    elif nvr_has_cmd dnf; then
      PM_INSTALL=(dnf install -y)
      PM_PKGS=(gcc gcc-c++ make pkgconf-pkg-config curl xz wget file webkit2gtk4.1-devel openssl-devel
        libappindicator-gtk3-devel librsvg2-devel libxdo-devel gstreamer1-plugins-base gstreamer1-plugins-good)
    elif nvr_has_cmd pacman; then
      PM_INSTALL=(pacman -S --needed --noconfirm)
      PM_PKGS=(base-devel curl xz wget file openssl webkit2gtk-4.1 libappindicator-gtk3 librsvg xdotool
        gst-plugins-base gst-plugins-good)
    elif nvr_has_cmd zypper; then
      PM_INSTALL=(zypper install -y)
      PM_PKGS=(gcc gcc-c++ make pkg-config curl xz wget file webkit2gtk3-devel libopenssl-devel
        libappindicator3-1 librsvg-devel gstreamer-plugins-base gstreamer-plugins-good)
    fi
    if [[ "${#PM_INSTALL[@]}" -eq 0 ]]; then
      need "WebKitGTK 4.1 development files and a C compiler"
      log "  Your package manager was not recognised. Install the packages listed at"
      log "  https://tauri.app/start/prerequisites/#linux and run this script again."
      MISSING=1
    else
      need "WebKitGTK 4.1 and build tools"
      if [[ "${DRY_RUN}" -eq 1 ]]; then
        plan "sudo ${PM_INSTALL[*]} ${PM_PKGS[*]}"
      else
        log "  Packages: ${PM_PKGS[*]}"
        if confirm "Install these with sudo ${PM_INSTALL[0]}? You may be asked for your password."; then
          [[ "${PM_INSTALL[0]}" == "apt-get" ]] && "${SUDO[@]}" apt-get update
          "${SUDO[@]}" "${PM_INSTALL[@]}" "${PM_PKGS[@]}"
          have_libs && ok "WebKitGTK $(pkg-config --modversion webkit2gtk-4.1)"
        else
          skipped
        fi
      fi
    fi
  fi
fi

# --- Node.js ---------------------------------------------------------------
log "Checking Node.js ${NODE_MAJOR}+..."
if nvr_has_cmd node && [[ "$(nvr_node_major)" -ge "${NODE_MAJOR}" ]]; then
  ok "Node.js $(node -v)"
else
  need "Node.js ${NODE_MAJOR}+"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    plan "install Node.js ${NODE_MAJOR} (Homebrew on macOS, otherwise ~/.local/nvr/node)"
  elif confirm "Install Node.js ${NODE_MAJOR}?"; then
    nvr_install_node
  else
    skipped
  fi
fi

# --- Rust ------------------------------------------------------------------
log "Checking Rust ${RUST_MIN_VERSION}+..."
[[ -f "${HOME}/.cargo/env" ]] && source "${HOME}/.cargo/env"
if nvr_has_cmd rustc && version_ge "$(rustc --version | awk '{print $2}')" "${RUST_MIN_VERSION}"; then
  ok "$(rustc --version)"
elif nvr_has_cmd rustup; then
  need "Rust ${RUST_MIN_VERSION}+ (found $(rustc --version 2>/dev/null || echo none))"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    plan "rustup update stable"
  elif confirm "Update Rust with rustup?"; then
    rustup update stable && rustup default stable
  else
    skipped
  fi
else
  need "Rust (rustup is not installed)"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    plan "install rustup from https://rustup.rs into ~/.cargo"
  elif confirm "Install Rust with rustup (into ~/.cargo, no sudo)?"; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
    source "${HOME}/.cargo/env"
  else
    skipped
  fi
fi

# --- npm packages ----------------------------------------------------------
log "Checking npm packages..."
if [[ -x "${ROOT}/node_modules/.bin/tauri" && "${ROOT}/node_modules/.package-lock.json" -nt "${ROOT}/package-lock.json" ]]; then
  ok "node_modules is up to date"
elif ! nvr_has_cmd npm; then
  need "npm (comes with Node.js)"
  MISSING=1
elif [[ "${DRY_RUN}" -eq 1 ]]; then
  plan "npm ci"
else
  (cd "${ROOT}" && npm ci)
fi

log ""
if [[ "${DRY_RUN}" -eq 1 ]]; then
  log "Dry run finished."
  exit 0
fi
if [[ "${MISSING}" -ne 0 ]]; then
  log "Some build tools are still missing (see above). The app will not build until they are installed."
  exit 1
fi
log "Ready to build."
path_hint=()
for dir in "${HOME}/.local/nvr/node/bin" "${HOME}/.cargo/bin"; do
  [[ -d "${dir}" && ":${ORIGINAL_PATH}:" != *":${dir}:"* ]] && path_hint+=("${dir}")
done
if [[ "${#path_hint[@]}" -gt 0 ]]; then
  log "  Open a new terminal first, or run this in the current one:"
  log "    export PATH=\"$(IFS=:; echo "${path_hint[*]}"):\$PATH\""
fi
log "  npm run app:dev     run the app with hot reload"
log "  npm run app:build   build installers into src-tauri/target/release/bundle/"
if [[ "${BUILD}" -eq 1 ]]; then
  (cd "${ROOT}" && npm run app:build)
fi
