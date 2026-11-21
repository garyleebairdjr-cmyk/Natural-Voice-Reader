import { createServerFn } from "@tanstack/react-start";
import { isVoiceId } from "@/lib/voices";
import { splitSpeakable, VOICESTUDIO_MAX_CHARS } from "@/lib/sentences";
import {
  DEFAULT_VOICESTUDIO_MODEL,
  DEFAULT_VOICESTUDIO_URL,
  isTtsModelId,
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
};

export type SpeechResult = SpeechOk | SpeechErr;

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

function requestedModel(raw: unknown): string {
  if (typeof raw === "string" && isTtsModelId(raw)) return raw;
  const fromEnv = process.env.VOICESTUDIO_TTS_MODEL?.trim();
  if (fromEnv && isTtsModelId(fromEnv)) return fromEnv;
  return DEFAULT_VOICESTUDIO_MODEL;
}

function clampSpeed(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 1;
  if (!Number.isFinite(n)) return 1;
  return Math.min(1.5, Math.max(0.7, n));
}

async function pingVoiceStudio(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${voiceStudioBase()}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function xaiConfigured(): boolean {
  return Boolean(process.env.XAI_API_KEY?.trim());
}

export const getTtsStatus = createServerFn({ method: "GET" }).handler(async (): Promise<TtsStatus> => {
  const voicestudioUp = await pingVoiceStudio();
  const hasXai = xaiConfigured();
  if (voicestudioUp) {
    const model = requestedModel(undefined);
    return {
      provider: "voicestudio",
      model,
      voicestudioUp,
      xaiConfigured: hasXai,
      message: `Using local VoiceStudio (${model === "kittentts" ? "KittenTTS" : "OmniVoice"}).`,
    };
  }
  if (hasXai) {
    return {
      provider: "xai",
      model: "xai",
      voicestudioUp,
      xaiConfigured: hasXai,
      message: "VoiceStudio is not running. Using the xAI cloud voice.",
    };
  }
  return {
    provider: "none",
    model: null,
    voicestudioUp,
    xaiConfigured: hasXai,
    message:
      "Generated voices are not available. VoiceStudio is not running and no xAI key is configured, so every named voice uses this browser's device voice.",
  };
});

type SpeakInput = {
  text: string;
  voiceId: string;
  speed: number;
  model: string;
};

async function speakVoiceStudio(
  input: SpeakInput,
  signal?: AbortSignal,
): Promise<SpeechResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.VOICESTUDIO_API_KEY?.trim() || process.env.OMNIVOICE_API_KEY?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

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
      headers,
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(120000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { ok: false, error: "Could not reach local VoiceStudio." };
  }

  if (!res.ok) {
    return { ok: false, error: `VoiceStudio error (${res.status}).` };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength < 64) return { ok: false, error: "VoiceStudio came back empty." };
  return {
    ok: true,
    audio: bytesToBase64(bytes),
    mime: res.headers.get("content-type")?.split(";")[0].trim() || "audio/mpeg",
    provider: "voicestudio",
    model: input.model,
    speedApplied: true,
  };
}

async function speakXai(input: SpeakInput, signal?: AbortSignal): Promise<SpeechResult> {
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
      signal: signal ?? AbortSignal.timeout(90000),
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
    // Sentence-level requests stay under the VoiceStudio 4,096-character cap.
    // If the client sent a longer card, speak the first piece only; the player
    // should split first. Downloads that pass a full card are handled below
    // when each piece fits.
    const text = pieces.length === 1 ? pieces[0]! : data.text.length <= VOICESTUDIO_MAX_CHARS ? data.text : pieces[0]!;
    const input = { ...data, text };

    if (await pingVoiceStudio()) {
      const local = await speakVoiceStudio(input);
      if (local.ok) return local;
      if (xaiConfigured()) {
        const cloud = await speakXai(input);
        if (cloud.ok) return cloud;
      }
      return local;
    }

    if (xaiConfigured()) return speakXai(input);
    return { ok: false, error: "Voice is not available in this environment." };
  });
