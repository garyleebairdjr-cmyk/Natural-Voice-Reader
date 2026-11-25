# Installed app (Tauri)

Natural Voice Reader ships as a web app today. This document covers the
installed app for macOS, Windows, Linux, and Android: how it is put together,
how to build it, what is done, and how it gets to users.

## How it fits together

- **One UI.** The React reader is the same code as the web build.
  `npm run build:desktop` (`vite build --mode desktop`) produces a static,
  client-only bundle in `dist/client/`, which Tauri loads. The web/Vercel build
  (`npm run build`) is unchanged.
- **Platform layer.** Components call `src/lib/platform/` instead of
  `*.functions.ts`. In a browser those calls go to the TanStack Start server
  functions as before. Inside the app (`window.__TAURI_INTERNALS__` is present)
  they go to Rust commands in `src-tauri/src/` through
  `src/lib/platform/desktop.ts`.
- **Speech (planned).** Native [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
  in Rust runs Kokoro, KittenTTS, and Piper on all four platforms with no
  Python. OmniVoice needs PyTorch and stays with the script install
  (`scripts/install.sh`).

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Tauri shell, static bundle, platform layer, page reading in Rust, icons | Done (Linux build needs system libraries, below) |
| 2 | sherpa-onnx speech in Rust (Kokoro, KittenTTS, Piper); confirm the KittenTTS mini 0.8 model converts | Next |
| 3 | Voice pack download, checksum, and remove in Rust; community catalog | Planned |
| 4 | CI builds for all platforms, signing, notarization, auto-update, GitHub Releases | Planned |
| 5 | Android: phone layout, model storage, background audio, Play Store build | Planned |
| — | Google sign-in for the app (needs a Desktop/Android OAuth client and a loopback/PKCE flow) | Later |

What works in the app today:

- The full reader UI, queue, settings, themes, and downloads of device-voice
  playback where the platform supports it.
- **Link** reading: Rust fetches the page (http/https only, no private or
  local addresses, DNS results pinned for the request, 4 redirects, 1.5 MB cap,
  12 s timeout). The webview turns it into reading text with the same
  `readableFromBody` helper as the server.
- Voice packs are listed from the bundled catalog. Install, remove, and
  community browse report that they are not in this version yet.
- Every voice uses the device voice. Google sign-in is hidden.

Known issue: the prerendered SPA shell logs one React hydration warning
(#418) on start. React recovers by rendering on the client, which is what the
app does anyway; nothing is lost. It comes from TanStack Start's SPA shell
and should be revisited when Start is upgraded.

## Build it

Requirements: Node 22+, Rust (stable, via rustup), and the Tauri system
libraries for your OS ([Tauri prerequisites](https://tauri.app/start/prerequisites/)).

Ubuntu / Debian:

```sh
sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev build-essential curl wget file libxdo-dev libssl-dev
```

macOS: Xcode Command Line Tools (`xcode-select --install`).
Windows: Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 11).

```sh
npm ci
npm run app:dev      # app window with hot reload (dev server on 127.0.0.1:1420)
npm run app:build    # installers in src-tauri/target/release/bundle/
npm run test:rust    # Rust unit tests (address and URL checks)
```

`app:build` makes the formats for the OS it runs on: `.deb`, `.rpm`, and
`.AppImage` on Linux; `.app` and `.dmg` on macOS; `.msi` and `.exe` (NSIS) on
Windows. Each OS has to build its own installers, which is why releases come
from CI (phase 4).

The app id is `io.github.garyleebairdjr.naturalvoicereader` in
`src-tauri/tauri.conf.json`. Choose the final id before the first store
listing; stores do not let it change afterwards.

## Downloads on the website

Yes. The plan for phase 4:

1. A GitHub Actions workflow (`tauri-apps/tauri-action`) builds on macOS
   (Apple Silicon and Intel), Windows, and Linux runners whenever a version
   tag such as `v0.2.0` is pushed.
2. It uploads the installers to a GitHub Release, plus a `latest.json` that
   the app's updater checks.
3. The website gets a Download page that links to the latest release assets
   (GitHub's `releases/latest/download/<file>` URLs stay stable) and picks
   the right file for the visitor's OS.

Unsigned builds work but warn people: macOS blocks them until the user
allows them in System Settings, and Windows SmartScreen shows "Windows
protected your PC". Signing removes those warnings (next section).

## Signing and app stores

| Channel | What you need | Cost | Notes |
| --- | --- | --- | --- |
| macOS download (outside the App Store) | Apple Developer Program membership; a "Developer ID Application" certificate; notarization | $99/year | Required to avoid Gatekeeper warnings. CI signs and notarizes with the certificate and an app-specific password or API key stored as secrets. |
| Mac App Store | Same Apple membership; App Store Connect listing; app sandbox entitlements; review | (included) | Sandboxing limits file access; voice models must live in the app container. Review checks privacy details and a support URL. |
| Windows download | A code-signing certificate (OV/EV), or Azure Trusted Signing | about $10/month (Azure) to a few hundred $/year | Builds trust with SmartScreen. Unsigned works with a warning. |
| Microsoft Store | Partner Center developer account; MSIX package | free for individuals | The Store signs the package for you, so no certificate is needed for this channel. |
| Linux | Nothing required | free | Ship `.deb`, `.rpm`, `.AppImage`. Optional: Flathub (review, free) and the Snap Store (free). |
| Google Play | Play Console account; an upload key; a privacy policy URL; content rating and Data safety forms | $25 once | New personal accounts must run a closed test with at least 12 testers for 14 days before production. Play requires an `.aab` bundle. |
| Android sideload / website | A release signing key | free | Users allow "install unknown apps". |

Things every store asks for: an app name and icon (in `src-tauri/icons/`),
screenshots (see `docs/screenshots/`), a short and long description, a
privacy policy page, a support contact, and license details. The voice model
licenses in `THIRD_PARTY.md` matter here: OmniVoice is non-commercial and is
not shipped in the app, and VoiceStudio (AGPL) is not bundled.
