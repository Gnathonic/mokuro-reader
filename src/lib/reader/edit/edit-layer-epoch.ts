/**
 * When this device first ran a reader that saves OCR corrections into the
 * `edit` layer (bunko design 0.8 D4). Edits stamped BEFORE it live only in a
 * volume's primary row and are carried into an `edit` layer once
 * (`migrateEditedPrimariesToEditLayers`, `layer-sync.ts`); anything stamped
 * after it already went through the new write path — a promotion included,
 * which must stay a local view and never become an "edit" layer. Stored on
 * the first edit, promotion or migration, whichever comes first.
 */
const EPOCH_KEY = 'edit-layer:epoch';

/** The epoch as ISO, recorded now when absent. Null when storage is unavailable. */
export function editLayerEpoch(): string | null {
  try {
    const stored = globalThis.localStorage?.getItem(EPOCH_KEY);
    if (stored) return stored;
    const now = new Date().toISOString();
    globalThis.localStorage?.setItem(EPOCH_KEY, now);
    return now;
  } catch {
    return null;
  }
}
