# Shared helpers for install.sh and nvr.sh. Sourced, not executed.

nvr_load_pins() {
  local dir="$1"
  set -a
  # shellcheck disable=SC1091
  source "${dir}/pins.env"
  set +a
}

nvr_data_dir() {
  if [[ -n "${NVR_DATA_HOME:-}" ]]; then
    printf '%s\n' "${NVR_DATA_HOME}"
    return
  fi
  case "$(uname -s 2>/dev/null || echo Linux)" in
    Darwin)
      printf '%s\n' "${HOME}/Library/Application Support/nvr"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      printf '%s\n' "${LOCALAPPDATA:-${USERPROFILE}/AppData/Local}/nvr"
      ;;
    *)
      printf '%s\n' "${XDG_DATA_HOME:-${HOME}/.local/share}/nvr"
      ;;
  esac
}

nvr_apply_data_env() {
  local data
  data="$(nvr_data_dir)"
  export NVR_DATA_HOME="${data}"
  if [[ -z "${NVR_SHERPA_CACHE:-}" ]]; then
    export NVR_SHERPA_CACHE="${data}/sherpa"
  fi
  if [[ -z "${NVR_HF_HOME:-}" ]]; then
    export NVR_HF_HOME="${data}/huggingface"
  fi
  # Only for this process and the VoiceStudio / Kokoro / reader children it starts.
  export HF_HOME="${NVR_HF_HOME}"
  export HUGGINGFACE_HUB_CACHE="${HF_HOME}/hub"
  if [[ -z "${NVR_STATUS_FILE:-}" ]]; then
    export NVR_STATUS_FILE="${data}/status.json"
  fi
  if [[ -z "${NVR_VOICE_STATE:-}" ]]; then
    export NVR_VOICE_STATE="${data}/voice-packs.json"
  fi
  if [[ -z "${NVR_VOICE_STATUS:-}" ]]; then
    export NVR_VOICE_STATUS="${data}/voice-pack-status.json"
  fi
  if [[ -z "${NVR_KOKORO_MODEL_DIR:-}" ]]; then
    export NVR_KOKORO_MODEL_DIR="${NVR_SHERPA_CACHE}/${KOKORO_MODEL_DIR_NAME:-kokoro-int8-multi-lang-v1_0}"
  fi
}

nvr_migrate_data() {
  nvr_apply_data_env
  local py=""
  if [[ -n "${VS_ROOT:-}" ]]; then
    py="$(nvr_vs_python "${VS_ROOT}" 2>/dev/null || true)"
  fi
  if [[ -z "${py}" ]]; then
    py="$(command -v python3 || true)"
  fi
  if [[ -z "${py}" ]]; then
    py="$(command -v python || true)"
  fi
  local script
  script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nvr_paths.py"
  if [[ -n "${py}" && -f "${script}" ]]; then
    "${py}" "${script}" migrate || printf '%s\n' "Warning: could not migrate voice data from the old cache location." >&2
  fi
}

nvr_default_status_file() {
  if [[ -n "${NVR_STATUS_FILE:-}" ]]; then
    printf '%s\n' "${NVR_STATUS_FILE}"
    return
  fi
  nvr_apply_data_env
  printf '%s\n' "${NVR_STATUS_FILE}"
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
