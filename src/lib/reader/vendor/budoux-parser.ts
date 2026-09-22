/**
 * BudouX phrase segmenter.
 * Copyright 2021 Google LLC
 * Licensed under the Apache License, Version 2.0.
 * Algorithm from https://github.com/google/budoux (parser.js).
 */

type Model = Record<string, Record<string, number>>;

/** Scores each character boundary and returns the phrase chunks. */
export class BudouXParser {
  private readonly model: Map<string, Map<string, number>>;
  private readonly baseScore: number;

  constructor(model: Model) {
    this.model = new Map(Object.entries(model).map(([k, v]) => [k, new Map(Object.entries(v))]));
    this.baseScore =
      -0.5 *
      [...this.model.values()]
        .flatMap((group) => [...group.values()])
        .reduce((prev, curr) => prev + curr, 0);
  }

  parse(sentence: string): string[] {
    if (sentence === '') return [];
    const boundaries = this.parseBoundaries(sentence);
    const result: string[] = [];
    let start = 0;
    for (const boundary of boundaries) {
      result.push(sentence.slice(start, boundary));
      start = boundary;
    }
    result.push(sentence.slice(start));
    return result;
  }

  private parseBoundaries(sentence: string): number[] {
    const result: number[] = [];
    const group = (name: string) => this.model.get(name);
    const uw1 = group('UW1');
    const uw2 = group('UW2');
    const uw3 = group('UW3');
    const uw4 = group('UW4');
    const uw5 = group('UW5');
    const uw6 = group('UW6');
    const bw1 = group('BW1');
    const bw2 = group('BW2');
    const bw3 = group('BW3');
    const tw1 = group('TW1');
    const tw2 = group('TW2');
    const tw3 = group('TW3');
    const tw4 = group('TW4');
    const scoreOf = (table: Map<string, number> | undefined, gram: string) => table?.get(gram) ?? 0;
    for (let i = 1; i < sentence.length; i++) {
      let score = this.baseScore;
      score += scoreOf(uw1, sentence.substring(i - 3, i - 2));
      score += scoreOf(uw2, sentence.substring(i - 2, i - 1));
      score += scoreOf(uw3, sentence.substring(i - 1, i));
      score += scoreOf(uw4, sentence.substring(i, i + 1));
      score += scoreOf(uw5, sentence.substring(i + 1, i + 2));
      score += scoreOf(uw6, sentence.substring(i + 2, i + 3));
      score += scoreOf(bw1, sentence.substring(i - 2, i));
      score += scoreOf(bw2, sentence.substring(i - 1, i + 1));
      score += scoreOf(bw3, sentence.substring(i, i + 2));
      score += scoreOf(tw1, sentence.substring(i - 3, i));
      score += scoreOf(tw2, sentence.substring(i - 2, i + 1));
      score += scoreOf(tw3, sentence.substring(i - 1, i + 2));
      score += scoreOf(tw4, sentence.substring(i, i + 3));
      if (score > 0) result.push(i);
    }
    return result;
  }
}
