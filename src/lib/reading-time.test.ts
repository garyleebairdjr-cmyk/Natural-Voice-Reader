import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDuration, pieceAtChar, secondsToRead, wordCount } from "./reading-time.ts";

describe("reading time", () => {
  it("counts words and estimates time at a speed", () => {
    assert.equal(wordCount("  one two\nthree  "), 3);
    assert.equal(wordCount(""), 0);
    assert.equal(secondsToRead(160), 60);
    assert.equal(secondsToRead(160, 2), 30);
    assert.equal(secondsToRead(0), 0);
    assert.equal(secondsToRead(160, 0), 60);
  });

  it("formats durations", () => {
    assert.equal(formatDuration(0), "0:00");
    assert.equal(formatDuration(42.4), "0:42");
    assert.equal(formatDuration(185), "3:05");
    assert.equal(formatDuration(3730), "1:02:10");
    assert.equal(formatDuration(Number.NaN), "0:00");
  });

  it("maps a character offset to the sentence being spoken", () => {
    const pieces = ["Hello there.", "Second one.", "Third."];
    assert.equal(pieceAtChar(pieces, 0), 0);
    assert.equal(pieceAtChar(pieces, 11), 0);
    assert.equal(pieceAtChar(pieces, 13), 1);
    assert.equal(pieceAtChar(pieces, 25), 2);
    assert.equal(pieceAtChar(pieces, 999), 2);
    assert.equal(pieceAtChar([], 5), 0);
  });
});
