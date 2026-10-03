/**
 * Ink color for black-and-white pages (#256) — prints a monochrome page in
 * one coloured ink on faintly tinted paper, like the single-colour pages of a
 * phonebook-thick manga anthology (Nakayoshi and friends).
 *
 * Ported from Christopher Fritz's MIT-licensed "Mokuro Reader Page Colorizer"
 * userscript, greasyfork.org/scripts/581547. Same palette, same two blend
 * layers, same colour-page test, same "a different colour every 32 pages":
 *
 * - INK: a `screen` layer of the ink colour. Screen leaves white white and
 *   lifts black to the ink, so the blacks become the colour.
 * - PAPER: a `multiply` layer of the paper tint at 8% opacity — the whites
 *   take a trace of the same hue.
 * - Text boxes take the matching (darker) `text` colour.
 * - A page that is already in colour is left alone (`isMonochrome`).
 *
 * The userscript made each colour by filtering a red box
 * (`sepia(100%) saturate(600%|500%) hue-rotate(<rotation>) brightness(1.1)
 * contrast(0.8)`). The `ink`/`paper` values below are what Chrome paints for
 * exactly that, measured — so the layers here are plain colours: no filter
 * per page, and the same colour in every engine.
 */

export const INK_COLOR_NAMES = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'violet',
  'pink'
] as const;

export type InkColorName = (typeof INK_COLOR_NAMES)[number];
export type InkColorSetting = 'off' | 'auto' | InkColorName;

export const INK_COLOR_SETTINGS: readonly InkColorSetting[] = ['off', 'auto', ...INK_COLOR_NAMES];

export interface InkPaletteEntry {
  /** The userscript's `--rotation` (hue-rotate of the filtered red), for the record. */
  rotation: number;
  /** Screen layer: what black becomes. sepia(100%) saturate(600%) … */
  ink: string;
  /** Multiply layer at {@link PAPER_TINT_OPACITY}: the paper tint. saturate(500%) … */
  paper: string;
  /** The userscript's `--color`, for the page's OCR text. */
  text: string;
}

export const INK_PALETTE: Record<InkColorName, InkPaletteEntry> = {
  red: { rotation: 320, ink: '#c7524e', paper: '#bf5349', text: '#bf534c' },
  orange: { rotation: 350, ink: '#ac5f24', paper: '#a36022', text: '#9b5b20' },
  yellow: { rotation: 15, ink: '#886b19', paper: '#806c19', text: '#806c19' },
  green: { rotation: 50, ink: '#4e7d19', paper: '#497c19', text: '#497c19' },
  blue: { rotation: 190, ink: '#466dc4', paper: '#4c6ac0', text: '#4c6ac0' },
  violet: { rotation: 230, ink: '#8859c7', paper: '#8a57bf', text: '#8a57bf' },
  pink: { rotation: 290, ink: '#c94d80', paper: '#c44d78', text: '#c44d78' }
};

export const PAPER_TINT_OPACITY = 0.08;

/** Auto mode moves to the next colour every this many pages. */
export const AUTO_INK_BLOCK_PAGES = 32;

/** A stored setting, sanitised: anything unknown is 'off'. */
export function sanitizeInkColor(value: unknown): InkColorSetting {
  return typeof value === 'string' && (INK_COLOR_SETTINGS as readonly string[]).includes(value)
    ? (value as InkColorSetting)
    : 'off';
}

/**
 * Auto: each volume its own colour, the next colour every 32 pages. The
 * userscript hashed `document.title`; the volume uuid is the stable identity
 * here (the title changes with the title-language setting).
 */
export function autoInkColor(volumeUuid: string, pageIndex: number): InkColorName {
  let hash = 0;
  for (let i = 0; i < volumeUuid.length; i++) hash += volumeUuid.charCodeAt(i);
  const page = Number.isFinite(pageIndex) && pageIndex > 0 ? Math.floor(pageIndex) : 0;
  const block = Math.floor(page / AUTO_INK_BLOCK_PAGES);
  return INK_COLOR_NAMES[(hash + block) % INK_COLOR_NAMES.length];
}

/** The colour a (monochrome) page gets under a setting, or null for 'off'. */
export function inkColorFor(
  setting: InkColorSetting,
  volumeUuid: string,
  pageIndex: number | undefined
): InkColorName | null {
  if (setting === 'off') return null;
  if (setting === 'auto') return autoInkColor(volumeUuid, pageIndex ?? 0);
  return INK_PALETTE[setting] ? setting : null;
}

/** Pixels a channel pair may differ by and still count as grey (JPEG noise). */
export const INK_COLOR_TOLERANCE = 8;
/** A page with more than this share of coloured pixels is a colour page. */
export const INK_COLOR_THRESHOLD = 0.01;
/** The page is judged from a SAMPLE_SIZE × SAMPLE_SIZE downscale. */
export const INK_SAMPLE_SIZE = 100;

/**
 * Is this (downscaled) page black and white? Fully transparent pixels are
 * ignored; a pixel is coloured when any two of its channels differ by more
 * than `tolerance`; the page is monochrome when at most `threshold` of its
 * pixels are coloured.
 */
export function isMonochrome(
  imageData: { readonly data: ArrayLike<number> },
  tolerance = INK_COLOR_TOLERANCE,
  threshold = INK_COLOR_THRESHOLD
): boolean {
  const data = imageData.data;
  let colored = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    total++;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (Math.abs(r - g) > tolerance || Math.abs(g - b) > tolerance || Math.abs(r - b) > tolerance) {
      colored++;
    }
  }
  return total === 0 || colored / total <= threshold;
}

/**
 * Per page image, sampled once: does it get ink? Keyed by the image's Blob
 * (the File the page shows) — not by its object URL, which blob-urls.ts
 * revokes a few seconds after the last holder lets go and re-mints on the
 * next mount, so a URL key would re-sample a page every time continuous mode
 * scrolled it out and back. Decoding the Blob itself also can never taint a
 * canvas. A failure (decode error, no canvas) is a `false`: the page stays
 * uncoloured, and is not retried.
 */
const verdicts = new WeakMap<Blob, Promise<boolean>>();
/** The same verdicts once settled — readable synchronously, at mount. */
const settled = new WeakMap<Blob, boolean>();

export function pageNeedsInk(image: Blob): Promise<boolean> {
  let verdict = verdicts.get(image);
  if (!verdict) {
    verdict = sampleIsMonochrome(image)
      .catch(() => false)
      .then((ink) => {
        settled.set(image, ink);
        return ink;
      });
    verdicts.set(image, verdict);
  }
  return verdict;
}

/**
 * The verdict for an image if it has already settled, else undefined. A page
 * whose verdict was computed ahead (see {@link prefetchPageInk}) mounts
 * already inked — no frame of it is ever painted without its ink.
 */
export function peekPageInk(image: Blob): boolean | undefined {
  return settled.get(image);
}

/**
 * Sample ahead: the pages around `center` (the page being read), nearest
 * first, so a page's verdict has usually settled before it mounts — a page
 * turn, a spread's second page, continuous scroll into the next pages. Each
 * call REPLACES the queue (the reader moved on; pages it left behind are not
 * worth sampling any more); samples already running finish. At most
 * {@link INK_PREFETCH_CONCURRENCY} run at once, so the prefetch never crowds
 * out a page that mounts and asks for its own verdict (that request does not
 * queue). The decode and downscale run off the main thread inside
 * createImageBitmap; the main thread only reads back 100×100 pixels.
 */
export const INK_PREFETCH_AHEAD = 8;
/**
 * A mounted page waits at most this long for its verdict before showing
 * uninked — a safety valve for a sample that never settles, not a budget:
 * measured samples take 13–47 ms for 1400×2000–2000×3000 JPEGs.
 */
export const INK_GATE_MAX_MS = 1500;
export const INK_PREFETCH_BEHIND = 4;
export const INK_PREFETCH_CONCURRENCY = 2;

let prefetchQueue: Blob[] = [];
let prefetchActive = 0;

export function prefetchPageInk(
  images: readonly (Blob | null | undefined)[],
  center: number,
  ahead = INK_PREFETCH_AHEAD,
  behind = INK_PREFETCH_BEHIND
): void {
  const order: Blob[] = [];
  const add = (i: number) => {
    const image = images[i];
    if (image && !verdicts.has(image) && !order.includes(image)) order.push(image);
  };
  const c = Math.max(0, Math.floor(Number.isFinite(center) ? center : 0));
  add(c);
  for (let k = 1; k <= Math.max(ahead, behind); k++) {
    if (k <= ahead) add(c + k);
    if (k <= behind) add(c - k);
  }
  prefetchQueue = order;
  pumpPrefetch();
}

/** Drop whatever is still queued (ink turned off, the reader closed). */
export function cancelInkPrefetch(): void {
  prefetchQueue = [];
}

function pumpPrefetch() {
  while (prefetchActive < INK_PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
    const image = prefetchQueue.shift()!;
    if (verdicts.has(image)) continue;
    prefetchActive++;
    pageNeedsInk(image).finally(() => {
      prefetchActive--;
      pumpPrefetch();
    });
  }
}

async function sampleIsMonochrome(image: Blob): Promise<boolean> {
  const size = INK_SAMPLE_SIZE;
  const bitmap = await createImageBitmap(image, {
    resizeWidth: size,
    resizeHeight: size,
    resizeQuality: 'low'
  });
  try {
    const canvas: OffscreenCanvas | HTMLCanvasElement =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(size, size)
        : Object.assign(document.createElement('canvas'), { width: size, height: size });
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0, size, size);
    return isMonochrome(ctx.getImageData(0, 0, size, size));
  } finally {
    bitmap.close();
  }
}
