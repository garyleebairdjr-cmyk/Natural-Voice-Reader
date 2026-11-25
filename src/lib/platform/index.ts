/**
 * Platform backend for the reader UI.
 *
 * The web build talks to TanStack Start server functions. The installed app
 * (Tauri, see src-tauri/) has no Node server, so the same calls go to Rust
 * commands instead. Components import from here and never from
 * `*.functions.ts` directly, so both targets share one UI.
 *
 * Every export keeps the server-function call shape (`fn({ data })`) so the
 * call sites read the same either way.
 */
import { getGooglePublicConfig as webGoogleConfig, type GooglePublicConfig } from "@/lib/google/config.functions";
import { readPage as webReadPage } from "@/lib/read-page.functions";
import {
  getTtsStatus as webTtsStatus,
  prepareTtsEngine as webPrepareTts,
  synthesizeSpeech as webSynthesize,
  type SpeechResult,
} from "@/lib/tts.functions";
import {
  addCatalogIndex as webAddIndex,
  browseVoicePacks as webBrowse,
  installCommunityPack as webInstallCommunity,
  installVoicePack as webInstall,
  listCatalogIndexes as webListIndexes,
  listVoicePacks as webListPacks,
  removeCatalogIndex as webRemoveIndex,
  removeVoicePack as webRemove,
  type CommunityBrowseResult,
  type VoicePackListResult,
} from "@/lib/voice-packs.functions";
import type { ReadPageResult } from "@/lib/page-text";
import type { TtsStatus } from "@/lib/tts-config";
import * as desktop from "./desktop";

export type { GooglePublicConfig, SpeechResult, CommunityBrowseResult, VoicePackListResult, ReadPageResult };

/** True inside the installed app (Tauri webview), false in a normal browser. */
export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type Call<I> = { data: I; signal?: AbortSignal };

export function readPage(call: Call<{ url: string }>): Promise<ReadPageResult> {
  return isDesktopApp() ? desktop.readPage(call.data.url) : webReadPage(call);
}

export function getTtsStatus(): Promise<TtsStatus> {
  return isDesktopApp() ? desktop.getTtsStatus() : webTtsStatus();
}

export function prepareTtsEngine(call: Call<{ model: string }>): Promise<TtsStatus> {
  return isDesktopApp() ? desktop.getTtsStatus() : webPrepareTts(call);
}

export function synthesizeSpeech(
  call: Call<{ text: string; voiceId: string; speed: number; model: string }>,
): Promise<SpeechResult> {
  return isDesktopApp() ? desktop.synthesizeSpeech(call.data) : webSynthesize(call);
}

export function getGooglePublicConfig(): Promise<GooglePublicConfig> {
  return isDesktopApp() ? Promise.resolve({ enabled: false, clientId: "", apiKey: "" }) : webGoogleConfig();
}

export function listVoicePacks(): Promise<VoicePackListResult> {
  return isDesktopApp() ? desktop.listVoicePacks() : webListPacks();
}

export function installVoicePack(call: Call<{ id: string }>): Promise<VoicePackListResult> {
  return isDesktopApp() ? desktop.installVoicePack(call.data.id) : webInstall(call);
}

export function removeVoicePack(call: Call<{ id: string }>): Promise<VoicePackListResult> {
  return isDesktopApp() ? desktop.removeVoicePack(call.data.id) : webRemove(call);
}

export function listCatalogIndexes(): Promise<{ urls: string[] }> {
  return isDesktopApp() ? desktop.notInApp() : webListIndexes();
}

export function addCatalogIndex(call: Call<{ url: string }>): Promise<{ urls: string[] }> {
  return isDesktopApp() ? desktop.notInApp() : webAddIndex(call);
}

export function removeCatalogIndex(call: Call<{ url: string }>): Promise<{ urls: string[] }> {
  return isDesktopApp() ? desktop.notInApp() : webRemoveIndex(call);
}

type BrowseFilter = {
  query?: string;
  language?: string;
  gender?: "male" | "female" | "neutral";
  license?: string;
  commercialUse?: boolean;
};

export function browseVoicePacks(call: Call<BrowseFilter>): Promise<CommunityBrowseResult> {
  return isDesktopApp() ? desktop.notInApp() : webBrowse(call);
}

export function installCommunityPack(call: Call<{ id: string }>): Promise<VoicePackListResult> {
  return isDesktopApp() ? desktop.notInApp() : webInstallCommunity(call);
}
