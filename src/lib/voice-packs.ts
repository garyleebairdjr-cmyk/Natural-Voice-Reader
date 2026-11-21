/**
 * Voice pack catalog schema, validation, overlay merge rules, and UI helpers.
 * Pack ids are the only client-supplied input; download URLs come from the catalog.
 * Node filesystem access lives in voice-packs.server.ts so the browser bundle stays clean.
 */

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
  origin: "catalog" | "overlay" | "community";
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

export type CommunityBrowsePack = VoicePack & {
  indexUrl: string;
  installed: boolean;
  inLibrary: boolean;
};

const HF_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SPDX = /^[A-Za-z0-9.+-]{3,128}$/;
const FILE_NAME = /^[A-Za-z0-9._-]+$/;

export function isPackId(id: unknown): id is string {
  return typeof id === "string" && PACK_ID_PATTERN.test(id);
}

export const DEFAULT_COMMUNITY_INDEX_URL =
  "https://raw.githubusercontent.com/garyleebairdjr-cmyk/Natural-Voice-Reader/main/voices/community-catalog.json";

export const DEFAULT_CATALOG_HOSTS = [
  "huggingface.co",
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "media.githubusercontent.com",
  "codeload.github.com",
] as const;

export const COMMUNITY_INDEX_MAX_BYTES = 1_048_576;

export type CatalogUrlOptions = {
  hosts?: readonly string[];
  allowLocal?: boolean;
};

export type ParsePackOptions = {
  requireFileHashes?: boolean;
  allowedHosts?: readonly string[];
  allowLocal?: boolean;
};

function issue(path: string, message: string): CatalogIssue {
  return { path, message };
}

function isPrivateHost(host: string): boolean {
  const name = host.toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "127.0.0.1" || name === "::1" || name === "0.0.0.0") return true;
  if (/^10\./.test(name) || /^192\.168\./.test(name) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(name)) return true;
  if (name.endsWith(".internal") || name.endsWith(".local")) return true;
  return false;
}

export function catalogHostAllowed(host: string, hosts: readonly string[] = DEFAULT_CATALOG_HOSTS): boolean {
  const name = host.toLowerCase();
  return hosts.some((allowed) => name === allowed || name.endsWith(`.${allowed}`));
}

/** Public https URL with no credentials. Official catalogs use this looser check. */
function isHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    return !isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}

/** Community indexes and pack sources must be https on an allowed host, unless a local test override is on. */
export function isAllowedCatalogUrl(raw: string, options: CatalogUrlOptions = {}): boolean {
  const allowLocal = Boolean(options.allowLocal);
  const hosts = options.hosts ?? DEFAULT_CATALOG_HOSTS;
  if (allowLocal && raw.startsWith("/") && !raw.includes("://")) {
    return !raw.includes("\0");
  }
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    if (url.protocol === "file:") return allowLocal;
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (isPrivateHost(url.hostname)) return allowLocal;
      if (url.protocol !== "https:") return false;
      return catalogHostAllowed(url.hostname, hosts);
    }
    return false;
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

function parseSource(raw: unknown, path: string, errors: CatalogIssue[], options: ParsePackOptions = {}): VoicePackSource | null {
  if (!raw || typeof raw !== "object") {
    errors.push(issue(path, "source is required."));
    return null;
  }
  const requireHashes = Boolean(options.requireFileHashes);
  const s = raw as Record<string, unknown>;
  if (s.kind === "huggingface") {
    if (typeof s.repo !== "string" || !HF_REPO.test(s.repo)) {
      errors.push(issue(`${path}.repo`, "A Hugging Face repo must look like owner/name."));
      return null;
    }
    if (options.allowedHosts && !catalogHostAllowed("huggingface.co", options.allowedHosts)) {
      errors.push(issue(`${path}.repo`, "Hugging Face is not on the catalog host allowlist."));
      return null;
    }
    const files = parseFiles(s.files, `${path}.files`, errors, requireHashes, requireHashes);
    if (requireHashes && !files) return null;
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
    const urlOk = typeof s.url === "string" && (
      options.allowedHosts
        ? isAllowedCatalogUrl(s.url, { hosts: options.allowedHosts, allowLocal: options.allowLocal })
        : isHttpsUrl(s.url)
    );
    if (!urlOk) {
      errors.push(issue(`${path}.url`, options.allowedHosts
        ? "Tarball URL must be https on an allowed host."
        : "Tarball URL must be https and a public host."));
      return null;
    }
    if (typeof s.dirName !== "string" || !/^[A-Za-z0-9._-]+$/.test(s.dirName)) {
      errors.push(issue(`${path}.dirName`, "dirName must be a single path segment."));
      return null;
    }
    const files = parseFiles(s.files, `${path}.files`, errors, true, requireHashes);
    if (!files) return null;
    return { kind: "tarball", url: s.url as string, dirName: s.dirName, files };
  }
  errors.push(issue(`${path}.kind`, "source.kind must be huggingface or tarball."));
  return null;
}

function parseFiles(
  raw: unknown,
  path: string,
  errors: CatalogIssue[],
  required: boolean,
  requireHashes = false,
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
    if (requireHashes && (typeof f.sha256 !== "string" || !SHA256.test(f.sha256))) {
      errors.push(issue(`${path}[${i}].sha256`, "Community packs require a sha256 digest for every file."));
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

export function parsePack(
  raw: unknown,
  path: string,
  origin: VoicePack["origin"],
  overlayFile?: string,
  options: ParsePackOptions = {},
): {
  pack: VoicePack | null;
  errors: CatalogIssue[];
} {
  const errors: CatalogIssue[] = [];
  if (!raw || typeof raw !== "object") {
    return { pack: null, errors: [issue(path, "A pack must be an object.")] };
  }
  const p = raw as Record<string, unknown>;
  const resolvedOrigin: VoicePack["origin"] = p.community === true ? "community" : origin;
  const resolvedOptions: ParsePackOptions = resolvedOrigin === "community"
    ? {
        allowLocal: options.allowLocal,
        requireFileHashes: options.requireFileHashes ?? true,
        allowedHosts: options.allowedHosts ?? DEFAULT_CATALOG_HOSTS,
      }
    : options;
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
  const source = parseSource(p.source, `${path}.source`, errors, resolvedOptions);
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
      origin: resolvedOrigin,
      overlayFile,
    },
    errors,
  };
}

export function parseCatalog(
  raw: unknown,
  path: string,
  origin: VoicePack["origin"],
  overlayFile?: string,
  options: ParsePackOptions = {},
): {
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
    const parsed = parsePack(item, `${path}.packs[${i}]`, origin, overlayFile, options);
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


export type CommunityPackFilter = {
  query?: string;
  language?: string;
  gender?: "male" | "female" | "neutral";
  license?: string;
  commercialUse?: boolean;
};

export function parseCommunityCatalog(
  raw: unknown,
  path: string,
  options: ParsePackOptions = {},
): { packs: VoicePack[]; errors: CatalogIssue[] } {
  return parseCatalog(raw, path, "community", path, {
    requireFileHashes: true,
    allowedHosts: options.allowedHosts ?? DEFAULT_CATALOG_HOSTS,
    allowLocal: options.allowLocal,
  });
}

export function filterCommunityPacks(packs: VoicePack[], filter: CommunityPackFilter = {}): VoicePack[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  return packs.filter((pack) => {
    if (filter.commercialUse != null && pack.commercialUse !== filter.commercialUse) return false;
    if (filter.license && pack.license.toLowerCase() !== filter.license.toLowerCase()) return false;
    if (filter.language) {
      const needle = filter.language.toLowerCase();
      const matches = pack.voices.some(
        (voice) => voice.language.toLowerCase() === needle || voice.language.toLowerCase().startsWith(`${needle}-`) || voice.language.toLowerCase().startsWith(needle),
      );
      if (!matches) return false;
    }
    if (filter.gender && !pack.voices.some((voice) => voice.gender === filter.gender)) return false;
    if (!query) return true;
    const hay = [
      pack.id,
      pack.name,
      pack.description ?? "",
      pack.engine,
      pack.license,
      ...pack.voices.flatMap((voice) => [voice.id, voice.name, voice.language, voice.accent ?? "", voice.note ?? ""]),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(query);
  });
}

export function packById(id: string, packs: VoicePack[]): VoicePack | undefined {
  if (!isPackId(id)) return undefined;
  return packs.find((pack) => pack.id === id);
}

export function voicesInInstalledPacks(packs: VoicePackStatus[]): CatalogVoice[] {
  const voices: CatalogVoice[] = [];
  const seen = new Set<string>();
  for (const pack of packs) {
    if (!pack.installed) continue;
    for (const voice of pack.voices) {
      if (seen.has(voice.id)) continue;
      seen.add(voice.id);
      voices.push(voice);
    }
  }
  return voices;
}

export function packIdForVoice(voiceId: string, packs: VoicePack[]): string | undefined {
  return packs.find((pack) => pack.voices.some((voice) => voice.id === voiceId))?.id;
}

export function formatPackSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Used by tests and the CLI to confirm a path stays inside a cache root. */
export function assertSafeRelativeName(name: string): string {
  const absolute = name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(name);
  if (!name || absolute || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error("Refused a path that is not a single safe file name.");
  }
  return name;
}
