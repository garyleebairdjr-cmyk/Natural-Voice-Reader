# First-run bootstrap for Windows. UNTESTED on Windows.
# VoiceStudio is cloned as a separate pinned dependency (AGPL-3.0) and is not vendored.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-DryRun] [-WithOmniVoice]

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$WithOmniVoice
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PinsPath = Join-Path $ScriptDir "pins.env"
$NvrRoot = if ($env:NVR_ROOT) { $env:NVR_ROOT } else { (Resolve-Path (Join-Path $ScriptDir "..")).Path }
$VsRoot = if ($env:VOICESTUDIO_ROOT) { $env:VOICESTUDIO_ROOT } else { Join-Path $env:LOCALAPPDATA "nvr\VoiceStudio" }
$DataDir = if ($env:NVR_DATA_HOME) { $env:NVR_DATA_HOME } else { Join-Path $env:LOCALAPPDATA "nvr" }
if (-not $env:NVR_DATA_HOME) { $env:NVR_DATA_HOME = $DataDir }
if (-not $env:NVR_SHERPA_CACHE) { $env:NVR_SHERPA_CACHE = Join-Path $DataDir "sherpa" }
if (-not $env:NVR_HF_HOME) { $env:NVR_HF_HOME = Join-Path $DataDir "huggingface" }
$env:HF_HOME = $env:NVR_HF_HOME
$env:HUGGINGFACE_HUB_CACHE = Join-Path $env:HF_HOME "hub"
$StatusFile = if ($env:NVR_STATUS_FILE) { $env:NVR_STATUS_FILE } else { Join-Path $DataDir "status.json" }
$env:NVR_STATUS_FILE = $StatusFile
if (-not $env:NVR_KOKORO_MODEL_DIR) { $env:NVR_KOKORO_MODEL_DIR = Join-Path $env:NVR_SHERPA_CACHE "kokoro-int8-multi-lang-v1_0" }

$pins = @{}
Get-Content $PinsPath | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $name, $value = $_.Split('=', 2)
    $pins[$name.Trim()] = $value.Trim()
}

function Write-Log($message) { Write-Host $message }
function Write-Skip($message) { Write-Host "  skip: $message" }
function Write-Need($message) { Write-Host "  need: $message" }
function Write-Plan($message) { Write-Host "  would: $message" }

Write-Log "This Windows installer has not been tested yet."
if ($DryRun) { Write-Log "Dry run. Nothing will be installed or changed." }

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# --- Node.js ---
Write-Log "Checking Node.js $($pins.NODE_MAJOR)+..."
if (Test-Command "node") {
    $major = [int]((node -v).TrimStart('v').Split('.')[0])
    if ($major -ge [int]$pins.NODE_MAJOR) {
        Write-Skip "Node.js $(node -v)"
    } else {
        Write-Need "Node.js $($pins.NODE_MAJOR)+ (found $(node -v))"
        if ($DryRun) { Write-Plan "winget install OpenJS.NodeJS.LTS" }
        else { winget install -e --id OpenJS.NodeJS.LTS }
    }
} else {
    Write-Need "Node.js is not on PATH"
    if ($DryRun) { Write-Plan "winget install OpenJS.NodeJS.LTS" }
    else { winget install -e --id OpenJS.NodeJS.LTS }
}

# --- uv / Python ---
Write-Log "Checking uv and Python $($pins.PYTHON_VERSION)..."
if (Test-Command "uv") {
    Write-Skip "uv is on PATH"
} else {
    Write-Need "uv"
    if ($DryRun) { Write-Plan "Install uv with the official PowerShell installer." }
    else { irm https://astral.sh/uv/install.ps1 | iex }
}

if (Test-Command "uv") {
    if ($DryRun) { Write-Plan "uv python install $($pins.PYTHON_VERSION) if that version is missing" }
    else { uv python install $pins.PYTHON_VERSION }
} else {
    Write-Need "Python $($pins.PYTHON_VERSION) (uv is required to install it)"
}

# --- VoiceStudio ---
Write-Log "Checking VoiceStudio (pinned $($pins.VOICESTUDIO_COMMIT.Substring(0,9)), not vendored)..."
if (Test-Path (Join-Path $VsRoot ".git")) {
    $current = (git -C $VsRoot rev-parse HEAD).Trim()
    if ($current -eq $pins.VOICESTUDIO_COMMIT) {
        Write-Skip "VoiceStudio at $VsRoot"
    } else {
        Write-Need "existing checkout is $current, not the pin"
        if ($DryRun) { Write-Plan "Leave the existing checkout unchanged." }
        else { Write-Log "  leaving $VsRoot unchanged so local work is not reset." }
    }
    if (-not (Test-Path (Join-Path $VsRoot ".venv"))) {
        Write-Need "VoiceStudio virtualenv"
        if ($DryRun) { Write-Plan "uv sync --no-dev in $VsRoot" }
        else { Push-Location $VsRoot; uv sync --no-dev; Pop-Location }
    } else {
        Write-Skip "VoiceStudio virtualenv"
    }
} else {
    Write-Need "VoiceStudio clone at $VsRoot"
    if ($DryRun) { Write-Plan "git clone $($pins.VOICESTUDIO_REPO) and checkout the pin, then uv sync --no-dev" }
    else {
        New-Item -ItemType Directory -Force -Path (Split-Path $VsRoot) | Out-Null
        git clone $pins.VOICESTUDIO_REPO $VsRoot
        git -C $VsRoot checkout --detach $pins.VOICESTUDIO_COMMIT
        Push-Location $VsRoot; uv sync --no-dev; Pop-Location
    }
}

# --- Reader deps ---
Write-Log "Checking Natural Voice Reader npm dependencies..."
if (Test-Path (Join-Path $NvrRoot "node_modules")) {
    Write-Skip "node_modules already present"
} else {
    Write-Need "npm ci"
    if ($DryRun) { Write-Plan "npm ci in $NvrRoot" }
    else { Push-Location $NvrRoot; npm ci; Pop-Location }
}

# --- Models ---
$VsPython = Join-Path $VsRoot ".venv\Scripts\python.exe"
$Packs = Join-Path $ScriptDir "voice-packs.py"
$PathsPy = Join-Path $ScriptDir "nvr_paths.py"
if ((Test-Path $PathsPy) -and (Test-Command "python")) {
    $py = if ($env:VOICESTUDIO_ROOT -and (Test-Path (Join-Path $env:VOICESTUDIO_ROOT ".venv\Scripts\python.exe"))) {
        Join-Path $env:VOICESTUDIO_ROOT ".venv\Scripts\python.exe"
    } elseif (Test-Path (Join-Path $VsRoot ".venv\Scripts\python.exe")) {
        Join-Path $VsRoot ".venv\Scripts\python.exe"
    } else { "python" }
    if (-not $DryRun) { & $py $PathsPy migrate }
} elseif ($DryRun) {
    Write-Plan "Move any legacy voice cache into $DataDir"
}

Write-Log "Checking the default KittenTTS voice pack..."
if ((Test-Path $VsPython) -and (Test-Path $Packs)) {
    & $VsPython $Packs check kittentts
    if ($LASTEXITCODE -eq 0) {
        Write-Skip "KittenTTS is already installed"
    } elseif ($DryRun) {
        Write-Need "KittenTTS voice pack"
        Write-Plan "Install the default KittenTTS pack (about 80 MB, Apache-2.0)."
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path $StatusFile) | Out-Null
        & $VsPython $Packs install kittentts --status-file $StatusFile
    }
} else {
    Write-Need "VoiceStudio Python and scripts/voice-packs.py to fetch KittenTTS"
}

Write-Log "Checking optional voice packs..."
if ((Test-Path $VsPython) -and (Test-Path $Packs)) {
    & $VsPython $Packs check omnivoice
    if ($LASTEXITCODE -eq 0) {
        Write-Skip "OmniVoice is already installed"
    } elseif ($WithOmniVoice) {
        Write-Need "OmniVoice weights (several GB, CC-BY-NC, not for commercial use)"
        if ($DryRun) { Write-Plan "Install the OmniVoice pack." }
        else { & $VsPython $Packs install omnivoice --status-file $StatusFile }
    } else {
        Write-Skip "OmniVoice is optional. Install it later from Settings or with: nvr voices install omnivoice"
    }
    & $VsPython $Packs check kokoro
    if ($LASTEXITCODE -eq 0) {
        Write-Skip "Kokoro is already installed"
    } else {
        Write-Skip "Kokoro is optional (Butler and Indian English). Install it later from Settings or with: nvr voices install kokoro"
    }
}

Write-Log ""
Write-Log "On Windows launch with scripts\nvr.cmd (untested)."
Write-Log "VoiceStudio remains a separate AGPL-3.0 project and must not be copied into this repo."
