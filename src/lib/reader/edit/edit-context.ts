import type { Page } from '$lib/types';

/** Screen px per image px for a page element (zoom-aware). 1 when unmeasurable (jsdom). */
export function pageScaleOf(el: HTMLElement | null | undefined, page: Page): number {
  if (!el || !page.img_width) return 1;
  const w = el.getBoundingClientRect().width;
  return w > 0 ? w / page.img_width : 1;
}
