import { describe, expect, it } from 'vitest';
import { detectTrackingUnitDetailed, extractVolumeNumber } from './volume-number';

/** The unit on its own — most of these cases are not about the confidence flag. */
const detectTrackingUnit = (
  titles: string[],
  totals?: { total_volumes?: number; total_chapters?: number }
) => detectTrackingUnitDetailed(titles, totals).unit;

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

describe('detectTrackingUnitDetailed — the unit it picks', () => {
  it('reads chapter-marked titles as chapters', () => {
    expect(detectTrackingUnit(['Chapter 1', 'Chapter 2', 'Chapter 3'])).toBe('chapters');
    expect(detectTrackingUnit(['第1話', '第2話'])).toBe('chapters');
    expect(detectTrackingUnit(['One Piece ch.7', 'One Piece ch.8'])).toBe('chapters');
  });

  it('reads volume-marked titles as volumes', () => {
    expect(detectTrackingUnit(['Vol 01', 'Vol 02'])).toBe('volumes');
    expect(detectTrackingUnit(['第01巻', '第02巻'])).toBe('volumes');
    expect(detectTrackingUnit(['One Piece_v02', 'One Piece_v03'])).toBe('volumes');
  });

  it('lets an explicit volume marker win over a chapter range in the same title', () => {
    expect(detectTrackingUnit(['Vol 1 (Ch 1-10)', 'Vol 2 (Ch 11-20)'])).toBe('volumes');
  });

  it('goes with the majority of a mixed folder', () => {
    expect(detectTrackingUnit(['Chapter 1', 'Chapter 2', 'Vol 01'])).toBe('chapters');
    expect(detectTrackingUnit(['Chapter 1', 'Vol 01', 'Vol 02'])).toBe('volumes');
  });

  it('ignores the ambiguous #N marker when counting volume markers', () => {
    // `#4` reads as a volume in extractVolumeNumber but says nothing about the
    // unit, so a chapter-marked sibling still decides the folder.
    expect(detectTrackingUnit(['One Piece #4', 'One Piece Chapter 5'])).toBe('chapters');
  });

  it('reads bare numbers above the volume count as chapters', () => {
    expect(
      detectTrackingUnit(['One Piece 1050', 'One Piece 1051'], {
        total_volumes: 108,
        total_chapters: 1100
      })
    ).toBe('chapters');
  });

  it('keeps volumes when the bare numbers fit inside the volume count', () => {
    expect(
      detectTrackingUnit(['One Piece 01', 'One Piece 02'], {
        total_volumes: 108,
        total_chapters: 1100
      })
    ).toBe('volumes');
  });

  it('keeps volumes when the bare numbers overshoot the chapter count too', () => {
    // 1050 > 108 volumes, but also > 900 chapters: nothing about it says
    // "chapters", so the safe default stands.
    expect(
      detectTrackingUnit(['Something 1050'], { total_volumes: 108, total_chapters: 900 })
    ).toBe('volumes');
  });

  it('reads bare numbers above the volume count as chapters when no chapter count is known', () => {
    expect(detectTrackingUnit(['Series 300'], { total_volumes: 20 })).toBe('chapters');
  });

  it('does not read an edition year as a chapter number', () => {
    // 2016 > 41 volumes would otherwise "prove" this folder is chapters.
    expect(detectTrackingUnit(['Berserk 2016'], { total_volumes: 41 })).toBe('volumes');
    expect(
      detectTrackingUnit(['Akira 1988', 'Akira 1990'], { total_volumes: 6, total_chapters: 120 })
    ).toBe('volumes');
    // …unless the title says chapter outright, where the number is meant.
    expect(detectTrackingUnit(['Chapter 1988'], { total_volumes: 6, total_chapters: 2000 })).toBe(
      'chapters'
    );
  });

  it('needs a known volume count before reading numbers as chapters', () => {
    // total_chapters alone says nothing about whether the FILES are chapters.
    expect(detectTrackingUnit(['Series 300'], { total_chapters: 900 })).toBe('volumes');
  });

  it('defaults to volumes with no titles, no numbers, or no totals', () => {
    expect(detectTrackingUnit([])).toBe('volumes');
    expect(detectTrackingUnit(['Extras', 'Omake'])).toBe('volumes');
    expect(detectTrackingUnit(['Series 300'])).toBe('volumes');
    expect(detectTrackingUnit(['', '   '])).toBe('volumes');
  });
});

describe('detectTrackingUnitDetailed — how much the answer is worth', () => {
  it('reports a marker-decided answer, whichever unit won', () => {
    expect(detectTrackingUnitDetailed(['Vol 01', 'Vol 02'])).toEqual({
      unit: 'volumes',
      markerDecided: true
    });
    expect(detectTrackingUnitDetailed(['Chapter 1', '第2話'])).toEqual({
      unit: 'chapters',
      markerDecided: true
    });
    // A majority is still the markers deciding.
    expect(detectTrackingUnitDetailed(['Chapter 1', 'Chapter 2', 'Vol 01']).markerDecided).toBe(
      true
    );
  });

  it('reports the bare-number, overshoot and default paths as undecided', () => {
    // These are the answers that need AniList's totals to be worth anything —
    // and nothing outside the push has them.
    expect(detectTrackingUnitDetailed(['One Piece 1050'])).toEqual({
      unit: 'volumes',
      markerDecided: false
    });
    expect(
      detectTrackingUnitDetailed(['One Piece 1050'], { total_volumes: 108, total_chapters: 1100 })
    ).toEqual({ unit: 'chapters', markerDecided: false });
    expect(detectTrackingUnitDetailed([])).toEqual({ unit: 'volumes', markerDecided: false });
    expect(detectTrackingUnitDetailed(['Extras', 'Omake']).markerDecided).toBe(false);
    // A tie is not a decision either.
    expect(detectTrackingUnitDetailed(['Chapter 1', 'Vol 01']).markerDecided).toBe(false);
  });
});
