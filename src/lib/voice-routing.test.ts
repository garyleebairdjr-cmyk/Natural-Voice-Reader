import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSpecialtyVoice, resolveSpeechRoute, germanAccentInstruction } from "./voice-routing.ts";

describe("voice-routing", () => {
  it("sends the British butler and Indian/Japanese English voices to Kokoro", () => {
    assert.equal(resolveSpeechRoute("butler", "kittentts").voice, "bm_george");
    assert.equal(resolveSpeechRoute("mira", "omnivoice").voice, "hf_alpha");
    assert.equal(resolveSpeechRoute("arjun", "kittentts").voice, "hm_omega");
    assert.equal(resolveSpeechRoute("aiko", "kittentts").voice, "jf_alpha");
    assert.equal(resolveSpeechRoute("haru", "kittentts").voice, "jm_kumo");
    assert.equal(resolveSpeechRoute("butler", "kittentts").provider, "kokoro");
    assert.equal(resolveSpeechRoute("butler", "omnivoice").model, "kokoro");
  });

  it("forces OmniVoice with a mild German-accent instruction", () => {
    const lena = resolveSpeechRoute("lena", "kittentts");
    assert.equal(lena.provider, "voicestudio");
    assert.equal(lena.model, "omnivoice");
    assert.equal(lena.slow, true);
    assert.match(lena.instruct ?? "", /mild, natural German accent/i);
    assert.match(germanAccentInstruction("man"), /adult man/i);
    const jonas = resolveSpeechRoute("jonas", "kittentts");
    assert.match(jonas.instruct ?? "", /adult man/i);
  });

  it("leaves Leo and the other KittenTTS voices on the selected engine", () => {
    const leo = resolveSpeechRoute("leo", "kittentts");
    assert.equal(leo.provider, "voicestudio");
    assert.equal(leo.model, "kittentts");
    assert.equal(leo.slow, false);
    assert.equal(isSpecialtyVoice("leo"), false);
    assert.equal(isSpecialtyVoice("butler"), true);
    assert.equal(isSpecialtyVoice("lena"), true);
  });
});
