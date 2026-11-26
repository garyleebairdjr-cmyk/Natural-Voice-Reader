/** Rough listening-time estimates and sentence lookup for read-along. */

/** Typical narration pace at 1x, in words per minute. */
export const WORDS_PER_MINUTE = 160;

export function wordCount(text: string): number {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

/** Seconds to read `words` at the given playback speed. */
export function secondsToRead(words: number, speed = 1): number {
  if (!Number.isFinite(words) || words <= 0) return 0;
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return (words / WORDS_PER_MINUTE / rate) * 60;
}

/** "0:42", "3:05", or "1:02:10". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * Which piece a character offset falls in, when the pieces are spoken
 * joined by single spaces (as the device voice receives them).
 */
export function pieceAtChar(pieces: string[], charIndex: number): number {
  if (pieces.length === 0) return 0;
  let end = 0;
  for (let i = 0; i < pieces.length; i++) {
    end += pieces[i]!.length;
    if (charIndex < end) return i;
    end += 1; // the joining space
  }
  return pieces.length - 1;
}
