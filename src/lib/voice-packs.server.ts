/**
 * Server-only voice pack catalog I/O, install state, and on-disk detection.
 * The browser must import from voice-packs.ts, not this file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  COMMUNITY_INDEX_MAX_BYTES,
  DEFAULT_CATALOG_HOSTS,
  DEFAULT_COMMUNITY_INDEX_URL,
  isAllowedCatalogUrl,
  isPackId,
  mergeCatalogs,
  parseCatalog,
  parseCommunityCatalog,
  type CatalogIssue,
  type VoicePack,
  type VoicePackProgress,
  type CommunityBrowsePack,
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


export function catalogAllowLocal(): boolean {
  const value = process.env.NVR_CATALOG_ALLOW_LOCAL?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function defaultCommunityIndex(): string {
  return process.env.NVR_COMMUNITY_INDEX?.trim() || DEFAULT_COMMUNITY_INDEX_URL;
}

export function catalogIndexesPath(): string {
  if (process.env.NVR_CATALOG_INDEXES?.trim()) return process.env.NVR_CATALOG_INDEXES.trim();
  if (process.platform === "win32") {
    const base = process.env.APPDATA?.trim() || process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Roaming");
    return join(base, "nvr", "catalog-indexes.json");
  }
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "nvr", "catalog-indexes.json");
}

type IndexFile = { version: 1; urls: string[] };

function readIndexFile(): IndexFile {
  const path = catalogIndexesPath();
  if (!existsSync(path)) return { version: 1, urls: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<IndexFile>;
    const urls = Array.isArray(raw.urls) ? raw.urls.filter((url): url is string => typeof url === "string" && url.trim() !== "") : [];
    return { version: 1, urls };
  } catch {
    return { version: 1, urls: [] };
  }
}

function writeIndexFile(file: IndexFile): void {
  const path = catalogIndexesPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, urls: file.urls }, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function readCatalogIndexUrls(): string[] {
  const fallback = defaultCommunityIndex();
  const extra = readIndexFile().urls.filter((url) => url !== fallback);
  return [fallback, ...extra];
}

export function addCatalogIndexUrl(url: string): string[] {
  if (!isAllowedCatalogUrl(url, { allowLocal: catalogAllowLocal() })) {
    throw new Error("Catalog URLs must be https on an allowed host such as github.com or huggingface.co.");
  }
  const fallback = defaultCommunityIndex();
  if (url === fallback) return readCatalogIndexUrls();
  const file = readIndexFile();
  if (!file.urls.includes(url)) file.urls.push(url);
  writeIndexFile(file);
  return readCatalogIndexUrls();
}

export function removeCatalogIndexUrl(url: string): string[] {
  if (url === defaultCommunityIndex()) {
    throw new Error("The default community catalog cannot be removed.");
  }
  const file = readIndexFile();
  file.urls = file.urls.filter((item) => item !== url);
  writeIndexFile(file);
  return readCatalogIndexUrls();
}

function assertIndexUrl(url: string): void {
  if (!isAllowedCatalogUrl(url, { allowLocal: catalogAllowLocal(), hosts: DEFAULT_CATALOG_HOSTS })) {
    throw new Error("Refused a catalog URL that is not https on an allowed host.");
  }
}

async function readIndexPayload(url: string): Promise<unknown> {
  const allowLocal = catalogAllowLocal();
  assertIndexUrl(url);
  if (allowLocal && url.startsWith("/") && !url.includes("://")) {
    const buf = readFileSync(url);
    if (buf.byteLength > COMMUNITY_INDEX_MAX_BYTES) {
      throw new Error("That catalog index is larger than the 1 MB limit.");
    }
    return JSON.parse(buf.toString("utf8"));
  }
  if (allowLocal && url.startsWith("file:")) {
    const path = new URL(url).pathname;
    const buf = readFileSync(path);
    if (buf.byteLength > COMMUNITY_INDEX_MAX_BYTES) {
      throw new Error("That catalog index is larger than the 1 MB limit.");
    }
    return JSON.parse(buf.toString("utf8"));
  }
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "Natural-Voice-Reader", accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Could not fetch the catalog index (${response.status}).`);
  }
  const finalUrl = response.url || url;
  if (!isAllowedCatalogUrl(finalUrl, { allowLocal, hosts: DEFAULT_CATALOG_HOSTS })) {
    throw new Error("The catalog index redirected to a host that is not allowed.");
  }
  const length = Number(response.headers.get("content-length") || 0);
  if (length > COMMUNITY_INDEX_MAX_BYTES) {
    throw new Error("That catalog index is larger than the 1 MB limit.");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > COMMUNITY_INDEX_MAX_BYTES) {
    throw new Error("That catalog index is larger than the 1 MB limit.");
  }
  return JSON.parse(buffer.toString("utf8"));
}

export type CommunityIndexResult = {
  url: string;
  packs: VoicePack[];
  errors: CatalogIssue[];
};

export async function fetchCommunityIndex(url: string): Promise<CommunityIndexResult> {
  assertIndexUrl(url);
  try {
    const raw = await readIndexPayload(url);
    const parsed = parseCommunityCatalog(raw, url, { allowLocal: catalogAllowLocal() });
    return { url, packs: parsed.packs, errors: parsed.errors };
  } catch (err) {
    return {
      url,
      packs: [],
      errors: [{ path: url, message: err instanceof Error ? err.message : "Could not read that catalog index." }],
    };
  }
}

export async function listCommunityPacks(): Promise<{ packs: CommunityBrowsePack[]; errors: CatalogIssue[]; urls: string[] }> {
  const official = loadOfficialCatalog();
  const officialIds = new Set(official.packs.map((pack) => pack.id));
  const local = loadMergedCatalog();
  const localIds = new Set(local.packs.map((pack) => pack.id));
  const state = readInstallState();
  const urls = readCatalogIndexUrls();
  const errors: CatalogIssue[] = [...official.errors, ...local.errors];
  const seen = new Set<string>();
  const packs: CommunityBrowsePack[] = [];
  for (const url of urls) {
    const result = await fetchCommunityIndex(url);
    errors.push(...result.errors);
    for (const pack of result.packs) {
      if (officialIds.has(pack.id)) {
        errors.push({ path: url, message: `Community pack "${pack.id}" is ignored because that id is reserved by the official catalog.` });
        continue;
      }
      if (seen.has(pack.id)) continue;
      seen.add(pack.id);
      const localPack = local.packs.find((item) => item.id === pack.id);
      packs.push({
        ...pack,
        indexUrl: url,
        inLibrary: localIds.has(pack.id),
        installed: localPack ? isPackInstalled(localPack, state) : false,
      });
    }
  }
  return { packs, errors, urls };
}

export function writeCommunityOverlay(pack: VoicePack): string {
  const dir = overlayDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `community-${pack.id}.json`);
  const doc = {
    version: 1,
    packs: [
      {
        id: pack.id,
        name: pack.name,
        description: pack.description,
        engine: pack.engine,
        installByDefault: false,
        commercialUse: pack.commercialUse,
        license: pack.license,
        licenseNote: pack.licenseNote,
        sizeBytes: pack.sizeBytes,
        source: pack.source,
        voices: pack.voices,
        community: true,
      },
    ],
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
  return file;
}
