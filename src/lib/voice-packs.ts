/**
 * Voice pack catalog, validation, overlays, and install-state.
 * Pack ids are the only client-supplied input; download URLs come from the catalog.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const PACK_ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
export const KNOWN_ENGINES = ["kittentts", "kokoro", "omnivoice", "piper"] as const;
export type VoicePackEngine = string;

export type VoicePackSourceFile = {
  name: string;
  sha256?: string;
};

export type VoicePackSource =
  | {
      kind: "huggingface";
      repo: string;
      revision?: string;
      files?: VoicePackSourceFile[];
    }
  | {
      kind: "tarball";
      url: string;
      dirName: string;
      files: VoicePackSourceFile[];
    };

export type CatalogVoice = {
  id: string;
  name: string;
  note?: string;
  language: string;
  accent?: string;
  gender?: "male" | "female" | "neutral";
};

export type VoicePack = {
  id: string;
  name: string;
  description?: string;
  engine: VoicePackEngine;
  installByDefault: boolean;
  commercialUse: boolean;
  license: string;
  licenseNote?: string;
  sizeBytes: number;
  source: VoicePackSource;
  voices: CatalogVoice[];
  origin: "catalog" | "overlay";
  overlayFile?: string;
};

export type CatalogIssue = { path: string; message: string };

export type VoicePackProgress = {
  packId: string;
  state: "downloading" | "verifying" | "ready" | "error" | "removing";
  percent: number | null;
  message: string;
};

export type VoicePackStatus = VoicePack & {
  installed: boolean;
  installing: boolean;
  progress?: VoicePackProgress;
};

const HF_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SPDX = /^[A-Za-z0-9.+-]{3,128}$/;
const FILE_NAME = /^[A-Za-z0-9._-]+$/;

export function isPackId(id: unknown): id is string {
  return typeof id === "string" && PACK_ID_PATTERN.test(id);
}

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

function huggingfaceHubDir(): string {
  if (process.env.HF_HOME?.trim()) return join(process.env.HF_HOME.trim(), "hub");
  if (process.env.HUGGINGFACE_HUB_CACHE?.trim()) return process.env.HUGGINGFACE_HUB_CACHE.trim();
  return join(homedir(), ".cache", "huggingface", "hub");
}

function issue(path: string, message: string): CatalogIssue {
  return { path, message };
}

function isHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) return false;
    // Block loopback and private IPv4 / IPv6.
    if (host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

function parseVoice(raw: unknown, path: string, errors: CatalogIssue[]): CatalogVoice | null {
  if (!raw || typeof raw !== "object") {
    errors.push(issue(path, "A voice must be an object."));
    return null;
  }
  const v = raw as Record<string, unknown>;
  if (!isPackId(v.id) && !(typeof v.id === "string" && /^[a-z][a-z0-9_-]{1,63}$/.test(v.id))) {
    errors.push(issue(`${path}.id`, "Voice id must be a lowercase token."));
    return null;
  }
  if (typeof v.name !== "string" || !v.name.trim()) {
    errors.push(issue(`${path}.name`, "Voice name is required."));
    return null;
  }
  if (typeof v.language !== "string" || !v.language.trim()) {
    errors.push(issue(`${path}.language`, "A BCP-47 language tag is required."));
    return null;
  }
  const gender = v.gender;
  if (gender != null && gender !== "male" && gender !== "female" && gender !== "neutral") {
    errors.push(issue(`${path}.gender`, "gender must be male, female, or neutral."));
    return null;
  }
  return {
    id: v.id as string,
    name: v.name.trim(),
    note: typeof v.note === "string" ? v.note : undefined,
    language: v.language.trim(),
    accent: typeof v.accent === "string" ? v.accent : undefined,
    gender: gender as CatalogVoice["gender"],
  };
}

function parseSource(raw: unknown, path: string, errors: CatalogIssue[]): VoicePackSource | null {
  if (!raw || typeof raw !== "object") {
    errors.push(issue(path, "source is required."));
    return null;
  }
  const s = raw as Record<string, unknown>;
  if (s.kind === "huggingface") {
    if (typeof s.repo !== "string" || !HF_REPO.test(s.repo)) {
      errors.push(issue(`${path}.repo`, "A Hugging Face repo must look like owner/name."));
      return null;
    }
    const files = parseFiles(s.files, `${path}.files`, errors, false);
    if (s.files !== undefined && files == null && Array.isArray(s.files) === false) {
      return null;
    }
    return {
      kind: "huggingface",
      repo: s.repo,
      revision: typeof s.revision === "string" && s.revision.trim() ? s.revision.trim() : undefined,
      files: files ?? undefined,
    };
  }
  if (s.kind === "tarball") {
    if (typeof s.url !== "string" || !isHttpsUrl(s.url)) {
      errors.push(issue(`${path}.url`, "Tarball URL must be https and a public host."));
      return null;
    }
    if (typeof s.dirName !== "string" || !/^[A-Za-z0-9._-]+$/.test(s.dirName)) {
      errors.push(issue(`${path}.dirName`, "dirName must be a single path segment."));
      return null;
    }
    const files = parseFiles(s.files, `${path}.files`, errors, true);
    if (!files) return null;
    return { kind: "tarball", url: s.url, dirName: s.dirName, files };
  }
  errors.push(issue(`${path}.kind`, "source.kind must be huggingface or tarball."));
  return null;
}

function parseFiles(
  raw: unknown,
  path: string,
  errors: CatalogIssue[],
  required: boolean,
): VoicePackSourceFile[] | null {
  if (raw == null) {
    if (required) {
      errors.push(issue(path, "A file list is required so the download can be verified."));
      return null;
    }
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(issue(path, "files must be a non-empty array when present."));
    return null;
  }
  const files: VoicePackSourceFile[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== "object") {
      errors.push(issue(`${path}[${i}]`, "Each file must be an object."));
      return;
    }
    const f = item as Record<string, unknown>;
    if (typeof f.name !== "string" || !FILE_NAME.test(f.name)) {
      errors.push(issue(`${path}[${i}].name`, "File names must be a single path segment."));
      return;
    }
    if (f.sha256 != null && (typeof f.sha256 !== "string" || !SHA256.test(f.sha256))) {
      errors.push(issue(`${path}[${i}].sha256`, "sha256 must be a 64-character hex digest."));
      return;
    }
    files.push({ name: f.name, sha256: typeof f.sha256 === "string" ? f.sha256 : undefined });
  });
  return files.length === raw.length ? files : null;
}

export function parsePack(raw: unknown, path: string, origin: VoicePack["origin"], overlayFile?: string): {
  pack: VoicePack | null;
  errors: CatalogIssue[];
} {
  const errors: CatalogIssue[] = [];
  if (!raw || typeof raw !== "object") {
    return { pack: null, errors: [issue(path, "A pack must be an object.")] };
  }
  const p = raw as Record<string, unknown>;
  if (!isPackId(p.id)) {
    errors.push(issue(`${path}.id`, "Pack id must match [a-z][a-z0-9_-]{1,63}."));
  }
  if (typeof p.name !== "string" || !p.name.trim()) {
    errors.push(issue(`${path}.name`, "Pack name is required."));
  }
  if (typeof p.engine !== "string" || !/^[a-z][a-z0-9-]+$/.test(p.engine)) {
    errors.push(issue(`${path}.engine`, "engine must be a lowercase token (kittentts, kokoro, omnivoice, piper, or an extension)."));
  }
  if (typeof p.installByDefault !== "boolean") {
    errors.push(issue(`${path}.installByDefault`, "installByDefault must be a boolean."));
  }
  if (typeof p.commercialUse !== "boolean") {
    errors.push(issue(`${path}.commercialUse`, "commercialUse must be a boolean."));
  }
  if (typeof p.license !== "string" || !SPDX.test(p.license)) {
    errors.push(issue(`${path}.license`, "license must be an SPDX id or LicenseRef-... token."));
  }
  if (typeof p.sizeBytes !== "number" || !Number.isFinite(p.sizeBytes) || p.sizeBytes < 0) {
    errors.push(issue(`${path}.sizeBytes`, "sizeBytes must be a non-negative number."));
  }
  const source = parseSource(p.source, `${path}.source`, errors);
  if (!Array.isArray(p.voices)) {
    errors.push(issue(`${path}.voices`, "voices must be an array (it may be empty)."));
  }
  const voices = Array.isArray(p.voices)
    ? p.voices.map((voice, i) => parseVoice(voice, `${path}.voices[${i}]`, errors)).filter((v): v is CatalogVoice => v != null)
    : [];
  if (errors.length || !source || !isPackId(p.id)) {
    return { pack: null, errors };
  }
  return {
    pack: {
      id: p.id,
      name: (p.name as string).trim(),
      description: typeof p.description === "string" ? p.description : undefined,
      engine: p.engine as string,
      installByDefault: Boolean(p.installByDefault),
      commercialUse: Boolean(p.commercialUse),
      license: p.license as string,
      licenseNote: typeof p.licenseNote === "string" ? p.licenseNote : undefined,
      sizeBytes: p.sizeBytes as number,
      source,
      voices,
      origin,
      overlayFile,
    },
    errors,
  };
}

export function parseCatalog(raw: unknown, path: string, origin: VoicePack["origin"], overlayFile?: string): {
  packs: VoicePack[];
  errors: CatalogIssue[];
} {
  const errors: CatalogIssue[] = [];
  if (!raw || typeof raw !== "object") {
    return { packs: [], errors: [issue(path, "Catalog must be a JSON object.")] };
  }
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1) {
    errors.push(issue(`${path}.version`, "Catalog version must be 1."));
  }
  if (!Array.isArray(doc.packs)) {
    errors.push(issue(`${path}.packs`, "packs must be an array."));
    return { packs: [], errors };
  }
  const packs: VoicePack[] = [];
  const seen = new Set<string>();
  doc.packs.forEach((item, i) => {
    const parsed = parsePack(item, `${path}.packs[${i}]`, origin, overlayFile);
    errors.push(...parsed.errors);
    if (!parsed.pack) return;
    if (seen.has(parsed.pack.id)) {
      errors.push(issue(`${path}.packs[${i}].id`, `Duplicate pack id "${parsed.pack.id}" in the same file.`));
      return;
    }
    seen.add(parsed.pack.id);
    packs.push(parsed.pack);
  });
  return { packs, errors };
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
export function mergeCatalogs(
  official: VoicePack[],
  overlays: VoicePack[],
): { packs: VoicePack[]; errors: CatalogIssue[] } {
  const packs = [...official];
  const officialIds = new Set(official.map((p) => p.id));
  const seen = new Set(officialIds);
  const errors: CatalogIssue[] = [];
  for (const pack of overlays) {
    if (officialIds.has(pack.id)) {
      errors.push(
        issue(pack.overlayFile || pack.id, `Overlay pack "${pack.id}" is ignored because that id is reserved by the official catalog.`),
      );
      continue;
    }
    if (seen.has(pack.id)) {
      errors.push(issue(pack.overlayFile || pack.id, `Overlay pack "${pack.id}" is ignored because that id was already added.`));
      continue;
    }
    seen.add(pack.id);
    packs.push(pack);
  }
  return { packs, errors };
}

export function loadMergedCatalog(): { packs: VoicePack[]; errors: CatalogIssue[] } {
  const official = loadOfficialCatalog();
  const overlays = loadOverlayCatalogs();
  const merged = mergeCatalogs(official.packs, overlays.packs);
  return { packs: merged.packs, errors: [...official.errors, ...overlays.errors, ...merged.errors] };
}

export function packById(id: string, packs?: VoicePack[]): VoicePack | undefined {
  if (!isPackId(id)) return undefined;
  const list = packs ?? loadMergedCatalog().packs;
  return list.find((pack) => pack.id === id);
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

export function voicesInInstalledPacks(packs?: VoicePackStatus[]): CatalogVoice[] {
  const list = packs ?? listPackStatus().packs;
  const voices: CatalogVoice[] = [];
  const seen = new Set<string>();
  for (const pack of list) {
    if (!pack.installed) continue;
    for (const voice of pack.voices) {
      if (seen.has(voice.id)) continue;
      seen.add(voice.id);
      voices.push(voice);
    }
  }
  return voices;
}

export function packIdForVoice(voiceId: string, packs?: VoicePack[]): string | undefined {
  const list = packs ?? loadMergedCatalog().packs;
  return list.find((pack) => pack.voices.some((voice) => voice.id === voiceId))?.id;
}

export function formatPackSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Used by tests and the CLI to confirm a path stays inside a cache root. */
export function assertSafeRelativeName(name: string): string {
  if (!name || isAbsolute(name) || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error("Refused a path that is not a single safe file name.");
  }
  return name;
}
