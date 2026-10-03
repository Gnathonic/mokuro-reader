/**
 * The image URL of the manga page an element sits on (a text box, a line span).
 *
 * A page paints its image on its own `.pageImage` layer (MangaPage.svelte) —
 * a sibling of the text boxes, so the brightness/contrast filter (#256) can
 * reach the image without reaching the text. Walk up from the element: an
 * ancestor carrying the image as its own background still counts (older
 * markup), otherwise a page's `.pageImage` child does.
 */
export function pageImageUrlFrom(element: Element | null): string | null {
  let current: Element | null = element;
  while (current) {
    const own = backgroundUrl(current);
    if (own) return own;
    for (const child of current.children) {
      if (!child.classList.contains('pageImage')) continue;
      const layered = backgroundUrl(child);
      if (layered) return layered;
    }
    current = current.parentElement;
  }
  return null;
}

function backgroundUrl(element: Element): string | null {
  const bgImage = getComputedStyle(element).backgroundImage;
  if (!bgImage || bgImage === 'none') return null;
  const match = bgImage.match(/url\(["']?(.+?)["']?\)/);
  return match ? match[1] : null;
}
