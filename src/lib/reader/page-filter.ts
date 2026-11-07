/**
 * Page brightness / contrast (#256) — washed-out scans.
 *
 * The two settings are whole percentages; this turns them into the CSS
 * `filter` the reader puts on each page's IMAGE layer (`.pageImage` in
 * MangaPage.svelte), never on the OCR text boxes, the edit overlay or the UI.
 *
 * At 100/100 the result is `none`, not an identity filter: any filter value
 * other than `none` makes its element a stacking context and a compositing
 * candidate, and a reader with the defaults should pay nothing for a feature
 * it isn't using.
 */

export const PAGE_ADJUST_MIN = 50;
export const PAGE_ADJUST_MAX = 200;
export const PAGE_ADJUST_STEP = 5;
export const PAGE_ADJUST_DEFAULT = 100;

/** A stored percentage, sanitised: whole, in range, the default for anything non-numeric. */
export function clampPageAdjust(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PAGE_ADJUST_DEFAULT;
  return Math.min(PAGE_ADJUST_MAX, Math.max(PAGE_ADJUST_MIN, Math.round(value)));
}

/** The CSS `filter` for a page image — `none` when both are at 100%. */
export function pageFilterCss(brightness: unknown, contrast: unknown): string {
  const b = clampPageAdjust(brightness);
  const c = clampPageAdjust(contrast);
  if (b === PAGE_ADJUST_DEFAULT && c === PAGE_ADJUST_DEFAULT) return 'none';
  return `brightness(${b}%) contrast(${c}%)`;
}
