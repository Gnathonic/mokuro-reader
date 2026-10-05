/**
 * The image URL of the manga page an element sits on (a text box, a line span).
 *
 * A page paints its image on its own `.pageImage` layer (MangaPage.svelte) —
 * a sibling of the text boxes, so the brightness/contrast filter (#256) can
 * reach the image without reaching the text. Walk up from the element: an
 * ancestor carrying the image as its own background still counts (older
 * markup), otherwise a page's `.pageImage` layer does (a child, or a child of
 * its `.pageArt` wrapper).
 */
export function pageImageUrlFrom(element: Element | null): string | null {
  let current: Element | null = element;
  while (current) {
    const own = backgroundUrl(current);
    if (own) return own;
    // The page's own image layer — directly, or inside its `.pageArt`
    // wrapper (which also holds the ink color layers).
    const layered = imageLayerUrl(current);
    if (layered) return layered;
    current = current.parentElement;
  }
  return null;
}

function imageLayerUrl(page: Element): string | null {
  for (const child of page.children) {
    const layer = child.classList.contains('pageArt')
      ? Array.from(child.children).find((c) => c.classList.contains('pageImage'))
      : child.classList.contains('pageImage')
        ? child
        : undefined;
    const url = layer ? backgroundUrl(layer) : null;
    if (url) return url;
  }
  return null;
}

function backgroundUrl(element: Element): string | null {
  const bgImage = getComputedStyle(element).backgroundImage;
  if (!bgImage || bgImage === 'none') return null;
  const match = bgImage.match(/url\(["']?(.+?)["']?\)/);
  return match ? match[1] : null;
}
