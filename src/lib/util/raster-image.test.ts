import { describe, expect, it } from 'vitest';
import { IMAGE_MIME_TYPES } from '$lib/import/types';
import {
  RASTER_FORMAT_NAMES,
  RASTER_IMAGE_TYPES,
  displayableCoverBlob,
  displayableImageBlob,
  isRasterImageType,
  rasterOrNull,
  rasterTypeForName,
  sniffRasterBlob,
  sniffRasterImageType,
  toRasterImageFile
} from './raster-image';

const enc = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? enc(p) : p)));
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u32le = (n: number) => u32be(n).reverse();

/** An ISO BMFF `ftyp` box: size, 'ftyp', major brand, minor version, compatible brands. */
const ftyp = (major: string, compatible: string[]) =>
  bytes(u32be(16 + 4 * compatible.length), 'ftyp', major, [0, 0, 0, 0], compatible.join(''));

const RASTER_SAMPLES: Array<[string, Uint8Array<ArrayBuffer>, string]> = [
  ['JPEG (JFIF)', bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10], 'JFIF'), 'image/jpeg'],
  ['JPEG (Exif)', bytes([0xff, 0xd8, 0xff, 0xe1]), 'image/jpeg'],
  ['PNG', bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 'IHDR'), 'image/png'],
  ['GIF87a', bytes('GIF87a', [1, 0, 1, 0]), 'image/gif'],
  ['GIF89a', bytes('GIF89a', [1, 0, 1, 0]), 'image/gif'],
  ['WebP (lossy)', bytes('RIFF', u32le(100), 'WEBPVP8 '), 'image/webp'],
  ['WebP (lossless)', bytes('RIFF', u32le(100), 'WEBPVP8L'), 'image/webp'],
  ['AVIF (major brand)', ftyp('avif', ['mif1', 'miaf']), 'image/avif'],
  ['AVIF sequence', ftyp('avis', ['msf1']), 'image/avif'],
  ['AVIF (compatible brand)', ftyp('mif1', ['miaf', 'avif']), 'image/avif'],
  [
    'BMP (BITMAPINFOHEADER)',
    bytes('BM', u32le(1000), [0, 0, 0, 0], u32le(54), u32le(40)),
    'image/bmp'
  ],
  ['BMP (V5)', bytes('BM', u32le(1000), [0, 0, 0, 0], u32le(138), u32le(124)), 'image/bmp'],
  ['TIFF (little-endian)', bytes('II', [0x2a, 0], u32le(8)), 'image/tiff'],
  ['TIFF (big-endian)', bytes('MM', [0, 0x2a], u32be(8)), 'image/tiff'],
  ['JPEG XL codestream', bytes([0xff, 0x0a, 0xfa]), 'image/jxl'],
  [
    'JPEG XL container',
    bytes([0, 0, 0, 0x0c], 'JXL ', [0x0d, 0x0a, 0x87, 0x0a], u32be(20), 'ftypjxl '),
    'image/jxl'
  ]
];

const SVG_SCRIPT =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>';

const NON_RASTER_SAMPLES: Array<[string, Uint8Array<ArrayBuffer>]> = [
  ['SVG', bytes(SVG_SCRIPT)],
  ['SVG with an XML prolog', bytes(`<?xml version="1.0" encoding="UTF-8"?>\n${SVG_SCRIPT}`)],
  ['SVG with a doctype', bytes(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">${SVG_SCRIPT}`)],
  ['SVG behind a UTF-8 BOM', bytes([0xef, 0xbb, 0xbf], SVG_SCRIPT)],
  ['SVG behind whitespace', bytes(`  \n\t${SVG_SCRIPT}`)],
  [
    'SVG in UTF-16',
    new Uint8Array(new Uint16Array(Array.from('﻿<svg>', (c) => c.charCodeAt(0))).buffer)
  ],
  ['HTML', bytes('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>')],
  ['bare HTML', bytes('<html><script>alert(1)</script>')],
  ['a script tag', bytes('<script>alert(1)</script>')],
  ['XML', bytes('<?xml version="1.0"?><root/>')],
  ['JSON', bytes('{"version":"0.2.1"}')],
  ['plain text', bytes('hello world')],
  ['empty', new Uint8Array(0)],
  // Truncated headers: a prefix of a signature is not that format.
  ['JPEG cut after two bytes', bytes([0xff, 0xd8])],
  ['PNG cut after four bytes', bytes([0x89], 'PNG')],
  ['PNG with a wrong byte', bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0b])],
  ['GIF without its version', bytes('GIF8')],
  ['RIFF alone', bytes('RIFF')],
  ['RIFF cut before the form type', bytes('RIFF', u32le(100), 'WEB')],
  ['RIFF that is not WebP (WAV)', bytes('RIFF', u32le(100), 'WAVEfmt ')],
  ['BMP cut before its DIB header', bytes('BM', u32le(1000))],
  ['TIFF cut after the byte order', bytes('II')],
  ['JPEG XL container cut short', bytes([0, 0, 0, 0x0c], 'JXL ')],
  // Lookalikes.
  ['ftyp that is HEIC, not AVIF', ftyp('heic', ['mif1', 'heic'])],
  ['ftyp that is MP4', ftyp('isom', ['iso2', 'mp41'])],
  ["'BM' starting a markup polyglot", bytes('BM<svg onload="alert(1)">')],
  ['ftyp brand past the box end', bytes(u32be(16), 'ftyp', 'mif1', [0, 0, 0, 0], 'avif')]
];

describe('sniffRasterImageType', () => {
  for (const [name, sample, type] of RASTER_SAMPLES) {
    it(`recognises ${name}`, () => {
      expect(sniffRasterImageType(sample)).toBe(type);
    });
  }

  for (const [name, sample] of NON_RASTER_SAMPLES) {
    it(`refuses ${name}`, () => {
      expect(sniffRasterImageType(sample)).toBeNull();
    });
  }

  // The type is all a blob: URL's document behaviour depends on. A file that
  // starts as a raster format is labelled as one, and no raster label ever
  // runs as a document, whatever bytes follow.
  it('labels a raster-headed polyglot by its header', () => {
    expect(sniffRasterImageType(bytes('GIF89a', SVG_SCRIPT))).toBe('image/gif');
    expect(sniffRasterImageType(bytes([0xff, 0xd8, 0xff], '<html><script>'))).toBe('image/jpeg');
  });
});

describe('the accepted formats', () => {
  it('are exactly the import allowlist (IMAGE_MIME_TYPES)', () => {
    expect(new Set(Object.values(IMAGE_MIME_TYPES))).toEqual(new Set(RASTER_IMAGE_TYPES));
  });

  it('never include SVG', () => {
    expect(RASTER_IMAGE_TYPES.some((t) => t.includes('svg'))).toBe(false);
  });
});

describe('isRasterImageType', () => {
  it('takes the raster types, in any case and with parameters', () => {
    for (const type of [...RASTER_IMAGE_TYPES, 'IMAGE/PNG', 'image/jpeg; q=1']) {
      expect(isRasterImageType(type), type).toBe(true);
    }
  });

  it('refuses SVG, markup, an unknown and an empty type', () => {
    for (const type of [
      'image/svg+xml',
      'IMAGE/SVG+XML',
      'text/html',
      'application/xhtml+xml',
      'text/xml',
      'application/octet-stream',
      'image/x-icon',
      'image/heic',
      '',
      null,
      undefined
    ]) {
      expect(isRasterImageType(type), String(type)).toBe(false);
    }
  });
});

describe('rasterTypeForName', () => {
  it('names the raster type of an allowlisted extension', () => {
    expect(rasterTypeForName('a/b/p001.JPG')).toBe('image/jpeg');
    expect(rasterTypeForName('scan.tif')).toBe('image/tiff');
    expect(rasterTypeForName('Vol 1.5.webp')).toBe('image/webp');
  });

  it('names nothing for SVG, no extension, or anything else', () => {
    for (const name of ['cover.svg', 'cover', 'index.html', '', null, undefined]) {
      expect(rasterTypeForName(name), String(name)).toBeNull();
    }
  });

  it('names nothing for an extension that is an Object.prototype key', () => {
    for (const name of ['p.constructor', 'p.toString', 'p.valueOf', 'p.__proto__']) {
      expect(rasterTypeForName(name), name).toBeNull();
    }
  });

  it('reads a file name as a file name, not a URL', () => {
    expect(rasterTypeForName('p#01.jpg')).toBe('image/jpeg');
    expect(rasterTypeForName('what?.png')).toBe('image/png');
  });
});

describe('displayableImageBlob and an odd extension', () => {
  it('shows an untyped page whose name ends in an Object.prototype key, as PNG', () => {
    const page = new File(['x'], '001.constructor');
    expect(displayableImageBlob(page).type).toBe('image/png');
  });
});

describe('RASTER_FORMAT_NAMES', () => {
  it('names one format per accepted type', () => {
    const names = RASTER_FORMAT_NAMES.replace(' or ', ', ').split(', ');
    expect(names).toHaveLength(RASTER_IMAGE_TYPES.length);
  });
});

describe('sniffRasterBlob / toRasterImageFile', () => {
  const PNG = RASTER_SAMPLES.find(([n]) => n === 'PNG')![1];

  it('reads only the leading bytes of a Blob', async () => {
    const big = new Blob([PNG, new Uint8Array(1 << 20)]);
    expect(await sniffRasterBlob(big)).toBe('image/png');
  });

  it('types a File by its bytes, never by its type or name', async () => {
    const file = await toRasterImageFile(
      new File([PNG], 'cover.svg', { type: 'image/svg+xml', lastModified: 42 }),
      'cover.svg'
    );
    expect(file?.type).toBe('image/png');
    expect(file?.name).toBe('cover.svg');
    expect(file?.lastModified).toBe(42);
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(PNG);
  });

  it('renames the extension to the sniffed type when asked', async () => {
    const file = await toRasterImageFile(new Blob([PNG]), 'Vol 1.5.webp', {
      renameExtension: true
    });
    expect(file?.name).toBe('Vol 1.5.png');
  });

  it('refuses SVG and HTML however they are typed or named', async () => {
    for (const [type, name] of [
      ['image/svg+xml', 'c.svg'],
      ['image/png', 'c.png'],
      ['', 'c.jpg'],
      ['text/html', 'c.webp']
    ]) {
      expect(await toRasterImageFile(new File([SVG_SCRIPT], name, { type }), name)).toBeNull();
    }
    expect(await toRasterImageFile(new Blob(['<html>']), 'c.png')).toBeNull();
  });

  it('hands back the same File when its type and name are already right', async () => {
    const file = new File([PNG], 'p.png', { type: 'image/png' });
    expect(await toRasterImageFile(file, 'p.png')).toBe(file);
  });
});

describe('rasterOrNull', () => {
  it('passes a raster-typed Blob and nothing else', () => {
    const png = new File(['x'], 'c.png', { type: 'image/png' });
    expect(rasterOrNull(png)).toBe(png);
    expect(rasterOrNull(new File(['x'], 'c.svg', { type: 'image/svg+xml' }))).toBeNull();
    expect(rasterOrNull(new File(['x'], 'c.png'))).toBeNull();
    expect(rasterOrNull(undefined)).toBeNull();
  });
});

describe('displayableCoverBlob', () => {
  it('keeps a raster-typed cover as it is', () => {
    const webp = new File(['x'], 'c.webp', { type: 'image/webp' });
    expect(displayableCoverBlob(webp)).toBe(webp);
  });

  // Earlier builds stored archive thumbnail sidecars untyped. They are shown
  // under an inert raster label until `processThumbnails` re-types them.
  it('shows an untyped cover under a raster label, by name or else PNG, without losing bytes', async () => {
    const cases: Array<[Blob, string]> = [
      [new File(['bytes'], 'Vol 1.webp'), 'image/webp'],
      [new File(['bytes'], 'cover.jpg'), 'image/jpeg'],
      [new File(['<svg/>'], 'c.svg'), 'image/png'],
      [new Blob(['<html>']), 'image/png']
    ];
    for (const [blob, type] of cases) {
      const shown = displayableCoverBlob(blob)!;
      expect(shown.type).toBe(type);
      expect(shown.size).toBe(blob.size);
      expect(await shown.text()).toBe(await blob.text());
    }
  });

  it('never shows a cover with an explicit non-raster type', () => {
    for (const type of ['image/svg+xml', 'text/html', 'application/xml', 'text/plain']) {
      expect(displayableCoverBlob(new File(['<svg/>'], 'c.webp', { type })), type).toBeNull();
    }
  });

  it('shows nothing without a cover', () => {
    expect(displayableCoverBlob(undefined)).toBeNull();
    expect(displayableCoverBlob(null)).toBeNull();
  });
});

describe('displayableImageBlob', () => {
  it('keeps a raster-typed Blob as it is', () => {
    const webp = new File(['x'], 'p.webp', { type: 'image/webp' });
    expect(displayableImageBlob(webp)).toBe(webp);
  });

  it('relabels anything else as a raster type, by name or else PNG, without losing bytes', async () => {
    const cases: Array<[Blob, string]> = [
      [new File(['<html>'], 'p001.jpg'), 'image/jpeg'],
      [new File(['<svg/>'], 'p002.gif', { type: 'image/svg+xml' }), 'image/gif'],
      [new File(['<svg/>'], 'p003.svg', { type: 'image/svg+xml' }), 'image/png'],
      [new Blob(['<html>'], { type: 'text/html' }), 'image/png']
    ];
    for (const [blob, type] of cases) {
      const shown = displayableImageBlob(blob);
      expect(shown.type).toBe(type);
      expect(shown.size).toBe(blob.size);
      expect(await shown.text()).toBe(await blob.text());
    }
  });
});
