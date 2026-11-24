#!/usr/bin/env bash
# Speak text to an audio file using Natural Voice Reader's local engines.
# Starts VoiceStudio or Kokoro if needed, without opening the reader UI.
# Usage: nvr say --text "Hello." --out file.mp3
set -euo pipefail

_SOURCE="${BASH_SOURCE[0]}"
while [[ -L "${_SOURCE}" ]]; do
  _DIR="$(cd "$(dirname "${_SOURCE}")" && pwd)"
  _SOURCE="$(readlink "${_SOURCE}")"
  [[ "${_SOURCE}" != /* ]] && _SOURCE="${_DIR}/${_SOURCE}"
done
SCRIPT_DIR="$(cd "$(dirname "${_SOURCE}")" && pwd)"
unset _SOURCE _DIR
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/nvr-lib.sh"
nvr_load_pins "${SCRIPT_DIR}"

NVR_ROOT="${NVR_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
export NVR_ROOT
VS_ROOT="$(nvr_default_vs_root)"
VS_HOST="${VOICESTUDIO_HOST:-127.0.0.1}"
VS_PORT="${VOICESTUDIO_PORT:-3900}"
KOKORO_HOST="${KOKORO_HOST:-127.0.0.1}"
KOKORO_PORT="${KOKORO_PORT:-3901}"
VS_URL="${VOICESTUDIO_URL:-http://${VS_HOST}:${VS_PORT}}"
KOKORO_URL="${KOKORO_URL:-http://${KOKORO_HOST}:${KOKORO_PORT}}"
export VOICESTUDIO_URL="${VS_URL}"
export KOKORO_URL
export NVR_KOKORO_URL="${KOKORO_URL}"
VS_LOG="${VS_LOG:-/tmp/voicestudio-api.log}"
KOKORO_LOG="${KOKORO_LOG:-/tmp/nvr-kokoro.log}"
nvr_migrate_data
nvr_apply_thread_env
KOKORO_MODEL_DIR="${NVR_KOKORO_MODEL_DIR}"

VS_PID=""
KOKORO_PID=""
STARTED_VS=0
STARTED_KOKORO=0
KEEP=0
CLEANING=0

log() {
  printf '%s\n' "$*"
}

die() {
  log "$*" >&2
  exit 1
}

SAY_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      KEEP=1
      shift
      ;;
    --help|-h)
      # Let the Python CLI print usage, then add the wrapper notes.
      py="$(nvr_vs_python "${VS_ROOT}" 2>/dev/null || true)"
      if [[ -z "${py}" ]]; then
        py="$(command -v python3 || true)"
      fi
      "${py}" "${SCRIPT_DIR}/nvr-say.py" --help
      cat <<'EOF'

Wrapper options:
  --keep    Leave VoiceStudio or Kokoro running if this command started them.

`nvr say` starts only the engine the chosen voice needs, speaks the text, and
stops anything it started. It does not open the reader in a browser, and it
does not stop engines that were already running. Existing `nvr` and
`nvr voices` commands are unchanged.
EOF
      exit 0
      ;;
    *)
      SAY_ARGS+=("$1")
      shift
      ;;
  esac
done

# Help and voice listing should not start engines.
for arg in "${SAY_ARGS[@]+"${SAY_ARGS[@]}"}"; do
  case "${arg}" in
    --list-voices|--route-only)
      py="$(nvr_vs_python "${VS_ROOT}" 2>/dev/null || true)"
      if [[ -z "${py}" ]]; then
        py="$(command -v python3 || true)"
      fi
      [[ -n "${py}" ]] || die "Python 3 is required for nvr say."
      exec "${py}" "${SCRIPT_DIR}/nvr-say.py" "${SAY_ARGS[@]}"
      ;;
  esac
done

[[ -d "${NVR_ROOT}" ]] || die "Natural Voice Reader was not found at ${NVR_ROOT}."

cmdline_of() {
  tr '\0' ' ' < "/proc/${1}/cmdline" 2>/dev/null || true
}

cwd_of() {
  readlink "/proc/${1}/cwd" 2>/dev/null || true
}

is_project_pid() {
  local pid="$1" cmd cwd
  [[ -n "${pid}" && -d "/proc/${pid}" ]] || return 1
  cmd="$(cmdline_of "${pid}")"
  cwd="$(cwd_of "${pid}")"
  [[ "${cmd}" == *"/VoiceStudio"* || "${cwd}" == *"/VoiceStudio"* ||
     "${cmd}" == *"/Natural-Voice-Reader"* || "${cwd}" == *"/Natural-Voice-Reader"* ||
     "${cmd}" == *"voicestudio"* || "${cmd}" == *"kokoro-server.py"* ]]
}

pids_on_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | sort -u
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "${port}" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | sort -u
  else
    ss -lptn "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u
  fi
}

kill_tree() {
  local pid="$1" child
  [[ -n "${pid}" && -d "/proc/${pid}" ]] || return 0
  while read -r child; do
    [[ -n "${child}" ]] && kill_tree "${child}"
  done < <(pgrep -P "${pid}" || true)
  kill "${pid}" 2>/dev/null || true
}

force_kill_tree() {
  local pid="$1" child
  [[ -n "${pid}" && -d "/proc/${pid}" ]] || return 0
  while read -r child; do
    [[ -n "${child}" ]] && force_kill_tree "${child}"
  done < <(pgrep -P "${pid}" || true)
  kill -9 "${pid}" 2>/dev/null || true
}

wait_pid_gone() {
  local pid="$1" i
  for i in $(seq 1 20); do
    kill -0 "${pid}" 2>/dev/null || return 0
    sleep 0.25
  done
  return 1
}

cleanup() {
  local status=$?
  if [[ "${CLEANING}" -eq 1 ]]; then
    return
  fi
  CLEANING=1
  trap - INT TERM EXIT
  if [[ "${KEEP}" -eq 1 ]]; then
    return
  fi
  if [[ "${STARTED_KOKORO}" -eq 1 && -n "${KOKORO_PID}" ]]; then
    log "Stopping the Kokoro helper started by this command..."
    kill_tree "${KOKORO_PID}"
    if ! wait_pid_gone "${KOKORO_PID}"; then
      force_kill_tree "${KOKORO_PID}"
    fi
  fi
  if [[ "${STARTED_VS}" -eq 1 && -n "${VS_PID}" ]]; then
    log "Stopping VoiceStudio started by this command..."
    kill_tree "${VS_PID}"
    if ! wait_pid_gone "${VS_PID}"; then
      force_kill_tree "${VS_PID}"
    fi
  fi
  exit "${status}"
}

trap cleanup INT TERM EXIT

ensure_voicestudio() {
  if curl -fsS -m 5 "${VS_URL}/health" >/dev/null 2>&1; then
    log "Using the VoiceStudio server that is already running on ${VS_URL}."
    return 0
  fi
  local pids
  pids="$(pids_on_port "${VS_PORT}" || true)"
  if [[ -n "${pids}" ]]; then
    die "Port ${VS_PORT} is in use, but VoiceStudio /health is not responding. Not replacing it."
  fi
  [[ -d "${VS_ROOT}" ]] || die "VoiceStudio was not found at ${VS_ROOT}."
  if [[ ! -x "$(command -v uv || true)" && ! -x "${HOME}/.local/bin/uv" ]]; then
    die "uv is required to start VoiceStudio. Install it, or start the reader with nvr first."
  fi
  export PATH="${HOME}/.local/bin:${PATH}"
  log "Starting VoiceStudio API on ${VS_HOST}:${VS_PORT}..."
  mkdir -p "$(dirname "${VS_LOG}")"
  : >> "${VS_LOG}"
  (
    cd "${VS_ROOT}"
    exec uv run --no-sync uvicorn main:app --app-dir backend --host "${VS_HOST}" --port "${VS_PORT}"
  ) >>"${VS_LOG}" 2>&1 &
  VS_PID=$!
  STARTED_VS=1
  log "VoiceStudio pid ${VS_PID}. Log: ${VS_LOG}"
  local i
  for i in $(seq 1 60); do
    if ! kill -0 "${VS_PID}" 2>/dev/null; then
      die "VoiceStudio exited before it became healthy. See ${VS_LOG}."
    fi
    if curl -fsS -m 8 "${VS_URL}/health" >/dev/null 2>&1; then
      log "VoiceStudio is healthy."
      return 0
    fi
    sleep 1
  done
  die "Timed out waiting for VoiceStudio /health. See ${VS_LOG}."
}

ensure_kokoro() {
  if curl -fsS -m 5 "${KOKORO_URL}/health" >/dev/null 2>&1; then
    log "Using the Kokoro helper that is already running on ${KOKORO_URL}."
    return 0
  fi
  local pids
  pids="$(pids_on_port "${KOKORO_PORT}" || true)"
  if [[ -n "${pids}" ]]; then
    die "Port ${KOKORO_PORT} is in use, but Kokoro /health is not responding. Not replacing it."
  fi
  local py
  py="$(nvr_vs_python "${VS_ROOT}")"
  if [[ -z "${py}" || ! -f "${SCRIPT_DIR}/kokoro-server.py" ]]; then
    die "Kokoro helper is not available (VoiceStudio Python or scripts/kokoro-server.py missing)."
  fi
  if [[ ! -f "${KOKORO_MODEL_DIR}/model.int8.onnx" && ! -f "${KOKORO_MODEL_DIR}/model.onnx" ]]; then
    die "Kokoro weights are not in ${KOKORO_MODEL_DIR}. Install them with: nvr voices install kokoro"
  fi
  log "Starting Kokoro helper on ${KOKORO_HOST}:${KOKORO_PORT}..."
  : >> "${KOKORO_LOG}"
  (
    exec "${py}" "${SCRIPT_DIR}/kokoro-server.py" \
      --host "${KOKORO_HOST}" \
      --port "${KOKORO_PORT}" \
      --model-dir "${KOKORO_MODEL_DIR}" \
      --threads "${NVR_CPU_THREADS:-4}"
  ) >>"${KOKORO_LOG}" 2>&1 &
  KOKORO_PID=$!
  STARTED_KOKORO=1
  log "Kokoro pid ${KOKORO_PID}. Log: ${KOKORO_LOG}"
  local i
  for i in $(seq 1 45); do
    if ! kill -0 "${KOKORO_PID}" 2>/dev/null; then
      die "Kokoro exited before it became healthy. See ${KOKORO_LOG}."
    fi
    if curl -fsS -m 5 "${KOKORO_URL}/health" >/dev/null 2>&1; then
      log "Kokoro is healthy."
      return 0
    fi
    sleep 1
  done
  die "Timed out waiting for Kokoro /health. See ${KOKORO_LOG}."
}

py="$(nvr_vs_python "${VS_ROOT}" 2>/dev/null || true)"
if [[ -z "${py}" ]]; then
  py="$(command -v python3 || true)"
fi
[[ -n "${py}" ]] || die "Python 3 is required for nvr say."

ROUTE="$("${py}" "${SCRIPT_DIR}/nvr-say.py" --route-only "${SAY_ARGS[@]+"${SAY_ARGS[@]}"}")"
PROVIDER="$(printf '%s' "${ROUTE}" | "${py}" -c 'import json,sys; print(json.load(sys.stdin)["provider"])')"
if [[ "${PROVIDER}" == "kokoro" ]]; then
  ensure_kokoro
else
  ensure_voicestudio
fi

"${py}" "${SCRIPT_DIR}/nvr-say.py" "${SAY_ARGS[@]+"${SAY_ARGS[@]}"}"
