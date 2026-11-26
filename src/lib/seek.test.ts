import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pieceBounds, progressAt, seekTarget } from "./seek.ts";

describe("seek", () => {
  const bounds = pieceBounds(["aaaa", "bbbbbbbbbbbb", "cccc"]); // 4 + 12 + 4 = 20

  it("weights sentences by length", () => {
    assert.deepEqual(bounds, [0, 0.2, 0.8, 1]);
    assert.deepEqual(pieceBounds([]), [0, 1]);
    assert.deepEqual(pieceBounds(["only"]), [0, 1]);
  });

  it("maps playback inside a sentence to a bar position", () => {
    assert.equal(progressAt(bounds, 0, 0), 0);
    assert.equal(progressAt(bounds, 1, 0.5), 0.5);
    assert.equal(progressAt(bounds, 2, 1), 1);
    assert.equal(progressAt(bounds, 9, 0.5), 0.9);
    assert.equal(progressAt(bounds, 1, Number.NaN), 0.2);
  });

  it("finds the sentence under a bar position", () => {
    assert.deepEqual(seekTarget(bounds, 0), { piece: 0, within: 0 });
    assert.deepEqual(seekTarget(bounds, 0.1), { piece: 0, within: 0.5 });
    assert.deepEqual(seekTarget(bounds, 0.2), { piece: 1, within: 0 });
    assert.equal(seekTarget(bounds, 0.5).piece, 1);
    assert.deepEqual(seekTarget(bounds, 1), { piece: 2, within: 1 });
    assert.deepEqual(seekTarget(bounds, -3), { piece: 0, within: 0 });
    assert.deepEqual(seekTarget([0, 1], 0.4), { piece: 0, within: 0.4 });
  });

  it("round-trips a position", () => {
    for (const f of [0.05, 0.33, 0.61, 0.97]) {
      const { piece, within } = seekTarget(bounds, f);
      assert.ok(Math.abs(progressAt(bounds, piece, within) - f) < 1e-9);
    }
  });
});
