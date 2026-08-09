// Deterministic randomness — see docs/03 §8.
// No other module may call a global random source.

/** String → 32-bit seed (xmur3). */
function seedFromString(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/**
 * Pseudo-random function of (seed, cursor). splitmix32 finalisation gives good
 * avalanche, so consecutive cursors produce uncorrelated output — which matters
 * because the cursor is a plain counter.
 */
export function prf(seed: string, cursor: number): number {
  let z = (seedFromString(seed) + Math.imul(cursor, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^= z >>> 15) >>> 0;
}

/** Fisher-Yates driven exclusively by `prf`. Returns the new cursor. */
export function shuffle<T>(
  items: readonly T[],
  seed: string,
  cursor: number,
): { items: T[]; cursor: number } {
  const out = items.slice();
  let c = cursor;
  for (let i = out.length - 1; i >= 1; i--) {
    const j = prf(seed, c) % (i + 1);
    c += 1;
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return { items: out, cursor: c };
}

/** Match seeds. The only place a non-deterministic source is allowed. */
export function newSeed(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
