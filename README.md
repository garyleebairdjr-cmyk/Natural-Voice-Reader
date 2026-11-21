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

```sh
npm ci
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

Start VoiceStudio's API, then the reader:

```sh
cd ~/Dev/Source/VoiceStudio
bun run dev:api
```

In another terminal:

```sh
cd ~/Dev/Source/Natural-Voice-Reader
npm run dev
```

Open `http://localhost:8080`. Choose **Best local** (OmniVoice) or **Fast local**
(KittenTTS). Keep VoiceStudio running while you listen.

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
