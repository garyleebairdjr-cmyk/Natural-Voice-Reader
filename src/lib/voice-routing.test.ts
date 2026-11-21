import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSpecialtyVoice, resolveSpeechRoute } from "./voice-routing.ts";

describe("voice-routing", () => {
  it("sends the British butler and Indian English voices to Kokoro", () => {
    assert.equal(resolveSpeechRoute("butler", "kittentts").voice, "bm_george");
    assert.equal(resolveSpeechRoute("mira", "omnivoice").voice, "hf_alpha");
    assert.equal(resolveSpeechRoute("arjun", "kittentts").voice, "hm_omega");
    assert.equal(resolveSpeechRoute("butler", "kittentts").provider, "kokoro");
    assert.equal(resolveSpeechRoute("butler", "omnivoice").model, "kokoro");
    assert.equal(isSpecialtyVoice("mira"), true);
    assert.equal(isSpecialtyVoice("arjun"), true);
  });

  it("does not route the dropped Japanese or German voices as specialty engines", () => {
    for (const id of ["aiko", "haru", "lena", "jonas"]) {
      const route = resolveSpeechRoute(id, "kittentts");
      assert.equal(route.provider, "voicestudio");
      assert.equal(route.model, "kittentts");
      assert.equal(isSpecialtyVoice(id), false);
    }
  });

  it("leaves Leo and the other KittenTTS voices on the selected engine", () => {
    const leo = resolveSpeechRoute("leo", "kittentts");
    assert.equal(leo.provider, "voicestudio");
    assert.equal(leo.model, "kittentts");
    assert.equal(leo.slow, false);
    assert.equal(isSpecialtyVoice("leo"), false);
    assert.equal(isSpecialtyVoice("butler"), true);
  });
});
