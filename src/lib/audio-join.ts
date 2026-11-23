/**
 * Join several synthesized clips into one downloadable file.
 *
 * MP3 clips are joined frame by frame: per-clip ID3 tags and the Xing/Info
 * header frame are dropped so players report the full duration. Anything
 * else (Kokoro returns WAV) is decoded and written as a single 16-bit WAV.
 */

export type JoinedAudio = { blob: Blob; extension: "mp3" | "wav" };

const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

/** Remove a leading ID3v2 tag and a trailing ID3v1 tag. */
export function stripId3(bytes: Uint8Array): Uint8Array {
  let start = 0;
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
    const footer = (bytes[5]! & 0x10) !== 0 ? 10 : 0;
    start = Math.min(bytes.length, 10 + size + footer);
  }
  let end = bytes.length;
  if (end - start >= 128 && bytes[end - 128] === 0x54 && bytes[end - 127] === 0x41 && bytes[end - 126] === 0x47) {
    end -= 128;
  }
  return bytes.subarray(start, end);
}

/** Byte length of the MPEG layer III frame starting at `offset`, or 0 if there is no valid header there. */
export function mp3FrameLength(bytes: Uint8Array, offset = 0): number {
  if (offset + 4 > bytes.length) return 0;
  const b1 = bytes[offset + 1]!;
  const b2 = bytes[offset + 2]!;
  if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return 0;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  if (version === 1 || layer !== 1) return 0; // reserved version, or not layer III
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const rateIndex = (b2 >> 2) & 0x03;
  if (rateIndex === 3) return 0;
  const kbps = (version === 3 ? MPEG1_L3_KBPS : MPEG2_L3_KBPS)[bitrateIndex]!;
  const sampleRate = SAMPLE_RATES[version]![rateIndex]!;
  if (!kbps) return 0;
  const padding = (b2 >> 1) & 0x01;
  const coefficient = version === 3 ? 144 : 72;
  return Math.floor((coefficient * kbps * 1000) / sampleRate) + padding;
}

function containsTag(bytes: Uint8Array, start: number, end: number, tag: string): boolean {
  const codes = Array.from(tag, (ch) => ch.charCodeAt(0));
  for (let i = start; i + codes.length <= end; i++) {
    if (codes.every((code, j) => bytes[i + j] === code)) return true;
  }
  return false;
}

/** Drop a leading Xing / Info / VBRI frame, which describes only one clip's length. */
export function stripInfoFrame(bytes: Uint8Array): Uint8Array {
  const length = mp3FrameLength(bytes, 0);
  if (!length || length > bytes.length) return bytes;
  const scanEnd = Math.min(length, 64);
  if (containsTag(bytes, 4, scanEnd, "Xing") || containsTag(bytes, 4, scanEnd, "Info") || containsTag(bytes, 4, scanEnd, "VBRI")) {
    return bytes.subarray(length);
  }
  return bytes;
}

/** Concatenate MP3 clips into one stream of plain audio frames. */
export function joinMp3(parts: Uint8Array[]): Uint8Array {
  const cleaned = parts.map((part) => stripInfoFrame(stripId3(part)));
  const total = cleaned.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of cleaned) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Encode mono or interleaved-ready channel data as a 16-bit PCM WAV file. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const channelCount = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * channelCount * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c]?.[i] ?? 0));
      view.setInt16(at, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      at += 2;
    }
  }
  return new Uint8Array(buffer);
}

function isMp3Type(type: string): boolean {
  return /audio\/(mpeg|mp3)/i.test(type);
}

/** Decode clips in the browser and write them back to back as one WAV. */
async function joinAsWav(clips: Blob[]): Promise<Blob> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("This browser cannot combine audio clips.");
  const ctx = new Ctx();
  try {
    const decoded: AudioBuffer[] = [];
    for (const clip of clips) {
      decoded.push(await ctx.decodeAudioData(await clip.arrayBuffer()));
    }
    const sampleRate = decoded[0]?.sampleRate ?? 24000;
    const channelCount = Math.max(...decoded.map((buf) => buf.numberOfChannels));
    // Clips from one engine share a rate; resample any outlier so pitch stays right.
    const normalized = await Promise.all(
      decoded.map(async (buf) => {
        if (buf.sampleRate === sampleRate) return buf;
        const frames = Math.ceil(buf.duration * sampleRate);
        const offline = new OfflineAudioContext(buf.numberOfChannels, frames, sampleRate);
        const source = offline.createBufferSource();
        source.buffer = buf;
        source.connect(offline.destination);
        source.start();
        return offline.startRendering();
      }),
    );
    const totalFrames = normalized.reduce((sum, buf) => sum + buf.length, 0);
    const channels = Array.from({ length: channelCount }, () => new Float32Array(totalFrames));
    let offset = 0;
    for (const buf of normalized) {
      for (let c = 0; c < channelCount; c++) {
        channels[c]!.set(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)), offset);
      }
      offset += buf.length;
    }
    const wav = encodeWav(channels, sampleRate);
    return new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" });
  } finally {
    void ctx.close().catch(() => {});
  }
}

/** Join clips into one file, keeping MP3 when every clip is MP3. */
export async function joinClips(clips: Blob[]): Promise<JoinedAudio> {
  if (clips.length === 0) throw new Error("There is no audio to save.");
  if (clips.every((clip) => isMp3Type(clip.type))) {
    if (clips.length === 1) return { blob: clips[0]!, extension: "mp3" };
    const parts = await Promise.all(clips.map(async (clip) => new Uint8Array(await clip.arrayBuffer())));
    const joined = joinMp3(parts);
    return { blob: new Blob([joined.buffer as ArrayBuffer], { type: "audio/mpeg" }), extension: "mp3" };
  }
  if (clips.length === 1 && /wav/i.test(clips[0]!.type)) return { blob: clips[0]!, extension: "wav" };
  return { blob: await joinAsWav(clips), extension: "wav" };
}
