import { createServerFn } from "@tanstack/react-start";
import { isVoiceId } from "@/lib/voices";
import { splitSpeakable, VOICESTUDIO_MAX_CHARS } from "@/lib/sentences";
import {
  DEFAULT_VOICESTUDIO_MODEL,
  DEFAULT_VOICESTUDIO_URL,
  TTS_COLD_TIMEOUT_MS,
  TTS_HEALTH_TIMEOUT_MS,
  TTS_WARM_TIMEOUT_MS,
  TTS_WARMUP_TEXT,
  isForbiddenTtsModel,
  isTtsModelId,
  modelLabel,
  type TtsStatus,
  voiceInstruction,
  voiceStudioVoice,
} from "@/lib/tts-config";

const XAI_MAX_CHARS = 5000;
const XAI_URL = "https://api.x.ai/v1/tts";

export type SpeechOk = {
  ok: true;
  audio: string;
  mime: string;
  provider: "voicestudio" | "xai";
  model: string;
  speedApplied: boolean;
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
  if (health.up) {
    return {
      provider: "voicestudio",
      model,
      state: extra?.state ?? "ready",
      voicestudioUp: true,
      xaiConfigured: hasXai,
      message: extra?.message ?? `Using local VoiceStudio (${modelLabel(model)}).`,
    };
  }
  if (health.loading) {
    return {
      provider: "voicestudio",
      model,
      state: "loading",
      voicestudioUp: false,
      xaiConfigured: hasXai,
      message: "Loading voice engine. The first load can take a minute on this computer.",
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
  if (input.model !== "kittentts") {
    body.instruct = voiceInstruction(input.voiceId);
    body.instructions = voiceInstruction(input.voiceId);
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

    const health = await pingVoiceStudio();
    if (health.up || health.loading) {
      const local = await speakVoiceStudio(input, !engineWarmed || health.loading);
      if (local.ok) return local;
      if (xaiConfigured() && !local.loading) {
        const cloud = await speakXai(input);
        if (cloud.ok) return cloud;
      }
      return local;
    }

    if (xaiConfigured()) return speakXai(input);
    return { ok: false, error: "Voice is not available in this environment." };
  });
