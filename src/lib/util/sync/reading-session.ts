/**
 * Is the user reading right now, and is a `volume-data.json` upload waiting
 * for the session to end (`volume-data-deferral.ts`)?
 *
 * A reading session is active while the reader has a volume open
 * (`positions/reader-open.ts`) AND the document is visible. The sync reads it
 * at decision time, after its downloads. The flush that ends a session
 * therefore sees it inactive, because the session ended before that sync
 * started:
 * - leaving the reader: `ReaderView` calls `noteReaderClosed` BEFORE
 *   `activityTracker.flush()`;
 * - hiding the tab: `visibilityState` is already `hidden` when
 *   `visibilitychange` fires, before the layout's listener flushes.
 *
 * The deferred flag makes that flush run a sync even when no page was turned
 * since the deferring sync (`ActivityTracker.flush`). Without it, a sync that
 * deferred and then a close with nothing new pending would leave the upload
 * to whatever sync happens next. The flush consumes it
 * (`takeVolumeDataDeferred`), and a provider disconnect or switch clears it
 * (`cacheManager`): a debt to one account is not owed to another.
 */

import { openReader } from '$lib/positions/reader-open';

export function readingSessionActive(): boolean {
  if (!openReader()) return false;
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible';
}

let deferred = false;

/** A sync skipped the volume-data upload for this session. */
export function noteVolumeDataDeferred(): void {
  deferred = true;
}

/** A sync uploaded `volume-data.json`, or found nothing to upload. */
export function clearVolumeDataDeferred(): void {
  deferred = false;
}

/** Does the session's end owe a volume-data upload? */
export function volumeDataDeferred(): boolean {
  return deferred;
}

/**
 * The flush that ends a session takes the debt: it starts the sync that owes
 * the upload, so the flag is spent whether that upload then lands or not. A
 * sync that never uploads (offline, a provider demoted read-only) must not
 * turn every later tab-hide into another full sync; a sync that defers again
 * sets the flag again.
 */
export function takeVolumeDataDeferred(): boolean {
  const owed = deferred;
  deferred = false;
  return owed;
}
