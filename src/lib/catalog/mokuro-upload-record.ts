import { db } from './db';
import { isMokuroSha256, sha256Hex } from './mokuro-hash';
import { isVolumeInstalled } from './volume-state';

/**
 * This device just uploaded a volume's PRIMARY `.mokuro` sidecar: the cloud
 * now holds exactly those bytes, so the volume's `mokuro_sha256` becomes their
 * hash (the base revision the primary is now known by everywhere) and the row
 * records where the file is (`mokuro_sha256_cloud`) — which is what lets
 * `buildSeriesFile` publish the hash for a plain storage backend.
 *
 * `size` is the byte count sent; `modifiedTime` the server's mtime from the
 * upload response, when it gave one (never a client-clock stamp). Only an
 * installed row is touched: a sidecar is serialized from the primary pages, so
 * there is nothing to describe on any other. Never rejects.
 */
export async function recordUploadedPrimarySidecar(
  volumeUuid: string,
  upload: UploadedSidecar
): Promise<void> {
  await writeRecords([[volumeUuid, upload]]);
}

interface UploadedSidecar {
  sha256?: string;
  provider: string;
  size: number;
  modifiedTime?: string;
}

/** Every record in ONE transaction; installed rows only. Never rejects. */
async function writeRecords(records: Array<[string, UploadedSidecar]>): Promise<void> {
  const usable = records.filter(([, u]) => isMokuroSha256(u.sha256) && u.size > 0);
  if (usable.length === 0) return;
  try {
    await db.transaction('rw', db.volumes, async () => {
      for (const [volumeUuid, upload] of usable) {
        const row = await db.volumes.get(volumeUuid);
        if (!row || !isVolumeInstalled(row)) continue;
        const ms = upload.modifiedTime ? Date.parse(upload.modifiedTime) : NaN;
        await db.volumes.update(volumeUuid, {
          mokuro_sha256: upload.sha256,
          mokuro_sha256_cloud: {
            provider: upload.provider,
            size: upload.size,
            ...(Number.isFinite(ms) ? { modified: Math.trunc(ms / 1000) } : {})
          }
        });
      }
    });
  } catch (error) {
    console.debug('[mokuro-upload-record] could not record uploaded sidecars:', error);
  }
}

/** {@link recordUploadedPrimarySidecar} for a main-thread upload: hashes the blob it sent. */
export async function recordUploadedPrimarySidecarBlob(
  volumeUuid: string,
  provider: string,
  blob: Blob,
  uploaded: { size?: number; modifiedTime?: string; modifiedTimeProvisional?: boolean } | undefined
): Promise<void> {
  const sha256 = await sha256Hex(blob);
  await recordUploadedPrimarySidecar(volumeUuid, {
    sha256,
    provider,
    size: blob.size,
    ...(uploaded?.modifiedTime && !uploaded.modifiedTimeProvisional
      ? { modifiedTime: uploaded.modifiedTime }
      : {})
  });
}

// ---- the batched variant, for the sidecar backfill ----

/**
 * Upload records waiting for {@link flushUploadRecords}, newest per volume.
 * The sidecar backfill uploads `.mokuro` files in bulk (a whole legacy library
 * on first connect) and pins its import feed at zero IndexedDB transactions
 * (`sidecar-backfill.test.ts`): its records are collected here and written in
 * ONE transaction shortly after the burst, off the upload path.
 */
const pendingRecords = new Map<string, UploadedSidecar>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** How long a burst of backfill uploads is collected before its records are written. */
export const UPLOAD_RECORD_FLUSH_MS = 500;

/** Queue {@link recordUploadedPrimarySidecar} for the next batched write. Sync; never throws. */
export function noteUploadedPrimarySidecar(volumeUuid: string, upload: UploadedSidecar): void {
  if (!isMokuroSha256(upload.sha256)) return;
  pendingRecords.set(volumeUuid, upload);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushUploadRecords();
  }, UPLOAD_RECORD_FLUSH_MS);
}

/** Write every queued record now. Never rejects. */
export async function flushUploadRecords(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const batch = [...pendingRecords];
  pendingRecords.clear();
  await writeRecords(batch);
}

/** Test hook: drop queued records and their timer. */
export function _resetUploadRecordsForTests(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  pendingRecords.clear();
}
