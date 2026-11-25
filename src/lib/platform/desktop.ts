/**
 * Installed-app implementations, backed by Rust commands in src-tauri/.
 *
 * - Page reading: Rust fetches (no CORS, same public-address checks as the
 *   web server); text extraction is shared with the server.
 * - Speech: sherpa-onnx in Rust (KittenTTS for the standard voices, Kokoro
 *   for Butler, Mira, and Arjun). Without a pack, the device voice is used.
 * - Voice packs: the KittenTTS and Kokoro sherpa-onnx archives, stored in
 *   the same data folder as `nvr voices install`. OmniVoice needs Python and
 *   stays with the script install, so it is not listed here.
 */
import { invoke } from "@tauri-apps/api/core";
import catalogJson from "../../../voices/catalog.json";
import { readableFromBody, type ReadPageResult } from "@/lib/page-text";
import type { SpeechResult } from "@/lib/tts.functions";
import { kittenVoiceId, type TtsStatus } from "@/lib/tts-config";
import { resolveSpeechRoute } from "@/lib/voice-routing";
import { parseCatalog, type VoicePackProgress } from "@/lib/voice-packs";
import type { VoicePackListResult } from "@/lib/voice-packs.functions";

type FetchedPage = { contentType: string; body: string };
type PackState = { id: string; installed: boolean; installing: boolean; progress: VoicePackProgress | null };

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

function errorText(err: unknown, fallback: string): string {
  if (typeof err === "string") return err;
  return err instanceof Error ? err.message : fallback;
}

async function packStates(): Promise<PackState[]> {
  return invoke<PackState[]>("list_packs");
}

function merge(states: PackState[]): VoicePackListResult {
  const { packs, errors } = parseCatalog(catalogJson, "voices/catalog.json", "catalog");
  const byId = new Map(states.map((state) => [state.id, state]));
  return {
    packs: packs
      .filter((pack) => byId.has(pack.id))
      .map((pack) => {
        const state = byId.get(pack.id)!;
        return { ...pack, installed: state.installed, installing: state.installing, progress: state.progress ?? undefined };
      }),
    errors,
  };
}

export async function listVoicePacks(): Promise<VoicePackListResult> {
  return merge(await packStates());
}

export async function installVoicePack(id: string): Promise<VoicePackListResult> {
  try {
    return merge(await invoke<PackState[]>("install_pack", { id }));
  } catch (err) {
    throw new Error(errorText(err, "Could not install that voice pack."));
  }
}

export async function removeVoicePack(id: string): Promise<VoicePackListResult> {
  try {
    return merge(await invoke<PackState[]>("remove_pack", { id }));
  } catch (err) {
    throw new Error(errorText(err, "Could not remove that voice pack."));
  }
}

export async function getTtsStatus(): Promise<TtsStatus> {
  const states = await packStates().catch(() => [] as PackState[]);
  const kitten = states.find((state) => state.id === "kittentts");
  const base = { voicestudioUp: false, xaiConfigured: false };
  if (kitten?.installing) {
    return {
      ...base,
      provider: "native",
      model: "kittentts",
      state: "downloading",
      message: kitten.progress?.message ?? "Downloading voices…",
      download: { model: "kittentts", percent: kitten.progress?.percent ?? null, message: kitten.progress?.message ?? "" },
    };
  }
  if (kitten?.installed) {
    return { ...base, provider: "native", model: "kittentts", state: "ready", message: "Using voices on this device (KittenTTS)." };
  }
  return {
    ...base,
    provider: "none",
    model: null,
    state: "unavailable",
    message: "Install the KittenTTS voice pack in Settings to use generated voices. Until then, the device voice is used.",
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export async function synthesizeSpeech(data: {
  text: string;
  voiceId: string;
  speed: number;
  model: string;
}): Promise<SpeechResult> {
  const route = resolveSpeechRoute(data.voiceId, "kittentts");
  const kokoro = route.provider === "kokoro";
  try {
    const wav = await invoke<ArrayBuffer>("synthesize", {
      engine: kokoro ? "kokoro" : "kitten",
      speaker: kokoro ? route.voice : kittenVoiceId(data.voiceId),
      text: data.text,
      speed: data.speed,
    });
    return {
      ok: true,
      audio: bytesToBase64(new Uint8Array(wav)),
      mime: "audio/wav",
      provider: "native",
      model: kokoro ? "kokoro" : "kittentts",
      speedApplied: true,
    };
  } catch (err) {
    return { ok: false, error: errorText(err, "The voice could not read that text.") };
  }
}

export function notInApp(): Promise<never> {
  return Promise.reject(new Error("Community voice packs are not in the app yet."));
}
