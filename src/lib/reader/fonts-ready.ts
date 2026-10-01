import { readable } from 'svelte/store';
import { webFontsRegistered } from '$lib/util/web-fonts';

/**
 * `document.fonts.ready`, read at most once per animation frame, and only
 * after the web font's faces are registered.
 *
 * Chrome's `FontFaceSet.ready` getter brings style and layout up to date
 * before it answers (it has to know whether any font is still pending), so
 * every read is a forced document layout. The text-box measuring action runs
 * once per OCR block, and reading the getter per block made a mount
 * O(blocks²): 7 s of a 7.3 s continuous-mode layer swap was this getter.
 *
 * Callers in the same frame share one promise. The cache is dropped on the
 * next frame, so a block mounted later still waits for a font that started
 * loading after the first read.
 *
 * The faces are added by script (`web-fonts.ts`), after an async fetch: before
 * that, `ready` would resolve at once with nothing loaded, so wait for them.
 */
let cached: Promise<unknown> | null = null;

export function fontsReady(): Promise<unknown> {
  if (cached) return cached;
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  cached = fonts ? webFontsRegistered().then(() => fonts.ready) : Promise.resolve();
  const clear = () => {
    cached = null;
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(clear);
  else setTimeout(clear, 0);
  return cached;
}

let epoch = 0;

/** The current {@link fontLoadEpoch} value, for non-reactive callers. */
export function currentFontLoadEpoch(): number {
  return epoch;
}

/**
 * Bumps every time the document finishes loading fonts (`loadingdone`).
 *
 * The OCR font arrives in subsets as text needs them, so a glyph measured
 * before its subset loaded was measured in the fallback font. Line layouts
 * (and the canvas measurer's memo) key on this to measure again.
 */
export const fontLoadEpoch = readable(epoch, (set) => {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts?.addEventListener) return;
  const onDone = () => set(++epoch);
  fonts.addEventListener('loadingdone', onDone);
  return () => fonts.removeEventListener('loadingdone', onDone);
});
