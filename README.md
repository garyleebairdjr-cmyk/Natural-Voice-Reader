# Natural Voice Reader

Natural Voice Reader turns pasted text and public web pages into a listenable
reading queue. Choose a voice and playback speed, move between reading cards,
and download generated audio. Your queue and preferences are stored in this
browser.

## Requirements

- Node.js 22 or newer
- npm
- Optional: a local VoiceStudio API on `http://127.0.0.1:3900` (preferred for
  generated voices)
- Optional: an `XAI_API_KEY` in the server environment as a cloud fallback.
  Without VoiceStudio or that key, the app uses this browser's device voice.

## Run locally

The usual way on this machine is one command, which stops any leftover
VoiceStudio or reader listeners on ports 3900 and 8080, starts VoiceStudio,
waits for health, warms the voice engine, starts the reader, and opens the
browser. Press Ctrl+C to stop both.

```sh
nvr
```

That command is a symlink to `scripts/nvr.sh`. If `nvr` is not on your PATH
yet, run:

```sh
~/Dev/Source/Natural-Voice-Reader/scripts/nvr.sh
```

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
so playback can start before a whole card is ready. If VoiceStudio is down, it
falls back to xAI when `XAI_API_KEY` is set, then to this browser's device
voice.

`nvr` pins one exact engine (`omnivoice` by default, or `kittentts` if you
set `NVR_TTS_MODEL=kittentts`) and warms it before the browser opens. Choose
**Best local** (OmniVoice) or **Fast local** (KittenTTS) in the app to switch.
The first load can take a minute; the reader shows "Loading voice engine"
instead of treating that wait as a failure. Never use `voxcpm2`.

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
