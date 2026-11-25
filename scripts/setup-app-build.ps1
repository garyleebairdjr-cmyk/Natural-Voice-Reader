# Get a Windows machine ready to build the installed app (src-tauri/).
# Checks for each build tool and offers to install what is missing with
# winget, so a fresh clone builds instead of failing with a compiler error.
# UNTESTED on Windows so far.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\setup-app-build.ps1 [-DryRun] [-Yes] [-Build]

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$Build
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$pins = @{}
Get-Content (Join-Path $ScriptDir "pins.env") | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $name, $value = $_.Split('=', 2)
    $pins[$name.Trim()] = $value.Trim()
}
$NodeMajor = [int]$pins.NODE_MAJOR
$RustMin = [version]($(if ($pins.RUST_MIN_VERSION) { $pins.RUST_MIN_VERSION } else { "1.90" }))
$script:Missing = $false

function Write-Ok($m) { Write-Host "  ok:   $m" }
function Write-Need($m) { Write-Host "  need: $m" }
function Write-Plan($m) { Write-Host "  would: $m" }
function Test-Command($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Confirm-Step($question) {
    if ($Yes) { return $true }
    $reply = Read-Host "  $question [Y/n]"
    return ($reply -eq "" -or $reply -match '^[Yy]')
}

function Skip-Step {
    $script:Missing = $true
    Write-Host "  skipped. Install it later and run this script again."
}

# Pick up PATH changes from installers without opening a new terminal.
function Update-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
    $cargo = Join-Path $env:USERPROFILE ".cargo\bin"
    if (Test-Path $cargo) { $env:Path = "$cargo;$env:Path" }
}

function Install-Winget($id, $extra = @()) {
    if (-not (Test-Command "winget")) {
        Write-Host "  winget is not available. Install 'App Installer' from the Microsoft Store, then run this script again."
        $script:Missing = $true
        return
    }
    winget install -e --id $id --accept-package-agreements --accept-source-agreements @extra
    Update-Path
}

if ($DryRun) { Write-Host "Dry run. Nothing will be installed or changed." }

# --- Visual Studio C++ build tools ----------------------------------------
Write-Host "Checking the Visual C++ build tools..."
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vc = $null
if (Test-Path $vswhere) {
    $vc = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
if ($vc) {
    Write-Ok "C++ build tools at $vc"
} else {
    Write-Need "Microsoft C++ Build Tools (about 2 GB)"
    if ($DryRun) { Write-Plan "winget install Microsoft.VisualStudio.2022.BuildTools with the C++ workload" }
    elseif (Confirm-Step "Install the Microsoft C++ Build Tools? Windows will ask for permission.") {
        Install-Winget "Microsoft.VisualStudio.2022.BuildTools" @("--override", "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended")
    } else { Skip-Step }
}

# --- WebView2 -------------------------------------------------------------
Write-Host "Checking the WebView2 runtime..."
$wv2Keys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
)
$wv2 = $wv2Keys | Where-Object { Test-Path $_ } | ForEach-Object { (Get-ItemProperty $_).pv } | Where-Object { $_ -and $_ -ne "0.0.0.0" } | Select-Object -First 1
if ($wv2) {
    Write-Ok "WebView2 $wv2"
} else {
    Write-Need "Microsoft Edge WebView2 runtime"
    if ($DryRun) { Write-Plan "winget install Microsoft.EdgeWebView2Runtime" }
    elseif (Confirm-Step "Install the WebView2 runtime?") { Install-Winget "Microsoft.EdgeWebView2Runtime" }
    else { Skip-Step }
}

# --- Node.js --------------------------------------------------------------
Write-Host "Checking Node.js $NodeMajor+..."
$nodeOk = $false
if (Test-Command "node") {
    $major = [int]((node -v).TrimStart('v').Split('.')[0])
    $nodeOk = $major -ge $NodeMajor
}
if ($nodeOk) {
    Write-Ok "Node.js $(node -v)"
} else {
    Write-Need "Node.js $NodeMajor+"
    if ($DryRun) { Write-Plan "winget install OpenJS.NodeJS.LTS" }
    elseif (Confirm-Step "Install Node.js LTS?") { Install-Winget "OpenJS.NodeJS.LTS" }
    else { Skip-Step }
}

# --- Rust -----------------------------------------------------------------
Write-Host "Checking Rust $RustMin+..."
Update-Path
$rustVersion = $null
if (Test-Command "rustc") {
    $rustVersion = [version](((rustc --version) -split ' ')[1] -replace '-.*$', '')
}
if ($rustVersion -and $rustVersion -ge $RustMin) {
    Write-Ok "rustc $rustVersion"
} elseif (Test-Command "rustup") {
    Write-Need "Rust $RustMin+ (found $rustVersion)"
    if ($DryRun) { Write-Plan "rustup update stable" }
    elseif (Confirm-Step "Update Rust with rustup?") { rustup update stable; rustup default stable-msvc }
    else { Skip-Step }
} else {
    Write-Need "Rust (rustup is not installed)"
    if ($DryRun) { Write-Plan "winget install Rustlang.Rustup" }
    elseif (Confirm-Step "Install Rust with rustup?") {
        Install-Winget "Rustlang.Rustup"
        if (Test-Command "rustup") { rustup default stable-msvc }
    } else { Skip-Step }
}

# --- npm packages ---------------------------------------------------------
Write-Host "Checking npm packages..."
$tauriCli = Join-Path $Root "node_modules\.bin\tauri.cmd"
$stamp = Join-Path $Root "node_modules\.package-lock.json"
$lock = Join-Path $Root "package-lock.json"
if ((Test-Path $tauriCli) -and (Test-Path $stamp) -and ((Get-Item $stamp).LastWriteTime -gt (Get-Item $lock).LastWriteTime)) {
    Write-Ok "node_modules is up to date"
} elseif (-not (Test-Command "npm")) {
    Write-Need "npm (comes with Node.js; open a new terminal if Node.js was just installed)"
    $script:Missing = $true
} elseif ($DryRun) {
    Write-Plan "npm ci"
} else {
    Push-Location $Root
    try { npm ci } finally { Pop-Location }
}

Write-Host ""
if ($DryRun) { Write-Host "Dry run finished."; exit 0 }
if ($script:Missing) {
    Write-Host "Some build tools are still missing (see above). The app will not build until they are installed."
    exit 1
}
Write-Host "Ready to build."
Write-Host "  npm run app:dev     run the app with hot reload"
Write-Host "  npm run app:build   build installers into src-tauri\target\release\bundle\"
if ($Build) {
    Push-Location $Root
    try { npm run app:build } finally { Pop-Location }
}
