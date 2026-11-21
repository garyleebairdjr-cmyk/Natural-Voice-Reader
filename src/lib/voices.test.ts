import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalVoiceId,
  DEFAULT_VOICE_ID,
  isVoiceId,
  REMOVED_VOICE_IDS,
  voiceById,
  voiceForCard,
} from "./voices.ts";

describe("voices", () => {
  it("keeps Butler and the Indian English voices, and drops Japanese and German ones", () => {
    assert.equal(isVoiceId("butler"), true);
    assert.equal(isVoiceId("mira"), true);
    assert.equal(isVoiceId("arjun"), true);
    assert.equal(isVoiceId("leo"), true);
    for (const id of REMOVED_VOICE_IDS) {
      assert.equal(isVoiceId(id), false);
    }
    assert.deepEqual([...REMOVED_VOICE_IDS], ["aiko", "haru", "lena", "jonas"]);
  });

  it("migrates a saved removed or malformed voice to the default", () => {
    assert.equal(canonicalVoiceId("lena"), DEFAULT_VOICE_ID);
    assert.equal(canonicalVoiceId("aiko"), DEFAULT_VOICE_ID);
    assert.equal(canonicalVoiceId("!!!"), DEFAULT_VOICE_ID);
    assert.equal(canonicalVoiceId("butler"), "butler");
    assert.equal(canonicalVoiceId("device"), "device");
    assert.equal(voiceById("jonas").id, DEFAULT_VOICE_ID);
    assert.equal(DEFAULT_VOICE_ID, "leo");
    assert.equal(voiceForCard(0, "haru", false).id, DEFAULT_VOICE_ID);
  });

  it("keeps well-formed community voice ids until a known list says otherwise", () => {
    assert.equal(canonicalVoiceId("ljspeech"), "ljspeech");
    assert.equal(canonicalVoiceId("ljspeech", ["leo", "ljspeech"]), "ljspeech");
    assert.equal(canonicalVoiceId("ljspeech", ["leo", "eve"]), DEFAULT_VOICE_ID);
    assert.equal(canonicalVoiceId("missing", ["leo"]), DEFAULT_VOICE_ID);
  });
});
