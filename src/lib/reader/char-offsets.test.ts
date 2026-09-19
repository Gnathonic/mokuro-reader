import { describe, it, expect } from 'vitest';
import {
  UNPLACED_MAX,
  codePoints,
  parallelOffsets,
  reflowOffsets,
  repairZeroCells,
  scaleOffsets,
  validLineOffsets
} from './char-offsets';

// One-Punch Man 20 p64 b0 l0 (mokuro-fork, attn-cells) — the real zero-width
// cell on a real character: ぎ[322,363) と[363,363) 、[363,449). The producer
// merged と into 、's ink cell and handed the whole cell to 、.
const opmText = '地道なポイント稼ぎと、';
const opmOffsets = [0, 94, 139, 165, 190, 235, 271, 300, 322, 363, 363, 449];

const widths = (offsets: number[]) => offsets.slice(1).map((o, i) => o - offsets[i]);
const isMonotone = (offsets: number[]) => offsets.every((o, i) => i === 0 || o >= offsets[i - 1]);

describe('codePoints', () => {
  it('counts a surrogate pair as one character', () => {
    expect(codePoints('a𠮷野')).toEqual(['a', '𠮷', '野']);
    expect('𠮷'.length).toBe(2); // the UTF-16 length the contract does NOT use
  });

  it('returns nothing for an empty or non-string line', () => {
    expect(codePoints('')).toEqual([]);
    expect(codePoints(undefined as unknown as string)).toEqual([]);
  });
});

describe('validLineOffsets', () => {
  it('returns a valid entry unchanged (same array, no copy)', () => {
    expect(validLineOffsets(opmText, opmOffsets, 457)).toBe(opmOffsets);
  });

  it('accepts equal neighbours: non-decreasing, not strictly increasing', () => {
    expect(validLineOffsets('あ　い', [0, 50, 50, 100])).not.toBeNull();
  });

  it('accepts a non-zero start', () => {
    expect(validLineOffsets('あい', [12, 50, 90], 100)).toEqual([12, 50, 90]);
  });

  it('counts code points, not UTF-16 units', () => {
    expect(validLineOffsets('𠮷野', [0, 40, 80])).not.toBeNull();
    // what a UTF-16 producer would have written
    expect(validLineOffsets('𠮷野', [0, 20, 40, 80])).toBeNull();
  });

  it('rejects a short entry', () => {
    expect(validLineOffsets('あいう', [0, 40, 80])).toBeNull();
  });

  it('rejects a long entry', () => {
    expect(validLineOffsets('あいう', [0, 40, 80, 120, 160])).toBeNull();
  });

  it('rejects decreasing values', () => {
    expect(validLineOffsets('あいう', [0, 80, 40, 120])).toBeNull();
  });

  it('rejects NaN, infinities and non-numbers', () => {
    expect(validLineOffsets('あい', [0, NaN, 80])).toBeNull();
    expect(validLineOffsets('あい', [0, 40, Infinity])).toBeNull();
    expect(validLineOffsets('あい', [0, '40', 80])).toBeNull();
    expect(validLineOffsets('あい', [0, null, 80])).toBeNull();
  });

  it('rejects a hole in the array (it must not be skipped like Array#every would)', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(validLineOffsets('あい', [0, , 80])).toBeNull();
  });

  it('rejects floats: the contract is integer pixels', () => {
    expect(validLineOffsets('あい', [0, 40.5, 80])).toBeNull();
  });

  it('rejects a negative start', () => {
    expect(validLineOffsets('あい', [-1, 40, 80])).toBeNull();
  });

  it('rejects an extent more than 1.15x the quad main extent', () => {
    expect(validLineOffsets('あい', [0, 50, 115], 100)).not.toBeNull();
    expect(validLineOffsets('あい', [0, 50, 116], 100)).toBeNull();
  });

  it('measures the overlong check from offsets[0], not from zero', () => {
    expect(validLineOffsets('あい', [50, 100, 160], 100)).not.toBeNull();
  });

  it('rejects a line that starts beyond its own quad', () => {
    // offsets[0] shifts the line's origin, so an unbounded one lets a corrupt
    // file paint text anywhere on the page. The span alone (80) would pass.
    expect(validLineOffsets('あい', [100000, 100040, 100080], 100)).toBeNull();
    expect(validLineOffsets('あい', [101, 141, 181], 100)).toBeNull();
    // the far edge is still inside
    expect(validLineOffsets('あい', [100, 140, 180], 100)).not.toBeNull();
  });

  it('skips the overlong check when no main extent is given', () => {
    expect(validLineOffsets('あい', [0, 5000, 10000])).not.toBeNull();
  });

  it('rejects everything against a main extent that is not a finite number', () => {
    expect(validLineOffsets('あい', [0, 40, 80], NaN)).toBeNull();
  });

  it('rejects an empty line: there is no character to place', () => {
    expect(validLineOffsets('', [0])).toBeNull();
    expect(validLineOffsets('', [])).toBeNull();
  });

  it('rejects anything that is not an array', () => {
    expect(validLineOffsets('あ', null)).toBeNull();
    expect(validLineOffsets('あ', undefined)).toBeNull();
    expect(validLineOffsets('あ', '0,40')).toBeNull();
    expect(validLineOffsets('あ', { 0: 0, 1: 40, length: 2 })).toBeNull();
    expect(validLineOffsets(undefined as unknown as string, [0, 40])).toBeNull();
  });
});

describe('parallelOffsets', () => {
  it('returns the block array itself when it is parallel to lines', () => {
    const char_offsets = [[0, 40, 80], null];
    expect(parallelOffsets({ lines: ['あい', 'う'], char_offsets })).toBe(char_offsets);
  });

  it('is null when the key is absent, not an array, or the wrong length', () => {
    expect(parallelOffsets({ lines: ['あい'] })).toBeNull();
    expect(parallelOffsets({ lines: ['あい'], char_offsets: 'nope' })).toBeNull();
    expect(parallelOffsets({ lines: ['あい', 'う'], char_offsets: [[0, 40, 80]] })).toBeNull();
    expect(
      parallelOffsets({ lines: undefined as unknown as string[], char_offsets: [] })
    ).toBeNull();
  });

  it('degrades a junk entry to null instead of rejecting the whole block', () => {
    const block = { lines: ['あい', 'う'], char_offsets: [[0, 40, 80], 'junk'] };
    expect(parallelOffsets(block)).toEqual([[0, 40, 80], null]);
    expect(block.char_offsets[1]).toBe('junk'); // input untouched
  });
});

describe('repairZeroCells', () => {
  it('repairs the real case: と borrows the larger neighbour 、 and they share its 86px', () => {
    const before = [...opmOffsets];
    const repaired = repairZeroCells(codePoints(opmText), opmOffsets);
    expect(repaired).toEqual([0, 94, 139, 165, 190, 235, 271, 300, 322, 363, 406, 449]);
    expect(opmOffsets).toEqual(before); // never mutates
  });

  it('returns the input array when there is nothing to repair', () => {
    const offsets = [0, 40, 80];
    expect(repairZeroCells(['あ', 'い'], offsets)).toBe(offsets);
  });

  it('splits a run and its neighbour evenly, remainder to the last', () => {
    // A=40 B=0 C=0 D=91 E=40 → B, C, D share D's 91
    expect(repairZeroCells([...'ABCDE'], [0, 40, 40, 40, 131, 171])).toEqual([
      0, 40, 70, 100, 131, 171
    ]);
    // A=91 B=0 C=0 D=10 E=10 → the larger neighbour is on the left
    expect(repairZeroCells([...'ABCDE'], [0, 91, 91, 91, 101, 111])).toEqual([
      0, 30, 60, 91, 101, 111
    ]);
  });

  it('borrows the following cell when both neighbours are equally wide', () => {
    // the one real example merged the missing glyph into the FOLLOWING cell
    expect(repairZeroCells([...'ABC'], [0, 50, 50, 100])).toEqual([0, 50, 75, 100]);
  });

  it('repairs a zero cell at the line start from its only neighbour', () => {
    expect(repairZeroCells([...'ABCD'], [0, 0, 80, 120, 160])).toEqual([0, 40, 80, 120, 160]);
  });

  it('repairs a zero cell at the line end from its only neighbour', () => {
    expect(repairZeroCells([...'ABCD'], [0, 40, 80, 160, 160])).toEqual([0, 40, 80, 120, 160]);
  });

  it('keeps a non-zero start', () => {
    expect(repairZeroCells([...'ABCD'], [7, 7, 87, 127, 167])).toEqual([7, 47, 87, 127, 167]);
  });

  it('leaves whitespace at zero width and never counts it as unplaced', () => {
    const offsets = [0, 50, 50, 50, 50, 100];
    expect(repairZeroCells([...'あ　 \tい'], offsets)).toBe(offsets);
  });

  it('keeps whitespace inside a repaired run at zero width', () => {
    // あ=40 space=0 と=0 い=80 → と borrows い; the space stays a zero cell
    expect(repairZeroCells([...'あ　とい'], [0, 40, 40, 40, 120])).toEqual([0, 40, 40, 80, 120]);
    // あ=80 space=0 と=0 い=40 → と borrows あ; the space sits between them
    expect(repairZeroCells([...'あ　とい'], [0, 80, 80, 80, 120])).toEqual([0, 40, 40, 80, 120]);
  });

  it(`gives up when more than ${UNPLACED_MAX * 100}% of the characters were unplaced`, () => {
    expect(UNPLACED_MAX).toBe(0.4);
    // 3 of 5 zero
    expect(repairZeroCells([...'ABCDE'], [0, 0, 0, 0, 80, 160])).toBeNull();
    // exactly 2 of 5 is still repairable
    expect(repairZeroCells([...'ABCDE'], [0, 40, 40, 40, 130, 170])).not.toBeNull();
    // whitespace does not dilute the ratio: 2 of 3 real characters are zero
    expect(repairZeroCells([...'A　　　BC'], [0, 0, 0, 0, 0, 0, 90])).toBeNull();
  });

  it('gives up when every cell is zero', () => {
    expect(repairZeroCells([...'AB'], [0, 0, 0])).toBeNull();
    expect(repairZeroCells([...'AB'], [5, 5, 5])).toBeNull();
    expect(repairZeroCells([' '], [0, 0])).toBeNull();
  });

  it('preserves the total extent and stays monotone, integer and valid', () => {
    const cases: [string, number[]][] = [
      [opmText, opmOffsets],
      ['ABCDEF', [0, 0, 80, 80, 120, 160, 200]], // two runs around one neighbour
      ['ABCDEFGH', [3, 40, 40, 40, 41, 90, 90, 140, 180]], // a 1px neighbour on one side
      ['ABCDE', [0, 1, 1, 1, 50, 99]], // run of 2 borrowing 49 → 16, 16, 17
      ['ABCDEFGH', [0, 0, 0, 3, 40, 80, 120, 160, 200]] // 3px neighbour, 3 ways: 1, 1, 1
    ];
    for (const [text, offsets] of cases) {
      const chars = codePoints(text);
      const repaired = repairZeroCells(chars, offsets);
      expect(repaired, text).not.toBeNull();
      expect(repaired![0]).toBe(offsets[0]);
      expect(repaired![chars.length]).toBe(offsets[chars.length]);
      expect(isMonotone(repaired!)).toBe(true);
      expect(validLineOffsets(text, repaired)).toBe(repaired);
    }
  });

  it('gives up when the neighbour cannot give every sharer a pixel', () => {
    // う and え would share お's 1px three ways: 0, 0, 1. A repair that leaves
    // zero cells behind is no repair, so the line takes the fitted path.
    expect(repairZeroCells([...'あいうえお'], [0, 10, 11, 11, 12, 22])).toBeNull();
    expect(repairZeroCells([...'ABCDEFGH'], [0, 0, 0, 2, 40, 80, 120, 160, 200])).toBeNull();
    // Chained Soldier 02 (paddle-manga) p199 b8 l4: twelve glyphs crushed into
    // 47px between a 180px and an 81px cell — 刊 and 、 sit between 1px cells
    const crushed = [0, 180, 181, 182, 182, 182, 183, 188, 192, 210, 210, 217, 221, 227, 308];
    expect(repairZeroCells(codePoints('分は週刊、この2巻目からは隔'), crushed)).toBeNull();
    // exactly one pixel each is still a repair
    expect(repairZeroCells([...'あいうえお'], [0, 2, 2, 2, 5, 15])).toEqual([0, 2, 3, 4, 5, 15]);
  });

  it('never zeroes a cell the file had placed', () => {
    // The donor is the PRECEDING cell here, so it is the first sharer and
    // "remainder to the last" would leave it floor(2 / 3) = 0: い, placed at
    // 2px in the file, would vanish and the run's last member take its pixels.
    expect(
      repairZeroCells([...'あいうえおかきく'], [0, 10, 12, 12, 12, 13, 23, 33, 43])
    ).toBeNull();
    expect(repairZeroCells([...'ABCDEFG'], [0, 40, 80, 120, 160, 162, 162, 162])).toBeNull();
    expect(repairZeroCells([...'ABCDE'], [0, 40, 80, 120, 121, 121])).toBeNull();
    // a preceding donor with pixels to spare keeps its share
    expect(repairZeroCells([...'ABCDEFG'], [0, 40, 80, 120, 160, 163, 163, 163])).toEqual([
      0, 40, 80, 120, 160, 161, 162, 163
    ]);
  });

  it('treats marks and variation selectors like whitespace: they sit on their base', () => {
    // a decomposed が: the dakuten takes no room in print, so its zero cell is
    // placement, not a gap to repair
    const dakuten = [0, 40, 40];
    expect(repairZeroCells([...'か\u3099'], dakuten)).toBe(dakuten);
    // ❤ + U+FE0F: the selector must not borrow half of the FOLLOWING glyph
    const heart = [0, 40, 80, 120, 120, 160, 200];
    expect(repairZeroCells([...'好き❤\ufe0fだよ'], heart)).toBe(heart);
    // an ideographic variation selector is a surrogate pair — still one cell
    const ivs = [0, 40, 40, 80];
    expect(repairZeroCells([...'葛\u{e0100}飾'], ivs)).toBe(ivs);
  });

  it('holds its guarantees over a spread of lines', () => {
    // Deterministic LCG — the cases are arbitrary, not random: a failure must
    // reproduce. Narrow cells are over-represented on purpose; they are where
    // a neighbour runs out of pixels to share.
    let seed = 20260919;
    const next = (bound: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % bound;
    };
    const alphabet = [...'あい、𠮷.　 '];
    const cellWidths = [0, 0, 0, 1, 2, 3, 16, 40, 88];
    let repairedLines = 0;
    for (let round = 0; round < 500; round++) {
      const chars = Array.from({ length: 1 + next(12) }, () => alphabet[next(alphabet.length)]);
      const offsets = [next(20)];
      for (let k = 0; k < chars.length; k++) {
        offsets.push(offsets[k] + cellWidths[next(cellWidths.length)]);
      }
      const frozen = [...offsets];
      const repaired = repairZeroCells(chars, offsets);
      expect(offsets).toEqual(frozen);
      if (repaired === null) continue;

      const label = `${chars.join('')} ${offsets.join(',')}`;
      expect(repaired[0], label).toBe(offsets[0]);
      expect(repaired[chars.length], label).toBe(offsets[chars.length]);
      expect(validLineOffsets(chars.join(''), repaired), label).toBe(repaired);
      const before = widths(offsets);
      const after = widths(repaired);
      chars.forEach((char, k) => {
        const blank = /\s/u.test(char);
        // no real character is left without a cell…
        if (!blank) expect(after[k], label).toBeGreaterThan(0);
        // …no placed cell is taken away, and whitespace is never widened
        if (before[k] > 0) expect(after[k], label).toBeGreaterThan(0);
        if (blank && before[k] === 0) expect(after[k], label).toBe(0);
      });
      // an untouched line comes back as the same array; a changed one differs
      if (repaired === offsets) expect(after).toEqual(before);
      else expect(after, label).not.toEqual(before);
      if (repaired !== offsets) repairedLines++;
    }
    expect(repairedLines).toBeGreaterThan(50);
  });

  it('leaves no zero cell behind when the neighbour had pixels to share', () => {
    const repaired = repairZeroCells([...'ABCDEF'], [0, 0, 80, 80, 120, 160, 200])!;
    expect(widths(repaired).every((w) => w > 0)).toBe(true);
  });
});

describe('scaleOffsets', () => {
  it('scales every value, offsets[0] included, to rounded integers', () => {
    expect(scaleOffsets([0, 47, 94, 141], 0.5)).toEqual([0, 24, 47, 71]);
    expect(scaleOffsets([10, 20, 35], 2)).toEqual([20, 40, 70]);
  });

  it('stays monotone when cells collapse under a small factor', () => {
    const scaled = scaleOffsets([0, 1, 2, 3, 4, 5], 0.3);
    expect(scaled).toEqual([0, 0, 1, 1, 1, 2]);
    expect(isMonotone(scaled)).toBe(true);
  });

  it('returns a fresh array and never mutates', () => {
    const offsets = [0, 40, 80];
    const scaled = scaleOffsets(offsets, 1);
    expect(scaled).toEqual(offsets);
    expect(scaled).not.toBe(offsets);
    scaleOffsets(offsets, 3);
    expect(offsets).toEqual([0, 40, 80]);
  });

  it('leaves the values alone under a factor that means nothing', () => {
    // a degenerate old quad gives new/old = NaN or Infinity; rendering
    // validates again, so the honest move is to not invent numbers here
    for (const factor of [NaN, Infinity, -2]) {
      expect(scaleOffsets([0, 40, 80], factor)).toEqual([0, 40, 80]);
    }
    expect(scaleOffsets([0, 40, 80], 0)).toEqual([0, 0, 0]);
  });
});

describe('scaleOffsets on entries that are not valid offsets', () => {
  it('never launders a malformed entry into a valid-looking one', () => {
    // Coercion would do exactly that: null → 0, '40' → 80, true → 2, 40.5 → 81.
    // A line on the fitted path must still be on it after a resize.
    // eslint-disable-next-line no-sparse-arrays
    const hole = [0, , 80];
    const junk: unknown[][] = [
      [0, null, 80],
      [0, '40', 80],
      [0, true, 80],
      [0, [], 80],
      [0, {}, 80],
      [0, 40.5, 80],
      [0, NaN, 80],
      hole
    ];
    for (const entry of junk) {
      const label = JSON.stringify(entry);
      expect(validLineOffsets('あい', entry), label).toBeNull();
      for (const factor of [2, 1, 0.01]) {
        const scaled = scaleOffsets(entry as number[], factor);
        expect(validLineOffsets('あい', scaled), `${label} × ${factor}`).toBeNull();
        expect(scaled).not.toBe(entry);
      }
    }
  });

  it('never lets rounding hide a negative start or a decrease', () => {
    // round(-1 × 0.3) is -0, and 80 and 79 both round to 1 under 0.01
    expect(validLineOffsets('あい', scaleOffsets([-1, 40, 80], 0.3))).toBeNull();
    expect(validLineOffsets('あいう', scaleOffsets([0, 80, 79, 120], 0.01))).toBeNull();
  });

  it('leaves the values alone when the product is past integer range', () => {
    // a near-degenerate old quad (extent 1e-306) yields a finite factor whose
    // products are Infinity — which JSON would then store as null
    expect(scaleOffsets([0, 40, 80], 1e307)).toEqual([0, 40, 80]);
    expect(scaleOffsets([0, 40, 80], 1e300)).toEqual([0, 40, 80]);
    expect(scaleOffsets([0, 40, 80], 1e6)).toEqual([0, 40e6, 80e6]);
  });
});

describe('reflowOffsets', () => {
  const text = 'あいうえ';
  const offsets = [0, 40, 80, 120, 160];

  it('returns the same array for identical text', () => {
    expect(reflowOffsets(text, text, offsets)).toBe(offsets);
  });

  it('keeps every boundary through a one-character substitution', () => {
    const fixed = reflowOffsets(
      'リペンジしてやる',
      'リベンジしてやる',
      [0, 127, 227, 346, 456, 568, 681, 795, 896]
    );
    expect(fixed).toEqual([0, 127, 227, 346, 456, 568, 681, 795, 896]);
  });

  it('keeps variable advances outside the edit', () => {
    const fixed = reflowOffsets(opmText, opmText.replace('稼', '嫁'), opmOffsets);
    expect(fixed).toEqual(opmOffsets);
    expect(fixed).not.toBe(opmOffsets);
  });

  it('widens a mid-line insertion by one character each side, then splits evenly', () => {
    // い[40,80) + う[80,120) become い X う over the same 80px: 26, 26, 28
    expect(reflowOffsets(text, 'あいXうえ', offsets)).toEqual([0, 40, 66, 92, 120, 160]);
    expect(reflowOffsets(text, 'あいXYうえ', offsets)).toEqual([0, 40, 60, 80, 100, 120, 160]);
  });

  it('widens an insertion at the start on the only side there is', () => {
    expect(reflowOffsets(text, 'Xあいうえ', offsets)).toEqual([0, 20, 40, 80, 120, 160]);
  });

  it('widens an insertion at the end on the only side there is', () => {
    expect(reflowOffsets(text, 'あいうえX', offsets)).toEqual([0, 40, 80, 120, 140, 160]);
  });

  it('keeps widening when the neighbours have no span to share with a typed glyph', () => {
    // X lands between two zero-width spaces; one step each way finds no pixels,
    // and a real character with an empty span paints on top of its neighbour
    const typed = reflowOffsets('A　　', 'A　X　', [0, 50, 50, 50])!;
    expect(typed).toEqual([0, 12, 24, 36, 50]);
    expect(widths(typed)[2]).toBeGreaterThan(0);
    // a glyph typed over a zero-width space is the same problem without being
    // a pure insertion
    expect(reflowOffsets('あ　い', 'あXい', [0, 50, 50, 100])).toEqual([0, 33, 66, 100]);
  });

  it('does not widen for whitespace, nor for a fixed character whose cell was already empty', () => {
    // whitespace is zero-width by contract: typing one into an empty region
    // takes the single step every insertion takes, and no more
    expect(reflowOffsets('A　 B', 'A　\t B', [0, 50, 50, 50, 100])).toEqual([
      0, 50, 50, 50, 50, 100
    ]);
    // と had a zero cell in the file; fixing it to ど still moves no boundary
    // (auto mode repairs the cell at render time, as it did before the edit)
    expect(reflowOffsets(opmText, opmText.replace('と', 'ど'), opmOffsets)).toEqual(opmOffsets);
  });

  it('drops deleted cells and lets the preceding neighbour absorb their span', () => {
    expect(reflowOffsets(text, 'あうえ', offsets)).toEqual([0, 80, 120, 160]);
    expect(reflowOffsets(text, 'あいう', offsets)).toEqual([0, 40, 80, 160]);
    expect(reflowOffsets(text, 'あえ', offsets)).toEqual([0, 120, 160]);
  });

  it('gives a deletion at the line start to the first survivor: the extent holds', () => {
    expect(reflowOffsets(text, 'いうえ', offsets)).toEqual([0, 80, 120, 160]);
    expect(reflowOffsets(text, 'え', offsets)).toEqual([0, 160]);
  });

  it('splits a replaced middle over its old span whatever the new count', () => {
    expect(reflowOffsets(text, 'あXYZえ', offsets)).toEqual([0, 40, 66, 92, 120, 160]);
    expect(reflowOffsets(text, 'あXえ', offsets)).toEqual([0, 40, 120, 160]);
  });

  it('splits a full rewrite over the whole line', () => {
    expect(reflowOffsets(text, 'XY', offsets)).toEqual([0, 80, 160]);
    expect(reflowOffsets('あい', 'XYZ', [10, 50, 90])).toEqual([10, 36, 62, 90]);
  });

  it('diffs by code point, so a surrogate pair is never cut in half', () => {
    // 𠮷 and 𠮸 share their high surrogate; a UTF-16 diff would split there
    expect(reflowOffsets('𠮷野家', '𠮸野家', [0, 40, 80, 120])).toEqual([0, 40, 80, 120]);
    expect(reflowOffsets('𠮷野家', '𠮷田野家', [0, 40, 80, 120])).toEqual([0, 26, 52, 80, 120]);
  });

  it('is null for an empty line', () => {
    expect(reflowOffsets(text, '', offsets)).toBeNull();
  });

  it('is null when there was no placement to reflow', () => {
    expect(reflowOffsets(text, 'あいう', null)).toBeNull();
    expect(reflowOffsets(text, text, null)).toBeNull();
  });

  it('is null when the old offsets were not valid for the old text', () => {
    expect(reflowOffsets(text, 'あいう', [0, 40, 80])).toBeNull();
    expect(reflowOffsets(text, 'あいう', [0, 80, 40, 120, 160])).toBeNull();
    expect(reflowOffsets(text, text, [0, 40, 80])).toBeNull();
  });

  it('never mutates the old offsets', () => {
    const before = [...offsets];
    reflowOffsets(text, 'あXいYうえZ', offsets);
    reflowOffsets(text, 'え', offsets);
    expect(offsets).toEqual(before);
  });

  it('holds its properties over a spread of edits', () => {
    // Deterministic LCG — the cases are arbitrary, not random: a failure must
    // reproduce.
    let seed = 20260919;
    const next = (bound: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % bound;
    };
    // a small alphabet on purpose: repeated characters are where prefix and
    // suffix matching gets ambiguous. 𠮷 keeps surrogate pairs in play.
    const alphabet = [...'あいう、。𠮷.'];
    const randomText = (length: number) =>
      Array.from({ length }, () => alphabet[next(alphabet.length)]).join('');

    for (let round = 0; round < 200; round++) {
      const oldChars = codePoints(randomText(1 + next(10)));
      const oldOffsets = [next(20)];
      // zero-width cells included: real files have them
      for (let k = 0; k < oldChars.length; k++) oldOffsets.push(oldOffsets[k] + next(4) * 23);

      const at = next(oldChars.length + 1);
      const removed = next(Math.min(4, oldChars.length - at + 1));
      const inserted = codePoints(randomText(next(4)));
      const newChars = [...oldChars.slice(0, at), ...inserted, ...oldChars.slice(at + removed)];
      const oldText = oldChars.join('');
      const newText = newChars.join('');

      const frozen = [...oldOffsets];
      const result = reflowOffsets(oldText, newText, oldOffsets);
      expect(oldOffsets).toEqual(frozen);

      const label = `${oldText} → ${newText}`;
      if (newChars.length === 0) {
        expect(result, label).toBeNull();
        continue;
      }
      expect(result, label).not.toBeNull();
      expect(result!.length, label).toBe(newChars.length + 1);
      expect(result![0], label).toBe(oldOffsets[0]);
      expect(result![newChars.length], label).toBe(oldOffsets[oldChars.length]);
      expect(validLineOffsets(newText, result), label).toBe(result);
    }
  });
});
