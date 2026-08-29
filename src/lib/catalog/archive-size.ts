import { db } from '$lib/catalog/db';
import { isArchiveSize } from '$lib/metadata/series-file';

/**
 * Record how big this volume's `.cbz` is, from a moment where we just held the
 * whole archive: the blob we uploaded, or the archive we downloaded.
 *
 * The newest measurement wins — unlike the index-fill rules, this is not a copy
 * of somebody else's claim but the bytes that just went over the wire, and a
 * re-upload after a re-OCR genuinely changes the size.
 *
 * Best-effort by design: an unknown volume is a no-op (`update` matches
 * nothing), a junk size is dropped by the shared validator, and a failed write
 * is logged at debug and forgotten. Nothing here may fail a backup or an
 * install — the size is a nicety, the archive is the point.
 */
export async function recordArchiveSize(
  volumeUuid: string,
  bytes: number | null | undefined
): Promise<void> {
  if (!isArchiveSize(bytes)) return;
  try {
    await db.volumes.update(volumeUuid, { archive_size: bytes });
  } catch (error) {
    console.debug('[archive-size] could not record the size of', volumeUuid, error);
  }
}
