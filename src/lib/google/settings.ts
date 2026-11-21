import { isThemeName, migrateInk, type ThemeName } from "../appearance.ts";
import {
  clampVolume,
  DEFAULT_SPEED,
  DEFAULT_VOLUME,
  isStoredVoiceId,
  MAX_FAVORITE_VOICES,
  MAX_RECENT_VOICES,
  normalizeVoiceIdList,
  type LaneSpeed,
} from "../lane-persist.ts";
import { DEFAULT_VOICESTUDIO_MODEL, isTtsModelId, type TtsModelId } from "../tts-config.ts";
import { DEFAULT_VOICE_ID } from "../voices.ts";

export const CLOUD_SETTINGS_VERSION = 1;

const SPEEDS = new Set<LaneSpeed>([0.9, 1, 1.15, 1.35]);

function isSpeed(value: unknown): value is LaneSpeed {
  return typeof value === "number" && SPEEDS.has(value as LaneSpeed);
}

export type CloudSettings = {
  version: typeof CLOUD_SETTINGS_VERSION;
  updatedAt: string;
  theme: ThemeName;
  ink: string;
  voiceId: string;
  speed: LaneSpeed;
  volume: number;
  muted: boolean;
  ttsModel: TtsModelId;
  settingsOpen: boolean | null;
  favoriteVoiceIds: string[];
  recentVoiceIds: string[];
  saveDownloadsToDrive: boolean;
};

export type CloudSettingsInput = {
  theme: ThemeName;
  ink: string;
  voiceId: string;
  speed: LaneSpeed;
  volume: number;
  muted: boolean;
  ttsModel: TtsModelId;
  settingsOpen: boolean | null;
  favoriteVoiceIds: string[];
  recentVoiceIds: string[];
  saveDownloadsToDrive: boolean;
  updatedAt?: string;
};

const SECRET_KEY = /token|secret|password|authorization|api[_-]?key|client[_-]?secret|refresh/i;

export function defaultCloudSettings(): CloudSettings {
  return {
    version: CLOUD_SETTINGS_VERSION,
    updatedAt: "1970-01-01T00:00:00.000Z",
    theme: "system",
    ink: "amber",
    voiceId: DEFAULT_VOICE_ID,
    speed: DEFAULT_SPEED,
    volume: DEFAULT_VOLUME,
    muted: false,
    ttsModel: DEFAULT_VOICESTUDIO_MODEL,
    settingsOpen: null,
    favoriteVoiceIds: [],
    recentVoiceIds: [],
    saveDownloadsToDrive: false,
  };
}

function asIso(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return fallback;
  return new Date(time).toISOString();
}

export function serializeCloudSettings(input: CloudSettingsInput, at = new Date()): CloudSettings {
  return {
    version: CLOUD_SETTINGS_VERSION,
    updatedAt: asIso(input.updatedAt, at.toISOString()),
    theme: isThemeName(input.theme) ? input.theme : "system",
    ink: migrateInk(input.ink),
    voiceId: isStoredVoiceId(input.voiceId) ? input.voiceId : DEFAULT_VOICE_ID,
    speed: isSpeed(input.speed) ? input.speed : DEFAULT_SPEED,
    volume: clampVolume(input.volume),
    muted: Boolean(input.muted),
    ttsModel: isTtsModelId(input.ttsModel) ? input.ttsModel : DEFAULT_VOICESTUDIO_MODEL,
    settingsOpen: typeof input.settingsOpen === "boolean" ? input.settingsOpen : null,
    favoriteVoiceIds: normalizeVoiceIdList(input.favoriteVoiceIds, MAX_FAVORITE_VOICES),
    recentVoiceIds: normalizeVoiceIdList(input.recentVoiceIds, MAX_RECENT_VOICES),
    saveDownloadsToDrive: Boolean(input.saveDownloadsToDrive),
  };
}

export function parseCloudSettings(raw: unknown): CloudSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (SECRET_KEY.test(key)) return null;
  }
  return serializeCloudSettings({
    theme: isThemeName(record.theme) ? record.theme : "system",
    ink: typeof record.ink === "string" ? record.ink : "amber",
    voiceId: typeof record.voiceId === "string" ? record.voiceId : DEFAULT_VOICE_ID,
    speed: isSpeed(record.speed) ? record.speed : DEFAULT_SPEED,
    volume: record.volume as number,
    muted: Boolean(record.muted),
    ttsModel: typeof record.ttsModel === "string" && isTtsModelId(record.ttsModel) ? record.ttsModel : DEFAULT_VOICESTUDIO_MODEL,
    settingsOpen: typeof record.settingsOpen === "boolean" ? record.settingsOpen : null,
    favoriteVoiceIds: Array.isArray(record.favoriteVoiceIds) ? (record.favoriteVoiceIds as string[]) : [],
    recentVoiceIds: Array.isArray(record.recentVoiceIds) ? (record.recentVoiceIds as string[]) : [],
    saveDownloadsToDrive: Boolean(record.saveDownloadsToDrive),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
  });
}

export function settingsTimestamp(settings: CloudSettings): number {
  const time = Date.parse(settings.updatedAt);
  return Number.isFinite(time) ? time : 0;
}

/**
 * Last-write-wins by updatedAt, then fill any fields the winner left empty
 * from the older copy. The newer document's updatedAt is kept.
 */
export function mergeCloudSettings(local: CloudSettings, remote: CloudSettings): CloudSettings {
  const localTime = settingsTimestamp(local);
  const remoteTime = settingsTimestamp(remote);
  const newer = remoteTime > localTime ? remote : local;
  const older = newer === remote ? local : remote;
  const merged: CloudSettings = { ...newer };
  if (!merged.favoriteVoiceIds.length && older.favoriteVoiceIds.length) merged.favoriteVoiceIds = older.favoriteVoiceIds;
  if (!merged.recentVoiceIds.length && older.recentVoiceIds.length) merged.recentVoiceIds = older.recentVoiceIds;
  if (merged.settingsOpen === null && older.settingsOpen !== null) merged.settingsOpen = older.settingsOpen;
  return serializeCloudSettings(merged, new Date(Math.max(localTime, remoteTime)));
}

export function cloudSettingsEqual(a: CloudSettings, b: CloudSettings): boolean {
  const left = { ...a, updatedAt: "" };
  const right = { ...b, updatedAt: "" };
  return JSON.stringify(left) === JSON.stringify(right);
}
