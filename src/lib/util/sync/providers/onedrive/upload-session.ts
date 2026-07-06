/**
 * Yields one ChunkRange per Graph upload-session PUT request.
 * Resumable from any byte offset (use `resumeFrom` after a partial upload).
 *
 * Ranges are inclusive-inclusive: `start` and `end` both name actual byte
 * positions, matching the HTTP `Content-Range` header format Graph expects.
 */
export interface ChunkRange {
  start: number;
  end: number;
  total: number;
}

export function* createChunkRanges(
  totalSize: number,
  chunkSize: number,
  resumeFrom = 0
): Generator<ChunkRange> {
  if (totalSize <= 0) {
    throw new Error('totalSize must be positive');
  }
  if (chunkSize <= 0) {
    throw new Error('chunkSize must be positive');
  }

  let start = resumeFrom;
  while (start < totalSize) {
    const end = Math.min(start + chunkSize - 1, totalSize - 1);
    yield { start, end, total: totalSize };
    start = end + 1;
  }
}

/**
 * Parses Graph's `nextExpectedRanges` (e.g. ["1024-2047"] or ["1024-"]).
 * Returns the first start byte, or null if no valid range is present.
 * Used after a network blip to resume the upload at the correct offset.
 */
export function parseNextExpectedRange(ranges: string[]): number | null {
  if (ranges.length === 0) return null;
  const match = ranges[0].match(/^(\d+)-/);
  if (!match) return null;
  return parseInt(match[1], 10);
}
