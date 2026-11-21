/**
 * Server-only voice pack catalog I/O, install state, and on-disk detection.
 * The browser must import from voice-packs.ts, not this file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isPackId,
  mergeCatalogs,
  parseCatalog,
  type CatalogIssue,
  type VoicePack,
  type VoicePackProgress,
  type VoicePackStatus,
} from "./voice-packs.ts";

export function repoRoot(): string {
  return process.env.NVR_ROOT?.trim() || process.cwd();
}

export function officialCatalogPath(): string {
  return join(repoRoot(), "voices", "catalog.json");
}

export function overlayDir(): string {
  if (process.env.NVR_VOICES_D?.trim()) return process.env.NVR_VOICES_D.trim();
  if (process.platform === "win32") {
    const base = process.env.APPDATA?.trim() || process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Roaming");
    return join(base, "nvr", "voices.d");
  }
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "nvr", "voices.d");
}

export function stateFilePath(): string {
  if (process.env.NVR_VOICE_STATE?.trim()) return process.env.NVR_VOICE_STATE.trim();
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
    return join(base, "nvr", "voice-packs.json");
  }
  return join(process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "nvr", "voice-packs.json");
}

export function statusFilePath(): string {
  if (process.env.NVR_VOICE_STATUS?.trim()) return process.env.NVR_VOICE_STATUS.trim();
  if (process.env.NVR_STATUS_FILE?.trim()) {
    // Keep progress next to the existing bootstrap status file.
    return process.env.NVR_STATUS_FILE.trim().replace(/status\.json$/, "voice-pack-status.json");
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
    return join(base, "nvr", "voice-pack-status.json");
  }
  return join(process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "nvr", "voice-pack-status.json");
}

export function sherpaCacheDir(): string {
  if (process.env.NVR_SHERPA_CACHE?.trim()) return process.env.NVR_SHERPA_CACHE.trim();
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
    return join(base, "nvr", "sherpa");
  }
  return join(process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "nvr", "sherpa");
}

function issue(path: string, message: string): CatalogIssue {
  return { path, message };
}

function huggingfaceHubDir(): string {
  if (process.env.HF_HOME?.trim()) return join(process.env.HF_HOME.trim(), "hub");
  if (process.env.HUGGINGFACE_HUB_CACHE?.trim()) return process.env.HUGGINGFACE_HUB_CACHE.trim();
  return join(homedir(), ".cache", "huggingface", "hub");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadOfficialCatalog(path = officialCatalogPath()): { packs: VoicePack[]; errors: CatalogIssue[] } {
  if (!existsSync(path)) {
    return { packs: [], errors: [issue(path, "Official catalog is missing.")] };
  }
  try {
    return parseCatalog(readJson(path), path, "catalog");
  } catch (err) {
    return { packs: [], errors: [issue(path, `Could not parse catalog: ${err instanceof Error ? err.message : String(err)}`)] };
  }
}

export function loadOverlayCatalogs(dir = overlayDir()): { packs: VoicePack[]; errors: CatalogIssue[] } {
  const errors: CatalogIssue[] = [];
  const packs: VoicePack[] = [];
  if (!existsSync(dir)) return { packs, errors };
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of files) {
    const file = join(dir, name);
    try {
      const parsed = parseCatalog(readJson(file), file, "overlay", file);
      errors.push(...parsed.errors);
      packs.push(...parsed.packs);
    } catch (err) {
      errors.push(issue(file, `Could not parse overlay: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  return { packs, errors };
}

/** Official catalog packs, then valid overlay packs. Overlay ids may not replace official ids. */
export function loadMergedCatalog(): { packs: VoicePack[]; errors: CatalogIssue[] } {
  const official = loadOfficialCatalog();
  const overlays = loadOverlayCatalogs();
  const merged = mergeCatalogs(official.packs, overlays.packs);
  return { packs: merged.packs, errors: [...official.errors, ...overlays.errors, ...merged.errors] };
}

export type InstalledMap = Record<string, { installedAt: string; revision?: string }>;

export type VoicePackStateFile = {
  version: 1;
  installed: InstalledMap;
};

export function readInstallState(path = stateFilePath()): VoicePackStateFile {
  if (!existsSync(path)) return { version: 1, installed: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<VoicePackStateFile>;
    const installed: InstalledMap = {};
    if (raw.installed && typeof raw.installed === "object") {
      for (const [id, value] of Object.entries(raw.installed)) {
        if (!isPackId(id) || !value || typeof value !== "object") continue;
        const row = value as { installedAt?: unknown; revision?: unknown };
        installed[id] = {
          installedAt: typeof row.installedAt === "string" ? row.installedAt : new Date().toISOString(),
          revision: typeof row.revision === "string" ? row.revision : undefined,
        };
      }
    }
    return { version: 1, installed };
  } catch {
    return { version: 1, installed: {} };
  }
}

export function writeInstallState(state: VoicePackStateFile, path = stateFilePath()): void {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function markInstalled(id: string, revision?: string, path = stateFilePath()): VoicePackStateFile {
  if (!isPackId(id)) throw new Error("Refused to record an invalid pack id.");
  const state = readInstallState(path);
  state.installed[id] = { installedAt: new Date().toISOString(), revision };
  writeInstallState(state, path);
  return state;
}

export function markRemoved(id: string, path = stateFilePath()): VoicePackStateFile {
  if (!isPackId(id)) throw new Error("Refused to record an invalid pack id.");
  const state = readInstallState(path);
  delete state.installed[id];
  writeInstallState(state, path);
  return state;
}

function huggingfaceSnapshotDir(repo: string, revision?: string): string | null {
  const slug = `models--${repo.replace(/\//g, "--")}`;
  const base = join(huggingfaceHubDir(), slug);
  if (revision) {
    const snap = join(base, "snapshots", revision);
    if (existsSync(snap)) return snap;
  }
  const refsMain = join(base, "refs", "main");
  if (existsSync(refsMain)) {
    const sha = readFileSync(refsMain, "utf8").trim();
    const snap = join(base, "snapshots", sha);
    if (existsSync(snap)) return snap;
  }
  const snaps = join(base, "snapshots");
  if (!existsSync(snaps)) return null;
  const dirs = readdirSync(snaps);
  return dirs.length ? join(snaps, dirs[0]!) : null;
}

export function packFilesPresent(pack: VoicePack): boolean {
  if (pack.source.kind === "tarball") {
    const root = join(sherpaCacheDir(), pack.source.dirName);
    const files = pack.source.files.length ? pack.source.files : [{ name: "model.int8.onnx" }];
    return files.every((file) => existsSync(join(root, file.name)));
  }
  const snap = huggingfaceSnapshotDir(pack.source.repo, pack.source.revision);
  if (!snap) return false;
  if (!pack.source.files || pack.source.files.length === 0) {
    return existsSync(snap);
  }
  return pack.source.files.every((file) => existsSync(join(snap, file.name)));
}

export function isPackInstalled(pack: VoicePack, state?: VoicePackStateFile): boolean {
  const current = state ?? readInstallState();
  if (current.installed[pack.id]) return true;
  return packFilesPresent(pack);
}

export function readProgress(path = statusFilePath()): VoicePackProgress | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const packId = typeof raw.packId === "string" ? raw.packId : typeof raw.model === "string" ? raw.model : "";
    if (!isPackId(packId)) return null;
    const state = raw.state;
    if (state !== "downloading" && state !== "verifying" && state !== "ready" && state !== "error" && state !== "removing") {
      return null;
    }
    const percent = typeof raw.percent === "number" && Number.isFinite(raw.percent) ? Math.max(0, Math.min(100, raw.percent)) : null;
    return {
      packId,
      state,
      percent,
      message: typeof raw.message === "string" ? raw.message : "",
    };
  } catch {
    return null;
  }
}

export function listPackStatus(): { packs: VoicePackStatus[]; errors: CatalogIssue[] } {
  const { packs, errors } = loadMergedCatalog();
  const state = readInstallState();
  const progress = readProgress();
  const listed = packs.map((pack) => {
    const installed = isPackInstalled(pack, state);
    const installing = progress?.packId === pack.id && (progress.state === "downloading" || progress.state === "verifying" || progress.state === "removing");
    return {
      ...pack,
      installed,
      installing,
      progress: progress?.packId === pack.id ? progress : undefined,
    } satisfies VoicePackStatus;
  });
  return { packs: listed, errors };
}

