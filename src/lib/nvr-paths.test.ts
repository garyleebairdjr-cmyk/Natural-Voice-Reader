import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hfHomeDir,
  huggingfaceHubDir,
  migrateLegacyData,
  nvrDataDir,
  repairHfRepoRefs,
  sherpaCacheDir,
  stateFilePath,
} from "./nvr-paths.ts";

const tmp = mkdtempSync(join(tmpdir(), "nvr-paths-ts-"));

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("nvr data directory", () => {
  it("uses XDG data, Application Support, and LOCALAPPDATA on each platform", () => {
    assert.equal(nvrDataDir({ platform: "linux", homedir: "/home/gary", env: {} }), "/home/gary/.local/share/nvr");
    assert.equal(
      nvrDataDir({ platform: "linux", homedir: "/home/gary", env: { XDG_DATA_HOME: "/home/gary/.data" } }),
      "/home/gary/.data/nvr",
    );
    assert.equal(
      nvrDataDir({ platform: "darwin", homedir: "/Users/gary", env: {} }),
      "/Users/gary/Library/Application Support/nvr",
    );
    assert.equal(
      nvrDataDir({
        platform: "win32",
        homedir: "C:\\Users\\gary",
        env: { LOCALAPPDATA: "C:\\Users\\gary\\AppData\\Local" },
      }),
      join("C:\\Users\\gary\\AppData\\Local", "nvr"),
    );
    assert.equal(
      nvrDataDir({ platform: "linux", homedir: "/home/gary", env: { NVR_DATA_HOME: "/tmp/custom-nvr" } }),
      "/tmp/custom-nvr",
    );
  });

  it("keeps sherpa and Hugging Face downloads under the data dir", () => {
    const opts = { platform: "linux" as const, homedir: "/home/gary", env: {} };
    const data = nvrDataDir(opts);
    assert.equal(sherpaCacheDir(opts), join(data, "sherpa"));
    assert.equal(hfHomeDir(opts), join(data, "huggingface"));
    assert.equal(huggingfaceHubDir(opts), join(data, "huggingface", "hub"));
    assert.equal(stateFilePath(opts), join(data, "voice-packs.json"));
  });
});

describe("legacy cache migration", () => {
  it("moves the old nvr cache and our pack HF repos, leaving unrelated HF repos", () => {
    const home = join(tmp, "home-move");
    mkdirSync(home, { recursive: true });
    const cache = join(home, ".cache", "nvr");
    mkdirSync(join(cache, "sherpa", "kokoro-int8-multi-lang-v1_0"), { recursive: true });
    writeFileSync(join(cache, "sherpa", "kokoro-int8-multi-lang-v1_0", "model.int8.onnx"), "weights");
    writeFileSync(join(cache, "voice-packs.json"), '{"version":1,"installed":{"kokoro":{"installedAt":"2026-01-01T00:00:00Z"}}}');
    const kitten = join(home, ".cache", "huggingface", "hub", "models--KittenML--kitten-tts-mini-0.8");
    mkdirSync(kitten, { recursive: true });
    writeFileSync(join(kitten, "snapshot.bin"), "kitten");
    const other = join(home, ".cache", "huggingface", "hub", "models--SomeoneElse--unrelated");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "keep.bin"), "keep");

    const env = { HOME: home, NVR_ROOT: process.cwd() };
    const opts = { platform: "linux" as const, homedir: home, env, repoRoot: process.cwd() };
    migrateLegacyData(opts);
    const dest = nvrDataDir(opts);
    assert.equal(existsSync(join(dest, "sherpa", "kokoro-int8-multi-lang-v1_0", "model.int8.onnx")), true);
    assert.equal(existsSync(join(dest, "voice-packs.json")), true);
    assert.equal(existsSync(cache), false);
    assert.equal(existsSync(join(dest, "huggingface", "hub", "models--KittenML--kitten-tts-mini-0.8", "snapshot.bin")), true);
    assert.equal(existsSync(kitten), false);
    assert.equal(existsSync(join(other, "keep.bin")), true);
  });

  it("is idempotent after a complete move", () => {
    const home = join(tmp, "home-again");
    mkdirSync(join(home, ".cache", "nvr"), { recursive: true });
    writeFileSync(join(home, ".cache", "nvr", "voice-packs.json"), '{"version":1,"installed":{}}');
    const env = { HOME: home };
    const opts = { platform: "linux" as const, homedir: home, env };
    migrateLegacyData(opts);
    const dest = nvrDataDir(opts);
    assert.equal(existsSync(join(home, ".cache", "nvr")), false);
    const again = migrateLegacyData(opts);
    assert.equal(again.length, 0);
    assert.equal(existsSync(join(dest, "voice-packs.json")), true);
  });

  it("writes refs/main when a moved Hugging Face repo has a single snapshot", () => {
    const home = join(tmp, "home-refs");
    const env = { HOME: home };
    const opts = { platform: "linux" as const, homedir: home, env };
    const dest = nvrDataDir(opts);
    const snap = join(dest, "huggingface", "hub", "models--k2-fsa--OmniVoice", "snapshots", "abc123");
    mkdirSync(snap, { recursive: true });
    writeFileSync(join(snap, "config.json"), "{}");
    const notes: string[] = [];
    repairHfRepoRefs(join(dest, "huggingface", "hub"), notes);
    assert.equal(readFileSync(join(dest, "huggingface", "hub", "models--k2-fsa--OmniVoice", "refs", "main"), "utf8").trim(), "abc123");
    assert.ok(notes.some((line) => line.includes("refs")));
  });

  it("does not overwrite files already in the data dir", () => {
    const home = join(tmp, "home-merge");
    mkdirSync(join(home, ".cache", "nvr"), { recursive: true });
    writeFileSync(join(home, ".cache", "nvr", "voice-packs.json"), "old");
    writeFileSync(join(home, ".cache", "nvr", "only-old.txt"), "from-old");
    const env = { HOME: home };
    const opts = { platform: "linux" as const, homedir: home, env };
    const dest = nvrDataDir(opts);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "voice-packs.json"), "new");
    const notes = migrateLegacyData(opts);
    assert.equal(readFileSync(join(dest, "voice-packs.json"), "utf8"), "new");
    assert.equal(existsSync(join(dest, "only-old.txt")), true);
    assert.ok(notes.some((line) => line.includes("already exists")));
  });
});
