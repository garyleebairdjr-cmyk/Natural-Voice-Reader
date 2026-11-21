import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isTtsModelId,
  kittenVoiceId,
  voiceInstruction,
  voiceStudioVoice,
} from "./tts-config.ts";

describe("tts-config", () => {
  it("accepts known models and rejects others", () => {
    assert.equal(isTtsModelId("omnivoice"), true);
    assert.equal(isTtsModelId("kittentts"), true);
    assert.equal(isTtsModelId("pockettts"), false);
  });

  it("maps reader voices onto KittenTTS presets", () => {
    assert.equal(kittenVoiceId("leo"), "expr-voice-2-m");
    assert.equal(kittenVoiceId("eve"), "expr-voice-2-f");
    assert.equal(kittenVoiceId("unknown"), "expr-voice-2-m");
  });

  it("uses KittenTTS presets only for that model", () => {
    assert.equal(voiceStudioVoice("kittentts", "luna"), "expr-voice-5-f");
    assert.equal(voiceStudioVoice("omnivoice", "luna"), "default");
  });

  it("builds an instruction from the voice note", () => {
    assert.match(voiceInstruction("leo"), /steady, british/i);
  });
});
