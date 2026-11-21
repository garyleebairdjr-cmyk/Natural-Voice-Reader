import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { isVoiceId } from "@/lib/voices";
import { splitSpeakable, VOICESTUDIO_MAX_CHARS } from "@/lib/sentences";
import { resolveSpeechRoute } from "@/lib/voice-routing";
import {
  DEFAULT_KOKORO_URL,
  DEFAULT_VOICESTUDIO_MODEL,
  DEFAULT_VOICESTUDIO_URL,
  TTS_COLD_TIMEOUT_MS,
  TTS_HEALTH_TIMEOUT_MS,
  TTS_WARM_TIMEOUT_MS,
  TTS_WARMUP_TEXT,
  isForbiddenTtsModel,
  isTtsModelId,
  modelLabel,
  type TtsDownloadProgress,
  type TtsStatus,
  voiceInstruction,
  voiceStudioVoice,
} from "@/lib/tts-config";


function bootstrapStatusPath(): string {
  if (process.env.NVR_STATUS_FILE?.trim()) return process.env.NVR_STATUS_FILE.trim();
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || process.env.USERPROFILE?.trim() || homedir();
    return join(base, "nvr", "status.json");
  }
  return join(homedir(), ".cache", "nvr", "status.json");
}

function readBootstrapStatus(): TtsDownloadProgress | null {
  const path = bootstrapStatusPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      state?: unknown;
      model?: unknown;
      percent?: unknown;
      message?: unknown;
    };
    const state = typeof raw.state === "string" ? raw.state : "";
    if (state !== "downloading" && state !== "warming") return null;
    const percent = typeof raw.percent === "number" && Number.isFinite(raw.percent) ? Math.max(0, Math.min(100, raw.percent)) : null;
    const model = typeof raw.model === "string" ? raw.model : null;
    const message =
      typeof raw.message === "string" && raw.message.trim()
        ? raw.message.trim()
        : state === "warming"
          ? "Loading voice engine. The first load can take a minute on this computer."
          : "Downloading the voice model. You can keep browsing the queue.";
    return { model, percent, message };
  } catch {
    return null;
  }
}

const XAI_MAX_CHARS = 5000;
const XAI_URL = "https://api.x.ai/v1/tts";

export type SpeechOk = {
  ok: true;
  audio: string;
  mime: string;
  provider: "voicestudio" | "kokoro" | "xai";
  model: string;
  speedApplied: boolean;
  slow?: boolean;
};

export type SpeechErr = {
  ok: false;
  error: string;
  loading?: boolean;
};

export type SpeechResult = SpeechOk | SpeechErr;

let lastPinnedModel: string | null = null;
let engineWarmed = false;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + size, bytes.length)));
  }
  return btoa(binary);
}

function voiceStudioBase(): string {
  return (process.env.VOICESTUDIO_URL ?? DEFAULT_VOICESTUDIO_URL).replace(/\/$/, "");
}

function kokoroBase(): string {
  return (process.env.KOKORO_URL ?? process.env.NVR_KOKORO_URL ?? DEFAULT_KOKORO_URL).replace(/\/$/, "");
}

function voiceStudioHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.VOICESTUDIO_API_KEY?.trim() || process.env.OMNIVOICE_API_KEY?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

export function requestedModel(raw: unknown): string {
  if (typeof raw === "string") {
    if (isForbiddenTtsModel(raw)) return DEFAULT_VOICESTUDIO_MODEL;
    if (isTtsModelId(raw)) return raw;
  }
  const fromEnv = process.env.VOICESTUDIO_TTS_MODEL?.trim() || process.env.NVR_TTS_MODEL?.trim();
  if (fromEnv && !isForbiddenTtsModel(fromEnv) && isTtsModelId(fromEnv)) return fromEnv;
  return DEFAULT_VOICESTUDIO_MODEL;
}

function clampSpeed(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 1;
  if (!Number.isFinite(n)) return 1;
  return Math.min(1.5, Math.max(0.7, n));
}

async function pingVoiceStudio(timeoutMs = TTS_HEALTH_TIMEOUT_MS): Promise<{
  up: boolean;
  engine: string | null;
  loading: boolean;
}> {
  try {
    const res = await fetch(`${voiceStudioBase()}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { up: false, engine: null, loading: res.status >= 500 };
    const body = (await res.json().catch(() => null)) as { engine?: unknown; status?: unknown } | null;
    const engine = typeof body?.engine === "string" ? body.engine : null;
    return { up: true, engine, loading: false };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : "";
    const loading = name === "TimeoutError" || /timeout|abort|network/i.test(message);
    return { up: false, engine: null, loading };
  }
}

function xaiConfigured(): boolean {
  return Boolean(process.env.XAI_API_KEY?.trim());
}

function loadingError(detail?: string): SpeechErr {
  return {
    ok: false,
    loading: true,
    error: detail?.trim()
      ? `Loading voice engine. ${detail.trim()}`
      : "Loading voice engine. The first load can take a minute on this computer.",
  };
}

function statusFor(
  health: { up: boolean; engine: string | null; loading: boolean },
  model: string,
  extra?: Partial<TtsStatus>,
): TtsStatus {
  const hasXai = xaiConfigured();
  const download = extra?.download ?? readBootstrapStatus();
  const downloading = Boolean(download) && (extra?.state === "downloading" || download !== null && !extra?.state);
  if (download && (downloading || extra?.state === "downloading" || extra?.state === "loading")) {
    return {
      provider: "voicestudio",
      model,
      state: "downloading",
      voicestudioUp: health.up,
      xaiConfigured: hasXai,
      message: download.message,
      download,
    };
  }
  if (health.up) {
    return {
      provider: "voicestudio",
      model,
      state: extra?.state ?? "ready",
      voicestudioUp: true,
      xaiConfigured: hasXai,
      message: extra?.message ?? `Using local VoiceStudio (${modelLabel(model)}).`,
      download: extra?.download,
    };
  }
  if (health.loading || download) {
    return {
      provider: "voicestudio",
      model,
      state: download ? "downloading" : "loading",
      voicestudioUp: false,
      xaiConfigured: hasXai,
      message: download?.message ?? "Loading voice engine. The first load can take a minute on this computer.",
      download: download ?? undefined,
    };
  }
  if (hasXai) {
    return {
      provider: "xai",
      model: "xai",
      state: "ready",
      voicestudioUp: false,
      xaiConfigured: true,
      message: "VoiceStudio is not running. Using the xAI cloud voice.",
    };
  }
  return {
    provider: "none",
    model: null,
    state: "unavailable",
    voicestudioUp: false,
    xaiConfigured: false,
    message:
      "Generated voices are not available. VoiceStudio is not running and no xAI key is configured, so every named voice uses this browser's device voice.",
  };
}

export const getTtsStatus = createServerFn({ method: "GET" }).handler(async (): Promise<TtsStatus> => {
  const model = requestedModel(undefined);
  const health = await pingVoiceStudio();
  if (health.up && !engineWarmed) {
    return statusFor(health, model, {
      state: "loading",
      message: `Loading voice engine (${modelLabel(model)}). The first load can take a minute.`,
    });
  }
  return statusFor(health, model);
});

type SpeakInput = {
  text: string;
  voiceId: string;
  speed: number;
  model: string;
  instruct?: string;
};

async function pinVoiceStudioEngine(model: string): Promise<string | null> {
  if (isForbiddenTtsModel(model) || !isTtsModelId(model)) {
    return `Refused to pin an unsupported engine.`;
  }
  if (lastPinnedModel === model) return null;
  try {
    const res = await fetch(`${voiceStudioBase()}/engines/select`, {
      method: "POST",
      headers: voiceStudioHeaders(),
      body: JSON.stringify({ family: "tts", backend_id: model }),
      signal: AbortSignal.timeout(TTS_HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return `Could not pin ${modelLabel(model)} (${res.status}).`;
    }
    const body = (await res.json().catch(() => null)) as { active?: unknown } | null;
    const active = typeof body?.active === "string" ? body.active : null;
    if (active && active !== model && model === "omnivoice") {
      // VoiceStudio remaps model "omnivoice" to the active engine. If we
      // cannot make OmniVoice the active engine, later speech calls would
      // silently use something else (for example pockettts).
      return `VoiceStudio is using ${active} as the active engine, not OmniVoice.`;
    }
    lastPinnedModel = model;
    engineWarmed = false;
    return null;
  } catch {
    return "Loading voice engine. Could not pin the engine yet.";
  }
}

async function postSpeech(input: SpeakInput, timeoutMs: number): Promise<SpeechResult> {
  const body: Record<string, unknown> = {
    model: input.model,
    input: input.text,
    voice: voiceStudioVoice(input.model, input.voiceId),
    response_format: "mp3",
    speed: input.speed,
    language: "en",
    denoise: true,
  };
  const instruct = input.instruct ?? (input.model !== "kittentts" ? voiceInstruction(input.voiceId) : undefined);
  if (instruct) {
    body.instruct = instruct;
    body.instructions = instruct;
  }

  let res: Response;
  try {
    res = await fetch(`${voiceStudioBase()}/v1/audio/speech`, {
      method: "POST",
      headers: voiceStudioHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : "";
    if (name === "TimeoutError" || /timeout|abort/i.test(message)) {
      return loadingError("The first load can take a minute on this computer.");
    }
    return loadingError("Could not reach local VoiceStudio.");
  }

  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) {
      return loadingError(`VoiceStudio is busy (${res.status}).`);
    }
    return { ok: false, error: `VoiceStudio error (${res.status}).` };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength < 64) return { ok: false, error: "VoiceStudio came back empty." };
  engineWarmed = true;
  lastPinnedModel = input.model;
  return {
    ok: true,
    audio: bytesToBase64(bytes),
    mime: res.headers.get("content-type")?.split(";")[0].trim() || "audio/mpeg",
    provider: "voicestudio",
    model: input.model,
    speedApplied: true,
  };
}

async function speakVoiceStudio(input: SpeakInput, cold: boolean): Promise<SpeechResult> {
  const pinError = await pinVoiceStudioEngine(input.model);
  if (pinError && input.model === "omnivoice") {
    return loadingError(pinError);
  }

  const timeoutMs = cold || !engineWarmed ? TTS_COLD_TIMEOUT_MS : TTS_WARM_TIMEOUT_MS;
  let result = await postSpeech(input, timeoutMs);
  if (!result.ok && result.loading) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    result = await postSpeech(input, TTS_COLD_TIMEOUT_MS);
  }
  return result;
}

async function speakKokoro(input: SpeakInput, voice: string): Promise<SpeechResult> {
  const timeoutMs = engineWarmed ? TTS_WARM_TIMEOUT_MS : TTS_COLD_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(`${kokoroBase()}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kokoro",
        input: input.text,
        voice,
        speed: input.speed,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : "";
    if (name === "TimeoutError" || /timeout|abort/i.test(message)) {
      return loadingError("The Kokoro voice helper is still starting.");
    }
    return {
      ok: false,
      error: "The Kokoro voice helper is not running. Start the reader with nvr so Butler and the accented English voices are available.",
    };
  }
  if (!res.ok) {
    if (res.status === 503) return loadingError("The Kokoro voice helper is still starting.");
    if (res.status >= 500) return loadingError(`Kokoro is busy (${res.status}).`);
    return { ok: false, error: `Kokoro error (${res.status}).` };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength < 64) return { ok: false, error: "Kokoro came back empty." };
  return {
    ok: true,
    audio: bytesToBase64(bytes),
    mime: res.headers.get("content-type")?.split(";")[0].trim() || "audio/wav",
    provider: "kokoro",
    model: "kokoro",
    speedApplied: true,
  };
}

async function speakXai(input: SpeakInput): Promise<SpeechResult> {

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey?.trim()) return { ok: false, error: "Voice is not available in this environment." };

  let res: Response;
  try {
    res = await fetch(XAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        text: input.text,
        voice_id: input.voiceId,
        language: "en",
      }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { ok: false, error: "Could not reach the voice service." };
  }

  if (!res.ok) return { ok: false, error: `Voice service error (${res.status}).` };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength < 64) return { ok: false, error: "The voice came back empty." };
  return {
    ok: true,
    audio: bytesToBase64(bytes),
    mime: "audio/mpeg",
    provider: "xai",
    model: "xai",
    speedApplied: false,
  };
}

export const prepareTtsEngine = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = input as { model?: unknown };
    return { model: requestedModel(raw.model) };
  })
  .handler(async ({ data }): Promise<TtsStatus> => {
    const model = data.model;
    const health = await pingVoiceStudio();
    if (!health.up && !health.loading) return statusFor(health, model);
    const pinError = await pinVoiceStudioEngine(model);
    if (pinError && model === "omnivoice") {
      return statusFor(health, model, { state: "loading", message: `Loading voice engine. ${pinError}` });
    }
    const warm = await postSpeech(
      { text: TTS_WARMUP_TEXT, voiceId: "leo", speed: 1, model },
      TTS_COLD_TIMEOUT_MS,
    );
    if (!warm.ok) {
      const retry = await postSpeech(
        { text: TTS_WARMUP_TEXT, voiceId: "leo", speed: 1, model },
        TTS_COLD_TIMEOUT_MS,
      );
      if (!retry.ok) {
        return statusFor(await pingVoiceStudio(), model, {
          state: "loading",
          message: retry.error || "Loading voice engine. The first load can take a minute on this computer.",
        });
      }
    }
    engineWarmed = true;
    lastPinnedModel = model;
    return statusFor(await pingVoiceStudio(), model, {
      state: "ready",
      message: `Using local VoiceStudio (${modelLabel(model)}). The engine is ready.`,
    });
  });

export const synthesizeSpeech = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = input as {
      text?: unknown;
      voiceId?: unknown;
      speed?: unknown;
      model?: unknown;
    };
    const text = typeof raw.text === "string" ? raw.text.replace(/\s+/g, " ").trim() : "";
    const voiceId = typeof raw.voiceId === "string" && isVoiceId(raw.voiceId) ? raw.voiceId : "leo";
    const speed = clampSpeed(raw.speed);
    const model = requestedModel(raw.model);
    if (!text) throw new Error("Nothing to read.");
    if (text.length > Math.max(XAI_MAX_CHARS, VOICESTUDIO_MAX_CHARS)) {
      throw new Error("A spoken piece is too long.");
    }
    return { text, voiceId, speed, model };
  })
  .handler(async ({ data }): Promise<SpeechResult> => {
    const pieces = splitSpeakable(data.text);
    if (pieces.length === 0) throw new Error("Nothing to read.");
    const text =
      pieces.length === 1 ? pieces[0]! : data.text.length <= VOICESTUDIO_MAX_CHARS ? data.text : pieces[0]!;
    const input = { ...data, text };

    const route = resolveSpeechRoute(data.voiceId, data.model);
    if (route.provider === "kokoro") {
      const local = await speakKokoro(input, route.voice);
      if (local.ok) return { ...local, slow: route.slow };
      // Do not fall back to another engine; that would drop the intended accent.
      return local;
    }

    const routed: SpeakInput = route.instruct
      ? { ...input, model: route.model, instruct: route.instruct }
      : { ...input, model: route.model };
    const health = await pingVoiceStudio();
    if (health.up || health.loading) {
      const local = await speakVoiceStudio(routed, !engineWarmed || health.loading || route.slow);
      if (local.ok) return { ...local, slow: route.slow };
      // Specialty voices (German English) must keep their engine; do not swap in xAI.
      if (route.instruct) {
        if (!local.ok && /not available|could not reach|not running/i.test(local.error)) {
          return {
            ok: false,
            error: "This German English voice needs OmniVoice. Install it with ./scripts/install.sh --with-omnivoice, then try again.",
          };
        }
        return local;
      }
      if (xaiConfigured() && !local.loading) {
        const cloud = await speakXai(input);
        if (cloud.ok) return cloud;
      }
      return local;
    }

    if (route.instruct) {
      return {
        ok: false,
        error: "This German English voice needs local OmniVoice. Start the reader with nvr, and install OmniVoice with ./scripts/install.sh --with-omnivoice if it is missing.",
      };
    }
    if (xaiConfigured()) return speakXai(input);
    return { ok: false, error: "Voice is not available in this environment." };
  });
