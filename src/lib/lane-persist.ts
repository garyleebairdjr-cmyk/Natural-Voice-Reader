import { DEFAULT_VOICESTUDIO_MODEL, isTtsModelId, type TtsModelId } from "./tts-config.ts";
import { canonicalVoiceId, DEFAULT_VOICE_ID } from "./voices.ts";

export const DEFAULT_VOLUME = 100;
export const DEFAULT_SPEED: LaneSpeed = 1;
export const SETTINGS_BREAKPOINT = "(min-width: 1024px)";
export const MAX_FAVORITE_VOICES = 32;
export const MAX_RECENT_VOICES = 8;

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

const VOICE_ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

export function isStoredVoiceId(id: unknown): id is string {
  return typeof id === "string" && (id === "device" || VOICE_ID_PATTERN.test(id));
}

/** Keep a de-duplicated list of well-formed voice ids, newest or first-saved first. */
export function normalizeVoiceIdList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isStoredVoiceId(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

export function rememberRecentVoice(list: string[], id: string, max = MAX_RECENT_VOICES): string[] {
  if (!isStoredVoiceId(id)) return normalizeVoiceIdList(list, max);
  return normalizeVoiceIdList([id, ...list.filter((item) => item !== id)], max);
}

export function toggleFavoriteVoice(list: string[], id: string, max = MAX_FAVORITE_VOICES): string[] {
  if (!isStoredVoiceId(id)) return normalizeVoiceIdList(list, max);
  if (list.includes(id)) return list.filter((item) => item !== id);
  return normalizeVoiceIdList([...list, id], max);
}

export type LaneSpeed = 0.9 | 1 | 1.15 | 1.35;

export type LaneSettingsSnapshot = {
  voiceId: string;
  speed: LaneSpeed;
  volume: number;
  muted: boolean;
  ttsModel: TtsModelId;
  settingsOpen: boolean | null;
};

export function defaultSettingsOpen(wide: boolean): boolean {
  return wide;
}

export function defaultLaneSettings(): LaneSettingsSnapshot {
  return {
    voiceId: DEFAULT_VOICE_ID,
    speed: DEFAULT_SPEED,
    volume: DEFAULT_VOLUME,
    muted: false,
    ttsModel: DEFAULT_VOICESTUDIO_MODEL,
    settingsOpen: null,
  };
}

export function readLaneSettings(state: Record<string, unknown>): LaneSettingsSnapshot {
  return {
    voiceId: canonicalVoiceId(state.voiceId),
    speed: state.speed === 0.9 || state.speed === 1 || state.speed === 1.15 || state.speed === 1.35 ? state.speed : DEFAULT_SPEED as LaneSpeed,
    volume: clampVolume(state.volume),
    muted: Boolean(state.muted),
    ttsModel: typeof state.ttsModel === "string" && isTtsModelId(state.ttsModel) ? state.ttsModel : DEFAULT_VOICESTUDIO_MODEL,
    settingsOpen: typeof state.settingsOpen === "boolean" ? state.settingsOpen : null,
  };
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
  if (version < 6) {
    next = {
      ...next,
      settingsOpen: typeof next.settingsOpen === "boolean" ? next.settingsOpen : null,
      favoriteVoiceIds: normalizeVoiceIdList(next.favoriteVoiceIds, MAX_FAVORITE_VOICES),
      recentVoiceIds: normalizeVoiceIdList(next.recentVoiceIds, MAX_RECENT_VOICES),
    };
  } else {
    next = {
      ...next,
      settingsOpen: typeof next.settingsOpen === "boolean" ? next.settingsOpen : null,
      favoriteVoiceIds: normalizeVoiceIdList(next.favoriteVoiceIds, MAX_FAVORITE_VOICES),
      recentVoiceIds: normalizeVoiceIdList(next.recentVoiceIds, MAX_RECENT_VOICES),
    };
  }
  return next;
}
