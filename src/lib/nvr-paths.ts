/**
 * Canonical per-user data paths for Natural Voice Reader.
 * Server-only: do not import this from the browser bundle.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, cpSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type PathEnv = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  repoRoot?: string;
};

const OFFICIAL_HF_REPOS = ["KittenML/kitten-tts-mini-0.8", "k2-fsa/OmniVoice"] as const;

let migrated = false;

function envOf(opts?: PathEnv): NodeJS.ProcessEnv {
  return opts?.env ?? process.env;
}

function homeOf(opts?: PathEnv): string {
  const env = envOf(opts);
  return opts?.homedir || env.HOME || env.USERPROFILE || homedir();
}

function platformOf(opts?: PathEnv): NodeJS.Platform {
  return opts?.platform ?? process.platform;
}

export function nvrDataDir(opts?: PathEnv): string {
  const env = envOf(opts);
  if (env.NVR_DATA_HOME?.trim()) return env.NVR_DATA_HOME.trim();
  const plat = platformOf(opts);
  const home = homeOf(opts);
  if (plat === "win32") {
    const base = env.LOCALAPPDATA?.trim() || env.USERPROFILE?.trim() || home;
    return join(base, "nvr");
  }
  if (plat === "darwin") return join(home, "Library", "Application Support", "nvr");
  if (env.XDG_DATA_HOME?.trim()) return join(env.XDG_DATA_HOME.trim(), "nvr");
  return join(home, ".local", "share", "nvr");
}

export function sherpaCacheDir(opts?: PathEnv): string {
  const env = envOf(opts);
  if (env.NVR_SHERPA_CACHE?.trim()) return env.NVR_SHERPA_CACHE.trim();
  return join(nvrDataDir(opts), "sherpa");
}

export function hfHomeDir(opts?: PathEnv): string {
  const env = envOf(opts);
  if (env.NVR_HF_HOME?.trim()) return env.NVR_HF_HOME.trim();
  return join(nvrDataDir(opts), "huggingface");
}

export function huggingfaceHubDir(opts?: PathEnv): string {
  const env = envOf(opts);
  if (env.NVR_HF_HUB?.trim()) return env.NVR_HF_HUB.trim();
  return join(hfHomeDir(opts), "hub");
}

export function stateFilePath(opts?: PathEnv): string {
  const env = envOf(opts);
  if (env.NVR_VOICE_STATE?.trim()) return env.NVR_VOICE_STATE.trim();
  return join(nvrDataDir(opts), "voice-packs.json");
}

export function statusFilePath(opts?: PathEnv): string {
  const env = envOf(opts);
  if (env.NVR_VOICE_STATUS?.trim()) return env.NVR_VOICE_STATUS.trim();
  if (env.NVR_STATUS_FILE?.trim()) return env.NVR_STATUS_FILE.trim().replace(/status\.json$/, "voice-pack-status.json");
  return join(nvrDataDir(opts), "voice-pack-status.json");
}

export function bootstrapStatusPath(opts?: PathEnv): string {
  const env = envOf(opts);
  if (env.NVR_STATUS_FILE?.trim()) return env.NVR_STATUS_FILE.trim();
  return join(nvrDataDir(opts), "status.json");
}

export function kokoroModelDir(opts?: PathEnv): string {
  const env = envOf(opts);
  if (env.NVR_KOKORO_MODEL_DIR?.trim()) return env.NVR_KOKORO_MODEL_DIR.trim();
  const name = env.KOKORO_MODEL_DIR_NAME?.trim() || "kokoro-int8-multi-lang-v1_0";
  return join(sherpaCacheDir(opts), name);
}

export function legacyNvrCacheDirs(opts?: PathEnv): string[] {
  const env = envOf(opts);
  const plat = platformOf(opts);
  if (plat === "win32") return [];
  const home = homeOf(opts);
  const found: string[] = [];
  if (env.XDG_CACHE_HOME?.trim()) found.push(join(env.XDG_CACHE_HOME.trim(), "nvr"));
  const fallback = join(home, ".cache", "nvr");
  if (!found.includes(fallback)) found.push(fallback);
  return found;
}

export function legacyHfHubDirs(opts?: PathEnv): string[] {
  const env = envOf(opts);
  const home = homeOf(opts);
  const found: string[] = [];
  if (env.XDG_CACHE_HOME?.trim()) found.push(join(env.XDG_CACHE_HOME.trim(), "huggingface", "hub"));
  const fallback = join(home, ".cache", "huggingface", "hub");
  if (!found.includes(fallback)) found.push(fallback);
  return found;
}

export function hfRepoSlug(repo: string): string {
  return `models--${repo.replaceAll("/", "--")}`;
}

function samePath(a: string, b: string): boolean {
  try {
    return resolve(a) === resolve(b);
  } catch {
    return a === b;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function reposFromCatalog(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || !("packs" in payload)) return [];
  const packs = (payload as { packs: unknown }).packs;
  if (!Array.isArray(packs)) return [];
  const repos: string[] = [];
  for (const pack of packs) {
    if (!pack || typeof pack !== "object") continue;
    const source = (pack as { source?: unknown }).source;
    if (!source || typeof source !== "object") continue;
    const kind = (source as { kind?: unknown }).kind;
    const repo = (source as { repo?: unknown }).repo;
    if (kind === "huggingface" && typeof repo === "string" && repo.includes("/") && !repo.includes("..")) {
      repos.push(repo);
    }
  }
  return repos;
}

function reposFromState(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || !("installed" in payload)) return [];
  const installed = (payload as { installed: unknown }).installed;
  if (!installed || typeof installed !== "object") return [];
  const repos: string[] = [];
  for (const item of Object.values(installed as Record<string, unknown>)) {
    if (!item || typeof item !== "object") continue;
    const repo = (item as { repo?: unknown }).repo;
    if (typeof repo === "string" && repo.includes("/") && !repo.includes("..")) repos.push(repo);
  }
  return repos;
}

export function huggingfaceReposToMigrate(opts?: PathEnv): string[] {
  const env = envOf(opts);
  const repos = new Set<string>(OFFICIAL_HF_REPOS);
  const root = opts?.repoRoot || env.NVR_ROOT?.trim() || process.cwd();
  const catalog = readJson(join(root, "voices", "catalog.json"));
  for (const repo of reposFromCatalog(catalog)) repos.add(repo);
  for (const path of [stateFilePath(opts), ...legacyNvrCacheDirs(opts).map((dir) => join(dir, "voice-packs.json"))]) {
    if (!existsSync(path)) continue;
    for (const repo of reposFromState(readJson(path))) repos.add(repo);
  }
  return [...repos];
}

function movePath(src: string, dest: string, notes: string[]): void {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (code !== "EXDEV") throw err;
    cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
    rmSync(src, { recursive: true, force: true });
  }
  notes.push(`moved ${src} -> ${dest}`);
}

export function moveTree(src: string, dest: string, notes: string[]): void {
  if (!existsSync(src)) return;
  if (samePath(src, dest)) return;
  if (!existsSync(dest)) {
    movePath(src, dest, notes);
    return;
  }
  const srcStat = statSync(src);
  const destStat = statSync(dest);
  if (!srcStat.isDirectory() || !destStat.isDirectory()) {
    notes.push(`left ${src} in place because ${dest} already exists`);
    return;
  }
  for (const name of readdirSync(src)) {
    moveTree(join(src, name), join(dest, name), notes);
  }
  try {
    rmdirSync(src);
    notes.push(`removed empty ${src}`);
  } catch {
    notes.push(`left leftover files in ${src}`);
  }
}

export function applyProcessEnv(opts?: PathEnv): Record<string, string> {
  const target = opts?.env ?? process.env;
  const pathOpts: PathEnv = { ...opts, env: target };
  const updates: Record<string, string> = {
    NVR_DATA_HOME: nvrDataDir(pathOpts),
    NVR_SHERPA_CACHE: sherpaCacheDir(pathOpts),
    NVR_HF_HOME: hfHomeDir(pathOpts),
    HF_HOME: hfHomeDir(pathOpts),
    HUGGINGFACE_HUB_CACHE: huggingfaceHubDir(pathOpts),
    NVR_VOICE_STATE: stateFilePath(pathOpts),
    NVR_VOICE_STATUS: statusFilePath(pathOpts),
    NVR_STATUS_FILE: bootstrapStatusPath(pathOpts),
    NVR_KOKORO_MODEL_DIR: kokoroModelDir(pathOpts),
  };
  Object.assign(target, updates);
  return updates;
}


export function repairHfRepoRefs(hubDir: string, notes: string[]): void {
  if (!existsSync(hubDir) || !statSync(hubDir).isDirectory()) return;
  for (const name of readdirSync(hubDir).filter((item) => item.startsWith("models--")).sort()) {
    const repoDir = join(hubDir, name);
    if (!statSync(repoDir).isDirectory()) continue;
    const refsMain = join(repoDir, "refs", "main");
    if (existsSync(refsMain)) continue;
    const snaps = join(repoDir, "snapshots");
    if (!existsSync(snaps) || !statSync(snaps).isDirectory()) continue;
    const kids = readdirSync(snaps).filter((item) => statSync(join(snaps, item)).isDirectory());
    if (kids.length !== 1) continue;
    mkdirSync(join(repoDir, "refs"), { recursive: true });
    writeFileSync(refsMain, `${kids[0]}\n`, "utf8");
    notes.push(`wrote ${refsMain} -> ${kids[0]}`);
  }
}

export function migrateLegacyData(opts?: PathEnv): string[] {
  if (migrated && !opts) return [];
  const notes: string[] = [];
  const dest = nvrDataDir(opts);
  mkdirSync(dest, { recursive: true });
  for (const src of legacyNvrCacheDirs(opts)) {
    if (existsSync(src) && !samePath(src, dest)) moveTree(src, dest, notes);
  }
  const newHub = huggingfaceHubDir(opts);
  for (const oldHub of legacyHfHubDirs(opts)) {
    if (!existsSync(oldHub) || samePath(oldHub, newHub)) continue;
    for (const repo of huggingfaceReposToMigrate(opts)) {
      const src = join(oldHub, hfRepoSlug(repo));
      const dst = join(newHub, hfRepoSlug(repo));
      if (existsSync(src) && !samePath(src, dst)) moveTree(src, dst, notes);
    }
  }
  repairHfRepoRefs(newHub, notes);
  if (!opts) migrated = true;
  return notes;
}

export function resetMigrationFlag(): void {
  migrated = false;
}
