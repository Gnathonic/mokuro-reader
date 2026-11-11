/**
 * "Mark volume read / unread" for the volume OPEN in the reader (#55,
 * `reader.volume-read`): what the volume row's button does, on the same test
 * (`isVolumeComplete` — the last page or the one before) and through the same
 * two store calls, so a key in the reader and the button on the series page
 * can never disagree about what "read" is.
 *
 * Read moves the position to the last page and marks the volume finished;
 * unread puts it back at the start and clears its completion date. The reader
 * follows the progress record, so the page on screen moves with it.
 *
 * After #224 merges, the mark goes through its sheet: route this one function
 * there, as the row's handler is.
 */
import { markVolumeAsComplete, markVolumeAsUnread } from '$lib/settings/volume-data';
import { isVolumeComplete } from '$lib/util/volume-helpers';

export type VolumeReadChange = 'read' | 'unread';

/**
 * Toggle the volume's read state. `progress` is the RAW stored page (0 when
 * the volume was never opened). Returns what was done, or null when there is
 * nothing to mark (no page count).
 */
export function toggleVolumeRead(
  volumeUuid: string,
  progress: number,
  pageCount: number,
  totalChars?: number
): VolumeReadChange | null {
  if (isVolumeComplete(progress, pageCount)) {
    markVolumeAsUnread(volumeUuid);
    return 'unread';
  }
  if (!pageCount) return null;
  markVolumeAsComplete(volumeUuid, pageCount, totalChars);
  return 'read';
}
