#!/usr/bin/env bash
# Start VoiceStudio and Natural Voice Reader together, then stop both on Ctrl+C.
set -euo pipefail

NVR_ROOT="${NVR_ROOT:-$HOME/Dev/Source/Natural-Voice-Reader}"
VS_ROOT="${VOICESTUDIO_ROOT:-$HOME/Dev/Source/VoiceStudio}"
VS_HOST="${VOICESTUDIO_HOST:-127.0.0.1}"
VS_PORT="${VOICESTUDIO_PORT:-3900}"
NVR_PORT="${NVR_PORT:-8080}"
VS_URL="${VOICESTUDIO_URL:-http://${VS_HOST}:${VS_PORT}}"
READER_URL="http://127.0.0.1:${NVR_PORT}"
MODEL="${NVR_TTS_MODEL:-${VOICESTUDIO_TTS_MODEL:-omnivoice}}"
VS_LOG="${VS_LOG:-/tmp/voicestudio-api.log}"
NVR_LOG="${NVR_LOG:-/tmp/nvr-dev.log}"
WARMUP_TEXT="The voice engine is ready."

VS_PID=""
NVR_PID=""
CLEANING=0

log() {
  printf '%s\n' "$*"
}

die() {
  log "$*"
  exit 1
}

case "${MODEL}" in
  voxcpm2|tts-1|tts-1-hd|gpt-4o-mini-tts)
    log "Refusing model ${MODEL}; using omnivoice instead."
    MODEL="omnivoice"
    ;;
  omnivoice|kittentts) ;;
  *)
    log "Unknown model ${MODEL}; using omnivoice instead."
    MODEL="omnivoice"
    ;;
esac

[[ -d "${NVR_ROOT}" ]] || die "Natural Voice Reader was not found at ${NVR_ROOT}."
[[ -d "${VS_ROOT}" ]] || die "VoiceStudio was not found at ${VS_ROOT}."

cmdline_of() {
  tr '\0' ' ' < "/proc/${1}/cmdline" 2>/dev/null || true
}

cwd_of() {
  readlink "/proc/${1}/cwd" 2>/dev/null || true
}

parent_of() {
  awk '/^PPid:/{print $2}' "/proc/${1}/status" 2>/dev/null || true
}

is_project_pid() {
  local pid="$1" cmd cwd
  [[ -n "${pid}" && -d "/proc/${pid}" ]] || return 1
  cmd="$(cmdline_of "${pid}")"
  cwd="$(cwd_of "${pid}")"
  [[ "${cmd}" == *"/VoiceStudio"* || "${cwd}" == *"/VoiceStudio"* ||
     "${cmd}" == *"/Natural-Voice-Reader"* || "${cwd}" == *"/Natural-Voice-Reader"* ||
     "${cmd}" == *"voicestudio"* ]]
}

root_project_pid() {
  local pid="$1" parent
  while true; do
    parent="$(parent_of "${pid}")"
    if [[ -n "${parent}" ]] && is_project_pid "${parent}"; then
      pid="${parent}"
      continue
    fi
    printf '%s\n' "${pid}"
    return 0
  done
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

stop_port() {
  local port="$1" label="$2" pid root leftover
  local pids
  pids="$(pids_on_port "${port}" || true)"
  if [[ -z "${pids}" ]]; then
    log "No existing ${label} listener on port ${port}."
    return 0
  fi
  leftover=0
  for pid in ${pids}; do
    if ! is_project_pid "${pid}"; then
      log "Port ${port} is in use by pid ${pid}, which is not VoiceStudio or the reader. Leaving it alone."
      leftover=1
      continue
    fi
    root="$(root_project_pid "${pid}")"
    log "Stopping existing ${label} process ${root} on port ${port}."
    kill_tree "${root}"
    if ! wait_pid_gone "${root}"; then
      log "Existing ${label} process ${root} did not exit; forcing it to stop."
      force_kill_tree "${root}"
    fi
  done
  if [[ "${leftover}" -eq 1 ]]; then
    return 1
  fi
  pids="$(pids_on_port "${port}" || true)"
  if [[ -n "${pids}" ]]; then
    die "Port ${port} is still in use after stopping the old ${label} process."
  fi
}

cleanup() {
  if [[ "${CLEANING}" -eq 1 ]]; then
    return
  fi
  CLEANING=1
  trap - INT TERM EXIT
  log "Shutting down the reader and VoiceStudio..."
  if [[ -n "${NVR_PID}" ]]; then
    kill_tree "${NVR_PID}"
  fi
  if [[ -n "${VS_PID}" ]]; then
    kill_tree "${VS_PID}"
  fi
  if [[ -n "${NVR_PID}" ]] && ! wait_pid_gone "${NVR_PID}"; then
    force_kill_tree "${NVR_PID}"
  fi
  if [[ -n "${VS_PID}" ]] && ! wait_pid_gone "${VS_PID}"; then
    force_kill_tree "${VS_PID}"
  fi
  log "Stopped."
}

trap cleanup INT TERM EXIT

stop_port "${VS_PORT}" "VoiceStudio"
stop_port "${NVR_PORT}" "reader"

: > "${VS_LOG}"
log "Starting VoiceStudio API on ${VS_HOST}:${VS_PORT}..."
(
  cd "${VS_ROOT}"
  # Do not set OMNIVOICE_TTS_BACKEND; it would lock the engine and ignore /engines/select.
  exec uv run --no-sync uvicorn main:app --app-dir backend --host "${VS_HOST}" --port "${VS_PORT}"
) >>"${VS_LOG}" 2>&1 &
VS_PID=$!
log "VoiceStudio pid ${VS_PID}. Log: ${VS_LOG}"

health_ok=0
for i in $(seq 1 60); do
  if ! kill -0 "${VS_PID}" 2>/dev/null; then
    die "VoiceStudio exited before it became healthy. See ${VS_LOG}."
  fi
  if curl -fsS -m 8 "${VS_URL}/health" >/dev/null 2>&1; then
    health_ok=1
    break
  fi
  sleep 1
done
[[ "${health_ok}" -eq 1 ]] || die "Timed out waiting for VoiceStudio /health. See ${VS_LOG}."
log "VoiceStudio is healthy."

log "Pinning and warming ${MODEL}..."
if ! curl -fsS -m 8 -X POST "${VS_URL}/engines/select" \
  -H "Content-Type: application/json" \
  -d "{\"family\":\"tts\",\"backend_id\":\"${MODEL}\"}" >/tmp/nvr-select.json; then
  log "Could not pin ${MODEL} on the first try; continuing with warm-up."
fi

warm() {
  curl -fsS -m 180 -X POST "${VS_URL}/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL}\",\"input\":\"${WARMUP_TEXT}\",\"voice\":\"default\",\"response_format\":\"mp3\",\"language\":\"en\",\"speed\":1}" \
    -o /tmp/nvr-warmup.mp3
}

if warm && [[ "$(wc -c < /tmp/nvr-warmup.mp3)" -gt 64 ]]; then
  log "Voice engine is ready (${MODEL})."
else
  log "First warm-up did not finish; retrying once..."
  sleep 2
  if warm && [[ "$(wc -c < /tmp/nvr-warmup.mp3)" -gt 64 ]]; then
    log "Voice engine is ready (${MODEL})."
  else
    log "Warm-up did not finish. The reader will keep trying when you press play. See ${VS_LOG}."
  fi
fi

: > "${NVR_LOG}"
log "Starting the reader on ${READER_URL}..."
(
  cd "${NVR_ROOT}"
  export VOICESTUDIO_URL="${VS_URL}"
  export VOICESTUDIO_TTS_MODEL="${MODEL}"
  export NVR_TTS_MODEL="${MODEL}"
  exec npm run dev
) >>"${NVR_LOG}" 2>&1 &
NVR_PID=$!
log "Reader pid ${NVR_PID}. Log: ${NVR_LOG}"

reader_ok=0
for i in $(seq 1 60); do
  if ! kill -0 "${NVR_PID}" 2>/dev/null; then
    die "The reader exited before it started. See ${NVR_LOG}."
  fi
  if curl -fsS -m 5 "${READER_URL}" >/dev/null 2>&1; then
    reader_ok=1
    break
  fi
  sleep 0.5
done
[[ "${reader_ok}" -eq 1 ]] || die "Timed out waiting for the reader on port ${NVR_PORT}. See ${NVR_LOG}."
log "Reader is ready at ${READER_URL}"

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${READER_URL}" >/dev/null 2>&1 || true
elif command -v gio >/dev/null 2>&1; then
  gio open "${READER_URL}" >/dev/null 2>&1 || true
fi
log "Opened ${READER_URL} in the browser."
log "Ready. Press Ctrl+C to stop both."

while kill -0 "${VS_PID}" 2>/dev/null && kill -0 "${NVR_PID}" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "${VS_PID}" 2>/dev/null; then
  die "VoiceStudio stopped unexpectedly. See ${VS_LOG}."
fi
die "The reader stopped unexpectedly. See ${NVR_LOG}."
