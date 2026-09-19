import { describe, it, expect } from 'vitest';
import { lineCells, processLine, type LineCells } from './char-offsets-layout';
import { codePoints } from './char-offsets';
import fixture from './__fixtures__/char-offsets-page.json';

// Fixture README: __fixtures__/char-offsets-page.json is a real page — One-Punch
// Man 20 p64 from the bench volume, mokuro-fork output, char_offsets_method
// "attn-cells" — with two hand edits so mixed blocks are covered: block 1's
// second line ("しばらく活動停止に") had its offsets set to null, and block 3
// had its char_offsets key removed. Everything else is verbatim: variable
// advances, a zero-width と (b0 l0), a ．．． run with unequal cells (b0 l2) and
// two rotated quads (b2).

const sizes = (result: LineCells | null) => result?.cells.map((c) => c.size);
const text = (result: LineCells | null) => result?.cells.map((c) => c.text).join('');
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

describe('processLine', () => {
  it('collapses an ASCII or a fullwidth run of three dots into one ellipsis', () => {
    expect(processLine('待て...')).toBe('待て…');
    expect(processLine('のに．．．')).toBe('のに…');
  });

  it('matches left to right without overlap, like the regexes it replaced', () => {
    expect(processLine('....')).toBe('….');
    expect(processLine('......')).toBe('……');
    expect(processLine('．．．．．')).toBe('…．．');
    expect(processLine('あ...い．．．う')).toBe('あ…い…う');
  });

  it('leaves shorter and mixed runs alone', () => {
    expect(processLine('..')).toBe('..');
    expect(processLine('．．')).toBe('．．');
    expect(processLine('.．.')).toBe('.．.');
    expect(processLine('管理命令')).toBe('管理命令');
  });

  it('is exactly the substitution TextBoxes.svelte has always made', () => {
    const legacy = (line: string) => line.replace(/\.\.\./g, '…').replace(/．．．/g, '…');
    for (const line of ['', '.', '...', '.......', '．...．．', '...．．．...', 'a.b..c...d....']) {
      expect(processLine(line)).toBe(legacy(line));
    }
  });
});

describe('lineCells', () => {
  // The spec's own example block: a vertical line, one full cell per kanji.
  // The function is axis-agnostic — vertical vs horizontal only decides which
  // quad extent the caller passes as mainExtent.
  it('places a vertical line: contiguous cells from offsets[0] to offsets[n]', () => {
    const raw = '管理命令されてこそ';
    const offsets = [0, 47, 94, 141, 188, 235, 282, 329, 376, 424];
    const result = lineCells(raw, offsets, 426, { repair: true });
    expect(text(result)).toBe(raw);
    expect(sizes(result)).toEqual([47, 47, 47, 47, 47, 47, 47, 47, 48]);
    expect(result!.start).toBe(0);
    expect(result!.extent).toBe(424);
    expect(result!.start + sum(sizes(result)!)).toBe(offsets[offsets.length - 1]);
  });

  it('places a horizontal line with a non-zero start', () => {
    const result = lineCells('Hello', [3, 15, 27, 33, 39, 52], 60, { repair: true });
    expect(text(result)).toBe('Hello');
    expect(sizes(result)).toEqual([12, 12, 6, 6, 13]);
    expect(result!.start).toBe(3);
    expect(result!.extent).toBe(49);
  });

  it('preserves variable advances: 、 keeps its half cell', () => {
    const result = lineCells('はい、そう。', [0, 46, 92, 115, 161, 207, 230], 232, {
      repair: true
    });
    expect(sizes(result)).toEqual([46, 46, 23, 46, 46, 23]);
  });

  it('gives a surrogate pair one cell', () => {
    const result = lineCells('𠮷野家', [0, 40, 80, 120], 120, { repair: true });
    expect(result!.cells).toEqual([
      { text: '𠮷', size: 40 },
      { text: '野', size: 40 },
      { text: '家', size: 40 }
    ]);
  });

  it('keeps zero-width whitespace in the cells so copy and Yomitan still see it', () => {
    for (const repair of [true, false]) {
      const result = lineCells('あ　い', [0, 50, 50, 100], 100, { repair });
      expect(result!.cells).toEqual([
        { text: 'あ', size: 50 },
        { text: '　', size: 0 },
        { text: 'い', size: 50 }
      ]);
    }
  });

  describe('validation: any failure degrades the line to null', () => {
    const cases: [string, string, unknown][] = [
      ['short', 'あいう', [0, 40, 80]],
      ['long', 'あいう', [0, 40, 80, 120, 160]],
      ['decreasing', 'あいう', [0, 80, 40, 120]],
      ['NaN', 'あいう', [0, 40, NaN, 120]],
      ['float', 'あいう', [0, 40.5, 80, 120]],
      ['negative start', 'あいう', [-4, 40, 80, 120]],
      ['overlong', 'あいう', [0, 40, 80, 139]],
      ['start beyond the quad', 'あいう', [100000, 100040, 100080, 100120]],
      ['empty line', '', [0]],
      ['null entry', 'あいう', null],
      ['not an array', 'あいう', '0,40,80,120'],
      ['UTF-16 length', '𠮷野', [0, 20, 40, 80]]
    ];
    for (const [name, raw, offsets] of cases) {
      it(name, () => {
        expect(lineCells(raw, offsets, 120, { repair: true })).toBeNull();
        expect(lineCells(raw, offsets, 120, { repair: false })).toBeNull();
      });
    }

    it('accepts an extent up to 1.15x the quad', () => {
      expect(lineCells('あいう', [0, 40, 80, 138], 120, { repair: true })).not.toBeNull();
    });

    it('never throws on junk', () => {
      const junk = undefined as unknown as string;
      expect(lineCells(junk, [0, 1], 10, { repair: true })).toBeNull();
      expect(lineCells('あ', [0, 40], NaN, { repair: true })).toBeNull();
      expect(
        lineCells('あ', [0, 40], 40, undefined as unknown as { repair: boolean })
      ).not.toBeNull();
    });
  });

  describe('zero-width cells on real characters', () => {
    const raw = '地道なポイント稼ぎと、';
    const offsets = [0, 94, 139, 165, 190, 235, 271, 300, 322, 363, 363, 449];

    it('repair: true (auto mode) shares the neighbour: と and 、 get 43px each', () => {
      const result = lineCells(raw, offsets, 457, { repair: true });
      expect(sizes(result)).toEqual([94, 45, 26, 25, 45, 36, 29, 22, 41, 43, 43]);
      expect(result!.extent).toBe(449);
    });

    it('repair: false (original mode) renders the file as-is', () => {
      const result = lineCells(raw, offsets, 457, { repair: false });
      expect(sizes(result)).toEqual([94, 45, 26, 25, 45, 36, 29, 22, 41, 0, 86]);
      expect(text(result)).toBe(raw);
    });

    it('an unrepairable line is null under repair, cells as-is without', () => {
      const unplaced = [0, 0, 0, 0, 80, 160];
      expect(lineCells('あいうえお', unplaced, 160, { repair: true })).toBeNull();
      expect(sizes(lineCells('あいうえお', unplaced, 160, { repair: false }))).toEqual([
        0, 0, 0, 80, 80
      ]);
    });

    it('a line whose neighbours have no pixels to share is null under repair, as-is without', () => {
      // Chained Soldier 02 (paddle-manga) p199 b8 l4: 刊 and 、 are zero-width
      // between 1px cells, so no split gives every glyph a pixel
      const crushedRaw = '分は週刊、この2巻目からは隔';
      const crushed = [0, 180, 181, 182, 182, 182, 183, 188, 192, 210, 210, 217, 221, 227, 308];
      expect(lineCells(crushedRaw, crushed, 308, { repair: true })).toBeNull();
      expect(sizes(lineCells(crushedRaw, crushed, 308, { repair: false }))).toEqual([
        180, 1, 1, 0, 0, 1, 5, 4, 18, 0, 7, 4, 6, 81
      ]);
    });

    it('a repaired line never has a zero cell on a real character', () => {
      const result = lineCells('あいうえお', [0, 2, 2, 2, 5, 15], 15, { repair: true });
      expect(sizes(result)).toEqual([2, 1, 1, 1, 10]);
      expect(lineCells('あいうえお', [0, 10, 11, 11, 12, 22], 22, { repair: true })).toBeNull();
    });

    it('a mark or variation selector keeps its zero cell and costs the line nothing', () => {
      // counted as unplaced, the dakuten would be 1 of 2 and null the line
      expect(sizes(lineCells('か\u3099', [0, 40, 40], 100, { repair: true }))).toEqual([40, 0]);
      const heart = lineCells('好き❤\ufe0fだよ', [0, 40, 80, 120, 120, 160, 200], 200, {
        repair: true
      });
      expect(sizes(heart)).toEqual([40, 40, 40, 0, 40, 40]);
      expect(text(heart)).toBe('好き❤\ufe0fだよ');
    });

    it('a line with no extent at all carries no placement in either mode', () => {
      expect(lineCells('あい', [0, 0, 0], 100, { repair: true })).toBeNull();
      expect(lineCells('あい', [0, 0, 0], 100, { repair: false })).toBeNull();
    });

    it('never mutates the offsets it was given', () => {
      const before = [...offsets];
      lineCells(raw, offsets, 457, { repair: true });
      expect(offsets).toEqual(before);
    });
  });

  describe('ellipsis remap: offsets index the RAW line, cells the processed one', () => {
    it("collapses '...' into one cell spanning its three raw cells", () => {
      const result = lineCells('a...', [0, 10, 14, 18, 22], 22, { repair: true });
      expect(result!.cells).toEqual([
        { text: 'a', size: 10 },
        { text: '…', size: 12 }
      ]);
    });

    it("collapses '．．．' whose raw cells are unequal (the real 14, 14, 13 split)", () => {
      // One-Punch Man 20 p64 b0 l2
      const raw = 'フブキ組の強みだったのに．．．';
      const offsets = [0, 53, 93, 138, 186, 226, 275, 317, 369, 402, 455, 498, 544, 558, 572, 585];
      const result = lineCells(raw, offsets, 596, { repair: true });
      expect(text(result)).toBe('フブキ組の強みだったのに…');
      expect(result!.cells).toHaveLength(13);
      expect(result!.cells[12]).toEqual({ text: '…', size: 41 });
      expect(result!.extent).toBe(585);
    });

    it('a run of wildly unequal cells still spans [offsets[k], offsets[k+3])', () => {
      const result = lineCells('...', [0, 5, 20, 22], 22, { repair: false });
      expect(result!.cells).toEqual([{ text: '…', size: 22 }]);
    });

    it("splits '....' the way the regex does: an ellipsis, then a dot", () => {
      const result = lineCells('....', [0, 4, 8, 12, 17], 17, { repair: true });
      expect(result!.cells).toEqual([
        { text: '…', size: 12 },
        { text: '.', size: 5 }
      ]);
    });

    it('collapses six dots into two ellipses', () => {
      const result = lineCells('......', [0, 4, 8, 12, 17, 22, 27], 27, { repair: true });
      expect(result!.cells).toEqual([
        { text: '…', size: 12 },
        { text: '…', size: 15 }
      ]);
    });

    it('remaps two runs in one line, ASCII and fullwidth', () => {
      const raw = 'あ...い．．．';
      const result = lineCells(raw, [0, 40, 44, 48, 52, 92, 106, 120, 133], 133, { repair: true });
      expect(result!.cells).toEqual([
        { text: 'あ', size: 40 },
        { text: '…', size: 12 },
        { text: 'い', size: 40 },
        { text: '…', size: 41 }
      ]);
    });

    it('leaves a mixed run alone', () => {
      const result = lineCells('.．.', [0, 4, 8, 12], 12, { repair: true });
      expect(text(result)).toBe('.．.');
      expect(result!.cells).toHaveLength(3);
    });

    it('repairs the rendered cell, not the raw dots: an even split that rounds to zero is not unplaced', () => {
      // a 2px ellipsis cell split three ways is 0, 1, 1 — the first dot is
      // zero-width in the file, but the '…' that renders is not
      const result = lineCells('あ...', [0, 40, 40, 41, 42], 42, { repair: true });
      expect(result!.cells).toEqual([
        { text: 'あ', size: 40 },
        { text: '…', size: 2 }
      ]);
    });

    it('a wholly zero-width run is ONE unplaced character, not three', () => {
      // counted raw this line would be 3 of 5 unplaced and lose its placement
      const result = lineCells('あい...', [0, 40, 80, 80, 80, 80], 80, { repair: true });
      expect(result!.cells).toEqual([
        { text: 'あ', size: 40 },
        { text: 'い', size: 20 },
        { text: '…', size: 20 }
      ]);
    });

    it('holds the invariant cells.join === processLine(raw), sizes summing to the extent', () => {
      const lines = [
        '...',
        '....',
        '.....',
        '......',
        '．．．．',
        'あ...い．．．う..',
        '.．.',
        '…...'
      ];
      for (const raw of lines) {
        const n = codePoints(raw).length;
        const offsets = Array.from({ length: n + 1 }, (_, k) => k * 7);
        for (const repair of [true, false]) {
          const result = lineCells(raw, offsets, n * 7, { repair });
          expect(text(result), raw).toBe(processLine(raw));
          expect(result!.cells).toHaveLength(codePoints(processLine(raw)).length);
          expect(sum(sizes(result)!), raw).toBe(result!.extent);
        }
      }
    });
  });

  describe('fixture page', () => {
    // Same construction as quadExtents in line-coords-layout.ts (edge
    // midpoints), so the two rotated quads in block 2 are measured the way
    // the renderer will measure them.
    const mainExtent = (quad: number[][], vertical: boolean) => {
      const [p0, p1, p2, p3] = quad;
      const h = Math.hypot(
        (p1[0] + p2[0] - p0[0] - p3[0]) / 2,
        (p1[1] + p2[1] - p0[1] - p3[1]) / 2
      );
      const v = Math.hypot(
        (p2[0] + p3[0] - p0[0] - p1[0]) / 2,
        (p2[1] + p3[1] - p0[1] - p1[1]) / 2
      );
      return vertical ? v : h;
    };

    it('is the mixed page the README above describes', () => {
      expect(fixture.char_offsets_method).toBe('attn-cells');
      expect(fixture.blocks).toHaveLength(4);
      expect(fixture.blocks[1].char_offsets?.[1]).toBeNull();
      expect('char_offsets' in fixture.blocks[3]).toBe(false);
    });

    it('every non-null line yields cells under both repair modes', () => {
      let placed = 0;
      for (const block of fixture.blocks) {
        block.lines.forEach((raw, i) => {
          const offsets = block.char_offsets?.[i] ?? null;
          const main = mainExtent(block.lines_coords[i], block.vertical);
          for (const repair of [true, false]) {
            const result = lineCells(raw, offsets, main, { repair });
            if (offsets === null) {
              expect(result, raw).toBeNull();
              continue;
            }
            expect(result, raw).not.toBeNull();
            expect(text(result), raw).toBe(processLine(raw));
            expect(result!.start, raw).toBe(offsets[0]);
            expect(result!.extent, raw).toBe(offsets[offsets.length - 1] - offsets[0]);
            expect(sum(sizes(result)!), raw).toBe(result!.extent);
            // auto mode leaves no real character without a cell
            if (repair) expect(sizes(result)!.every((size) => size > 0)).toBe(true);
            placed++;
          }
        });
      }
      expect(placed).toBe(7 * 2);
    });
  });
});
