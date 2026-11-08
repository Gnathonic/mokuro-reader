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
 *
 * The adjustment can be switched off without losing the values (#362):
 * `pageAdjustEnabled` in the profile, the `B` key in the reader. Covers and
 * colour pages are usually fine as they are, and distort under a setting made
 * for a washed-out scan.
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

/**
 * A stored on/off switch, sanitised: only an explicit `false` turns the
 * adjustment off. A profile that predates the switch, or carries garbage,
 * keeps the adjustment it had.
 */
export function sanitizePageAdjustEnabled(value: unknown): boolean {
  return value !== false;
}

/**
 * The CSS `filter` for a page image — `none` when both are at 100%, or when
 * the adjustment is switched off (the values are kept, just not applied).
 */
export function pageFilterCss(
  brightness: unknown,
  contrast: unknown,
  enabled: unknown = true
): string {
  if (!sanitizePageAdjustEnabled(enabled)) return 'none';
  const b = clampPageAdjust(brightness);
  const c = clampPageAdjust(contrast);
  if (b === PAGE_ADJUST_DEFAULT && c === PAGE_ADJUST_DEFAULT) return 'none';
  return `brightness(${b}%) contrast(${c}%)`;
}
