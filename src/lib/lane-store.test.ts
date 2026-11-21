import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampVolume,
  DEFAULT_VOLUME,
  defaultLaneSettings,
  defaultSettingsOpen,
  effectiveGain,
  migrateLaneState,
  normalizeVoiceIdList,
  readLaneSettings,
  rememberRecentVoice,
  toggleFavoriteVoice,
} from "./lane-persist.ts";

describe("lane volume", () => {
  it("clamps stored volume to a 0-100 percent", () => {
    assert.equal(clampVolume(0), 0);
    assert.equal(clampVolume(100), 100);
    assert.equal(clampVolume(DEFAULT_VOLUME), 100);
    assert.equal(clampVolume(150), 100);
    assert.equal(clampVolume(-8), 0);
    assert.equal(clampVolume("42"), 42);
    assert.equal(clampVolume("nope"), DEFAULT_VOLUME);
    assert.equal(clampVolume(undefined), DEFAULT_VOLUME);
  });

  it("is silent when muted and uses a linear gain otherwise", () => {
    assert.equal(effectiveGain(80, false), 0.8);
    assert.equal(effectiveGain(80, true), 0);
    assert.equal(effectiveGain(0, false), 0);
    assert.equal(effectiveGain(100, false), 1);
  });

  it("migrates saved prefs without a volume to the default, unmuted", () => {
    const migrated = migrateLaneState({ voiceId: "butler", softRoom: true }, 4);
    assert.equal(migrated.volume, DEFAULT_VOLUME);
    assert.equal(migrated.muted, false);
    assert.equal(migrated.voiceId, "butler");
    assert.equal(migrated.softRoom, true);
  });

  it("persists a saved volume and mute flag across rehydration", () => {
    const saved = migrateLaneState({ voiceId: "mira", volume: 35, muted: true }, 5);
    assert.equal(saved.volume, 35);
    assert.equal(saved.muted, true);
    assert.equal(effectiveGain(saved.volume as number, saved.muted as boolean), 0);

    const clamped = migrateLaneState({ volume: 999, muted: 0 }, 5);
    assert.equal(clamped.volume, 100);
    assert.equal(clamped.muted, false);
  });
});

describe("lane settings and voice lists", () => {
  it("migrates v5 state with the settings panel unset and empty favorites", () => {
    const migrated = migrateLaneState({ voiceId: "butler", volume: 40, muted: false }, 5);
    assert.equal(migrated.settingsOpen, null);
    assert.deepEqual(migrated.favoriteVoiceIds, []);
    assert.deepEqual(migrated.recentVoiceIds, []);
    assert.equal(migrated.voiceId, "butler");
    assert.equal(migrated.volume, 40);
  });

  it("keeps a saved panel preference, favorites, and recents on v6", () => {
    const saved = migrateLaneState(
      {
        voiceId: "mira",
        settingsOpen: false,
        favoriteVoiceIds: ["butler", "butler", "???", "ljspeech"],
        recentVoiceIds: ["ljspeech", "mira", "ljspeech"],
      },
      6,
    );
    assert.equal(saved.settingsOpen, false);
    assert.deepEqual(saved.favoriteVoiceIds, ["butler", "ljspeech"]);
    assert.deepEqual(saved.recentVoiceIds, ["ljspeech", "mira"]);
  });

  it("defaults the settings panel to open on wide screens and collapsed on narrow ones", () => {
    assert.equal(defaultSettingsOpen(true), true);
    assert.equal(defaultSettingsOpen(false), false);
    assert.equal(defaultLaneSettings().settingsOpen, null);
    assert.equal(defaultLaneSettings().voiceId, "leo");
    assert.equal(defaultLaneSettings().volume, 100);
    assert.equal(defaultLaneSettings().muted, false);
    assert.equal(defaultLaneSettings().speed, 1);
    assert.equal(defaultLaneSettings().ttsModel, "kittentts");
  });

  it("can snapshot settings and rebuild lists for undo", () => {
    const snapshot = readLaneSettings({
      voiceId: "eve",
      speed: 1.35,
      volume: 20,
      muted: true,
      ttsModel: "omnivoice",
      settingsOpen: false,
    });
    assert.equal(snapshot.voiceId, "eve");
    assert.equal(snapshot.speed, 1.35);
    assert.equal(snapshot.volume, 20);
    assert.equal(snapshot.muted, true);
    assert.equal(snapshot.ttsModel, "omnivoice");
    assert.equal(snapshot.settingsOpen, false);

    assert.deepEqual(rememberRecentVoice(["leo", "eve"], "butler"), ["butler", "leo", "eve"]);
    assert.deepEqual(toggleFavoriteVoice(["leo"], "eve"), ["leo", "eve"]);
    assert.deepEqual(toggleFavoriteVoice(["leo", "eve"], "leo"), ["eve"]);
    assert.deepEqual(normalizeVoiceIdList(["eve", 1, "device", "eve"], 8), ["eve", "device"]);
  });
});
