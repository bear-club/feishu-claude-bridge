const MAX_BYTES = 28000;

export function splitByBytes(text: string, maxBytes: number = MAX_BYTES): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (Buffer.byteLength(remaining, "utf8") > maxBytes) {
    const cutPoint = findCutPoint(remaining, maxBytes);
    chunks.push(remaining.slice(0, cutPoint));
    remaining = remaining.slice(cutPoint);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function findCutPoint(text: string, maxBytes: number): number {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  const lastNewline = text.lastIndexOf("\n", lo);
  if (lastNewline > lo * 0.5) return lastNewline + 1;
  return lo;
}
