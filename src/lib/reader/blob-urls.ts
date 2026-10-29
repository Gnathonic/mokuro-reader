/**
 * One object URL per page image, shared by everything that shows it.
 *
 * The browser keys its loaded and decoded images by URL. A fresh
 * `URL.createObjectURL` for the same File is a different URL, so the page is
 * fetched and decoded again and shows the reader background until it is —
 * the black flash when a rotation swaps the continuous reader, or a page the
 * preload cache had already decoded mounts with a URL of its own. Sharing the
 * URL lets the new element paint the image that is already there.
 *
 * Reference-counted per Blob; the URL is revoked a grace period after its
 * last holder lets go, so a holder that is replaced in the same frame (a
 * remount) picks the URL back up instead of minting a new one.
 */
export const BLOB_URL_GRACE_MS = 5000;

interface Entry {
  url: string;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<Blob, Entry>();
const blobsByUrl = new Map<string, Blob>();

export function acquireBlobUrl(blob: Blob): string {
  let entry = entries.get(blob);
  if (!entry) {
    entry = { url: URL.createObjectURL(blob), refs: 0, timer: null };
    entries.set(blob, entry);
    blobsByUrl.set(entry.url, blob);
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.refs++;
  return entry.url;
}

export function releaseBlobUrl(blob: Blob): void {
  const entry = entries.get(blob);
  if (!entry || --entry.refs > 0) return;
  entry.timer = setTimeout(() => {
    if (entry.refs > 0) return;
    URL.revokeObjectURL(entry.url);
    entries.delete(blob);
    blobsByUrl.delete(entry.url);
  }, BLOB_URL_GRACE_MS);
}

/**
 * The Blob behind a live URL from {@link acquireBlobUrl}, or null. A page
 * handed only a URL (paged mode's preloaded `cachedUrl`, before the image
 * cache has its File to pass along) can still reach its image's identity.
 */
export function blobForUrl(url: string): Blob | null {
  return blobsByUrl.get(url) ?? null;
}
