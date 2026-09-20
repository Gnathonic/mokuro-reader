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
  // Anthropic has no JSON mode, and Claude likes a sentence around its answer.
  describe('a reply that wraps the JSON in prose', () => {
    const want = [
      { index: 0, text: 'Hi' },
      { index: 2, text: 'Bye [sigh]' }
    ];
    const json = JSON.stringify(want);
    it('prose, then a fenced block', () => {
      expect(
        parseTranslation('Here are the translations:\n\n```json\n' + json + '\n```', [0, 2])
      ).toEqual(want);
    });
    it('a fenced block, then prose', () => {
      expect(
        parseTranslation(
          '```\n' + json + '\n```\nLet me know if you want another register.',
          [0, 2]
        )
      ).toEqual(want);
    });
    it('bare JSON with prose before and after', () => {
      expect(parseTranslation('Sure! ' + json + ' Hope that helps.', [0, 2])).toEqual(want);
      expect(
        parseTranslation('Here you go: ' + JSON.stringify({ translations: want }), [0, 2])
      ).toEqual(want);
    });
    it('plain JSON is parsed as is, even when its text holds a fence or brackets', () => {
      const tricky = [{ index: 0, text: '```json [x] {y} ```' }];
      expect(parseTranslation(JSON.stringify(tricky), [0])).toEqual(tricky);
    });
    it('garbage still throws', () => {
      expect(() => parseTranslation('I cannot translate this page.', [0])).toThrow(
        MalformedTranslationError
      );
      expect(() => parseTranslation('```json\nnot json\n```', [0])).toThrow(
        MalformedTranslationError
      );
      expect(() => parseTranslation('see [the notes] for {details}', [0])).toThrow(
        MalformedTranslationError
      );
    });
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
