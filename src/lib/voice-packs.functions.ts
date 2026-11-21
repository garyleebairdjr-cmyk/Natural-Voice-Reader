import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { isPackId, packById, type CatalogIssue, type VoicePackStatus } from "./voice-packs.ts";
import { listPackStatus, loadMergedCatalog, readProgress, repoRoot, statusFilePath } from "./voice-packs.server.ts";

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
    const child = spawn(packManagerPython(), [script, ...args], {
      env: {
        ...process.env,
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
