/**
 * Installed-app implementations, backed by Rust commands in src-tauri/.
 *
 * Phase 1: page reading goes through Rust (no CORS, same public-address
 * checks as the web server). Generated voices and pack installs arrive with
 * the native sherpa-onnx engine; until then every voice uses the device
 * voice, which the reader already falls back to.
 */
import { invoke } from "@tauri-apps/api/core";
import catalogJson from "../../../voices/catalog.json";
import { readableFromBody, type ReadPageResult } from "@/lib/page-text";
import type { SpeechResult } from "@/lib/tts.functions";
import type { TtsStatus } from "@/lib/tts-config";
import { parseCatalog } from "@/lib/voice-packs";
import type { VoicePackListResult } from "@/lib/voice-packs.functions";

type FetchedPage = { contentType: string; body: string };

export async function readPage(url: string): Promise<ReadPageResult> {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, error: "Enter a link first." };
  if (trimmed.length > 2000) return { ok: false, error: "That link is too long." };
  try {
    const page = await invoke<FetchedPage>("fetch_page", { url: trimmed });
    return readableFromBody(page.body, page.contentType);
  } catch (err) {
    return { ok: false, error: typeof err === "string" ? err : "Could not read that page." };
  }
}

const DEVICE_VOICE_MESSAGE =
  "Generated voices are not in this version of the app yet, so every voice uses this device's voice.";

export async function getTtsStatus(): Promise<TtsStatus> {
  return {
    provider: "none",
    model: null,
    state: "unavailable",
    voicestudioUp: false,
    xaiConfigured: false,
    message: DEVICE_VOICE_MESSAGE,
  };
}

export async function synthesizeSpeech(): Promise<SpeechResult> {
  return { ok: false, error: DEVICE_VOICE_MESSAGE };
}

export async function listVoicePacks(): Promise<VoicePackListResult> {
  const { packs, errors } = parseCatalog(catalogJson, "voices/catalog.json", "catalog");
  return {
    packs: packs.map((pack) => ({ ...pack, installed: false, installing: false })),
    errors,
  };
}

export function notYet(): Promise<never> {
  return Promise.reject(new Error("Voice pack downloads are not in this version of the app yet."));
}
