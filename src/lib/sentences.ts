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

/**
 * Abbreviations that are almost never the end of a sentence, so the next
 * word stays in the same sentence even when it is capitalized.
 */
const ALWAYS_JOIN = new Set([
  "mr", "mrs", "ms", "mx", "dr", "prof", "sr", "jr", "st", "mt", "ft",
  "gen", "sen", "rep", "gov", "pres", "lt", "col", "capt", "cpt", "sgt", "cmdr", "adm", "rev", "hon",
  "cf", "vs", "approx", "dept", "univ", "assn", "bros",
]);

/** Abbreviations that are also ordinary words ("no", "art"): join only before a number ("No. 5", "Mar. 3"). */
const JOIN_BEFORE_NUMBER = new Set([
  "no", "nos", "vol", "vols", "fig", "figs", "p", "pp", "ch", "sec", "art", "op",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/** Abbreviations that may end a sentence: join only when the next word is lowercase or a digit. */
const JOIN_IF_LOWER = new Set(["etc", "inc", "ltd", "co", "corp", "llc", "plc", "al", "est"]);

const SENTENCE_STARTERS =
  /^(?:The|A|An|It|He|She|They|We|I|You|This|That|These|Those|There|Then|So|But|And|In|On|At|After|When|My|Our|His|Her|Their)\b/;

/** The last word before a trailing period, lowercased and without its dots. */
function trailingAbbreviation(segment: string): string | null {
  const match = segment.trimEnd().match(/(?:^|[\s("'[])((?:[A-Za-z]{1,2}\.){2,}|[A-Za-z]+\.)$/);
  if (!match) return null;
  return match[1]!.replace(/\./g, "").toLowerCase();
}

function shouldJoin(segment: string, next: string): boolean {
  const abbr = trailingAbbreviation(segment);
  if (!abbr) return false;
  const nextStart = next.trimStart();
  const lowerNext = /^[a-z0-9]/.test(nextStart);
  const numberNext = /^\d/.test(nextStart);
  const tail = segment.trimEnd();
  // Dotted initialisms such as U.S., e.g., or p.m.: keep together unless a new sentence clearly begins.
  if (/(?:[A-Za-z]{1,2}\.){2,}$/.test(tail)) {
    return lowerNext || !SENTENCE_STARTERS.test(nextStart);
  }
  // A single capital letter followed by a capitalized word is an initial ("J. Smith").
  if (/(?:^|\s)[A-Z]\.$/.test(tail) && /^[A-Z]/.test(nextStart)) return true;
  if (ALWAYS_JOIN.has(abbr)) return true;
  if (JOIN_BEFORE_NUMBER.has(abbr)) return numberNext;
  if (JOIN_IF_LOWER.has(abbr)) return lowerNext;
  return false;
}

const REGEX_SENTENCES = /[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g;

function rawSegments(text: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return text.match(REGEX_SENTENCES) ?? [text];
}

/**
 * Split text into sentences. Uses the platform sentence segmenter, which
 * already handles decimals ("3.14"), ellipses, and quoted endings, then
 * rejoins breaks after common abbreviations ("Dr.", "Mr.", "U.S.").
 */
export function splitSentences(raw: string): string[] {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const out: string[] = [];
  for (const segment of rawSegments(text)) {
    if (!segment.trim()) continue;
    const last = out[out.length - 1];
    if (last !== undefined && shouldJoin(last, segment)) {
      out[out.length - 1] = `${last.trimEnd()} ${segment.trimStart()}`;
    } else {
      out.push(segment);
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Split on sentence boundaries, then pack leftover fragments. */
export function splitSpeakable(raw: string, maxChunk = MAX_CHUNK): string[] {
  const sentences = splitSentences(raw);
  if (sentences.length === 0) return [];

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
