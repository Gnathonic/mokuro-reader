/**
 * What the settings section draws a quick-menu glyph FOR (#55, owner review:
 * "the icons you see are not the icons you get").
 *
 * Two entries draw differently in different books — Next page and Previous
 * page point where the page goes, and "Add image to Anki" is numbered only
 * while two pages are on screen (`menuGlyph`, `quick-menu.ts`). While the
 * reader is open it provides the context its own menu is drawn with, so the
 * section, opened over the reader, shows exactly the buttons the menu has.
 * Elsewhere the section draws them for the profile's defaults: a new
 * volume's reading direction, the profile's layout and page view.
 */
import { derived, readable, writable, type Readable } from 'svelte/store';
import { settings, type Settings } from '#lib/settings/settings.js';
import type { MenuGlyphContext } from './quick-menu';

const fromReader = writable<MenuGlyphContext | null>(null);

/**
 * The reader's own context, or null when it unmounts. Writes only on a
 * change, so a page turn that changes nothing costs the section nothing.
 */
export function provideMenuGlyphContext(ctx: MenuGlyphContext | null): void {
  fromReader.update((prev) =>
    prev === ctx ||
    (prev && ctx && prev.forward === ctx.forward && prev.hasSecondPage === ctx.hasSecondPage)
      ? prev
      : ctx
  );
}

/** The context for the profile's defaults, outside the reader. */
export function defaultMenuGlyphContext(
  s: Pick<Settings, 'continuousScroll' | 'scrollMode' | 'singlePageView' | 'volumeDefaults'>,
  landscape: boolean
): MenuGlyphContext {
  const scroll = s.scrollMode === 'auto' ? (landscape ? 'horizontal' : 'vertical') : s.scrollMode;
  const vertical = s.continuousScroll && scroll === 'vertical';
  const rtl = s.volumeDefaults?.rightToLeft ?? true;
  return {
    forward: vertical ? 'down' : rtl ? 'left' : 'right',
    hasSecondPage:
      !s.continuousScroll &&
      (s.singlePageView === 'dual' || (s.singlePageView === 'auto' && landscape))
  };
}

function isLandscape(): boolean {
  return typeof window !== 'undefined' && window.innerWidth > window.innerHeight;
}

/**
 * Whether the window is landscape, kept current: a resize or an orientation
 * change updates it (a `matchMedia` listener, one flip per orientation change
 * rather than per resize event). Without `matchMedia` it is read once.
 */
export const landscape: Readable<boolean> = readable(isLandscape(), (set) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  const mq = window.matchMedia('(orientation: landscape)');
  const update = () => set(isLandscape());
  update();
  mq.addEventListener?.('change', update);
  window.addEventListener('orientationchange', update);
  window.addEventListener('resize', update);
  return () => {
    mq.removeEventListener?.('change', update);
    window.removeEventListener('orientationchange', update);
    window.removeEventListener('resize', update);
  };
});

/** The context the section draws glyphs with: the open reader's, else the defaults'. */
export const menuGlyphContext: Readable<MenuGlyphContext> = derived(
  [fromReader, settings, landscape],
  ([reader, s, land]) => reader ?? defaultMenuGlyphContext(s, land)
);
