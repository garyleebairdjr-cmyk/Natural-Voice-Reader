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
  Butler and the Indian English voices
- Optional: an `XAI_API_KEY` in the server environment as a cloud fallback.
  Without VoiceStudio or that key, the app uses this browser's device voice.

## Install (Linux, macOS, Windows)

The script-based bootstrap checks for Node.js 22+, uv, Python 3.11, the
reader's npm dependencies, and a pinned VoiceStudio checkout. Missing pieces
are installed. KittenTTS weights download on demand from Hugging Face into
the per-user cache, with progress shown in the reader UI. That is the only
pack the installer adds by default. Optional packs such as Kokoro (Butler and
Indian English) and OmniVoice are installed later from **Settings > Voice packs**
or with `nvr voices install <id>`. OmniVoice weights are larger and CC-BY-NC
(not for commercial use); `--with-omnivoice` still fetches that pack at install
time if you want it immediately.

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
Indian English voices (Mira, Arjun) use a small Kokoro helper on port 3901.
If VoiceStudio is down, the original KittenTTS/OmniVoice voices fall back to
xAI when `XAI_API_KEY` is set, then to this browser's device voice. Butler and
the Indian English voices do not fall back, so the accent is not silently
replaced.

`nvr` pins one exact VoiceStudio engine (`kittentts` by default, or
`omnivoice` if you set `NVR_TTS_MODEL=omnivoice`) and warms it, and also
starts Kokoro. Choose **Fast local** (KittenTTS) or **Best quality (slow)**
(OmniVoice) in the app to switch the standard voices. The first load can take
a minute; the reader shows "Loading voice engine" or a download percent
instead of treating that wait as a failure. Never use `voxcpm2`. OmniVoice
weights are CC-BY-NC (personal use only). A **Soft room** toggle adds a light
playback-only room tone; downloads stay dry.


## Voice packs

The reader ships a catalog in `voices/catalog.json`. Each pack declares its
engine, voices (with language, accent, and gender tags), download source,
pinned revision, file checksums where feasible, size, SPDX license, and
whether it may be used commercially. The current packs are:

- **kittentts** — default, Apache-2.0, the standard English voices
- **kokoro** — optional, Apache-2.0, Butler (British), Mira, and Arjun
- **omnivoice** — optional, CC-BY-NC, enables **Best quality (slow)**

Installed voices appear in the searchable voice picker, grouped by accent or
language, with gender, engine, and quality badges. Favorites and recent voices
stay at the top. A compact version of the picker lives in the playback bar so
you can change the voice while Settings is hidden.

The settings panel can be hidden to give the queue the full width. Use the
Settings button, or press `,` (or Ctrl+, / Cmd+,). On screens narrower than
1024px the panel starts collapsed and opens as a slide-over drawer. That
preference is saved with the rest of the reader settings.

`Clear queue` removes every card, after a confirmation, and offers Undo.
`Reset to defaults` restores the voice, speed, volume, engine, and settings
panel without touching the queue or installed packs.

```sh
nvr voices list
nvr voices install kokoro
nvr voices remove kokoro
nvr voices browse
nvr voices browse ljspeech
```

Downloads go into the per-user cache, are verified when checksums are in the
catalog, and can be removed to free disk space. The UI and the CLI only accept
pack ids from the official catalog, a validated community index, or your
overlays. They will not fetch an arbitrary URL from the client.

### Community packs

**Settings > Voice packs > Browse** loads a remote community index (the same
schema as `voices/catalog.json`). The default index is
`voices/community-catalog.json` in this repository
(`raw.githubusercontent.com/garyleebairdjr-cmyk/Natural-Voice-Reader/main/voices/community-catalog.json`).
The server fetches that JSON, checks the schema, allows only https hosts such
as `github.com` and `huggingface.co`, caps the index size, and requires a
sha256 digest on every community pack file. Installing writes an overlay under
`~/.config/nvr/voices.d/` marked `community` and then uses the normal install
path.

The shipped community index currently includes two English Piper packs whose
MODEL_CARDs are clearly licensed and were trained from scratch: LJ Speech
(public domain) and LibriTTS (CC BY 4.0). Voices fine-tuned from Lessac,
marked non-commercial, or with unclear cards (including `en_GB-alan`) are not
listed. A Piper-capable helper is still needed to *speak* those packs after
they are installed.

Advanced users can add another catalog URL in Settings, with a warning that
the source must be trusted. `NVR_COMMUNITY_INDEX` can point at a local file
and `NVR_CATALOG_ALLOW_LOCAL=1` allows `file://` or localhost indexes for
testing.

### Adding your own packs

Place a JSON file next to the official schema in `~/.config/nvr/voices.d/`
(on Windows, `%APPDATA%\nvr\voices.d\`). See `voices/overlay.example.json`.
Overlay files use the same catalog schema. New pack ids are merged in;
overlay ids cannot replace an official pack. Supported source kinds today are
`huggingface` and `tarball` (https only). Engines listed in the catalog can
include `piper` and other extensions; speaking a custom engine still needs a
compatible local helper.

## Roadmap

The speech pipeline is already typed so later STT, translation, and smaller
on-device models can slot in without rewriting the queue UI. A German-accented
English voice is not shipped today: a style-prompted English model sounded
American. That should wait for a native-German speaker model, not an overlay
or caricature. Japanese English was also dropped from the picker after the
available speakers sounded unnaturally high-pitched.

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

## License

MIT, see [LICENSE](LICENSE). Third-party engines and voice models keep their own licenses, listed in [THIRD_PARTY.md](THIRD_PARTY.md). VoiceStudio (AGPL-3.0) is a separate download and is not included here, and the OmniVoice weights are non-commercial only.
