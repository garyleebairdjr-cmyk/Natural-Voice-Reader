# Natural Voice Reader

Natural Voice Reader turns pasted text and public web pages into a listenable
reading queue. Choose a voice and playback speed, move between reading cards,
and download generated audio. Your queue and preferences are stored in this
browser.

## Requirements

- Node.js 22 or newer
- npm
- Optional: a local VoiceStudio API on `http://127.0.0.1:3900` (preferred for
  generated voices) and a local Kokoro helper on `http://127.0.0.1:3901` for
  Butler and the accented English voices
- Optional: an `XAI_API_KEY` in the server environment as a cloud fallback.
  Without VoiceStudio or that key, the app uses this browser's device voice.

## Install (Linux, macOS, Windows)

The script-based bootstrap checks for Node.js 22+, uv, Python 3.11, the
reader's npm dependencies, and a pinned VoiceStudio checkout. Missing pieces
are installed. KittenTTS weights download on demand from Hugging Face into
the per-user cache, with progress shown in the reader UI. Kokoro (Apache-2.0)
downloads by default into `~/.cache/nvr/sherpa` for Butler and the Indian and
Japanese English voices. OmniVoice weights are larger and CC-BY-NC, so they
download only with `--with-omnivoice` or when you later choose **Best quality
(slow)**. The German English voices need OmniVoice.

Linux and macOS:

```sh
./scripts/install.sh
```

`./scripts/install.sh --dry-run` prints what would happen and changes nothing.
The macOS path uses the same script; it has not been run on a Mac in this
work.

Windows (PowerShell, **untested**):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

VoiceStudio is AGPL-3.0 and is fetched as a separate, pinned repository. It
is not vendored into this project. See `THIRD_PARTY.md` for model licenses
and AGPL notes. A packaged desktop app (Tauri, later) is a future option;
the installer today is the script bootstrap.

## Run locally

The usual way is one command, which stops leftover VoiceStudio, Kokoro, or
reader listeners on ports 3900, 3901, and 8080, starts VoiceStudio and the
Kokoro helper, waits for health, downloads a missing voice model if needed,
warms the engines, starts the reader, and opens the browser. Press Ctrl+C to
stop them.

```sh
nvr
```

That command is a symlink to `scripts/nvr.sh`. If `nvr` is not on your PATH
yet, run:

```sh
~/Dev/Source/Natural-Voice-Reader/scripts/nvr.sh
```

On Windows use `scripts\nvr.cmd` (**untested**).

Or, after `npm ci`, start only the reader (VoiceStudio must already be running):

```sh
npm run dev
```

Open `http://localhost:8080`. The app's checked-in workspace config keeps
authentication disabled for local development. Never expose secrets through a
`VITE_`-prefixed variable. `scripts/with-app-env.mjs` only loads `VITE_` flags
from `.grok/app-env.json`; it does not load API keys.

## Local voices (VoiceStudio)

The reader prefers a local VoiceStudio server and speaks sentence by sentence
so playback can start before a whole card is ready. Butler (British) and the
Indian and Japanese English voices use a small Kokoro helper on port 3901.
German English voices use OmniVoice with a mild-accent instruction and are
much slower. If VoiceStudio is down, the original KittenTTS/OmniVoice voices
fall back to xAI when `XAI_API_KEY` is set, then to this browser's device
voice. Specialty voices do not fall back, so the accent is not silently
replaced.

`nvr` pins one exact VoiceStudio engine (`kittentts` by default, or
`omnivoice` if you set `NVR_TTS_MODEL=omnivoice`) and warms it, and also
starts Kokoro. Choose **Fast local** (KittenTTS) or **Best quality (slow)**
(OmniVoice) in the app to switch the standard voices. The first load can take
a minute; the reader shows "Loading voice engine" or a download percent
instead of treating that wait as a failure. Never use `voxcpm2`. OmniVoice
weights are CC-BY-NC (personal use only). A **Soft room** toggle adds a light
playback-only room tone; downloads stay dry.

## Useful commands

```sh
npm run typecheck
npm test
npm run lint
npm run build
```

## Notes

- Text cards, playback preferences, and the reading queue are persisted in
  browser storage; they are not synced between devices.
- Reading a URL fetches its public page on the server. Some pages may block
  fetching or require a browser to render their content.
- The project includes optional authentication and database infrastructure.
  Enabling authentication outside the hosted preview requires the appropriate
  OAuth client credentials, an auth URL, and a PostgreSQL `DATABASE_URL`.
