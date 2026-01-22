import { test, expect } from 'vitest';
import { parseHash, viewToHash, nav } from '$lib/util/hash-router';

test('parseHash handles merge-series route', () => {
  const result = parseHash('#/merge-series');
  expect(result).toEqual({ type: 'merge-series' });
});

test('viewToHash generates merge-series hash', () => {
  const result = viewToHash({ type: 'merge-series' });
  expect(result).toBe('#/merge-series');
});

test('nav.toMergeSeries exists and is callable', () => {
  expect(typeof nav.toMergeSeries).toBe('function');
});
