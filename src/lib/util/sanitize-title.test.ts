import { describe, it, expect } from 'vitest';
import { sanitizeTitleSegment, sanitizeRenameTitle } from './sanitize-title';

const CTRL = String.fromCharCode(1); // a control char (U+0001)
const DEL = String.fromCharCode(127); // DEL (U+007F)

describe('sanitizeTitleSegment', () => {
  it('substitutes each Windows-illegal char with its fullwidth twin', () => {
    expect(sanitizeTitleSegment('a/b')).toBe('a／b');
    expect(sanitizeTitleSegment('a\\b')).toBe('a＼b');
    expect(sanitizeTitleSegment('Steins;Gate: 0')).toBe('Steins;Gate： 0');
    expect(sanitizeTitleSegment('What If?')).toBe('What If？');
    expect(sanitizeTitleSegment('a*b"c<d>e|f')).toBe('a＊b＂c＜d＞e｜f');
  });

  it('strips control characters and DEL', () => {
    expect(sanitizeTitleSegment('a' + CTRL + 'b' + DEL + 'c')).toBe('abc');
  });

  it('trims leading and trailing spaces but keeps interior ones', () => {
    expect(sanitizeTitleSegment('  Vol 3  ')).toBe('Vol 3');
  });

  it('converts leading, trailing, and all-dot runs to dot leaders, keeping interior dots', () => {
    expect(sanitizeTitleSegment('.')).toBe('․');
    expect(sanitizeTitleSegment('..')).toBe('․․');
    expect(sanitizeTitleSegment('Vol. 3')).toBe('Vol. 3');
    expect(sanitizeTitleSegment('etc.')).toBe('etc․');
  });

  it('suffixes reserved device names (case-insensitive)', () => {
    expect(sanitizeTitleSegment('CON')).toBe('CON_');
    expect(sanitizeTitleSegment('nul')).toBe('nul_');
    expect(sanitizeTitleSegment('Com1')).toBe('Com1_');
    expect(sanitizeTitleSegment('LPT9')).toBe('LPT9_');
    expect(sanitizeTitleSegment('console')).toBe('console'); // not reserved
  });

  it('returns empty string when nothing usable remains', () => {
    expect(sanitizeTitleSegment('   ')).toBe('');
    expect(sanitizeTitleSegment('')).toBe('');
  });

  it('is idempotent', () => {
    for (const raw of ['a/b', '..', 'CON', 'Steins;Gate: 0', 'etc.']) {
      const once = sanitizeTitleSegment(raw);
      expect(sanitizeTitleSegment(once)).toBe(once);
    }
  });
});

describe('sanitizeRenameTitle', () => {
  it('reports value, changed, and empty', () => {
    expect(sanitizeRenameTitle('a/b')).toEqual({ value: 'a／b', changed: true, empty: false });
    expect(sanitizeRenameTitle('Naruto')).toEqual({ value: 'Naruto', changed: false, empty: false });
    expect(sanitizeRenameTitle('   ')).toEqual({ value: '', changed: true, empty: true });
  });
});
