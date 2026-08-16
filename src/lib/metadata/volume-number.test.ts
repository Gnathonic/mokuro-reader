import { describe, expect, it } from 'vitest';
import { extractVolumeNumber } from './volume-number';

describe('extractVolumeNumber — volumes', () => {
  it.each([
    ['Vol 01', 1],
    ['Volume 12', 12],
    ['vol.3', 3],
    ['One Piece Vol.03', 3],
    ['第01巻', 1],
    ['ワンピース 第5巻', 5],
    ['3巻', 3],
    ['v07', 7],
    ['One Piece_v02', 2],
    ['One Piece #4', 4],
    ['One Piece 12', 12],
    ['One Piece_04', 4],
    ['One Piece-09', 9],
    ['01', 1]
  ])('%s → %i', (title, expected) => {
    expect(extractVolumeNumber(title, 'volumes')).toBe(expected);
  });

  it.each([['One Piece'], ['Extra'], ['One Piece (2020)'], ['第12話'], ['']])(
    '%s → undefined',
    (title) => {
      expect(extractVolumeNumber(title, 'volumes')).toBeUndefined();
    }
  );

  // An explicit chapter marker must not be read as a volume number: "Chapter 5"
  // would otherwise push volume 5 for the series' fifth chapter. Undefined sends
  // the tracker to its sort-position fallback instead.
  it.each([
    ['Chapter 5'],
    ['One Piece Chapter 105'],
    ['ch 7'],
    ['One Piece ch.7'],
    ['One Piece 第5話'],
    ['ワンピース 12話']
  ])('%s → undefined (chapter-titled entry)', (title) => {
    expect(extractVolumeNumber(title, 'volumes')).toBeUndefined();
  });

  it('leaves ordinary volume titles alone', () => {
    expect(extractVolumeNumber('Vol 3', 'volumes')).toBe(3);
    expect(extractVolumeNumber('One Piece #4', 'volumes')).toBe(4);
  });

  // An explicit volume marker wins over the chapter veto: these are volumes
  // that also mention a chapter range, not chapter-titled entries.
  it.each([
    ['Vol 3 (Ch 21-30)', 3],
    ['One Piece Vol 3 Ch 21-30', 3],
    ['Volume 5 第41話-第50話', 5]
  ])('%s → %i (explicit volume marker beats chapter veto)', (title, expected) => {
    expect(extractVolumeNumber(title, 'volumes')).toBe(expected);
  });

  it.each([['Chapter 106'], ['第12話']])(
    '%s → undefined still (no explicit volume marker to save it)',
    (title) => {
      expect(extractVolumeNumber(title, 'volumes')).toBeUndefined();
    }
  );
});

describe('extractVolumeNumber — chapters', () => {
  it.each([
    ['第12話', 12],
    ['Chapter 105', 105],
    ['ch.7', 7],
    ['Ch 1050', 1050],
    ['One Piece 1050', 1050],
    ['#12', 12],
    ['012', 12]
  ])('%s → %i', (title, expected) => {
    expect(extractVolumeNumber(title, 'chapters')).toBe(expected);
  });

  it('does not treat 巻 as a chapter number', () => {
    expect(extractVolumeNumber('第3巻', 'chapters')).toBeUndefined();
  });
});
