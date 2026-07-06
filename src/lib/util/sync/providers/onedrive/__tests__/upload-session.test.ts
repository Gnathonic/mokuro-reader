import { describe, it, expect } from 'vitest';
import { createChunkRanges, parseNextExpectedRange } from '../upload-session';

describe('createChunkRanges', () => {
  it('produces a single chunk when payload fits in one chunk', () => {
    const chunks = [...createChunkRanges(500, 1024)];
    expect(chunks).toEqual([{ start: 0, end: 499, total: 500 }]);
  });

  it('splits at chunk boundary', () => {
    const chunks = [...createChunkRanges(2048, 1024)];
    expect(chunks).toEqual([
      { start: 0, end: 1023, total: 2048 },
      { start: 1024, end: 2047, total: 2048 }
    ]);
  });

  it('handles a last chunk smaller than chunk size', () => {
    const chunks = [...createChunkRanges(1500, 1024)];
    expect(chunks).toEqual([
      { start: 0, end: 1023, total: 1500 },
      { start: 1024, end: 1499, total: 1500 }
    ]);
  });

  it('throws on zero-length payload', () => {
    expect(() => [...createChunkRanges(0, 1024)]).toThrow();
  });

  it('throws on non-positive chunk size', () => {
    expect(() => [...createChunkRanges(500, 0)]).toThrow();
    expect(() => [...createChunkRanges(500, -10)]).toThrow();
  });

  it('supports resuming from a given start byte', () => {
    const chunks = [...createChunkRanges(2048, 1024, 1024)];
    expect(chunks).toEqual([{ start: 1024, end: 2047, total: 2048 }]);
  });
});

describe('parseNextExpectedRange', () => {
  it('returns start byte of the first range', () => {
    expect(parseNextExpectedRange(['1024-2047'])).toBe(1024);
  });

  it('handles open-ended ranges', () => {
    expect(parseNextExpectedRange(['1024-'])).toBe(1024);
  });

  it('returns null for empty array', () => {
    expect(parseNextExpectedRange([])).toBeNull();
  });

  it('returns null for malformed range', () => {
    expect(parseNextExpectedRange(['not-a-range'])).toBeNull();
  });
});
