import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VOICES, voiceById } from "./voices.ts";
import {
  filterVoices,
  groupVoices,
  voiceBadges,
  voiceGroupId,
  voiceGroupLabel,
  VOICE_PREVIEW_LINE,
} from "./voice-picker.ts";

describe("voice picker", () => {
  it("groups official voices by accent or language", () => {
    assert.equal(voiceGroupId(voiceById("leo")), "british");
    assert.equal(voiceGroupId(voiceById("butler")), "british");
    assert.equal(voiceGroupId(voiceById("mira")), "indian");
    assert.equal(voiceGroupId(voiceById("naksh")), "indian");
    assert.equal(voiceGroupId(voiceById("rigel")), "australian");
    assert.equal(voiceGroupId(voiceById("rex")), "english");
    assert.equal(voiceGroupId(voiceById("device")), "device");
    assert.equal(voiceGroupLabel("british"), "British");
  });

  it("filters by name, accent, engine, or gender and keeps a preview line", () => {
    const british = filterVoices(VOICES, "british");
    assert.ok(british.some((voice) => voice.id === "leo"));
    assert.ok(british.some((voice) => voice.id === "butler"));
    assert.equal(british.some((voice) => voice.id === "mira"), false);

    const kokoro = filterVoices(VOICES, "kokoro");
    assert.ok(kokoro.some((voice) => voice.id === "butler"));
    assert.ok(kokoro.some((voice) => voice.id === "arjun"));

    const female = filterVoices(VOICES, "female");
    assert.ok(female.some((voice) => voice.id === "eve"));
    assert.equal(female.some((voice) => voice.id === "leo"), false);

    assert.ok(VOICE_PREVIEW_LINE.length > 10);
  });

  it("pins favorites and recents at the top of the grouped list", () => {
    const groups = groupVoices(VOICES, {
      favoriteIds: ["mira"],
      recentIds: ["butler", "mira", "leo"],
    });
    assert.equal(groups[0]?.id, "favorites");
    assert.deepEqual(groups[0]?.voices.map((voice) => voice.id), ["mira"]);
    assert.equal(groups[1]?.id, "recent");
    assert.deepEqual(groups[1]?.voices.map((voice) => voice.id), ["butler", "leo"]);
    const british = groups.find((group) => group.id === "british");
    assert.ok(british);
    assert.equal(british.voices.some((voice) => voice.id === "butler"), false);
  });

  it("shows gender, engine, and quality badges", () => {
    const butler = voiceBadges(voiceById("butler"), "kittentts");
    assert.deepEqual(
      butler.map((badge) => `${badge.kind}:${badge.label}`),
      ["gender:Male", "engine:Kokoro", "quality:Clear"],
    );
    const leo = voiceBadges(voiceById("leo"), "kittentts");
    assert.deepEqual(
      leo.map((badge) => `${badge.kind}:${badge.label}`),
      ["gender:Male", "engine:KittenTTS", "quality:Fast"],
    );
    const piper = voiceBadges(
      { id: "ljspeech", name: "LJ Speech", note: "Piper medium.", language: "en-US", accent: "american", gender: "female" },
      "kittentts",
      "piper",
    );
    assert.ok(piper.some((badge) => badge.kind === "engine" && badge.label === "Piper"));
    assert.ok(piper.some((badge) => badge.kind === "quality" && badge.label === "Medium"));
  });
});
