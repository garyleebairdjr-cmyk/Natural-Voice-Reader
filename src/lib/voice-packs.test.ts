import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafeRelativeName,
  isPackId,
  loadOfficialCatalog,
  markInstalled,
  markRemoved,
  mergeCatalogs,
  packById,
  packFilesPresent,
  parseCatalog,
  readInstallState,
  writeInstallState,
  type VoicePack,
} from "./voice-packs.ts";

function officialPacks(): VoicePack[] {
  const { packs, errors } = loadOfficialCatalog();
  assert.equal(errors.length, 0, errors.map((e) => e.message).join("; "));
  return packs;
}

const tmpRoot = mkdtempSync(join(tmpdir(), "nvr-voice-packs-"));

describe("voice pack catalog", () => {
  it("accepts the official catalog and seeds the current packs", () => {
    const packs = officialPacks();
    assert.deepEqual(packs.map((p) => p.id), ["kittentts", "kokoro", "omnivoice"]);
    const kitten = packs[0]!;
    assert.equal(kitten.installByDefault, true);
    assert.equal(kitten.commercialUse, true);
    assert.equal(kitten.license, "Apache-2.0");
    assert.equal(kitten.engine, "kittentts");
    assert.ok(kitten.voices.some((v) => v.id === "leo"));
    const kokoro = packs[1]!;
    assert.equal(kokoro.installByDefault, false);
    assert.ok(kokoro.voices.some((v) => v.id === "butler"));
    const omni = packs[2]!;
    assert.equal(omni.commercialUse, false);
    assert.match(omni.license, /CC-BY-NC/i);
    assert.equal(omni.voices.length, 0);
  });

  it("rejects an invalid pack id, license, and unsafe file name", () => {
    const parsed = parseCatalog(
      {
        version: 1,
        packs: [
          {
            id: "../etc",
            name: "Bad",
            engine: "piper",
            installByDefault: false,
            commercialUse: true,
            license: "not a license!",
            sizeBytes: 1,
            source: {
              kind: "tarball",
              url: "https://example.com/pack.tar.gz",
              dirName: "pack",
              files: [{ name: "../../passwd" }],
            },
            voices: [],
          },
        ],
      },
      "memory",
      "overlay",
    );
    assert.equal(parsed.packs.length, 0);
    const messages = parsed.errors.map((e) => e.message).join(" ");
    assert.match(messages, /Pack id/);
    assert.match(messages, /SPDX|license/i);
    assert.match(messages, /single path segment|File names/);
  });

  it("rejects a non-https or private tarball URL", () => {
    const base = {
      id: "okpack",
      name: "Ok",
      engine: "piper",
      installByDefault: false,
      commercialUse: true,
      license: "MIT",
      sizeBytes: 10,
      voices: [],
    };
    const http = parseCatalog(
      { version: 1, packs: [{ ...base, source: { kind: "tarball", url: "http://example.com/a.tgz", dirName: "a", files: [{ name: "m.onnx" }] } }] },
      "memory",
      "overlay",
    );
    assert.equal(http.packs.length, 0);
    const local = parseCatalog(
      { version: 1, packs: [{ ...base, source: { kind: "tarball", url: "https://127.0.0.1/a.tgz", dirName: "a", files: [{ name: "m.onnx" }] } }] },
      "memory",
      "overlay",
    );
    assert.equal(local.packs.length, 0);
  });

  it("validates pack ids strictly so a client cannot pass an arbitrary target", () => {
    assert.equal(isPackId("kokoro"), true);
    assert.equal(isPackId("kittentts"), true);
    assert.equal(isPackId("../kokoro"), false);
    assert.equal(isPackId("https://evil.example/x"), false);
    assert.equal(isPackId("KOKORO"), false);
    assert.equal(isPackId(""), false);
    assert.equal(packById("../kokoro", officialPacks()), undefined);
    assert.equal(packById("not-a-real-pack", officialPacks()), undefined);
    assert.equal(packById("kokoro", officialPacks())?.engine, "kokoro");
  });

  it("merges overlays but will not let them replace an official pack id", () => {
    const official = officialPacks();
    const overlay: VoicePack = {
      id: "kokoro",
      name: "Hijack",
      engine: "piper",
      installByDefault: false,
      commercialUse: true,
      license: "MIT",
      sizeBytes: 1,
      source: { kind: "tarball", url: "https://example.com/x.tgz", dirName: "x", files: [{ name: "m.onnx" }] },
      voices: [],
      origin: "overlay",
      overlayFile: "overlay.json",
    };
    const extra: VoicePack = { ...overlay, id: "community-en" };
    const merged = mergeCatalogs(official, [overlay, extra, extra]);
    assert.ok(merged.errors.some((e) => /reserved by the official catalog/.test(e.message)));
    assert.ok(merged.errors.some((e) => /already added/.test(e.message)));
    assert.equal(merged.packs.find((p) => p.id === "kokoro")?.name, "Kokoro");
    assert.ok(merged.packs.some((p) => p.id === "community-en"));
  });
});

describe("voice pack install state", () => {
  const statePath = join(tmpRoot, "state.json");

  afterEach(() => {
    if (existsSync(statePath)) rmSync(statePath);
  });

  it("records and removes install state only for valid ids", () => {
    const first = markInstalled("kokoro", "abc", statePath);
    assert.equal(first.installed.kokoro?.revision, "abc");
    assert.ok(first.installed.kokoro?.installedAt);
    const again = readInstallState(statePath);
    assert.equal(again.installed.kokoro?.revision, "abc");
    markRemoved("kokoro", statePath);
    assert.equal(readInstallState(statePath).installed.kokoro, undefined);
    assert.throws(() => markInstalled("../etc", undefined, statePath));
    assert.throws(() => markRemoved("https://x", statePath));
  });

  it("treats files on disk as installed even before state is recorded", () => {
    const cache = join(tmpRoot, "sherpa");
    const dir = join(cache, "demo-pack");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model.int8.onnx"), "ok");
    const prev = process.env.NVR_SHERPA_CACHE;
    process.env.NVR_SHERPA_CACHE = cache;
    try {
      const pack: VoicePack = {
        id: "demo-pack",
        name: "Demo",
        engine: "kokoro",
        installByDefault: false,
        commercialUse: true,
        license: "Apache-2.0",
        sizeBytes: 2,
        source: {
          kind: "tarball",
          url: "https://example.com/demo.tar.bz2",
          dirName: "demo-pack",
          files: [{ name: "model.int8.onnx" }],
        },
        voices: [],
        origin: "overlay",
      };
      assert.equal(packFilesPresent(pack), true);
    } finally {
      if (prev == null) delete process.env.NVR_SHERPA_CACHE;
      else process.env.NVR_SHERPA_CACHE = prev;
    }
  });

  it("writes state atomically and refuses path traversal in file names", () => {
    writeInstallState({ version: 1, installed: { kittentts: { installedAt: "2026-01-01T00:00:00Z" } } }, statePath);
    assert.equal(readInstallState(statePath).installed.kittentts?.installedAt, "2026-01-01T00:00:00Z");
    assert.equal(assertSafeRelativeName("model.int8.onnx"), "model.int8.onnx");
    assert.throws(() => assertSafeRelativeName("../etc/passwd"));
    assert.throws(() => assertSafeRelativeName("/tmp/x"));
  });
});

before(() => {
  // The official catalog must be reachable from the repo root used by tests.
  assert.ok(loadOfficialCatalog().packs.length >= 3);
});
