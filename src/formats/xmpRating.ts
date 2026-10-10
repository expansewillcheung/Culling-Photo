// Minimal XMP reader: extracts xmp:Rating from a packet (attribute or element form).

const ATTR = /\bxmp:Rating\s*=\s*["']\s*([+-]?\d+(?:\.\d+)?)\s*["']/;
const ELEM = /<xmp:Rating>\s*([+-]?\d+(?:\.\d+)?)\s*<\/xmp:Rating>/;

/** Returns the rating clamped to -1..5, or undefined if absent/invalid. */
export function parseXmpRating(text: string): number | undefined {
  if (!text) return undefined;
  const m = ATTR.exec(text) ?? ELEM.exec(text);
  if (!m) return undefined;
  const v = Math.round(Number(m[1]));
  if (!Number.isFinite(v)) return undefined;
  return Math.max(-1, Math.min(5, v));
}
