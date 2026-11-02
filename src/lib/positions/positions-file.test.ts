import { describe, it, expect } from 'vitest';
import { FUTURE_TOLERANCE_MS } from '$lib/metadata/sanitize';
import {
  POSITION_WINDOW_MS,
  composePositionsFile,
  mergePositions,
  parsePositionsFile,
  positionsContent,
  prunePositions
} from './positions-file';

const now = Date.parse('2026-10-16T12:00:00Z');
const ok = [now - 1000, 120, 12000, 'dev-a'];

describe('parsePositionsFile', () => {
  it('parses well-formed entries', () => {
    expect(parsePositionsFile({ version: 1, positions: { v1: ok } }, now)).toEqual({
      v1: { t: now - 1000, page: 120, chars: 12000, device: 'dev-a' }
    });
  });

  it('drops malformed entries and tolerates junk files', () => {
    expect(
      parsePositionsFile(
        {
          version: 1,
          positions: { a: [1, 'x', 0, 'd'], b: [1, 2], c: ok, d: [1, 2, 3, ''], e: [-1, 2, 3, 'd'] }
        },
        now
      )
    ).toEqual({ c: expect.any(Object) });
    expect(parsePositionsFile('not json', now)).toEqual({});
    expect(parsePositionsFile(null, now)).toEqual({});
    expect(parsePositionsFile({ version: 1, positions: [] }, now)).toEqual({});
    expect(parsePositionsFile({ version: 2, positions: { c: ok } }, now)).toEqual({});
  });

  it('drops an entry stamped beyond FUTURE_TOLERANCE_MS', () => {
    const bogus = [now + FUTURE_TOLERANCE_MS + 1, 5, 50, 'fast'];
    expect(parsePositionsFile({ version: 1, positions: { v: bogus } }, now)).toEqual({});
    const edge = [now + FUTURE_TOLERANCE_MS, 5, 50, 'fast'];
    expect(Object.keys(parsePositionsFile({ version: 1, positions: { v: edge } }, now))).toEqual([
      'v'
    ]);
  });
});

describe('mergePositions', () => {
  it('newest t wins per volume; a tie goes to the greater device id', () => {
    const a = { v: { t: 10, page: 1, chars: 0, device: 'a' } };
    const b = { v: { t: 20, page: 9, chars: 0, device: 'b' } };
    expect(mergePositions(a, b).v.page).toBe(9);
    expect(mergePositions(b, a).v.page).toBe(9);
    const tie = { v: { t: 20, page: 3, chars: 0, device: 'c' } };
    expect(mergePositions(b, tie).v.device).toBe('c');
    expect(mergePositions(tie, b).v.device).toBe('c');
  });

  it('keeps volumes only one side has', () => {
    const a = { x: { t: 1, page: 1, chars: 0, device: 'a' } };
    const b = { y: { t: 2, page: 2, chars: 0, device: 'b' } };
    expect(Object.keys(mergePositions(a, b)).sort()).toEqual(['x', 'y']);
  });

  it('a page-0 reset entry is kept and beats an older entry', () => {
    const read = { v: { t: 10, page: 120, chars: 1, device: 'a' } };
    const reset = { v: { t: 20, page: 0, chars: 0, device: 'a' } };
    expect(mergePositions(read, reset).v.page).toBe(0);
  });
});

describe('prunePositions', () => {
  it('prunes entries older than 30 days', () => {
    const map = {
      old: { t: now - POSITION_WINDOW_MS - 1, page: 1, chars: 0, device: 'a' },
      fresh: { t: now - POSITION_WINDOW_MS + 1, page: 1, chars: 0, device: 'a' }
    };
    expect(Object.keys(prunePositions(map, now))).toEqual(['fresh']);
  });
});

describe('composePositionsFile / positionsContent', () => {
  it('compose → parse is an identity, keys sorted', () => {
    const map = {
      b: { t: 2, page: 2, chars: 2, device: 'x' },
      a: { t: 1, page: 1, chars: 1, device: 'x' }
    };
    const file = composePositionsFile(map);
    expect(file.version).toBe(1);
    expect(Object.keys(file.positions)).toEqual(['a', 'b']);
    expect(parsePositionsFile(JSON.parse(JSON.stringify(file)), 3)).toEqual(map);
  });

  it('positionsContent is the canonical string of the RAW positions object', () => {
    const raw = { version: 1, positions: { b: [2, 2, 2, 'x'], a: [1, 1, 1, 'x'] } };
    const reordered = { positions: { a: [1, 1, 1, 'x'], b: [2, 2, 2, 'x'] }, version: 1 };
    expect(positionsContent(raw)).toBe(positionsContent(reordered));
    // Raw, not parsed: a bogus entry the parser drops still shows in the content,
    // so a file holding one never compares equal to its healed rewrite.
    const withBogus = { version: 1, positions: { a: [1, 1, 1, 'x'], z: ['junk'] } };
    expect(positionsContent(withBogus)).not.toBe(
      positionsContent(composePositionsFile({ a: { t: 1, page: 1, chars: 1, device: 'x' } }))
    );
    expect(positionsContent('junk')).toBe('');
    expect(positionsContent({ version: 1 })).toBe('');
  });
});
