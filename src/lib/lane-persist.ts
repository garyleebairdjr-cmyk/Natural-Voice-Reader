import { DEFAULT_VOICESTUDIO_MODEL } from "./tts-config.ts";
import { canonicalVoiceId } from "./voices.ts";

export const DEFAULT_VOLUME = 100;

/** Playback volume as a whole percent from 0 to 100. */
export function clampVolume(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : DEFAULT_VOLUME;
  if (!Number.isFinite(n)) return DEFAULT_VOLUME;
  return Math.round(Math.min(100, Math.max(0, n)));
}

/** Linear gain for an audio element, Web Audio node, or SpeechSynthesisUtterance. */
export function effectiveGain(volume: number, muted: boolean): number {
  if (muted) return 0;
  return clampVolume(volume) / 100;
}

export function migrateLaneState(persisted: unknown, version: number): Record<string, unknown> {
  const state = (persisted ?? {}) as Record<string, unknown>;
  let next = state;
  if (version < 2) {
    next = { ...next, ttsModel: DEFAULT_VOICESTUDIO_MODEL };
  }
  if (version < 3) {
    next = { ...next, softRoom: false };
  }
  if (version < 4) {
    next = { ...next, voiceId: canonicalVoiceId(next.voiceId) };
  }
  if (version < 5) {
    next = {
      ...next,
      volume: next.volume == null ? DEFAULT_VOLUME : clampVolume(next.volume),
      muted: Boolean(next.muted),
    };
  } else {
    next = { ...next, volume: clampVolume(next.volume), muted: Boolean(next.muted) };
  }
  return next;
}
