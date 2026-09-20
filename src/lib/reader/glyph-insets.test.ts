import { describe, it, expect } from 'vitest';
import { inkInsets } from './glyph-insets';

describe('inkInsets', () => {
  it('ordinary kana and kanji leave a little of their cell empty, about evenly', () => {
    for (const vertical of [true, false]) {
      const kanji = inkInsets('山川', vertical);
      expect(kanji.lead).toBeGreaterThanOrEqual(0.03);
      expect(kanji.lead).toBeLessThanOrEqual(0.07);
      expect(kanji.trail).toBeGreaterThanOrEqual(0.03);
      expect(kanji.trail).toBeLessThanOrEqual(0.07);
      const kana = inkInsets('あいうえお', vertical);
      expect(kana.lead).toBeGreaterThan(kanji.lead);
      expect(kana.lead).toBeLessThanOrEqual(0.13);
      expect(Math.abs(kana.lead - kana.trail)).toBeLessThan(0.03);
    }
  });

  it('reads the FIRST and the LAST character of the line, nothing in between', () => {
    expect(inkInsets('「嫌だ」', true)).toEqual({
      lead: inkInsets('「', true).lead,
      trail: inkInsets('」', true).trail
    });
    expect(inkInsets('あ。、「」い', true)).toEqual(inkInsets('あい', true));
  });

  it('a full stop or comma inks only the start of its cell, in both directions', () => {
    for (const stop of ['。', '、', '，', '．']) {
      for (const vertical of [true, false]) {
        const { lead, trail } = inkInsets(`た${stop}`, vertical);
        expect(lead).toBeCloseTo(inkInsets('た', vertical).lead, 9);
        expect(trail).toBeGreaterThan(0.6);
        expect(trail).toBeLessThan(0.75);
      }
    }
  });

  it('a closing bracket inks the start of its cell, an opening one the end', () => {
    for (const vertical of [true, false]) {
      for (const close of '」』）】') {
        expect(inkInsets(`あ${close}`, vertical).trail).toBeGreaterThan(0.55);
        expect(inkInsets(close, vertical).lead).toBeLessThan(0.1);
      }
      for (const open of '「『（【') {
        expect(inkInsets(`${open}あ`, vertical).lead).toBeGreaterThan(0.55);
        expect(inkInsets(open, vertical).trail).toBeLessThan(0.1);
      }
    }
  });

  it('small kana sit in the middle of their cell', () => {
    const v = inkInsets('っ', true);
    expect(v.lead).toBeCloseTo(0.25, 2);
    expect(v.trail).toBeCloseTo(0.25, 2);
    const h = inkInsets('ッ', false);
    expect(h.lead).toBeGreaterThan(0.15);
    expect(h.lead).toBeLessThan(v.lead);
  });

  it('一 is a thin stroke mid-cell in a column and fills the cell in a row', () => {
    const v = inkInsets('一', true);
    expect(v.lead).toBeGreaterThan(0.38);
    expect(v.trail).toBeGreaterThan(0.38);
    const h = inkInsets('一', false);
    expect(h.lead).toBeLessThan(0.08);
    expect(h.trail).toBeLessThan(0.08);
  });

  it('the long-vowel mark and the dash are turned with the column: they fill the cell', () => {
    for (const bar of ['ー', '―', '—']) {
      for (const vertical of [true, false]) {
        const { lead, trail } = inkInsets(bar, vertical);
        expect(lead).toBeLessThan(0.1);
        expect(trail).toBeLessThan(0.1);
      }
    }
  });

  it('！ and ？ are full height in a column but a narrow glyph mid-cell in a row', () => {
    expect(inkInsets('！', true).lead).toBeLessThan(0.2);
    expect(inkInsets('？', true).trail).toBeLessThan(0.2);
    expect(inkInsets('！', false).lead).toBeGreaterThan(0.3);
    expect(inkInsets('？', false).trail).toBeGreaterThan(0.3);
  });

  it('half-width characters are inset by a sliver of an em', () => {
    const { lead, trail } = inkInsets('NO WAY', false);
    expect(lead).toBeLessThanOrEqual(0.05);
    expect(trail).toBeLessThanOrEqual(0.05);
  });

  it('a mark riding on the last character is not the last character', () => {
    expect(inkInsets('か\u3099', true)).toEqual(inkInsets('か', true));
    expect(inkInsets('。\ufe00', true).trail).toBe(inkInsets('。', true).trail);
  });

  it('an ideographic space at either end is a whole empty cell', () => {
    const plain = inkInsets('あい', true);
    expect(inkInsets('\u3000あい', true).lead).toBeCloseTo(1 + plain.lead, 9);
    expect(inkInsets('あい\u3000', true).trail).toBeCloseTo(1 + plain.trail, 9);
  });

  it('never throws and never returns a negative or non-finite inset', () => {
    for (const text of ['', '\u3000', '\u3099', 'あ', '。']) {
      const { lead, trail } = inkInsets(text, true);
      expect(lead).toBeGreaterThanOrEqual(0);
      expect(trail).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(lead + trail)).toBe(true);
    }
    expect(inkInsets('', true)).toEqual({ lead: 0, trail: 0 });
    // a line of nothing but space has no ink to anchor on
    expect(inkInsets('\u3000', false)).toEqual({ lead: 0, trail: 0 });
  });

  it('a one-character line reads both insets off that character', () => {
    expect(inkInsets('。', true)).toEqual({
      lead: inkInsets('。あ', true).lead,
      trail: inkInsets('あ。', true).trail
    });
  });
});
