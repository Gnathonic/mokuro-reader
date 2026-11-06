/**
 * Raster images only. SVG is an unsupported format.
 *
 * Every image that becomes a Blob in this app (page images, covers,
 * thumbnails) is eventually handed to `URL.createObjectURL`. A blob: URL
 * belongs to the app's origin and is served with the Blob's own `type`. So an
 * `image/svg+xml` or `text/html` Blob, or an untyped one whose bytes the
 * browser sniffs as HTML, runs its script as the app when the user picks
 * "Open image in new tab". That script can read every stored token.
 *
 * The rule is that a stored image Blob's type comes ONLY from its magic
 * bytes, and only when those bytes are one of the raster formats below. A
 * remote `Content-Type` and a file extension never decide it. Bytes that are
 * not raster (SVG, HTML, XML, anything unknown) are refused, never stored.
 *
 * Accepted formats: the values of `IMAGE_MIME_TYPES` (`$lib/import/types`),
 * the import allowlist. A test keeps the two sets equal.
 */

import { IMAGE_EXTENSIONS, IMAGE_MIME_TYPES } from '$lib/import/types';

export const RASTER_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
  'image/tiff',
  'image/jxl'
] as const;

export type RasterImageType = (typeof RASTER_IMAGE_TYPES)[number];

/** The accepted formats, as a user-facing list for "not supported" messages. */
export const RASTER_FORMAT_NAMES = 'JPEG, PNG, WebP, GIF, AVIF, BMP, TIFF or JPEG XL';

const RASTER_TYPE_SET: ReadonlySet<string> = new Set(RASTER_IMAGE_TYPES);

/** The file extension a sniffed type is stored under. */
const EXTENSION_FOR_TYPE: Record<RasterImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
  'image/jxl': 'jxl'
};

/**
 * How many leading bytes {@link sniffRasterImageType} looks at. An AVIF `ftyp`
 * box lists its compatible brands within this span in practice.
 */
export const RASTER_SNIFF_BYTES = 64;

/** BMP DIB header sizes: CORE, OS/2 short, INFO, V2, V3, OS/2 2, V4, V5. */
const BMP_DIB_HEADER_SIZES = new Set([12, 16, 40, 52, 56, 64, 108, 124]);

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function ascii(text: string): number[] {
  return Array.from(text, (ch) => ch.charCodeAt(0));
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

const AVIF_BRANDS = [ascii('avif'), ascii('avis')];

function isAvif(bytes: Uint8Array): boolean {
  // ISO BMFF: [u32 box size]['ftyp'][major brand][u32 minor][compatible brands...]
  if (!startsWith(bytes, ascii('ftyp'), 4) || bytes.length < 12) return false;
  if (AVIF_BRANDS.some((brand) => startsWith(bytes, brand, 8))) return true;
  const boxEnd = Math.min(readU32BE(bytes, 0), bytes.length);
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    if (AVIF_BRANDS.some((brand) => startsWith(bytes, brand, offset))) return true;
  }
  return false;
}

/**
 * The raster format these leading bytes are, or null when they are none of
 * the accepted ones (SVG, HTML, XML, text, a truncated header, anything else).
 * A byte string that STARTS as a raster format is that format, whatever
 * follows: the type only decides how the browser treats the Blob, and no
 * raster type is ever run as a document.
 */
export function sniffRasterImageType(bytes: Uint8Array): RasterImageType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) {
    return 'image/gif';
  }
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) {
    return 'image/webp';
  }
  if (isAvif(bytes)) return 'image/avif';
  if (
    startsWith(bytes, ascii('BM')) &&
    bytes.length >= 18 &&
    BMP_DIB_HEADER_SIZES.has(readU32LE(bytes, 14))
  ) {
    return 'image/bmp';
  }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'image/tiff';
  }
  // JPEG XL: a bare codestream, or the ISO BMFF container.
  if (
    startsWith(bytes, [0xff, 0x0a]) ||
    startsWith(bytes, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])
  ) {
    return 'image/jxl';
  }
  return null;
}

/** The media type's essence (`image/png; q=1` → `image/png`), lowercased. */
function essence(type: string | null | undefined): string {
  return (type ?? '').split(';')[0].trim().toLowerCase();
}

/** Is this one of the accepted raster media types? Never true for SVG or an empty type. */
export function isRasterImageType(type: string | null | undefined): type is RasterImageType {
  return RASTER_TYPE_SET.has(essence(type));
}

/**
 * The raster type a file name's extension names, or null (`.svg`, no
 * extension, …). A file name, not a URL: `p#01.jpg` is a `.jpg`.
 */
export function rasterTypeForName(name: string | null | undefined): RasterImageType | null {
  const base = name ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  // `IMAGE_MIME_TYPES` is a plain object: `constructor` would index a function.
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  const type = IMAGE_MIME_TYPES[ext];
  return isRasterImageType(type) ? (essence(type) as RasterImageType) : null;
}

/** The extension {@link toRasterImageFile} names a file of this type with. */
export function extensionForRasterType(type: RasterImageType): string {
  return EXTENSION_FOR_TYPE[type];
}

async function readHead(blob: Blob, length: number): Promise<Uint8Array> {
  const head = blob.slice(0, length);
  if (typeof head.arrayBuffer === 'function') {
    return new Uint8Array(await head.arrayBuffer());
  }
  // jsdom's Blob predates `arrayBuffer()` in some versions.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(head);
  });
}

/** {@link sniffRasterImageType} over a Blob's leading bytes. Reads at most {@link RASTER_SNIFF_BYTES}. */
export async function sniffRasterBlob(blob: Blob): Promise<RasterImageType | null> {
  return sniffRasterImageType(await readHead(blob, RASTER_SNIFF_BYTES));
}

export interface ToRasterFileOptions {
  /**
   * Replace the name's extension with the sniffed type's (`cover.svg` holding
   * PNG bytes → `cover.png`). Off by default: page names are keys the OCR
   * matches on and must stay as they are.
   */
  renameExtension?: boolean;
  lastModified?: number;
}

/**
 * The same bytes as a File whose type is the one its magic bytes name, or
 * null when they are not an accepted raster format. The bytes are not copied.
 */
export async function toRasterImageFile(
  blob: Blob,
  name: string,
  options: ToRasterFileOptions = {}
): Promise<File | null> {
  const type = await sniffRasterBlob(blob);
  if (!type) return null;
  let fileName = name;
  if (options.renameExtension) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    fileName = `${stem}.${EXTENSION_FOR_TYPE[type]}`;
  }
  if (blob instanceof File && blob.type === type && blob.name === fileName) return blob;
  const lastModified =
    options.lastModified ?? (blob instanceof File ? blob.lastModified : undefined);
  return new File([blob], fileName, {
    type,
    ...(lastModified !== undefined ? { lastModified } : {})
  });
}

/**
 * A stored cover or thumbnail, only when its type is an accepted raster type;
 * null otherwise. For data written before this rule: an `image/svg+xml` (or
 * untyped) thumbnail is never shown. `processThumbnails` re-types it from its
 * bytes or replaces it. Display surfaces use {@link displayableCoverBlob}.
 */
export function rasterOrNull<T extends Blob>(blob: T | null | undefined): T | null {
  return blob && isRasterImageType(blob.type) ? blob : null;
}

/**
 * The Blob to make an object URL of for a page image. A page is shown even
 * when its stored type is not a raster one (pages imported before this rule
 * were stored untyped): it is relabelled, without copying, as the raster type
 * its name says, else as PNG. A raster label is inert as a document, so
 * "Open image in new tab" can never run it, and `<img>` and CSS decode raster
 * bytes by their content whatever the label says.
 */
export function displayableImageBlob(blob: Blob): Blob {
  if (isRasterImageType(blob.type)) return blob;
  const type = (blob instanceof File ? rasterTypeForName(blob.name) : null) ?? 'image/png';
  return blob.slice(0, blob.size, type);
}

/**
 * The Blob to show (or send to Anki) for a stored cover or thumbnail, or null.
 * A raster-typed cover is shown as it is. An UNTYPED one is shown under a
 * raster label, like an untyped page ({@link displayableImageBlob}): earlier
 * builds stored archive thumbnail sidecars untyped, and they would otherwise
 * vanish until `processThumbnails` re-types them. Any explicit non-raster
 * type (`image/svg+xml`, `text/html`, …) is never shown.
 */
export function displayableCoverBlob(blob: Blob | null | undefined): Blob | null {
  if (!blob) return null;
  if (isRasterImageType(blob.type)) return blob;
  return essence(blob.type) === '' ? displayableImageBlob(blob) : null;
}
