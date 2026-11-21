/** Split reading text into speakable sentences for streamed TTS. */

const MAX_CHUNK = 4096;

function flushOversized(piece: string, out: string[]): void {
  const text = piece.trim();
  if (!text) return;
  if (text.length <= MAX_CHUNK) {
    out.push(text);
    return;
  }
  let rest = text;
  while (rest.length > MAX_CHUNK) {
    let cut = MAX_CHUNK;
    const before = rest.lastIndexOf(" ", cut);
    if (before > 0) cut = before;
    const slice = rest.slice(0, cut).trim();
    if (slice) out.push(slice);
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
}

/** Split on sentence punctuation, then pack leftover fragments. */
export function splitSpeakable(raw: string, maxChunk = MAX_CHUNK): string[] {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return [];

  const parts = text.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g);
  const sentences = (parts ?? [text]).map((s) => s.trim()).filter(Boolean);

  const packed: string[] = [];
  for (const sentence of sentences) {
    const fragment = sentence.length < 12 && !/[.!?…]["')\]]*$/.test(sentence);
    if (packed.length > 0 && fragment) {
      const merged = `${packed[packed.length - 1]} ${sentence}`;
      if (merged.length <= maxChunk) {
        packed[packed.length - 1] = merged;
        continue;
      }
    }
    flushOversized(sentence, packed);
  }
  return packed;
}

export const VOICESTUDIO_MAX_CHARS = MAX_CHUNK;
