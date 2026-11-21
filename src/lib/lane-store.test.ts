import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampVolume,
  DEFAULT_VOLUME,
  effectiveGain,
  migrateLaneState,
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
