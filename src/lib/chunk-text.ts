import { splitSentences } from "./sentences.ts";

export type Card = { id: string; text: string };

/** One spoken card. Longer pastes and pages are split into several. */
export const CARD_MAX = 5000;

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pack(block: string): string[] {
  if (block.length <= CARD_MAX) return [block];
  const sentences = splitSentences(block);
  const out: string[] = [];
  let buf = "";
  const flush = (piece: string) => {
    if (piece.length <= CARD_MAX) {
      out.push(piece);
      return;
    }
    for (let i = 0; i < piece.length; i += CARD_MAX) {
      const slice = piece.slice(i, i + CARD_MAX).trim();
      if (slice) out.push(slice);
    }
  };
  for (const sentence of sentences) {
    if (sentence.length > CARD_MAX) {
      if (buf) flush(buf);
      buf = "";
      flush(sentence);
      continue;
    }
    const next = buf ? `${buf} ${sentence}` : sentence;
    if (buf && next.length > CARD_MAX) {
      flush(buf);
      buf = sentence;
    } else {
      buf = next;
    }
  }
  if (buf) flush(buf);
  return out;
}

function toCards(blocks: string[]): Card[] {
  return blocks.flatMap(pack).map((text) => ({ id: newId(), text }));
}

/** Paste: a blank line starts a new card. A card longer than 5,000 characters is split. */
export function cardsFromPaste(raw: string): Card[] {
  const blocks = raw
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return toCards(blocks);
}

/** A page is queued in pieces of about this many characters, split on the nearest word. */
export const PAGE_CHUNK = 2000;

function chunkOnNearestWord(text: string, size: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    let cut = size;
    const midWord = rest[cut] !== " " && rest[cut - 1] !== " ";
    if (midWord) {
      const before = rest.lastIndexOf(" ", cut);
      const after = rest.indexOf(" ", cut);
      const distBefore = before <= 0 ? Infinity : cut - before;
      const distAfter = after === -1 ? Infinity : after - cut;
      if (distBefore === Infinity && distAfter === Infinity) cut = size;
      else if (distAfter < distBefore) cut = after;
      else cut = before;
    }
    if (cut <= 0) cut = size;
    const piece = rest.slice(0, cut).trim();
    if (!piece) break;
    out.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** A whole page: queue the text in ~2,000-character pieces, broken on the nearest word. */
export function cardsFromPage(raw: string): Card[] {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return [];
  return chunkOnNearestWord(text, PAGE_CHUNK).map((piece) => ({ id: newId(), text: piece }));
}
