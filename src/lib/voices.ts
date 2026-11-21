export type Voice = {
  id: string;
  name: string;
  note: string;
  /** BCP-47 language tag this voice is intended to speak. */
  language: string;
  /** Accent family for English voices, when it is not implied by the language tag. */
  accent?: string;
};

export const DEVICE_VOICE: Voice = {
  id: "device",
  name: "Device",
  note: "This browser",
  language: "en",
};

const SPECIAL_VOICES: Voice[] = [
  {
    id: "butler",
    name: "Butler (British)",
    note: "Jarvis-style butler. Generic RP; not a film or actor voice.",
    language: "en-GB",
    accent: "british",
  },
  {
    id: "mira",
    name: "Mira (Indian English)",
    note: "Clear, natural Indian English.",
    language: "en-IN",
    accent: "indian",
  },
  {
    id: "arjun",
    name: "Arjun (Indian English)",
    note: "Calm, natural Indian English.",
    language: "en-IN",
    accent: "indian",
  },
  {
    id: "aiko",
    name: "Aiko (Japanese English)",
    note: "Gentle, natural Japanese-accented English.",
    language: "en",
    accent: "japanese",
  },
  {
    id: "haru",
    name: "Haru (Japanese English)",
    note: "Even, natural Japanese-accented English.",
    language: "en",
    accent: "japanese",
  },
  {
    id: "lena",
    name: "Lena (German English)",
    note: "Mild German-accented English. Slower engine.",
    language: "en",
    accent: "german",
  },
  {
    id: "jonas",
    name: "Jonas (German English)",
    note: "Mild German-accented English. Slower engine.",
    language: "en",
    accent: "german",
  },
];

/** Curated voices. Leo is the default. Device is the browser fallback. */
export const VOICES: Voice[] = [
  ...SPECIAL_VOICES,
  { id: "leo", name: "Leo", note: "Steady, British", language: "en" },
  { id: "eve", name: "Eve", note: "Bright, British", language: "en" },
  { id: "rex", name: "Rex", note: "Clear and direct", language: "en" },
  { id: "sal", name: "Sal", note: "Smooth midrange", language: "en" },
  { id: "ara", name: "Ara", note: "Warm and close", language: "en" },
  { id: "orion", name: "Orion", note: "Cinematic read", language: "en" },
  { id: "helix", name: "Helix", note: "Commentary punch", language: "en" },
  { id: "luna", name: "Luna", note: "Patient and soft", language: "en" },
  { id: "sirius", name: "Sirius", note: "Quick and playful", language: "en" },
  { id: "aurora", name: "Aurora", note: "Calm and even", language: "en" },
  { id: "atlas", name: "Atlas", note: "Low and sure", language: "en" },
  { id: "rigel", name: "Rigel", note: "Precise, Australian", language: "en" },
  { id: "naksh", name: "Naksh", note: "Thoughtful, Indian", language: "en" },
  { id: "lumen", name: "Lumen", note: "Warm educator", language: "en" },
  { id: "iris", name: "Iris", note: "Upbeat and light", language: "en" },
  { id: "castor", name: "Castor", note: "Easygoing", language: "en" },
];

const IDS = new Set(VOICES.map((v) => v.id));
const FALLBACK = VOICES.find((v) => v.id === "leo") ?? VOICES[0];

export function isVoiceId(id: string): boolean {
  return IDS.has(id);
}

export function voiceById(id: string): Voice {
  if (id === DEVICE_VOICE.id) return DEVICE_VOICE;
  return VOICES.find((v) => v.id === id) ?? FALLBACK;
}

export function voiceForCard(index: number, voiceId: string, rotate: boolean): Voice {
  if (voiceId === DEVICE_VOICE.id) return DEVICE_VOICE;
  const start = Math.max(0, VOICES.findIndex((v) => v.id === voiceId));
  if (!rotate) return VOICES[start] ?? FALLBACK;
  return VOICES[(start + index) % VOICES.length] ?? FALLBACK;
}

export function voiceAccentLabel(voice: Voice): string | null {
  if (!voice.accent) return null;
  const accent = voice.accent.charAt(0).toUpperCase() + voice.accent.slice(1);
  return `${voice.language} · ${accent}`;
}
