import { describe, expect, test } from 'vitest';
import { nav, parseHash, viewToHash } from '$lib/util/hash-router';

describe('parseHash', () => {
  test('handles merge-series route', () => {
    const result = parseHash('#/merge-series');
    expect(result).toEqual({ type: 'merge-series' });
  });

  test('routes libraries path to catalog while feature is hidden', () => {
    const result = parseHash('#/libraries');
    expect(result).toEqual({ type: 'catalog' });
  });

  test('handles upload route with query params', () => {
    const result = parseHash('#/upload?source=https%3A%2F%2Fexample.com&manga=Foo&volume=Bar');
    expect(result).toEqual({ type: 'upload' });
  });

  test('routes add-library path to catalog while feature is hidden', () => {
    const result = parseHash('#/add-library');
    expect(result).toEqual({ type: 'catalog' });
  });

  test('routes add-library path with params to catalog while feature is hidden', () => {
    const result = parseHash(
      '#/add-library?url=https%3A%2F%2Fexample.com%2Fdav&name=My+Library&path=%2Fmanga'
    );
    expect(result).toEqual({ type: 'catalog' });
  });
});

describe('viewToHash', () => {
  test('generates merge-series hash', () => {
    const result = viewToHash({ type: 'merge-series' });
    expect(result).toBe('#/merge-series');
  });

  test('generates libraries hash', () => {
    const result = viewToHash({ type: 'libraries' });
    expect(result).toBe('#/libraries');
  });

  test('generates add-library hash with params', () => {
    const result = viewToHash({
      type: 'add-library',
      params: { url: 'https://example.com/dav', name: 'My Library' }
    });
    expect(result).toBe('#/add-library?url=https%3A%2F%2Fexample.com%2Fdav&name=My+Library');
  });
});

describe('nav helpers', () => {
  test('nav.toMergeSeries exists and is callable', () => {
    expect(typeof nav.toMergeSeries).toBe('function');
  });

  test('nav.toLibraries exists and is callable', () => {
    expect(typeof nav.toLibraries).toBe('function');
  });

  test('nav.toAddLibrary exists and is callable', () => {
    expect(typeof nav.toAddLibrary).toBe('function');
  });
});
