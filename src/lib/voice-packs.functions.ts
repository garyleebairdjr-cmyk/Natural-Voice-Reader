import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import {
  filterCommunityPacks,
  isAllowedCatalogUrl,
  isPackId,
  packById,
  type CatalogIssue,
  type CommunityBrowsePack,
  type VoicePackStatus,
} from "./voice-packs.ts";
import { applyProcessEnv, migrateLegacyData } from "./nvr-paths.ts";
import {
  addCatalogIndexUrl,
  catalogAllowLocal,
  listCommunityPacks,
  listPackStatus,
  loadMergedCatalog,
  readCatalogIndexUrls,
  readProgress,
  removeCatalogIndexUrl,
  repoRoot,
  statusFilePath,
  writeCommunityOverlay,
} from "./voice-packs.server.ts";

export type VoicePackListResult = {
  packs: VoicePackStatus[];
  errors: CatalogIssue[];
};

function voiceStudioRoot(): string {
  if (process.env.VOICESTUDIO_ROOT?.trim()) return process.env.VOICESTUDIO_ROOT.trim();
  const home = homedir();
  const dev = join(home, "Dev", "Source", "VoiceStudio");
  if (existsSync(dev)) return dev;
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
    return join(base, "nvr", "VoiceStudio");
  }
  return join(home, ".local", "share", "nvr", "VoiceStudio");
}

function packManagerPython(): string {
  const venv = process.platform === "win32"
    ? join(voiceStudioRoot(), ".venv", "Scripts", "python.exe")
    : join(voiceStudioRoot(), ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return process.platform === "win32" ? "python" : "python3";
}

function packManagerScript(): string {
  return join(repoRoot(), "scripts", "voice-packs.py");
}

function runPackCommand(args: string[]): Promise<{ code: number; output: string }> {
  const script = packManagerScript();
  if (!existsSync(script)) {
    return Promise.resolve({ code: 2, output: "The voice pack manager script is missing." });
  }
  return new Promise((resolve, reject) => {
    migrateLegacyData();
    const child = spawn(packManagerPython(), [script, ...args], {
      env: {
        ...process.env,
        ...applyProcessEnv(),
        NVR_ROOT: repoRoot(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });
}

function assertKnownPack(id: unknown): string {
  if (!isPackId(id)) {
    throw new Error("That is not a valid voice pack id.");
  }
  if (!packById(id, loadMergedCatalog().packs)) {
    throw new Error("Unknown voice pack. Only catalog and overlay ids can be installed.");
  }
  return id;
}

export const listVoicePacks = createServerFn({ method: "GET" }).handler(async (): Promise<VoicePackListResult> => {
  return listPackStatus();
});

export const installVoicePack = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = input as { id?: unknown };
    return { id: assertKnownPack(raw.id) };
  })
  .handler(async ({ data }): Promise<VoicePackListResult> => {
    const progress = readProgress();
    if (progress && (progress.state === "downloading" || progress.state === "verifying" || progress.state === "removing") && progress.packId !== data.id) {
      throw new Error(`Another pack (${progress.packId}) is already being changed. Try again when it finishes.`);
    }
    const result = await runPackCommand(["install", data.id, "--status-file", statusFilePath()]);
    if (result.code !== 0) {
      throw new Error(result.output || "Could not install that voice pack.");
    }
    return listPackStatus();
  });

export const removeVoicePack = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = input as { id?: unknown };
    return { id: assertKnownPack(raw.id) };
  })
  .handler(async ({ data }): Promise<VoicePackListResult> => {
    const progress = readProgress();
    if (progress && (progress.state === "downloading" || progress.state === "verifying") && progress.packId !== data.id) {
      throw new Error(`Another pack (${progress.packId}) is already being changed. Try again when it finishes.`);
    }
    const result = await runPackCommand(["remove", data.id, "--status-file", statusFilePath()]);
    if (result.code !== 0) {
      throw new Error(result.output || "Could not remove that voice pack.");
    }
    return listPackStatus();
  });

export type CommunityBrowseResult = {
  packs: CommunityBrowsePack[];
  errors: CatalogIssue[];
  urls: string[];
};

export const listCatalogIndexes = createServerFn({ method: "GET" }).handler(async () => {
  return { urls: readCatalogIndexUrls() };
});

export const addCatalogIndex = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = input as { url?: unknown };
    if (typeof raw.url !== "string" || !raw.url.trim()) {
      throw new Error("Enter a catalog URL.");
    }
    const url = raw.url.trim();
    if (!isAllowedCatalogUrl(url, { allowLocal: catalogAllowLocal() })) {
      throw new Error("Catalog URLs must be https on an allowed host such as github.com or huggingface.co.");
    }
    return { url };
  })
  .handler(async ({ data }) => {
    return { urls: addCatalogIndexUrl(data.url) };
  });

export const removeCatalogIndex = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = input as { url?: unknown };
    if (typeof raw.url !== "string" || !raw.url.trim()) {
      throw new Error("Missing catalog URL.");
    }
    return { url: raw.url.trim() };
  })
  .handler(async ({ data }) => {
    return { urls: removeCatalogIndexUrl(data.url) };
  });

export const browseVoicePacks = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const gender = raw.gender === "male" || raw.gender === "female" || raw.gender === "neutral" ? raw.gender as "male" | "female" | "neutral" : undefined;
    const commercialUse = raw.commercialUse === true ? true : raw.commercialUse === false ? false : undefined;
    return {
      query: typeof raw.query === "string" ? raw.query : "",
      language: typeof raw.language === "string" ? raw.language : "",
      gender,
      license: typeof raw.license === "string" ? raw.license : "",
      commercialUse,
    };
  })
  .handler(async ({ data }): Promise<CommunityBrowseResult> => {
    const result = await listCommunityPacks();
    return {
      packs: filterCommunityPacks(result.packs, data) as CommunityBrowsePack[],
      errors: result.errors,
      urls: result.urls,
    };
  });

export const installCommunityPack = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = input as { id?: unknown };
    if (!isPackId(raw.id)) {
      throw new Error("That is not a valid voice pack id.");
    }
    return { id: raw.id };
  })
  .handler(async ({ data }): Promise<VoicePackListResult> => {
    const listed = await listCommunityPacks();
    const pack = listed.packs.find((item) => item.id === data.id);
    if (!pack) {
      throw new Error("Unknown community pack. Refresh the catalog and try again.");
    }
    writeCommunityOverlay(pack);
    const progress = readProgress();
    if (progress && (progress.state === "downloading" || progress.state === "verifying" || progress.state === "removing") && progress.packId !== data.id) {
      throw new Error(`Another pack (${progress.packId}) is already being changed. Try again when it finishes.`);
    }
    const result = await runPackCommand(["install", data.id, "--status-file", statusFilePath()]);
    if (result.code !== 0) {
      throw new Error(result.output || "Could not install that voice pack.");
    }
    return listPackStatus();
  });
