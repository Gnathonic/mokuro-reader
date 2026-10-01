import type { VolumeMetadata } from '$lib/types';

/**
 * A content signature of a `volumes` row: equal signatures = nothing about
 * the row changed.
 *
 * The `volumes` store re-reads the whole table on any write to ANY row, and
 * again whenever it restarts (the hash router swapping catalog → reader drops
 * its last subscriber), so the open volume's row arrives as a fresh object
 * with identical content many times. Reloading the volume's pages and files
 * for each of those hands the reader new `File` objects — every page makes a
 * new blob URL and decodes its image again (the "loads, flashes black, loads
 * again" on open). Every writer that changes a volume's OCR or images also
 * writes its row (`ocr_edited_at`, `mokuro_sha256`, counts, `metadata_only`),
 * so a changed signature is the reload signal.
 *
 * Blobs (the thumbnail) come back from IndexedDB as new objects on every read:
 * compared by size and type, not identity.
 */
export function volumeRowSignature(row: VolumeMetadata): string {
  return JSON.stringify(row, (_key, value) =>
    value instanceof Blob ? `blob:${value.size}:${value.type}` : value
  );
}
