/**
 * Positions on the card progress bar. Each sentence gets a share of the bar
 * in proportion to its length, so the bar moves at an even pace as it reads.
 */

/** Start of each sentence as a fraction of the bar, plus a final 1. Length is pieces.length + 1. */
export function pieceBounds(pieces: string[]): number[] {
  if (pieces.length === 0) return [0, 1];
  const weights = pieces.map((piece) => Math.max(1, piece.length));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const bounds = [0];
  let run = 0;
  for (const w of weights) {
    run += w;
    bounds.push(run / total);
  }
  bounds[bounds.length - 1] = 1;
  return bounds;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Bar position for a sentence and how far through it playback is (0 to 1). */
export function progressAt(bounds: number[], piece: number, within: number): number {
  const count = bounds.length - 1;
  if (count < 1) return 0;
  const i = Math.min(count - 1, Math.max(0, Math.floor(piece)));
  const start = bounds[i]!;
  const end = bounds[i + 1]!;
  return clamp01(start + clamp01(within) * (end - start));
}

/** The sentence under a bar position, and how far into that sentence it falls. */
export function seekTarget(bounds: number[], fraction: number): { piece: number; within: number } {
  const count = bounds.length - 1;
  if (count < 1) return { piece: 0, within: 0 };
  const f = clamp01(fraction);
  let piece = count - 1;
  for (let i = 0; i < count; i++) {
    if (f < bounds[i + 1]!) {
      piece = i;
      break;
    }
  }
  const start = bounds[piece]!;
  const span = bounds[piece + 1]! - start;
  return { piece, within: span > 0 ? clamp01((f - start) / span) : 0 };
}
