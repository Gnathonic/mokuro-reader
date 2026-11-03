import { describe, it, expect } from 'vitest';
import {
  escapeFieldText,
  fieldHtmlToPreviewText,
  placeholderNonce,
  tagSafeTitle
} from './field-html';

describe('escapeFieldText', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeFieldText(`<img src=x onerror="alert('1')">&`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;'
    );
  });

  it('escapes an existing entity rather than passing it through', () => {
    expect(escapeFieldText('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
  });

  it('leaves Japanese text, newlines and replacement patterns alone', () => {
    expect(escapeFieldText("「嫌だ」\n$& $1 $` $'")).toBe('「嫌だ」\n$&amp; $1 $` $&#39;');
    expect(escapeFieldText('吾輩は猫である。\n名前はまだ無い。')).toBe(
      '吾輩は猫である。\n名前はまだ無い。'
    );
  });
});

describe('tagSafeTitle', () => {
  it('turns whitespace into underscores', () => {
    expect(tagSafeTitle('One Piece  Vol 1')).toBe('One_Piece_Vol_1');
  });

  it('swaps markup delimiters for fullwidth look-alikes', () => {
    expect(tagSafeTitle('<svg/onload=alert(1)>')).toBe('＜svg/onload=alert(1)＞');
  });

  it('swaps quotes too, so a title cannot leave a quoted attribute', () => {
    expect(tagSafeTitle("x'onmouseover='alert(1)")).toBe('x＇onmouseover=＇alert(1)');
    expect(tagSafeTitle('x"onmouseover="alert(1)')).toBe('x＂onmouseover=＂alert(1)');
    expect(tagSafeTitle("Tom & Jerry's")).toBe('Tom_&_Jerry＇s');
  });

  it('gives the same result when applied twice', () => {
    const once = tagSafeTitle(`<a href='x'>"b"</a>`);
    expect(tagSafeTitle(once)).toBe(once);
  });

  it('keeps ordinary titles unchanged', () => {
    expect(tagSafeTitle('ダンジョン飯')).toBe('ダンジョン飯');
  });
});

describe('placeholderNonce', () => {
  it('is 16 hex characters and differs between calls', () => {
    const a = placeholderNonce();
    const b = placeholderNonce();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});

describe('fieldHtmlToPreviewText', () => {
  it('decodes what escapeFieldText encodes, so a preview shows the text as typed', () => {
    const raw = `<img src=x onerror="alert('1')"> & 「嫌だ」`;
    expect(fieldHtmlToPreviewText(escapeFieldText(raw))).toBe(raw);
  });

  it('decodes &amp; last, never twice', () => {
    expect(fieldHtmlToPreviewText(escapeFieldText('&lt;'))).toBe('&lt;');
  });

  it('still summarizes real markup', () => {
    expect(fieldHtmlToPreviewText('<b>猫</b><br><img src="a.jpg">')).toBe('猫\n[img]');
  });

  it('returns an empty string for empty input', () => {
    expect(fieldHtmlToPreviewText('')).toBe('');
  });
});
