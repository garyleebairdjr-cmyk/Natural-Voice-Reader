@echo off
REM Cross-platform Windows launcher. UNTESTED on Windows.
REM Starts VoiceStudio and Natural Voice Reader together.
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
set "NVR_ROOT=%SCRIPT_DIR%.."
if not defined VOICESTUDIO_ROOT set "VOICESTUDIO_ROOT=%LOCALAPPDATA%\nvr\VoiceStudio"
if not defined NVR_TTS_MODEL set "NVR_TTS_MODEL=kittentts"
if not defined NVR_STATUS_FILE set "NVR_STATUS_FILE=%LOCALAPPDATA%\nvr\status.json"
if not defined VOICESTUDIO_URL set "VOICESTUDIO_URL=http://127.0.0.1:3900"
if not defined KOKORO_URL set "KOKORO_URL=http://127.0.0.1:3901"
if not defined NVR_CPU_THREADS set "NVR_CPU_THREADS=4"
set "OMP_NUM_THREADS=%NVR_CPU_THREADS%"
set "MKL_NUM_THREADS=%NVR_CPU_THREADS%"
set "OPENBLAS_NUM_THREADS=%NVR_CPU_THREADS%"
set "NUMEXPR_NUM_THREADS=%NVR_CPU_THREADS%"
set "TOKENIZERS_PARALLELISM=false"
set "OMP_WAIT_POLICY=PASSIVE"
set "KMP_BLOCKTIME=1"

echo This Windows launcher has not been tested yet.
if not exist "%VOICESTUDIO_ROOT%" (
  echo VoiceStudio was not found at %VOICESTUDIO_ROOT%.
  echo Run scripts\install.ps1 first.
  exit /b 1
)

echo If ports 3900, 3901, or 8080 are already in use, close the old VoiceStudio, Kokoro, or reader window first.
REM This untested launcher does not auto-kill other processes on those ports.

echo Starting VoiceStudio API on 127.0.0.1:3900...
start "VoiceStudio API" /MIN cmd /c "cd /d "%VOICESTUDIO_ROOT%" && uv run --no-sync uvicorn main:app --app-dir backend --host 127.0.0.1 --port 3900 >> %TEMP%\voicestudio-api.log 2>&1"

set /a "tries=0"
:wait_health
timeout /t 1 /nobreak >nul
curl -fsS -m 8 "%VOICESTUDIO_URL%/health" >nul 2>&1
if errorlevel 1 (
  set /a tries+=1
  if %tries% GEQ 60 (
    echo Timed out waiting for VoiceStudio /health. See %TEMP%\voicestudio-api.log
    exit /b 1
  )
  goto wait_health
)
echo VoiceStudio is healthy.

set "VS_PY=%VOICESTUDIO_ROOT%\.venv\Scripts\python.exe"
if exist "%VS_PY%" (
  "%VS_PY%" "%SCRIPT_DIR%download-models.py" --model %NVR_TTS_MODEL% --check >nul 2>&1
  if errorlevel 1 (
    echo Voice model %NVR_TTS_MODEL% is missing. Starting the reader so the UI stays usable while it downloads.
    start "Natural Voice Reader" /MIN cmd /c "cd /d "%NVR_ROOT%" && set VOICESTUDIO_URL=%VOICESTUDIO_URL%&& set KOKORO_URL=%KOKORO_URL%&& set VOICESTUDIO_TTS_MODEL=%NVR_TTS_MODEL%&& set NVR_TTS_MODEL=%NVR_TTS_MODEL%&& set NVR_STATUS_FILE=%NVR_STATUS_FILE%&& npm run dev >> %TEMP%\nvr-dev.log 2>&1"
    start "" "http://127.0.0.1:8080"
    "%VS_PY%" "%SCRIPT_DIR%download-models.py" --model %NVR_TTS_MODEL% --status-file "%NVR_STATUS_FILE%"
  )
)

if exist "%VS_PY%" (
  "%VS_PY%" "%SCRIPT_DIR%download-models.py" --model kokoro --check >nul 2>&1
  if errorlevel 1 (
    echo Kokoro is missing. Downloading it now.
    "%VS_PY%" "%SCRIPT_DIR%download-models.py" --model kokoro --status-file "%NVR_STATUS_FILE%"
  )
  echo Starting Kokoro helper on 127.0.0.1:3901...
  start "Kokoro TTS" /MIN cmd /c "cd /d "%NVR_ROOT%" && "%VS_PY%" "%SCRIPT_DIR%kokoro-server.py" --host 127.0.0.1 --port 3901 >> %TEMP%\nvr-kokoro.log 2>&1"
)

echo Pinning and warming %NVR_TTS_MODEL%...
curl -fsS -m 8 -X POST "%VOICESTUDIO_URL%/engines/select" -H "Content-Type: application/json" -d "{\"family\":\"tts\",\"backend_id\":\"%NVR_TTS_MODEL%\"}" > "%TEMP%\nvr-select.json"
set "WARM_VOICE=default"
if /I "%NVR_TTS_MODEL%"=="kittentts" set "WARM_VOICE=expr-voice-2-m"
curl -fsS -m 180 -X POST "%VOICESTUDIO_URL%/v1/audio/speech" -H "Content-Type: application/json" -d "{\"model\":\"%NVR_TTS_MODEL%\",\"input\":\"The voice engine is ready.\",\"voice\":\"%WARM_VOICE%\",\"response_format\":\"mp3\",\"language\":\"en\",\"speed\":1}" -o "%TEMP%\nvr-warmup.mp3"

echo Starting the reader on http://127.0.0.1:8080...
start "Natural Voice Reader" /MIN cmd /c "cd /d "%NVR_ROOT%" && set VOICESTUDIO_URL=%VOICESTUDIO_URL%&& set KOKORO_URL=%KOKORO_URL%&& set VOICESTUDIO_TTS_MODEL=%NVR_TTS_MODEL%&& set NVR_TTS_MODEL=%NVR_TTS_MODEL%&& set NVR_STATUS_FILE=%NVR_STATUS_FILE%&& npm run dev >> %TEMP%\nvr-dev.log 2>&1"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8080"
echo Ready. Close the VoiceStudio API and Natural Voice Reader windows to stop both.
