import { VOICES } from "./voices.ts";

export const DEFAULT_VOICESTUDIO_URL = "http://127.0.0.1:3900";
export const DEFAULT_VOICESTUDIO_MODEL = "omnivoice";

/** Exact VoiceStudio engine ids this app may request. Never send aliases or voxcpm2. */
export const PINNED_TTS_MODELS = ["omnivoice", "kittentts"] as const;

export const TTS_HEALTH_TIMEOUT_MS = 8_000;
export const TTS_WARM_TIMEOUT_MS = 60_000;
export const TTS_COLD_TIMEOUT_MS = 180_000;
export const TTS_WARMUP_TEXT = "The voice engine is ready.";

export function modelLabel(model: string): string {
  if (model === "kittentts") return "KittenTTS";
  if (model === "omnivoice") return "OmniVoice";
  return model;
}

export function isForbiddenTtsModel(id: string): boolean {
  const n = id.trim().toLowerCase();
  return n === "voxcpm2" || n === "tts-1" || n === "tts-1-hd" || n === "gpt-4o-mini-tts";
}

export function isLoadingVoiceError(message: string): boolean {
  const n = message.toLowerCase();
  return (
    n.includes("loading voice engine") ||
    n.includes("still starting") ||
    n.includes("timed out") ||
    n.includes("timeout") ||
    n.includes("aborted") ||
    n.includes("backend died") ||
    n.includes("event loop") ||
    n.includes("could not reach")
  );
}

export const TTS_MODELS = [
  {
    id: "omnivoice",
    label: "Best local (OmniVoice)",
    note: "Higher quality. About a second per sentence once warm.",
  },
  {
    id: "kittentts",
    label: "Fast local (KittenTTS)",
    note: "Eight English presets. Lighter on the CPU.",
  },
] as const;

export type TtsModelId = (typeof TTS_MODELS)[number]["id"];

export function isTtsModelId(id: string): id is TtsModelId {
  if (isForbiddenTtsModel(id)) return false;
  return TTS_MODELS.some((model) => model.id === id);
}

/** KittenTTS has eight presets. Map the sixteen reader voices onto them. */
const KITTEN_VOICE: Record<string, string> = {
  leo: "expr-voice-2-m",
  eve: "expr-voice-2-f",
  rex: "expr-voice-3-m",
  sal: "expr-voice-3-f",
  ara: "expr-voice-4-f",
  orion: "expr-voice-4-m",
  helix: "expr-voice-5-m",
  luna: "expr-voice-5-f",
  sirius: "expr-voice-2-f",
  aurora: "expr-voice-3-f",
  atlas: "expr-voice-2-m",
  rigel: "expr-voice-4-f",
  naksh: "expr-voice-3-m",
  lumen: "expr-voice-5-m",
  iris: "expr-voice-5-f",
  castor: "expr-voice-4-m",
};

export function kittenVoiceId(voiceId: string): string {
  return KITTEN_VOICE[voiceId] ?? "expr-voice-2-m";
}

export function voiceInstruction(voiceId: string): string {
  const voice = VOICES.find((item) => item.id === voiceId);
  const note = voice?.note ?? "Clear narration";
  return `Read naturally in a ${note.toLowerCase()} speaking style. Conversational pacing, no announcer affect.`;
}

export function voiceStudioVoice(model: string, voiceId: string): string {
  if (model === "kittentts") return kittenVoiceId(voiceId);
  return "default";
}

export type TtsProvider = "voicestudio" | "xai" | "none";

export type TtsEngineState = "ready" | "loading" | "unavailable";

export type TtsStatus = {
  provider: TtsProvider;
  model: string | null;
  state: TtsEngineState;
  voicestudioUp: boolean;
  xaiConfigured: boolean;
  message: string;
};
