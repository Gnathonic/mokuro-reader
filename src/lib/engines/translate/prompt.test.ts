import { describe, expect, it } from 'vitest';
import {
  buildUserPrompt,
  MalformedTranslationError,
  parseTranslation,
  readingOrder
} from './prompt';

describe('readingOrder', () => {
  const blocks = [
    { box: [10, 10, 50, 50] }, // left top
    { box: [200, 10, 240, 50] }, // right top
    { box: [200, 100, 240, 140] } // right lower
  ];
  it('RTL: right column first (xmax desc), then top to bottom', () => {
    expect(readingOrder(blocks, true)).toEqual([1, 2, 0]);
  });
  it('LTR: top to bottom, then left to right', () => {
    expect(readingOrder(blocks, false)).toEqual([0, 1, 2]);
  });
});

describe('parseTranslation', () => {
  it('accepts a bare array, a fenced block, and a {translations} wrapper', () => {
    const want = [
      { index: 0, text: 'Hi' },
      { index: 2, text: 'Bye' }
    ];
    expect(parseTranslation(JSON.stringify(want), [0, 2])).toEqual(want);
    expect(parseTranslation('```json\n' + JSON.stringify(want) + '\n```', [0, 2])).toEqual(want);
    expect(parseTranslation(JSON.stringify({ translations: want }), [0, 2])).toEqual(want);
  });
  it('throws MalformedTranslationError on bad JSON, a missing index, or a non-string', () => {
    expect(() => parseTranslation('not json', [0])).toThrow(MalformedTranslationError);
    expect(() => parseTranslation('[{"index":1,"text":"x"}]', [0])).toThrow(
      MalformedTranslationError
    );
    expect(() => parseTranslation('[{"index":0,"text":5}]', [0])).toThrow(
      MalformedTranslationError
    );
  });
});

describe('buildUserPrompt', () => {
  it('names the series and volume and lists blocks by index', () => {
    const p = buildUserPrompt({
      seriesTitle: 'Chainsaw Man',
      volumeTitle: 'Vol 2',
      target: 'en',
      blocks: [{ index: 3, text: 'こんにちは' }]
    });
    expect(p).toContain('Chainsaw Man');
    expect(p).toContain('Vol 2');
    expect(p).toContain('"index": 3');
    expect(p).toContain('こんにちは');
  });
});
