# Shared helpers for install.sh and nvr.sh. Sourced, not executed.

nvr_load_pins() {
  local dir="$1"
  set -a
  # shellcheck disable=SC1091
  source "${dir}/pins.env"
  set +a
}

nvr_default_status_file() {
  if [[ -n "${NVR_STATUS_FILE:-}" ]]; then
    printf '%s\n' "${NVR_STATUS_FILE}"
    return
  fi
  printf '%s\n' "${HOME}/.cache/nvr/status.json"
}

nvr_default_vs_root() {
  if [[ -n "${VOICESTUDIO_ROOT:-}" ]]; then
    printf '%s\n' "${VOICESTUDIO_ROOT}"
    return
  fi
  if [[ -d "${HOME}/Dev/Source/VoiceStudio" ]]; then
    printf '%s\n' "${HOME}/Dev/Source/VoiceStudio"
    return
  fi
  printf '%s\n' "${HOME}/.local/share/nvr/VoiceStudio"
}

nvr_cpu_threads() {
  if [[ -n "${NVR_CPU_THREADS:-}" ]]; then
    printf '%s\n' "${NVR_CPU_THREADS}"
    return
  fi
  local n
  n="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
  if [[ "${n}" -ge 8 ]]; then
    printf '4\n'
  elif [[ "${n}" -ge 1 ]]; then
    printf '%s\n' "${n}"
  else
    printf '4\n'
  fi
}

nvr_apply_thread_env() {
  local threads
  threads="$(nvr_cpu_threads)"
  export NVR_CPU_THREADS="${threads}"
  export OMP_NUM_THREADS="${threads}"
  export MKL_NUM_THREADS="${threads}"
  export OPENBLAS_NUM_THREADS="${threads}"
  export NUMEXPR_NUM_THREADS="${threads}"
  export VECLIB_MAXIMUM_THREADS="${threads}"
  export TOKENIZERS_PARALLELISM=false
  export OMP_WAIT_POLICY=PASSIVE
  export KMP_BLOCKTIME=1
}

nvr_vs_python() {
  local root="$1"
  if [[ -x "${root}/.venv/bin/python" ]]; then
    printf '%s\n' "${root}/.venv/bin/python"
    return
  fi
  command -v python3
}

nvr_write_status() {
  local file="$1"
  local json="$2"
  mkdir -p "$(dirname "${file}")"
  printf '%s\n' "${json}" > "${file}"
}

nvr_has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

nvr_node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || true
}
