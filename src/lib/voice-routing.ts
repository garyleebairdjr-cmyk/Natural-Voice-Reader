/** Route a reader voice to the engine that can actually produce it. */

export type SpeechProvider = "kokoro" | "voicestudio";

export type SpeechRoute = {
  provider: SpeechProvider;
  /** Engine id used in requests and cache keys. */
  model: string;
  /** Speaker or preset sent to that engine. */
  voice: string;
  instruct?: string;
  cacheKey: string;
  slow: boolean;
  label: string;
};

/** Official Kokoro-82M speakers used for Butler and Indian English. */
export const KOKORO_SPEAKERS: Record<string, string> = {
  butler: "bm_george",
  mira: "hf_alpha",
  arjun: "hm_omega",
};

export function isSpecialtyVoice(voiceId: string): boolean {
  return voiceId in KOKORO_SPEAKERS;
}

export function resolveSpeechRoute(voiceId: string, selectedModel: string): SpeechRoute {
  const kokoro = KOKORO_SPEAKERS[voiceId];
  if (kokoro) {
    return {
      provider: "kokoro",
      model: "kokoro",
      voice: kokoro,
      cacheKey: `kokoro:${kokoro}`,
      slow: false,
      label: "Kokoro",
    };
  }
  const model = selectedModel === "omnivoice" ? "omnivoice" : "kittentts";
  return {
    provider: "voicestudio",
    model,
    voice: "",
    cacheKey: model,
    slow: model === "omnivoice",
    label: model === "omnivoice" ? "OmniVoice" : "KittenTTS",
  };
}
