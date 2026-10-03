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

/**
 * The print effect's own controls (#256). They shape the effect only — on
 * black-and-white pages, inside the isolated `.pageArt` group — and never the
 * scan itself: page brightness/contrast stay the scan adjustment, applied to
 * every page before the effect. All three reach the page as reader-wide CSS
 * variables ({@link inkEffectVars}); the per-page colour mixing is CSS
 * `color-mix(in srgb, …)`, which is the same arithmetic as {@link mixHex}.
 */

/** Ink strength: −100 (faded, pastel) … 0 (the palette ink) … +100 (deep). */
export const INK_STRENGTH_MIN = -100;
export const INK_STRENGTH_MAX = 100;
export const INK_STRENGTH_DEFAULT = 0;
/** At −100 the ink is this far toward white: pale, still a visible tint. */
export const INK_FADE_MAX = 0.65;
/** At +100 the ink is this far toward black: heavy, but the hue survives. */
export const INK_DEEPEN_MAX = 0.75;

/** Paper tint: the multiply paper layer's opacity, %. 8 = the userscript's. */
export const PAPER_TINT_MIN = 0;
export const PAPER_TINT_MAX = 30;
export const PAPER_TINT_DEFAULT = 8;

/** Paper age: 0 (fresh) … 100 (old, dingy newsprint). */
export const PAPER_AGE_MIN = 0;
export const PAPER_AGE_MAX = 100;
export const PAPER_AGE_DEFAULT = 0;
/**
 * The aged paper at 100, as a multiply colour: a warm grey. Chosen by
 * rendering candidates over a real black-and-white page in every ink: the
 * lighter, yellower ones read as cream rather than old; darker ones muddy
 * the screentone. This one greys the white to ~75% and warms it, the ink
 * and the art underneath stay legible.
 */
export const PAPER_AGE_COLOR = '#c8bca4';

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampInkStrength(value: unknown): number {
  return clampInt(value, INK_STRENGTH_MIN, INK_STRENGTH_MAX, INK_STRENGTH_DEFAULT);
}

export function clampPaperTint(value: unknown): number {
  return clampInt(value, PAPER_TINT_MIN, PAPER_TINT_MAX, PAPER_TINT_DEFAULT);
}

export function clampPaperAge(value: unknown): number {
  return clampInt(value, PAPER_AGE_MIN, PAPER_AGE_MAX, PAPER_AGE_DEFAULT);
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: number[]): string {
  return '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}

/** `a` moved `t` (0…1) of the way to `b`, per sRGB channel — CSS color-mix(in srgb). */
export function mixHex(a: string, b: string, t: number): string {
  const ca = channels(a);
  const cb = channels(b);
  return toHex(ca.map((c, i) => c + (cb[i] - c) * t));
}

/** Where a strength moves the ink: toward white (fade) or black (deepen), and how far. */
export function inkStrengthMix(strength: unknown): { toward: string; amount: number } {
  const s = clampInkStrength(strength);
  return s <= 0
    ? { toward: '#ffffff', amount: (-s / 100) * INK_FADE_MAX }
    : { toward: '#000000', amount: (s / 100) * INK_DEEPEN_MAX };
}

/** The screen layer's colour: what black becomes on an inked page. */
export function inkLayerColor(inkHex: string, strength: unknown): string {
  const { toward, amount } = inkStrengthMix(strength);
  return mixHex(inkHex, toward, amount);
}

/** The age multiply colour: white (no change) at 0, {@link PAPER_AGE_COLOR} at 100. */
export function paperAgeColor(age: unknown): string {
  return mixHex('#ffffff', PAPER_AGE_COLOR, clampPaperAge(age) / 100);
}

/**
 * The paper multiply as one colour: the tinted paper at its opacity (a
 * multiply at opacity a is a multiply by white→paper mixed a), times the age.
 * The page renders it as two background layers of one pseudo-element.
 */
export function paperLayerColor(paperHex: string, tint: unknown, age: unknown): string {
  const tinted = channels(mixHex('#ffffff', paperHex, clampPaperTint(tint) / 100));
  const aged = channels(paperAgeColor(age));
  return toHex(tinted.map((c, i) => (c * aged[i]) / 255));
}

/**
 * The reader-wide CSS variables for the controls, set once on the reader
 * (like `--page-filter`) and read by every inked page's layers:
 * `--ink-mix-to` / `--ink-mix` (color-mix of the page's own ink),
 * `--paper-tint` (the paper's mix toward its tint), `--paper-age`.
 */
export function inkEffectVars(
  strength: unknown,
  tint: unknown,
  age: unknown
): { mixTo: string; mix: string; tint: string; age: string } {
  const { toward, amount } = inkStrengthMix(strength);
  return {
    mixTo: toward,
    mix: `${+(amount * 100).toFixed(4)}%`,
    tint: `${clampPaperTint(tint)}%`,
    age: paperAgeColor(age)
  };
}

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
