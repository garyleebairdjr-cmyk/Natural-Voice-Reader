import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSpeechPipeline,
  engineSupportsLanguage,
  ttsEngineById,
} from "./speech-pipeline.ts";

describe("speech-pipeline", () => {
  it("registers KittenTTS as the small, mobile-capable English engine", () => {
    const engine = ttsEngineById("kittentts");
    assert.equal(engine?.mobileCapable, true);
    assert.deepEqual(engine?.languages, ["en"]);
    assert.equal(engineSupportsLanguage(engine!, "en"), true);
    assert.equal(engineSupportsLanguage(engine!, "en-GB"), true);
    assert.equal(engineSupportsLanguage(engine!, "es"), false);
  });

  it("starts a pipeline with TTS only", () => {
    const pipeline = defaultSpeechPipeline("kittentts");
    assert.equal(pipeline.stt, null);
    assert.equal(pipeline.translate, null);
    assert.equal(pipeline.tts.id, "kittentts");
  });
});
