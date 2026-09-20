import { describe, it, expect } from 'vitest';
import {
  CRUSHED_RATIO,
  SQUEEZED_MAX,
  SQUEEZED_RATIO,
  UNPLACED_MAX,
  blockHasPlacement,
  codePoints,
  dropUnplacedMethod,
  pageHasPlacement,
  parallelOffsets,
  reflowOffsets,
  repairZeroCells,
  scaleOffsets,
  stampCharOffsetsMethod,
  validLineOffsets
} from './char-offsets';

// One-Punch Man 20 p64 b0 l0 (mokuro-fork, attn-cells) — the real zero-width
// cell on a real character: ぎ[322,363) と[363,363) 、[363,449). The producer
// merged と into 、's ink cell and handed the whole cell to 、. The same line is
// also the real SQUEEZED case: 地 sits in 94px while な ポ ン print in 22–26px
// cells, so auto mode gives the whole line to the fitted path.
const opmText = '地道なポイント稼ぎと、';
const opmOffsets = [0, 94, 139, 165, 190, 235, 271, 300, 322, 363, 363, 449];
// The same tail (と merged into 、) behind even print: the zero cell alone, on a
// line whose other cells are plausible — what the repair is FOR.
const opmTailOffsets = [0, 41, 82, 123, 164, 205, 246, 281, 322, 363, 363, 449];

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

describe('blockHasPlacement / pageHasPlacement', () => {
  it('is true for a block with at least one placed line', () => {
    expect(blockHasPlacement({ lines: ['あい', 'う'], char_offsets: [null, [0, 40]] })).toBe(true);
    expect(
      pageHasPlacement({ blocks: [{ lines: ['う'] }, { lines: ['あ'], char_offsets: [[0, 9]] }] })
    ).toBe(true);
  });

  it('is false when every entry is null, the key is absent, or nothing is parallel', () => {
    expect(blockHasPlacement({ lines: ['あ'], char_offsets: [null] })).toBe(false);
    expect(blockHasPlacement({ lines: ['あ'] })).toBe(false);
    // not parallel to lines: no line could ever render from it
    expect(blockHasPlacement({ lines: ['あ', 'い'], char_offsets: [[0, 9]] })).toBe(false);
    // a junk entry is no placement (parallelOffsets degrades it to null)
    expect(blockHasPlacement({ lines: ['あ'], char_offsets: ['junk'] })).toBe(false);
    expect(pageHasPlacement({ blocks: [] })).toBe(false);
    expect(pageHasPlacement({ blocks: [{ lines: ['あ'], char_offsets: [null] }] })).toBe(false);
  });

  it('never throws on file data', () => {
    for (const junk of [null, undefined, 3, 'page', {}, { blocks: 'no' }, { blocks: [null, 7] }]) {
      expect(pageHasPlacement(junk)).toBe(false);
      expect(blockHasPlacement(junk)).toBe(false);
    }
  });
});

describe('stampCharOffsetsMethod', () => {
  const placed = { blocks: [{ lines: ['あ'], char_offsets: [[0, 9]] }] };
  const bare = { blocks: [{ lines: ['あ'] }] };

  it('stamps the file-level method onto pages that carry placement, and only those', () => {
    const pages = [placed, bare];
    const stamped = stampCharOffsetsMethod(pages, 'cells');
    expect(stamped[0]).toEqual({ ...placed, char_offsets_method: 'cells' });
    // a page that placed nothing must not claim a method it never used
    expect(stamped[1]).toBe(bare);
    expect('char_offsets_method' in placed).toBe(false); // never mutates
  });

  it("lets a page's own value win", () => {
    const own = { ...placed, char_offsets_method: 'attn-cells' };
    expect(stampCharOffsetsMethod([own], 'cells')[0]).toBe(own);
    // even on a page with no placement: the page said so itself
    const ownBare = { ...bare, char_offsets_method: 'attn-cells' };
    expect(stampCharOffsetsMethod([ownBare], 'cells')[0]).toBe(ownBare);
  });

  it('changes nothing without a usable file-level method', () => {
    const pages = [placed];
    for (const method of [undefined, null, '', 7, {}]) {
      expect(stampCharOffsetsMethod(pages, method)).toBe(pages);
    }
  });
});

describe('dropUnplacedMethod', () => {
  it('drops the method from a page with no placement', () => {
    const page = { img_path: '1.jpg', char_offsets_method: 'cells', blocks: [{ lines: ['Hi'] }] };
    expect(dropUnplacedMethod(page)).toEqual({ img_path: '1.jpg', blocks: [{ lines: ['Hi'] }] });
    expect(page.char_offsets_method).toBe('cells'); // never mutates
  });

  it('returns the same page when it has placement, or no method to drop', () => {
    const placed = {
      char_offsets_method: 'cells',
      blocks: [{ lines: ['あ'], char_offsets: [[0, 9]] }]
    };
    expect(dropUnplacedMethod(placed)).toBe(placed);
    const bare = { blocks: [] };
    expect(dropUnplacedMethod(bare)).toBe(bare);
  });
});

describe('repairZeroCells', () => {
  it('repairs the real shape: a glyph merged into the following cell shares its 86px', () => {
    // ぎ[322,363) と[363,363) 、[363,449), with the rest of the line in even
    // print. The real line around that tail is squeezed as well and is refused
    // whole (see "squeezed cells" below), so the repair is shown on even cells.
    const before = [...opmTailOffsets];
    const repaired = repairZeroCells(codePoints(opmText), opmTailOffsets);
    expect(repaired).toEqual([0, 41, 82, 123, 164, 205, 246, 281, 322, 363, 406, 449]);
    expect(opmTailOffsets).toEqual(before); // never mutates
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
      [opmText, opmTailOffsets],
      ['ABCDEF', [0, 0, 80, 80, 120, 160, 200]], // two runs around one neighbour
      ['ABCDEFGHIJK', [3, 40, 40, 40, 41, 90, 90, 140, 180, 220, 260, 300]], // a 1px neighbour on one side
      ['ABCDEFGH', [0, 1, 1, 1, 50, 99, 148, 197, 246]], // run of 2 borrowing 49 → 16, 16, 17
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
    // exactly one pixel each is still a repair (Latin, so that this rule is
    // the only one judging it: as kana those 1px cells are squeezed print)
    expect(repairZeroCells([...'ABCDE'], [0, 2, 2, 2, 5, 15])).toEqual([0, 2, 3, 4, 5, 15]);
    expect(repairZeroCells([...'あいうえお'], [0, 2, 2, 2, 5, 15])).toBeNull();
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
    // a preceding donor with pixels to spare keeps its share (the line is long
    // enough that its crushed 3px donor and the run stay under UNPLACED_MAX)
    expect(
      repairZeroCells([...'ABCDEFGHI'], [0, 40, 80, 120, 160, 200, 240, 243, 243, 243])
    ).toEqual([0, 40, 80, 120, 160, 200, 240, 241, 242, 243]);
  });

  describe('crushed cells: placed in the file, unreadable on the page', () => {
    it(`counts a cell under ${CRUSHED_RATIO * 100}% of the median non-zero cell as unplaced`, () => {
      expect(CRUSHED_RATIO).toBe(0.25);
      // One zero cell in ten passes the zero-only rule easily, but four more
      // glyphs sit in 1–3px cells: half the line has no placement worth drawing.
      expect(
        repairZeroCells([...'ABCDEFGHIJ'], [0, 40, 80, 120, 160, 200, 202, 205, 206, 208, 208])
      ).toBeNull();
    });

    it('gives up on a crushed line even when no cell is zero', () => {
      expect(repairZeroCells([...'ABCDEF'], [0, 40, 80, 120, 122, 123, 126])).toBeNull();
    });

    it('never repairs a crushed cell: it only counts toward giving up', () => {
      // B is crushed (2px) and I is zero: 2 of 10, so the line keeps its
      // placement. I shares J's cell; B stays exactly as the file had it.
      expect(
        repairZeroCells([...'ABCDEFGHIJ'], [0, 40, 42, 82, 122, 162, 202, 242, 282, 282, 322])
      ).toEqual([0, 40, 42, 82, 122, 162, 202, 242, 282, 302, 322]);
      // nothing zero, one crushed cell: nothing to repair, the same array back
      const offsets = [0, 40, 42, 82, 122, 162];
      expect(repairZeroCells([...'ABCDE'], offsets)).toBe(offsets);
    });

    it('keeps the half cells of 、 and 。 placed', () => {
      // Counted as crushed, 、 and 。 would make 3 of 6 unplaced and cost the
      // line its cells. Half a cell is the print, not a producer failure.
      expect(repairZeroCells([...'あ、い。うえ'], [0, 40, 60, 100, 120, 120, 200])).toEqual([
        0, 40, 60, 100, 120, 160, 200
      ]);
    });

    it('is strict: a cell of exactly the ratio is placed', () => {
      // median 40 → crushed below 10. C is zero either way and shares D's
      // 40px; A at 9px makes it two unplaced of four, at 10px only one.
      expect(repairZeroCells([...'ABCD'], [0, 10, 50, 50, 90])).toEqual([0, 10, 50, 70, 90]);
      expect(repairZeroCells([...'ABCD'], [0, 9, 49, 49, 89])).toBeNull();
    });

    it('measures against the NON-ZERO median, so zero cells never lower the bar', () => {
      // widths 40 0 40 0 40 0 40 2 2 2. Over every cell the median would be 2
      // and nothing would count as crushed; three zeros alone pass the 40% rule
      // and each has a 40px neighbour to share. Against the non-zero median
      // (40) six of ten characters are unplaced.
      expect(
        repairZeroCells([...'ABCDEFGHIJ'], [0, 40, 40, 80, 80, 120, 120, 160, 162, 164, 166])
      ).toBeNull();
    });

    describe('when crushed cells are the majority', () => {
      // The median of such a line IS a crushed cell, so a bar taken from it
      // alone flags nothing. The mean cell (extent / real characters) cannot be
      // dragged down that way: the pixels the crushed glyphs lost are still in
      // the extent, inside the one or two cells that swallowed them.
      const widthsOf = (offsets: number[]) => offsets.slice(1).map((v, k) => v - offsets[k]);
      const fromWidths = (widths: number[]) =>
        widths.reduce((acc, width) => [...acc, acc[acc.length - 1] + width], [0]);

      it('gives up on real lines whose median cell is itself crushed', () => {
        // Chained Soldier 01 (paddle-manga) p16 b6 l0: no zero cell at all,
        // median 5.5 → the old bar was 1.4px and every glyph passed
        const gate = fromWidths([116, 7, 3, 2, 4, 4, 4, 7, 3, 5, 7, 4, 8, 8, 6, 107]);
        expect(widthsOf(gate)).toHaveLength(16);
        expect(repairZeroCells(codePoints('日本各地に謎の門が突如として出現'), gate)).toBeNull();
        // Chained Soldier 02 (mokuro-fork) p45 b5 l0
        expect(repairZeroCells(codePoints('それでは、'), fromWidths([68, 5, 1, 1, 39]))).toBeNull();
      });

      it('never manufactures a crushed line: the bar applies to the repaired cells too', () => {
        // Chained Soldier 01 (paddle-manga) p189 b5 l0, widths 60 19 0 10 180.
        // One zero and one crushed cell of five pass the count — and then で
        // takes half of る's 19px, leaving three 10px slivers between a 60px
        // and a 180px cell: the very line the rule exists to refuse.
        expect(repairZeroCells(codePoints('まるで巣の'), [0, 60, 79, 79, 89, 269])).toBeNull();
        // Chained Soldier 02 (paddle-manga) p92 b1 l0: 0 11 11 100 → 5 6 11 100
        expect(repairZeroCells(codePoints('羅俱美偉'), [0, 0, 11, 22, 122])).toBeNull();
        // a donor with room to spare still repairs: 0 60 60 100 → 30 30 60 100
        expect(repairZeroCells([...'ABCD'], [0, 0, 60, 120, 220])).toEqual([0, 30, 60, 120, 220]);
      });

      it('takes the larger of the two references, so it only ever raises the bar', () => {
        // even print: the mean equals the median and nothing changes
        const even = fromWidths([40, 40, 40, 40, 40]);
        expect(repairZeroCells([...'ABCDE'], even)).toBe(even);
        // one glyph in 2px beside 40px print: mean 32, median 40 — still the
        // median's bar (10), still one crushed cell of five, still placed
        const one = fromWidths([40, 2, 40, 40, 40]);
        expect(repairZeroCells([...'ABCDE'], one)).toBe(one);
      });

      it('counts only real characters in the mean: whitespace does not lower it', () => {
        // widths 100 0 0 0 0 6 6 6 100: over all nine cells the mean would be
        // 24 (bar 6, nothing crushed); over the five glyphs it is 43.6 and the
        // three 6px ones are unplaced
        expect(
          repairZeroCells(
            [...'A\u3000\u3000\u3000\u3000BCDE'],
            fromWidths([100, 0, 0, 0, 0, 6, 6, 6, 100])
          )
        ).toBeNull();
      });

      it('still keeps the half cells of 、 and 。 on a line with a wide cell', () => {
        // a 90px opening cell lifts the mean to 42: 、 and 。 at 20px stay
        // well above a quarter of it
        const offsets = fromWidths([90, 20, 40, 20, 40]);
        expect(repairZeroCells([...'あ、い。う'], offsets)).toBe(offsets);
      });
    });

    it('never counts a narrow whitespace or mark cell', () => {
      // the 2px space is no crushed glyph: 1 of 3 real characters is unplaced
      expect(repairZeroCells([...'あ いう'], [0, 40, 42, 82, 82])).not.toBeNull();
      expect(repairZeroCells([...'か\u3099きく'], [0, 40, 41, 81, 81])).not.toBeNull();
    });
  });

  describe('squeezed cells: placed, plausible one by one, overlapping as a line', () => {
    const fromWidths = (cellWidths: number[]) =>
      cellWidths.reduce((acc, width) => [...acc, acc[acc.length - 1] + width], [0]);

    it('pins the constants', () => {
      expect(SQUEEZED_RATIO).toBe(0.7);
      expect(SQUEEZED_MAX).toBe(0.25);
    });

    it('gives up on the real line: 地 in 94px squeezes な ポ ン into 22–26px cells', () => {
      // reference 449 / 11 = 40.8px, the glyphs print at about 41. After the と
      // repair the cells are 94 45 26 25 45 36 29 22 41 43 43: three of the ten
      // full-cell glyphs sit under 0.7 × 40.8 = 28.6px and would overlap. No
      // zero- or crushed-cell rule sees it — every cell is well over a quarter.
      const before = [...opmOffsets];
      expect(repairZeroCells(codePoints(opmText), opmOffsets)).toBeNull();
      expect(opmOffsets).toEqual(before);
      // the FILE is valid: only the reader's best rendering declines it
      expect(validLineOffsets(opmText, opmOffsets, 457)).toBe(opmOffsets);
    });

    it('keeps an evenly spaced line placed (the same array back)', () => {
      const offsets = fromWidths([40, 40, 40, 40, 40, 40, 40, 40]);
      expect(repairZeroCells([...'あいうえおかきく'], offsets)).toBe(offsets);
    });

    it('keeps tight but plausible tracking: cells at 0.8 of the reference', () => {
      // reference 400 / 10 = 40; half the line in 32px cells is tight print
      // beside generous print, not an overlap
      const offsets = fromWidths([32, 48, 32, 48, 32, 48, 32, 48, 32, 48]);
      expect(repairZeroCells([...'継続的な活動が強みだ'], offsets)).toBe(offsets);
    });

    it('never counts 、 。 っ ー: less than a cell is what they print in', () => {
      // reference 240 / 8 = 30, so the 20px cells are under 0.7 of it. Counted,
      // they would be 4 of 8; they are not glyphs that fill a cell, and the four
      // that do (あ い う え) all have their 40px.
      const offsets = fromWidths([40, 20, 40, 20, 40, 20, 40, 20]);
      expect(repairZeroCells([...'あ、いっうーえ。'], offsets)).toBe(offsets);
      // the same for small katakana, brackets and fullwidth marks
      const marks = fromWidths([20, 40, 20, 40, 20, 40, 20, 40, 20]);
      expect(repairZeroCells([...'「アッイャウ！エ」'], marks)).toBe(marks);
    });

    it('never trips on fewer than three full-cell glyphs', () => {
      // い at 20px of a 60px reference is squeezed, but one of two glyphs is no
      // pattern — a short line has too few cells to tell print from failure
      const two = fromWidths([100, 20]);
      expect(repairZeroCells([...'あい'], two)).toBe(two);
      const withMarks = fromWidths([100, 20, 30, 30]);
      expect(repairZeroCells([...'あい、。'], withMarks)).toBe(withMarks);
      // the third full-cell glyph makes it a line that can be judged
      expect(repairZeroCells([...'あいう'], fromWidths([20, 50, 50]))).toBeNull();
    });

    it('never judges Latin or halfwidth text: its advances are proportional', () => {
      // GCV layers place horizontal text per symbol; an l beside a W is print
      const latin = fromWidths([30, 30, 10, 40, 28, 28, 8, 8]);
      expect(repairZeroCells([...'NO WAY!!'], latin)).toBe(latin);
      const halfwidth = fromWidths([22, 8, 22, 22, 8, 22]);
      expect(repairZeroCells([...'ｶﾞﾝﾊﾞﾚ'], halfwidth)).toBe(halfwidth);
      // narrow Latin beside kanji: the 12px letters are under 0.7 × 21.3 and
      // are simply not part of the count
      const mixed = fromWidths([40, 40, 40, 12, 12, 12, 12, 12, 12]);
      expect(repairZeroCells([...'東京都ABCDEF'], mixed)).toBe(mixed);
    });

    it('is strict on the ratio: a cell of exactly 0.7 of the reference is not squeezed', () => {
      // reference 400 / 10 = 40 → the bar is 28px. Three cells AT the bar: none
      // squeezed. Three cells one pixel under: 3 of 10, over a quarter.
      const at = fromWidths([28, 45, 28, 45, 28, 45, 45, 45, 45, 46]);
      expect(repairZeroCells([...'あいうえおかきくけこ'], at)).toBe(at);
      const under = fromWidths([27, 45, 27, 45, 27, 45, 46, 46, 46, 46]);
      expect(repairZeroCells([...'あいうえおかきくけこ'], under)).toBeNull();
    });

    it('is strict on the share: exactly a quarter squeezed is still placed', () => {
      // 1 of 4 and 2 of 8 are a quarter; 3 of 8 is over it
      const quarter = fromWidths([20, 60, 60, 60]);
      expect(repairZeroCells([...'あいうえ'], quarter)).toBe(quarter);
      const two = fromWidths([20, 60, 20, 60, 40, 40, 40, 40]);
      expect(repairZeroCells([...'あいうえおかきく'], two)).toBe(two);
      const three = fromWidths([20, 60, 20, 60, 20, 60, 40, 40]);
      expect(repairZeroCells([...'あいうえおかきく'], three)).toBeNull();
    });

    it('judges the REPAIRED cells, not the ones in the file', () => {
      // As filed, あ (0px) is one squeezed glyph of three. Repaired it shares
      // い's 80px and the line is even print.
      expect(repairZeroCells([...'あいう'], [0, 0, 80, 120])).toEqual([0, 40, 80, 120]);
      // The other way round: う takes half of 。's 20px and lands in a 10px
      // sliver. One zero cell of five passes every other rule.
      expect(repairZeroCells([...'あ、い。う'], [0, 40, 60, 100, 120, 120])).toBeNull();
    });

    it('counts every ideograph, the supplementary planes included', () => {
      // 𠮷 (U+20BB7) is a surrogate pair and one full-cell glyph
      expect(repairZeroCells([...'𠮷野家'], fromWidths([20, 50, 50]))).toBeNull();
    });
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
    // Kana at these widths are mostly squeezed lines, which come back null, so
    // it takes this many rounds to see enough repaired ones.
    for (let round = 0; round < 1600; round++) {
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
      // a line that keeps its cells is never a squeezed one (あ い 𠮷 are the
      // alphabet's full-cell glyphs)
      const wide = after.filter((_, k) => /^[あい𠮷]$/u.test(chars[k]));
      const reference = (offsets[chars.length] - offsets[0]) / chars.length;
      const squeezed = wide.filter((width) => width / reference < SQUEEZED_RATIO).length;
      if (wide.length >= 3) expect(squeezed, label).toBeLessThanOrEqual(SQUEEZED_MAX * wide.length);
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
