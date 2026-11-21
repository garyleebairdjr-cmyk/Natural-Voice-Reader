export type Voice = {
  id: string;
  name: string;
  note: string;
  /** BCP-47 language tag this voice is intended to speak. */
  language: string;
  /** Accent family for English voices, when it is not implied by the language tag. */
  accent?: string;
  gender?: "male" | "female" | "neutral";
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
    gender: "male",
  },
  {
    id: "mira",
    name: "Mira (Indian English)",
    note: "Clear, natural Indian English.",
    language: "en-IN",
    accent: "indian",
    gender: "female",
  },
  {
    id: "arjun",
    name: "Arjun (Indian English)",
    note: "Calm, natural Indian English.",
    language: "en-IN",
    accent: "indian",
    gender: "male",
  },
];

/** Curated voices. Leo is the default. Device is the browser fallback. */
export const VOICES: Voice[] = [
  ...SPECIAL_VOICES,
  { id: "leo", name: "Leo", note: "Steady, British", language: "en", accent: "british", gender: "male" },
  { id: "eve", name: "Eve", note: "Bright, British", language: "en", accent: "british", gender: "female" },
  { id: "rex", name: "Rex", note: "Clear and direct", language: "en", gender: "male" },
  { id: "sal", name: "Sal", note: "Smooth midrange", language: "en", gender: "female" },
  { id: "ara", name: "Ara", note: "Warm and close", language: "en", gender: "female" },
  { id: "orion", name: "Orion", note: "Cinematic read", language: "en", gender: "male" },
  { id: "helix", name: "Helix", note: "Commentary punch", language: "en", gender: "male" },
  { id: "luna", name: "Luna", note: "Patient and soft", language: "en", gender: "female" },
  { id: "sirius", name: "Sirius", note: "Quick and playful", language: "en", gender: "female" },
  { id: "aurora", name: "Aurora", note: "Calm and even", language: "en", gender: "female" },
  { id: "atlas", name: "Atlas", note: "Low and sure", language: "en", gender: "male" },
  { id: "rigel", name: "Rigel", note: "Precise, Australian", language: "en", accent: "australian", gender: "female" },
  { id: "naksh", name: "Naksh", note: "Thoughtful, Indian", language: "en", accent: "indian", gender: "male" },
  { id: "lumen", name: "Lumen", note: "Warm educator", language: "en", gender: "male" },
  { id: "iris", name: "Iris", note: "Upbeat and light", language: "en", gender: "female" },
  { id: "castor", name: "Castor", note: "Easygoing", language: "en", gender: "male" },
];

const IDS = new Set(VOICES.map((v) => v.id));
export const DEFAULT_VOICE_ID = "leo";
const FALLBACK = VOICES.find((v) => v.id === DEFAULT_VOICE_ID) ?? VOICES[0];

/** Voices that used to be in the picker and must fall back to the default. */
export const REMOVED_VOICE_IDS = ["aiko", "haru", "lena", "jonas"] as const;

export function isVoiceId(id: string): boolean {
  return IDS.has(id);
}

/** Map a saved or requested voice onto one that still exists. */
export function canonicalVoiceId(id: unknown, knownIds?: Iterable<string>): string {
  if (id === DEVICE_VOICE.id) return DEVICE_VOICE.id;
  if (typeof id !== "string" || !id) return DEFAULT_VOICE_ID;
  if ((REMOVED_VOICE_IDS as readonly string[]).includes(id)) return DEFAULT_VOICE_ID;
  if (isVoiceId(id)) return id;
  const known = knownIds ? new Set(knownIds) : null;
  if (known) return known.has(id) ? id : DEFAULT_VOICE_ID;
  // Keep well-formed ids so community or overlay voices survive persist before packs load.
  if (/^[a-z][a-z0-9_-]{1,63}$/.test(id)) return id;
  return DEFAULT_VOICE_ID;
}

export function voiceById(id: string): Voice {
  if (id === DEVICE_VOICE.id) return DEVICE_VOICE;
  return VOICES.find((v) => v.id === canonicalVoiceId(id)) ?? FALLBACK;
}

export function voiceForCardIn(voices: Voice[], index: number, voiceId: string, rotate: boolean): Voice {
  if (voices.length === 0) return DEVICE_VOICE;
  const id = canonicalVoiceId(voiceId);
  if (id === DEVICE_VOICE.id) return DEVICE_VOICE;
  const start = Math.max(0, voices.findIndex((v) => v.id === id));
  if (!rotate) return voices[start] ?? voices[0] ?? DEVICE_VOICE;
  return voices[(start + index) % voices.length] ?? voices[0] ?? DEVICE_VOICE;
}

export function voiceForCard(index: number, voiceId: string, rotate: boolean): Voice {
  return voiceForCardIn(VOICES, index, voiceId, rotate);
}

export function voiceAccentLabel(voice: Voice): string | null {
  if (!voice.accent) return null;
  const accent = voice.accent.charAt(0).toUpperCase() + voice.accent.slice(1);
  return `${voice.language} · ${accent}`;
}
