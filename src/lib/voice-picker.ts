/** Grouping, search, and badges for the searchable voice picker. */
import { resolveSpeechRoute } from "./voice-routing.ts";
import type { Voice } from "./voices.ts";

/** Cached preview line shared by every packed voice. */
export const VOICE_PREVIEW_LINE = "This is a short preview of the voice.";

export type VoiceBadge = {
  kind: "gender" | "engine" | "quality";
  label: string;
};

export type VoiceGroup = {
  id: string;
  label: string;
  voices: Voice[];
};

const GROUP_ORDER = ["favorites", "recent", "device", "british", "american", "indian", "australian", "english", "other"];

const GROUP_LABELS: Record<string, string> = {
  favorites: "Favorites",
  recent: "Recent",
  device: "Device",
  british: "British",
  american: "American",
  indian: "Indian",
  australian: "Australian",
  english: "English",
  other: "Other",
};

export function voiceGroupId(voice: Voice): string {
  if (voice.id === "device") return "device";
  const accent = voice.accent?.toLowerCase() ?? "";
  const language = voice.language.toLowerCase();
  if (accent === "british" || language.startsWith("en-gb")) return "british";
  if (accent === "indian" || language.startsWith("en-in")) return "indian";
  if (accent === "australian" || language.startsWith("en-au")) return "australian";
  if (accent === "american" || language.startsWith("en-us")) return "american";
  if (language === "en" || language.startsWith("en-")) return "english";
  return "other";
}

export function voiceGroupLabel(id: string): string {
  return GROUP_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

export function voiceEngineLabel(voice: Voice, selectedModel: string, packEngine?: string): string {
  if (voice.id === "device") return "Device";
  const route = resolveSpeechRoute(voice.id, selectedModel);
  if (route.provider === "kokoro") return "Kokoro";
  const engine = packEngine || route.model;
  if (engine === "omnivoice") return "OmniVoice";
  if (engine === "piper") return "Piper";
  if (engine === "kokoro") return "Kokoro";
  if (engine && engine !== "kittentts" && engine !== "omnivoice") {
    return engine.charAt(0).toUpperCase() + engine.slice(1);
  }
  return route.label;
}

export function voiceQualityLabel(voice: Voice, selectedModel: string, packEngine?: string): string {
  const engine = voiceEngineLabel(voice, selectedModel, packEngine);
  if (engine === "Device") return "Browser";
  if (engine === "Kokoro") return "Clear";
  if (engine === "OmniVoice") return "Best · Slow";
  if (engine === "Piper") return voice.note.toLowerCase().includes("high") ? "High" : "Medium";
  return "Fast";
}

export function voiceBadges(voice: Voice, selectedModel: string, packEngine?: string): VoiceBadge[] {
  const badges: VoiceBadge[] = [];
  if (voice.gender) {
    badges.push({ kind: "gender", label: voice.gender.charAt(0).toUpperCase() + voice.gender.slice(1) });
  }
  badges.push({ kind: "engine", label: voiceEngineLabel(voice, selectedModel, packEngine) });
  badges.push({ kind: "quality", label: voiceQualityLabel(voice, selectedModel, packEngine) });
  return badges;
}

export function voiceSearchText(voice: Voice, selectedModel: string, packEngine?: string): string {
  const badges = voiceBadges(voice, selectedModel, packEngine).map((badge) => badge.label);
  return [voice.id, voice.name, voice.note, voice.language, voice.accent, voiceGroupLabel(voiceGroupId(voice)), ...badges]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function filterVoices(
  voices: Voice[],
  query: string,
  selectedModel = "kittentts",
  engines: Record<string, string> = {},
): Voice[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return voices;
  return voices.filter((voice) => voiceSearchText(voice, selectedModel, engines[voice.id]).includes(needle));
}

export function groupVoices(
  voices: Voice[],
  options: {
    favoriteIds?: string[];
    recentIds?: string[];
    query?: string;
    selectedModel?: string;
    engines?: Record<string, string>;
  } = {},
): VoiceGroup[] {
  const selectedModel = options.selectedModel ?? "kittentts";
  const engines = options.engines ?? {};
  const filtered = filterVoices(voices, options.query ?? "", selectedModel, engines);
  const byId = new Map(filtered.map((voice) => [voice.id, voice]));
  const groups: VoiceGroup[] = [];
  const used = new Set<string>();

  const take = (id: string, label: string, ids: string[]) => {
    const items = ids.map((voiceId) => byId.get(voiceId)).filter((voice): voice is Voice => Boolean(voice));
    if (items.length === 0) return;
    for (const voice of items) used.add(voice.id);
    groups.push({ id, label, voices: items });
  };

  take("favorites", "Favorites", options.favoriteIds ?? []);
  take(
    "recent",
    "Recent",
    (options.recentIds ?? []).filter((id) => !(options.favoriteIds ?? []).includes(id)),
  );

  const rest = filtered.filter((voice) => !used.has(voice.id));
  const buckets = new Map<string, Voice[]>();
  for (const voice of rest) {
    const id = voiceGroupId(voice);
    const list = buckets.get(id) ?? [];
    list.push(voice);
    buckets.set(id, list);
  }
  const order = GROUP_ORDER.filter((id) => id !== "favorites" && id !== "recent");
  for (const id of order) {
    const items = buckets.get(id);
    if (!items?.length) continue;
    groups.push({ id, label: voiceGroupLabel(id), voices: items });
    buckets.delete(id);
  }
  for (const [id, items] of buckets) {
    if (items.length) groups.push({ id, label: voiceGroupLabel(id), voices: items });
  }
  return groups;
}
