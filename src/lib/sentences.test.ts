import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitForStreaming, splitLeadingClause, splitSentences, splitSpeakable, VOICESTUDIO_MAX_CHARS } from "./sentences.ts";

describe("splitSentences", () => {
  const cases: Array<[string, string[]]> = [
    ["Dr. Smith said pi is 3.14. Next one.", ["Dr. Smith said pi is 3.14.", "Next one."]],
    ["See e.g. the U.S. Army report. Then Mr. Jones left!", ["See e.g. the U.S. Army report.", "Then Mr. Jones left!"]],
    ["He said no. Then he left.", ["He said no.", "Then he left."]],
    ["I love art. It makes me happy.", ["I love art.", "It makes me happy."]],
    ["Read No. 5 and Fig. 2 today. Done.", ["Read No. 5 and Fig. 2 today.", "Done."]],
    ["We met at 5 p.m. Then we ate.", ["We met at 5 p.m.", "Then we ate."]],
    ["Apple Inc. makes phones. It is big.", ["Apple Inc. makes phones.", "It is big."]],
    ["J. Smith wrote it. They liked it.", ["J. Smith wrote it.", "They liked it."]],
    ["Wait... what? Yes!", ["Wait... what?", "Yes!"]],
    ['He said "Stop." Then he left.', ['He said "Stop."', "Then he left."]],
  ];
  for (const [input, expected] of cases) {
    it(`splits ${JSON.stringify(input)}`, () => {
      assert.deepEqual(splitSentences(input), expected);
    });
  }
});

describe("splitSpeakable", () => {
  it("returns an empty list for blank input", () => {
    assert.deepEqual(splitSpeakable("   "), []);
  });

  it("keeps a short sentence intact", () => {
    assert.deepEqual(splitSpeakable("Hello there."), ["Hello there."]);
  });

  it("splits on sentence punctuation", () => {
    assert.deepEqual(splitSpeakable("One. Two? Three!"), ["One.", "Two?", "Three!"]);
  });

  it("merges a tiny trailing fragment", () => {
    const out = splitSpeakable("The probe arrived in 2012. OK");
    assert.equal(out.length, 1);
    assert.equal(out[0], "The probe arrived in 2012. OK");
  });

  it("hard-splits a run with no punctuation at the max chunk size", () => {
    const word = "alphabet";
    const long = Array.from({ length: 600 }, () => word).join(" ");
    const out = splitSpeakable(long);
    assert.ok(out.length >= 2);
    assert.ok(out.every((part) => part.length <= VOICESTUDIO_MAX_CHARS));
    assert.equal(out.join(" ").replace(/\s+/g, " "), long);
  });
});

describe("splitLeadingClause", () => {
  it("keeps a short or unpunctuated sentence intact", () => {
    assert.deepEqual(splitLeadingClause("Voyager 1 is now in interstellar space."), [
      "Voyager 1 is now in interstellar space.",
    ]);
    assert.deepEqual(splitLeadingClause("Hello, pal."), ["Hello, pal."]);
  });

  it("splits a long first sentence at the first clause", () => {
    const text = "The signal is faint, but it is still arriving on Earth this week.";
    const out = splitLeadingClause(text);
    assert.deepEqual(out, ["The signal is faint,", "but it is still arriving on Earth this week."]);
  });
});

describe("splitForStreaming", () => {
  it("clause-splits only the first sentence of a card", () => {
    const text =
      "The signal is faint, but it is still arriving on Earth this week. The next packet will take a day.";
    const out = splitForStreaming(text);
    assert.deepEqual(out, [
      "The signal is faint,",
      "but it is still arriving on Earth this week.",
      "The next packet will take a day.",
    ]);
  });
});
