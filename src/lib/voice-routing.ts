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

/** Official Kokoro-82M speakers used for British and accented English. */
export const KOKORO_SPEAKERS: Record<string, string> = {
  butler: "bm_george",
  mira: "hf_alpha",
  arjun: "hm_omega",
  aiko: "jf_alpha",
  haru: "jm_kumo",
};

const GERMAN_VOICES: Record<string, "woman" | "man"> = {
  lena: "woman",
  jonas: "man",
};

export function germanAccentInstruction(gender: "woman" | "man"): string {
  return `A calm adult ${gender} speaking English with a mild, natural German accent. Keep the accent light and respectful. Do not exaggerate or caricature.`;
}

export function isSpecialtyVoice(voiceId: string): boolean {
  return voiceId in KOKORO_SPEAKERS || voiceId in GERMAN_VOICES;
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
  const german = GERMAN_VOICES[voiceId];
  if (german) {
    return {
      provider: "voicestudio",
      model: "omnivoice",
      voice: "default",
      instruct: germanAccentInstruction(german),
      cacheKey: `omnivoice:de:${voiceId}`,
      slow: true,
      label: "OmniVoice",
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
