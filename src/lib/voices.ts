export type Voice = {
  id: string;
  name: string;
  note: string;
};

export const DEVICE_VOICE: Voice = {
  id: "device",
  name: "Device",
  note: "This browser",
};

/** Curated voices. Leo is the default. Device is the browser fallback. */
export const VOICES: Voice[] = [
  { id: "leo", name: "Leo", note: "Steady, British" },
  { id: "eve", name: "Eve", note: "Bright, British" },
  { id: "rex", name: "Rex", note: "Clear and direct" },
  { id: "sal", name: "Sal", note: "Smooth midrange" },
  { id: "ara", name: "Ara", note: "Warm and close" },
  { id: "orion", name: "Orion", note: "Cinematic read" },
  { id: "helix", name: "Helix", note: "Commentary punch" },
  { id: "luna", name: "Luna", note: "Patient and soft" },
  { id: "sirius", name: "Sirius", note: "Quick and playful" },
  { id: "aurora", name: "Aurora", note: "Calm and even" },
  { id: "atlas", name: "Atlas", note: "Low and sure" },
  { id: "rigel", name: "Rigel", note: "Precise, Australian" },
  { id: "naksh", name: "Naksh", note: "Thoughtful, Indian" },
  { id: "lumen", name: "Lumen", note: "Warm educator" },
  { id: "iris", name: "Iris", note: "Upbeat and light" },
  { id: "castor", name: "Castor", note: "Easygoing" },
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
