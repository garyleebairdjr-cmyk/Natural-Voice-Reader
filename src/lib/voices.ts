export type Voice = {
  id: string;
  name: string;
  note: string;
  /** BCP-47 language tag this voice is intended to speak. */
  language: string;
};

export const DEVICE_VOICE: Voice = {
  id: "device",
  name: "Device",
  note: "This browser",
  language: "en",
};

/** Curated voices. Leo is the default. Device is the browser fallback. */
export const VOICES: Voice[] = [
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

export function isVoiceId(id: string): boolean {
  return IDS.has(id);
}

export function voiceById(id: string): Voice {
  if (id === DEVICE_VOICE.id) return DEVICE_VOICE;
  return VOICES.find((v) => v.id === id) ?? VOICES[0];
}

export function voiceForCard(index: number, voiceId: string, rotate: boolean): Voice {
  if (voiceId === DEVICE_VOICE.id) return DEVICE_VOICE;
  const start = Math.max(0, VOICES.findIndex((v) => v.id === voiceId));
  if (!rotate) return VOICES[start];
  return VOICES[(start + index) % VOICES.length];
}
