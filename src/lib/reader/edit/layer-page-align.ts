/**
 * Fitting a layer file's pages onto the volume they are a layer of.
 *
 * A layer is shown by INDEX: page 12 of the layer is drawn over image 12 of the
 * volume. That only holds while the layer has a page for every page of the
 * volume — and an engine run does not promise that. mokuro-bunko's runner keeps
 * going past a page its engine crashed on ("a bad page must not sink the
 * volume") and writes the sidecar WITHOUT it, so a 206-page volume gets a
 * 194-page file whose every later page would land on the wrong image.
 *
 * The pages still say which image they belong to (`img_path`), so a short file
 * can be put back in step: each page goes to the slot of the volume page with
 * the same image, and the slots nobody claimed become blank pages. Refusing the
 * whole file instead threw away ~95% good OCR for the sake of a few bad pages.
 *
 * Pure: no database, no provider.
 */
import type { Page } from '$lib/types';

/** `Vol 01\\Page_005.JPG` → `vol 01/page_005`: the import may re-spell the extension. */
function imageKey(imgPath: string): string {
  const path = imgPath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash ? path.slice(0, dot) : path;
}

function fileKey(imgPath: string): string {
  const key = imageKey(imgPath);
  return key.slice(key.lastIndexOf('/') + 1);
}

/** key → index, or null when two pages share a key (then the key identifies nothing). */
function indexByKey(pages: Page[], keyOf: (path: string) => string): Map<string, number> | null {
  const index = new Map<string, number>();
  for (let i = 0; i < pages.length; i++) {
    const key = keyOf(pages[i].img_path ?? '');
    if (!key || index.has(key)) return null;
    index.set(key, i);
  }
  return index;
}

function slotsFor(
  layerPages: Page[],
  volumePages: Page[],
  keyOf: (path: string) => string
): number[] | null {
  const index = indexByKey(volumePages, keyOf);
  if (!index) return null;
  const slots: number[] = [];
  let previous = -1;
  for (const page of layerPages) {
    const slot = index.get(keyOf(page.img_path ?? ''));
    // In the volume's own order, each image once: anything else is not this
    // volume with pages missing, it is some other page set.
    if (slot === undefined || slot <= previous) return null;
    slots.push(slot);
    previous = slot;
  }
  return slots;
}

/** A volume page's image facts with no text — the same shape an empty layer is made of. */
function blankFrom(source: Page): Page {
  return { ...source, blocks: [] };
}

/**
 * `layerPages` as one page per page of the volume, or null when they cannot be
 * a layer of it.
 *
 * - Same length: returned as they are — positional, exactly as layers always
 *   were (an engine's paths need not match for that).
 * - Fewer: every layer page must name the image of a distinct volume page, in
 *   the volume's order (full path first; bare filename only when those are
 *   unique, for a file whose folder prefix differs). The rest are blanks.
 * - More, none, or any page that fits nowhere: null.
 */
export function alignLayerPages(layerPages: Page[], volumePages: Page[]): Page[] | null {
  if (layerPages.length === volumePages.length) return layerPages;
  if (layerPages.length === 0 || layerPages.length > volumePages.length) return null;
  const slots =
    slotsFor(layerPages, volumePages, imageKey) ?? slotsFor(layerPages, volumePages, fileKey);
  if (!slots) return null;
  const aligned = volumePages.map(blankFrom);
  // One spelling of the image paths per page set: the reader resolves a page
  // set's images by ONE strategy (`image-cache.ts`), so the blanks' local paths
  // and the engine's as-scanned ones must not be mixed.
  slots.forEach((slot, i) => {
    aligned[slot] = { ...layerPages[i], img_path: volumePages[slot].img_path };
  });
  return aligned;
}
