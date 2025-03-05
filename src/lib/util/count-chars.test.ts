import { describe, expect, it } from 'vitest';
import { countChars, getCharCount } from './count-chars';
import type { Page } from '$lib/types';

describe('countChars', () => {
  it('counts Japanese characters correctly', () => {
    expect(countChars('こんにちは')).toBe(5);
    expect(countChars('私は日本語を勉強します')).toBe(11);
  });

  it('ignores non-Japanese characters', () => {
    expect(countChars('Hello世界')).toBe(2);
    expect(countChars('123漢字abc')).toBe(2);
  });

  it('handles mixed content correctly', () => {
    expect(countChars('私の名前は John です')).toBe(7);
    expect(countChars('漢字 and かな')).toBe(4);
  });

  it('handles empty strings', () => {
    expect(countChars('')).toBe(0);
  });
});

describe('getCharCount', () => {
  const samplePages: Page[] = [
    {
      blocks: [
        {
          lines: ['こんにちは', 'Hello世界'],
          box: [0, 0, 0, 0]
        },
        {
          lines: ['私は日本語を勉強します'],
          box: [0, 0, 0, 0]
        }
      ],
      dimensions: [0, 0]
    },
    {
      blocks: [
        {
          lines: ['漢字 and かな'],
          box: [0, 0, 0, 0]
        }
      ],
      dimensions: [0, 0]
    }
  ];

  it('counts characters and lines correctly for all pages', () => {
    const result = getCharCount(samplePages);
    expect(result.charCount).toBe(22); // 5 + 2 + 11 + 4
    expect(result.lineCount).toBe(4);
  });

  it('counts characters and lines correctly up to specified page', () => {
    const result = getCharCount(samplePages, 1);
    expect(result.charCount).toBe(18); // 5 + 2 + 11
    expect(result.lineCount).toBe(3);
  });

  it('handles empty pages array', () => {
    const result = getCharCount([]);
    expect(result.charCount).toBe(0);
    expect(result.lineCount).toBe(0);
  });
});
