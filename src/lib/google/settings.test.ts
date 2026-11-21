import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeCloudSettings, parseCloudSettings, serializeCloudSettings, type CloudSettings } from "./settings.ts";

function sample(over: Partial<CloudSettings> = {}): CloudSettings {
  return serializeCloudSettings({
    theme: "dark",
    ink: "sky",
    voiceId: "leo",
    speed: 1,
    volume: 80,
    muted: false,
    ttsModel: "kittentts",
    settingsOpen: true,
    favoriteVoiceIds: ["leo"],
    recentVoiceIds: ["butler"],
    saveDownloadsToDrive: false,
    updatedAt: "2026-11-21T19:00:00.000Z",
    ...over,
  });
}

describe("cloud settings serialization", () => {
  it("writes only safe settings fields and stamps a version", () => {
    const json = serializeCloudSettings({
      theme: "light",
      ink: "paper",
      voiceId: "butler",
      speed: 1.15,
      volume: 40,
      muted: true,
      ttsModel: "kittentts",
      settingsOpen: false,
      favoriteVoiceIds: ["butler", "butler", "not valid!!"],
      recentVoiceIds: ["leo"],
      saveDownloadsToDrive: true,
    }, new Date("2026-11-21T12:00:00.000Z"));
    assert.equal(json.version, 1);
    assert.equal(json.theme, "light");
    assert.equal(json.ink, "violet");
    assert.equal(json.voiceId, "butler");
    assert.equal(json.muted, true);
    assert.equal(json.saveDownloadsToDrive, true);
    assert.deepEqual(json.favoriteVoiceIds, ["butler"]);
    assert.equal(json.updatedAt, "2026-11-21T12:00:00.000Z");
    assert.equal("accessToken" in json, false);
  });

  it("rejects documents that smuggle a secret field", () => {
    assert.equal(parseCloudSettings({ version: 1, theme: "dark", accessToken: "nope" }), null);
    assert.equal(parseCloudSettings({ version: 1, theme: "dark", api_key: "nope" }), null);
    const parsed = parseCloudSettings({ version: 1, theme: "system", voiceId: "leo", volume: 10, updatedAt: "2026-01-01T00:00:00.000Z" });
    assert.ok(parsed);
    assert.equal(parsed.theme, "system");
    assert.equal(parsed.volume, 10);
  });
});

describe("cloud settings merge", () => {
  it("keeps the newer document on last-write-wins and fills empty lists from the older copy", () => {
    const local = sample({ updatedAt: "2026-11-21T18:00:00.000Z", theme: "light", favoriteVoiceIds: ["mira"], recentVoiceIds: [] });
    const remote = sample({ updatedAt: "2026-11-21T19:00:00.000Z", theme: "dark", favoriteVoiceIds: [], recentVoiceIds: ["arjun"] });
    const merged = mergeCloudSettings(local, remote);
    assert.equal(merged.theme, "dark");
    assert.deepEqual(merged.favoriteVoiceIds, ["mira"]);
    assert.deepEqual(merged.recentVoiceIds, ["arjun"]);
    assert.equal(merged.updatedAt, "2026-11-21T19:00:00.000Z");
  });

  it("keeps local when it is newer", () => {
    const local = sample({ updatedAt: "2026-11-21T20:00:00.000Z", volume: 15, theme: "light" });
    const remote = sample({ updatedAt: "2026-11-21T19:00:00.000Z", volume: 90, theme: "dark" });
    const merged = mergeCloudSettings(local, remote);
    assert.equal(merged.theme, "light");
    assert.equal(merged.volume, 15);
    assert.equal(merged.updatedAt, "2026-11-21T20:00:00.000Z");
  });
});
