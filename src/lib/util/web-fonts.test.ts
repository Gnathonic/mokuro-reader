import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseFontFaceCss } from './web-fonts';

const CSS = `/* [0] */
@font-face {
  font-family: 'Noto Sans JP';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/notosansjp/v56/a.0.woff2) format('woff2');
  unicode-range: U+25ee8, U+26017-26019;
}
/* [1] */
@font-face {
  font-family: 'Noto Sans JP';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/notosansjp/v56/b.1.woff2) format('woff2');
  unicode-range: U+3000-303f;
}`;

describe('parseFontFaceCss', () => {
  it('reads every face with its source and descriptors', () => {
    expect(parseFontFaceCss(CSS)).toEqual([
      {
        family: 'Noto Sans JP',
        source: "url(https://fonts.gstatic.com/s/notosansjp/v56/a.0.woff2) format('woff2')",
        descriptors: {
          style: 'normal',
          weight: '400',
          unicodeRange: 'U+25ee8, U+26017-26019',
          display: 'swap'
        }
      },
      {
        family: 'Noto Sans JP',
        source: "url(https://fonts.gstatic.com/s/notosansjp/v56/b.1.woff2) format('woff2')",
        descriptors: {
          style: 'normal',
          weight: '700',
          unicodeRange: 'U+3000-303f',
          display: 'swap'
        }
      }
    ]);
  });

  it('skips a rule without a family or a source', () => {
    expect(parseFontFaceCss('@font-face { font-weight: 400; }')).toEqual([]);
  });
});

describe('loadWebFonts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    document.head.innerHTML = '';
  });

  it('adds one FontFace per rule and no stylesheet', async () => {
    const added: unknown[] = [];
    vi.stubGlobal('fetch', async () => new Response(CSS));
    vi.stubGlobal(
      'FontFace',
      class {
        constructor(
          public family: string,
          public source: string,
          public descriptors: FontFaceDescriptors
        ) {}
      }
    );
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { add: (f: unknown) => added.push(f) }
    });
    const { loadWebFonts } = await import('./web-fonts');
    await loadWebFonts('https://fonts.example/css');
    expect(added).toHaveLength(2);
    expect(document.querySelector('link[rel="stylesheet"]')).toBeNull();
  });

  it('falls back to the stylesheet when the CSS cannot be fetched', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    vi.stubGlobal('FontFace', class {});
    Object.defineProperty(document, 'fonts', { configurable: true, value: { add: () => {} } });
    const { loadWebFonts } = await import('./web-fonts');
    await loadWebFonts('https://fonts.example/css');
    expect(document.querySelector('link[href="https://fonts.example/css"]')).not.toBeNull();
  });
});
