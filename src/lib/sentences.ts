/** Split reading text into speakable chunks for streamed TTS. */

const MAX_CHUNK = 4096;
const MIN_LEADING_CLAUSE = 18;
const MIN_TRAILING_CLAUSE = 18;

function flushOversized(piece: string, out: string[], maxChunk: number): void {
  const text = piece.trim();
  if (!text) return;
  if (text.length <= maxChunk) {
    out.push(text);
    return;
  }
  let rest = text;
  while (rest.length > maxChunk) {
    let cut = maxChunk;
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
    flushOversized(sentence, packed, maxChunk);
  }
  return packed;
}

/**
 * Split a long first sentence at the first comma, semicolon, or dash so
 * playback can start before the rest of the sentence is synthesized.
 * Short sentences stay intact.
 */
export function splitLeadingClause(text: string): string[] {
  const raw = text.replace(/\s+/g, " ").trim();
  if (raw.length < MIN_LEADING_CLAUSE + MIN_TRAILING_CLAUSE) return raw ? [raw] : [];
  const re = /[,;:—–]\s+|\s+[—–]\s+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const cut = match.index + match[0].length;
    const head = raw.slice(0, cut).trim();
    const tail = raw.slice(cut).trim();
    if (head.length >= MIN_LEADING_CLAUSE && tail.length >= MIN_TRAILING_CLAUSE) {
      return [head, tail];
    }
  }
  return [raw];
}

/** Sentence split plus a shorter first chunk for time-to-first-audio. */
export function splitForStreaming(raw: string, maxChunk = MAX_CHUNK): string[] {
  const pieces = splitSpeakable(raw, maxChunk);
  if (pieces.length === 0) return [];
  const [first, ...rest] = pieces;
  return [...splitLeadingClause(first!), ...rest];
}

export const VOICESTUDIO_MAX_CHARS = MAX_CHUNK;
