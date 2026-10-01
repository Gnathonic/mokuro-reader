import { describe, expect, it } from 'vitest';
import { bunkoPathPrefix, resolveBunkoLink } from './bunko-links';

describe('bunkoPathPrefix', () => {
  it('is empty for a server mounted at the root', () => {
    expect(bunkoPathPrefix('https://example.com/mokuro-reader/S/V.cbz')).toBe('');
    expect(bunkoPathPrefix('https://example.com/catalog/api/manifest?series=S')).toBe('');
    expect(bunkoPathPrefix('https://example.com/')).toBe('');
  });

  it('is whatever precedes the first bunko route', () => {
    expect(bunkoPathPrefix('https://example.com/manga/mokuro-reader/S/V.cbz')).toBe('/manga');
    expect(bunkoPathPrefix('https://example.com/a/b/catalog/api/manifest?x=1')).toBe('/a/b');
    expect(bunkoPathPrefix('https://example.com/manga/mokuro-reader/.mokuro-queue.json')).toBe(
      '/manga'
    );
    expect(bunkoPathPrefix('https://example.com/manga/login/api/token')).toBe('/manga');
  });

  it('matches whole path segments only, and the first one', () => {
    expect(bunkoPathPrefix('https://example.com/catalogue/mokuro-reader/x')).toBe('/catalogue');
    // A series that happens to be called "catalog" does not move the cut.
    expect(bunkoPathPrefix('https://example.com/m/mokuro-reader/catalog/V.cbz')).toBe('/m');
    expect(bunkoPathPrefix('not a url')).toBe('');
  });
});

describe('resolveBunkoLink', () => {
  it('leaves every link alone for a root-mounted server', () => {
    expect(
      resolveBunkoLink(
        '/catalog/api/manifest?series=S',
        'https://example.com/mokuro-reader/S/V.cbz'
      )
    ).toBe('https://example.com/catalog/api/manifest?series=S');
  });

  it('puts a root-absolute link back under the prefix', () => {
    expect(
      resolveBunkoLink(
        '/catalog/api/manifest?series=S&volume=V',
        'https://example.com/manga/mokuro-reader/S/V.cbz'
      )
    ).toBe('https://example.com/manga/catalog/api/manifest?series=S&volume=V');
    expect(
      resolveBunkoLink(
        '/mokuro-reader/S/V.mokuro',
        'https://example.com/manga/catalog/api/manifest?series=S&volume=V'
      )
    ).toBe('https://example.com/manga/mokuro-reader/S/V.mokuro');
  });

  it('does not double a prefix a proxy-aware server already sent, nor touch other links', () => {
    const base = 'https://example.com/manga/mokuro-reader/.mokuro-queue.json';
    expect(resolveBunkoLink('/manga/catalog/api/manifest', base)).toBe(
      'https://example.com/manga/catalog/api/manifest'
    );
    expect(resolveBunkoLink('https://cdn.example.org/x.mokuro', base)).toBe(
      'https://cdn.example.org/x.mokuro'
    );
    expect(resolveBunkoLink('S/V.cbz', base)).toBe(
      'https://example.com/manga/mokuro-reader/S/V.cbz'
    );
    expect(resolveBunkoLink('//other.example/x', base)).toBe('https://other.example/x');
  });
});
