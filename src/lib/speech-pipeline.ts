/**
 * Pluggable speech stages for the reader.
 *
 * Only TTS is wired today. STT and translation are typed here so a later
 * multilingual / on-device path can slot in without rewriting the queue UI.
 * Language tags are BCP-47 (for example "en", "es", "hi").
 */

export type LanguageCode = string;

export type SpeechStageKind = "stt" | "translate" | "tts";

export type SpeechEngine = {
  id: string;
  kind: SpeechStageKind;
  label: string;
  languages: LanguageCode[];
  /** True when the engine is small enough to consider for on-device / mobile use. */
  mobileCapable: boolean;
  license: string;
};

export type TtsEngine = SpeechEngine & {
  kind: "tts";
  quality: "fast" | "quality";
};

export type SttEngine = SpeechEngine & { kind: "stt" };
export type TranslationEngine = SpeechEngine & { kind: "translate" };

/** Engines the reader can actually request today. */
export const TTS_ENGINE_REGISTRY: readonly TtsEngine[] = [
  {
    id: "kittentts",
    kind: "tts",
    label: "KittenTTS",
    languages: ["en"],
    mobileCapable: true,
    license: "Apache-2.0",
    quality: "fast",
  },
  {
    id: "omnivoice",
    kind: "tts",
    label: "OmniVoice",
    languages: ["en"],
    mobileCapable: false,
    license: "CC-BY-NC (weights); tokenizer also under Boson Higgs Audio 2 and Meta Llama 3 terms",
    quality: "quality",
  },
];

export type SpeechPipeline = {
  /** Speech-to-text, not wired yet. */
  stt: SttEngine | null;
  /** Text translation, not wired yet. */
  translate: TranslationEngine | null;
  tts: TtsEngine;
};

export function ttsEngineById(id: string): TtsEngine | undefined {
  return TTS_ENGINE_REGISTRY.find((engine) => engine.id === id);
}

export function defaultSpeechPipeline(ttsId: string): SpeechPipeline {
  const tts = ttsEngineById(ttsId) ?? TTS_ENGINE_REGISTRY[0]!;
  return { stt: null, translate: null, tts };
}

export function engineSupportsLanguage(engine: SpeechEngine, language: LanguageCode): boolean {
  const tag = language.trim().toLowerCase();
  if (!tag) return false;
  if (engine.languages.includes("multi")) return true;
  return engine.languages.some((item) => item.toLowerCase() === tag || tag.startsWith(`${item.toLowerCase()}-`));
}
