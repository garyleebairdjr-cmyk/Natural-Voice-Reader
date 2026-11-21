import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  catalogHostAllowed,
  DEFAULT_CATALOG_HOSTS,
  DEFAULT_COMMUNITY_INDEX_URL,
  filterCommunityPacks,
  isAllowedCatalogUrl,
  parseCommunityCatalog,
  parseCatalog,
} from "./voice-packs.ts";

const communityPath = join(dirname(fileURLToPath(import.meta.url)), "../../voices/community-catalog.json");

function communityDoc() {
  return JSON.parse(readFileSync(communityPath, "utf8"));
}

describe("community catalog index validation", () => {
  it("accepts the shipped community catalog and requires checksums", () => {
    const parsed = parseCommunityCatalog(communityDoc(), "voices/community-catalog.json");
    assert.equal(parsed.errors.length, 0, parsed.errors.map((error) => error.message).join("; "));
    assert.deepEqual(parsed.packs.map((pack) => pack.id), ["piper-en-us-ljspeech", "piper-en-us-libritts"]);
    for (const pack of parsed.packs) {
      assert.equal(pack.origin, "community");
      assert.equal(pack.engine, "piper");
      assert.equal(pack.installByDefault, false);
      assert.equal(pack.source.kind, "tarball");
      if (pack.source.kind === "tarball") {
        assert.ok(isAllowedCatalogUrl(pack.source.url));
        assert.ok(pack.source.files.every((file) => file.sha256 && file.sha256.length === 64));
      }
    }
    const ljspeech = parsed.packs[0]!;
    assert.equal(ljspeech.license, "LicenseRef-Public-Domain");
    assert.equal(ljspeech.commercialUse, true);
    const libritts = parsed.packs[1]!;
    assert.equal(libritts.license, "CC-BY-4.0");
    assert.match(libritts.licenseNote ?? "", /libritts_r/i);
  });

  it("rejects a community pack that is missing sha256 or uses a disallowed host", () => {
    const missingHash = parseCommunityCatalog(
      {
        version: 1,
        packs: [
          {
            id: "bad-hash",
            name: "Bad",
            engine: "piper",
            installByDefault: false,
            commercialUse: true,
            license: "MIT",
            sizeBytes: 10,
            source: {
              kind: "tarball",
              url: "https://github.com/example/repo/releases/download/v1/pack.tar.bz2",
              dirName: "pack",
              files: [{ name: "model.onnx" }],
            },
            voices: [],
          },
        ],
      },
      "remote.json",
    );
    assert.ok(missingHash.packs.length === 0);
    assert.ok(missingHash.errors.some((error) => /sha256/i.test(error.message)));

    const badHost = parseCommunityCatalog(
      {
        version: 1,
        packs: [
          {
            id: "bad-host",
            name: "Bad host",
            engine: "piper",
            installByDefault: false,
            commercialUse: true,
            license: "MIT",
            sizeBytes: 10,
            source: {
              kind: "tarball",
              url: "https://evil.example/pack.tar.bz2",
              dirName: "pack",
              files: [{ name: "model.onnx", sha256: "a".repeat(64) }],
            },
            voices: [],
          },
        ],
      },
      "remote.json",
    );
    assert.ok(badHost.packs.length === 0);
    assert.ok(badHost.errors.some((error) => /allowed host/i.test(error.message)));
  });

  it("allows only https hosts on the catalog allowlist, with an explicit local override", () => {
    assert.ok(catalogHostAllowed("github.com", DEFAULT_CATALOG_HOSTS));
    assert.ok(catalogHostAllowed("raw.githubusercontent.com", DEFAULT_CATALOG_HOSTS));
    assert.ok(isAllowedCatalogUrl(DEFAULT_COMMUNITY_INDEX_URL));
    assert.ok(isAllowedCatalogUrl("https://huggingface.co/datasets/example/index.json"));
    assert.equal(isAllowedCatalogUrl("https://evil.example/index.json"), false);
    assert.equal(isAllowedCatalogUrl("http://github.com/index.json"), false);
    assert.equal(isAllowedCatalogUrl("https://127.0.0.1/index.json"), false);
    assert.equal(isAllowedCatalogUrl("http://localhost:8787/index.json"), false);
    assert.equal(isAllowedCatalogUrl("file:///tmp/community-catalog.json"), false);
    assert.ok(isAllowedCatalogUrl("http://127.0.0.1:8787/index.json", { allowLocal: true }));
    assert.ok(isAllowedCatalogUrl("file:///tmp/community-catalog.json", { allowLocal: true }));
    assert.ok(isAllowedCatalogUrl("/tmp/community-catalog.json", { allowLocal: true }));
  });

  it("filters community packs by search, language, gender, license, and commercial use", () => {
    const { packs } = parseCommunityCatalog(communityDoc(), "voices/community-catalog.json");
    assert.equal(filterCommunityPacks(packs, { query: "libritts" }).map((pack) => pack.id).join(), "piper-en-us-libritts");
    assert.equal(filterCommunityPacks(packs, { query: "public domain" }).map((pack) => pack.id).join(), "piper-en-us-ljspeech");
    assert.ok(filterCommunityPacks(packs, { language: "en-US" }).length === 2);
    assert.equal(filterCommunityPacks(packs, { gender: "female" }).map((pack) => pack.id).join(), "piper-en-us-ljspeech");
    assert.equal(filterCommunityPacks(packs, { license: "CC-BY-4.0" }).map((pack) => pack.id).join(), "piper-en-us-libritts");
    assert.equal(filterCommunityPacks(packs, { commercialUse: false }).length, 0);
    assert.equal(filterCommunityPacks(packs, { commercialUse: true }).length, 2);
  });

  it("does not treat a community catalog as a replacement for the official parser defaults", () => {
    // Official catalogs may omit hashes; community parsing must not leak that looseness the other way.
    const officialShape = parseCatalog(
      {
        version: 1,
        packs: [
          {
            id: "demo-hf",
            name: "Demo",
            engine: "kittentts",
            installByDefault: false,
            commercialUse: true,
            license: "Apache-2.0",
            sizeBytes: 1,
            source: { kind: "huggingface", repo: "acme/demo", revision: "abc" },
            voices: [],
          },
        ],
      },
      "official.json",
      "catalog",
    );
    assert.equal(officialShape.errors.length, 0, officialShape.errors.map((error) => error.message).join("; "));
  });
});
