import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeWav, joinMp3, mp3FrameLength, stripId3, stripInfoFrame } from "./audio-join.ts";

/** One MPEG-1 layer III frame header: 128 kbps, 44.1 kHz, no padding (417 bytes). */
function frame(fill: number, tag?: string): Uint8Array {
  const out = new Uint8Array(417).fill(fill);
  out.set([0xff, 0xfb, 0x90, 0x00], 0);
  if (tag) out.set(Array.from(tag, (c) => c.charCodeAt(0)), 36);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function id3v2(size: number): Uint8Array {
  const out = new Uint8Array(10 + size);
  out.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, (size >> 7) & 0x7f, size & 0x7f], 0);
  return out;
}

describe("mp3FrameLength", () => {
  it("reads an MPEG-1 layer III header", () => {
    assert.equal(mp3FrameLength(frame(1)), 417);
  });
  it("reads an MPEG-2 24 kHz header", () => {
    // 0xF3 = MPEG-2 layer III; 0x84 = 64 kbps, 24 kHz.
    assert.equal(mp3FrameLength(new Uint8Array([0xff, 0xf3, 0x84, 0x00])), 192);
  });
  it("rejects bytes that are not a frame", () => {
    assert.equal(mp3FrameLength(new Uint8Array([0x00, 0x01, 0x02, 0x03])), 0);
  });
});

describe("stripId3 and stripInfoFrame", () => {
  it("removes a leading ID3v2 tag and a trailing ID3v1 tag", () => {
    const tail = new Uint8Array(128);
    tail.set([0x54, 0x41, 0x47], 0);
    const audio = frame(7);
    assert.deepEqual(stripId3(concat(id3v2(20), audio, tail)), audio);
  });
  it("drops a Xing or Info header frame but keeps audio frames", () => {
    const audio = frame(9);
    assert.deepEqual(stripInfoFrame(concat(frame(0, "Xing"), audio)), audio);
    assert.deepEqual(stripInfoFrame(concat(frame(0, "Info"), audio)), audio);
    assert.deepEqual(stripInfoFrame(audio), audio);
  });
});

describe("joinMp3", () => {
  it("joins clips without their per-clip headers", () => {
    const a = frame(1);
    const b = frame(2);
    const joined = joinMp3([concat(id3v2(5), frame(0, "Info"), a), concat(id3v2(5), frame(0, "Xing"), b)]);
    assert.deepEqual(joined, concat(a, b));
  });
});

describe("encodeWav", () => {
  it("writes a valid 16-bit PCM header and samples", () => {
    const wav = encodeWav([new Float32Array([0, 1, -1])], 24000);
    const view = new DataView(wav.buffer);
    assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
    assert.equal(String.fromCharCode(...wav.subarray(8, 12)), "WAVE");
    assert.equal(view.getUint32(24, true), 24000);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(view.getUint32(40, true), 6);
    assert.equal(view.getInt16(44, true), 0);
    assert.equal(view.getInt16(46, true), 0x7fff);
    assert.equal(view.getInt16(48, true), -0x8000);
  });
});
