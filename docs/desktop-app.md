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
- **Speech.** [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) runs in
  Rust (`src-tauri/src/speech/`): KittenTTS for the standard voices and Kokoro
  for Butler, Mira, and Arjun. No Python and no espeak-ng (GPL), so the app
  stays MIT. Text is turned into phonemes in Rust:
  1. **Cleanup** (`normalize.rs`): times, money, percentages, ordinals, years,
     and other numbers become words ("6:30 a.m." becomes "six thirty A M").
  2. **Dictionary** (piper-plus-g2p with CMUdict) gives espeak-style IPA, with
     stress and common suffixes handled.
  3. **Neural guesser** (`neural.rs`, a Rust port of g2p_en's small GRU model)
     reads words that are not in the dictionary, such as names, instead of
     spelling them letter by letter. Short all-caps words are still spelled
     as acronyms.
  4. **Kokoro** uses the pack's British lexicon first, so Butler keeps his
     accent, and converts anything else to Kokoro's symbols.
  OmniVoice needs PyTorch and stays with the script install (`scripts/install.sh`).

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Tauri shell, static bundle, platform layer, page reading in Rust, icons | Done |
| 2 | On-device speech with sherpa-onnx (KittenTTS, Kokoro), pronunciation without espeak-ng | Done on Linux |
| 3 | Voice pack download, checksum, unpack, and remove in Rust; first-run install of KittenTTS | Done on Linux |
| — | Build setup scripts that install missing compilers and libraries | Done (Linux tested; macOS and Windows untested) |
| 4 | CI builds for all platforms, unsigned releases, auto-update | Next |
| 5 | Android: phone layout, model storage, background audio, APK | Planned |
| — | Community (Piper) packs, Google sign-in in the app | Later |

What the app does today:

- The full reader UI, queue, settings, themes, and audio downloads (WAV).
- **Generated voices on the device.** On first launch the app downloads the
  KittenTTS pack (about 67 MB) in the background, like the script installer
  does. Kokoro (Butler, Mira, Arjun, about 130 MB) is one click in
  **Settings > Voice packs**. A pack removed there is not downloaded again.
- Packs are stored in the same folder as `nvr voices install`, so a pack
  installed either way works for both.
- **Link** reading: Rust fetches the page (http/https only, no private or
  local addresses, DNS results pinned for the request, 4 redirects, 1.5 MB
  cap, 12 s timeout). The webview turns it into reading text with the same
  `readableFromBody` helper as the server.
- Hidden in the app for now: OmniVoice and the engine switch, community pack
  browsing, and Google sign-in.

Known issue: the prerendered SPA shell logs one React hydration warning
(#418) on start. React recovers by rendering on the client, which is what the
app does anyway; nothing is lost. It comes from TanStack Start's SPA shell
and should be revisited when Start is upgraded.

## Build it

One command checks for every build tool and offers to install what is
missing. It asks before each install, and before using `sudo`.

Linux and macOS:

```sh
./scripts/setup-app-build.sh            # or: npm run app:setup
./scripts/setup-app-build.sh --dry-run  # show what is missing, change nothing
./scripts/setup-app-build.sh --yes --build  # install without asking, then build
```

Windows (PowerShell, **untested**):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-app-build.ps1 [-DryRun] [-Yes] [-Build]
```

What it installs when missing:

| Need | Linux | macOS | Windows |
| --- | --- | --- | --- |
| C compiler and SDK | build-essential (apt), gcc (dnf/zypper), base-devel (pacman) | Xcode Command Line Tools | Visual Studio 2022 C++ Build Tools |
| Web view | WebKitGTK 4.1 dev files, librsvg, OpenSSL, GStreamer plugins | built in | WebView2 runtime |
| Rust 1.90+ | rustup (into `~/.cargo`, no sudo) | rustup | rustup (winget) |
| Node.js 22+ | official build in `~/.local/nvr/node` | Homebrew | winget |
| npm packages | `npm ci` | `npm ci` | `npm ci` |

Then:

```sh
npm run app:dev      # app window with hot reload (dev server on 127.0.0.1:1420)
npm run app:build    # installers in src-tauri/target/release/bundle/
npm run test:rust    # Rust unit tests
```

`app:build` makes the formats for the OS it runs on: `.deb`, `.rpm`, and
`.AppImage` on Linux; `.app` and `.dmg` on macOS; `.msi` and `.exe` (NSIS) on
Windows. Each OS has to build its own installers, which is why releases come
from CI (phase 4).

Optional Rust tests that use real models or the network:

```sh
NVR_TEST_SHERPA_ROOT=~/.local/share/nvr/sherpa npm run test:rust   # speak with installed packs
NVR_TEST_PACK_ROOT=/tmp/nvr-pack-test npm run test:rust            # download, verify, remove KittenTTS
```

### What end users need

Nothing beyond the installer. The `.deb` and `.rpm` declare WebKitGTK, GTK,
and the GStreamer plugins, so the package manager installs them. The
AppImage carries its own libraries. The Windows installer downloads WebView2
if it is missing. macOS 10.15 or newer has everything built in. The speech
engine is compiled into the app; voices download on first launch.

The app id is `io.github.garyleebairdjr.naturalvoicereader` in
`src-tauri/tauri.conf.json`. A store publisher would use their own id.

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

This project ships unsigned downloads; it does not hold Apple, Windows
signing, or store accounts. The table is for anyone who wants to publish a
signed build or a store listing under their own account.

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
