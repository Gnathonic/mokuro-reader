import { db } from '$lib/catalog/db';
import { parseMokuroFile } from '$lib/import/processing';
import type { Page, VolumeMetadata } from '$lib/types';
import {
  unifiedCloudManager,
  type CloudVolumeWithProvider
} from '$lib/util/sync/unified-cloud-manager';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import type { CloudFileMetadata, ProviderType } from '$lib/util/sync/provider-interface';
import {
  deleteLayerRows,
  getLayerMeta,
  getLayerPages,
  layerTables,
  listLayerIds,
  putLayerWithPages
} from './layer-store';
import { notePendingLayerDelete } from '$lib/metadata/layer-sync';
import {
  isMokuroCloudAttestation,
  isUntouchedUpgradeLayer,
  sha256Hex,
  type MokuroCloudAttestation
} from './mokuro-hash';
export { isUntouchedUpgradeLayer };
import { firstImageSizeMismatch, fitPagesToVolume, sameOcrPages } from './ocr-upgrade-pages';

/**
 * Upgrading an installed volume's OCR from the cloud's `.mokuro`/`.mokuro.gz`
 * sidecar — the WRITE half. Two callers:
 *
 * - the image-only queue below (`enqueueCloudOcrUpgrade`, fed by the catalog's
 *   placeholder pass): an installed volume with no OCR at all takes the
 *   sidecar beside its archive (extracted from the removed libraries feature);
 * - the hash-driven pass (`ocr-upgrade-pass.ts`): a volume WITH OCR whose
 *   `series.json` entry names a different `mokuro_sha256` than the one its
 *   primary was installed from takes the new file — or, when the user edited
 *   that primary, gets it as the `updated-ocr` layer instead
 *   (`applyCloudPrimaryOcr`).
 */

type CloudUpgradeTask = {
  volumeUuid: string;
  provider: ProviderType;
  sidecar: CloudVolumeWithProvider;
};

const pendingTaskIds = new Set<string>();
const queuedTasks: CloudUpgradeTask[] = [];
let processing = false;

/**
 * Re-exported from the pure module for its existing importers
 * (`series-backfill.ts`, `sidecar-pull.ts`, the OCR editor); the definition
 * lives in `page-char-counts.ts` so a Worker can use it without this file's
 * cloud-manager graph.
 */
import { buildPageCharCounts } from './page-char-counts';
export { buildPageCharCounts };

/**
 * Exported for `series-backfill.ts`, which pulls the same `.mokuro`/`.mokuro.gz`
 * sidecars straight from a cloud folder listing (rather than a placeholder's
 * matched sidecar) and needs the identical gunzip-and-rename handling.
 */
export async function decodeMokuroSidecar(sidecarPath: string, blob: Blob): Promise<File | null> {
  if (sidecarPath.toLowerCase().endsWith('.mokuro')) {
    console.log('[Cloud OCR Upgrade] Decoding plain mokuro sidecar:', sidecarPath, blob.size);
    return new File([blob], sidecarPath.split('/').pop() || sidecarPath, {
      type: 'application/json'
    });
  }

  if (!sidecarPath.toLowerCase().endsWith('.mokuro.gz')) {
    return null;
  }

  if (typeof DecompressionStream === 'undefined') {
    console.warn('[Cloud OCR Upgrade] DecompressionStream not available for .mokuro.gz');
    return null;
  }

  console.log('[Cloud OCR Upgrade] Decoding gz mokuro sidecar:', sidecarPath, blob.size);
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  const decompressedBlob = await new Response(stream).blob();
  const filename = (sidecarPath.split('/').pop() || sidecarPath).replace(/\.gz$/i, '');
  return new File([decompressedBlob], filename, { type: 'application/json' });
}

/**
 * Why this volume must NOT take the cloud sidecar's OCR, or null when it may.
 *
 * `mokuro_version === ''` alone does not mean "has no OCR worth keeping". An
 * image-only volume is imported with a real `volume_ocr` row of empty pages, so
 * the OCR editor and layer promotion both work on it — and both leave
 * `mokuro_version` at '' while stamping `ocr_edited_at`. That stamp is the only
 * record that a person wrote what is in the primary row; the upgrade is a
 * wholesale `put` with no merge, so it yields to it unconditionally.
 */
function upgradeSkipReason(volume: VolumeMetadata): string | null {
  // Nothing to upgrade unless the pages are actually here: writing OCR onto a
  // placeholder is meaningless, and writing it onto a metadata-only row would
  // leave OCR without images and a row that still claims to be metadata only.
  if (!isVolumeInstalled(volume)) return 'volume not installed';
  const version = typeof volume.mokuro_version === 'string' ? volume.mokuro_version.trim() : '';
  if (version !== '') return `already has OCR (${version})`;
  if (volume.ocr_edited_at) return `OCR hand-edited at ${volume.ocr_edited_at}`;
  return null;
}

/** Where a listed sidecar is stored — the attestation its hash may be published under. */
export function attestationOfListedFile(
  provider: string,
  file: Pick<CloudFileMetadata, 'size' | 'modifiedTime' | 'modifiedTimeProvisional'>
): MokuroCloudAttestation | undefined {
  if (!(typeof file.size === 'number' && Number.isInteger(file.size) && file.size > 0)) {
    return undefined;
  }
  const ms = file.modifiedTimeProvisional ? NaN : Date.parse(file.modifiedTime ?? '');
  return {
    provider,
    size: file.size,
    ...(Number.isFinite(ms) ? { modified: Math.trunc(ms / 1000) } : {})
  };
}

async function applyUpgrade(task: CloudUpgradeTask): Promise<void> {
  console.log(
    '[Cloud OCR Upgrade] Starting task:',
    task.volumeUuid,
    'sidecar=',
    task.sidecar.path,
    'provider=',
    task.provider
  );
  const activeProvider = unifiedCloudManager.getActiveProvider();
  if (!activeProvider || activeProvider.type !== task.provider) {
    console.warn(
      '[Cloud OCR Upgrade] Active provider unavailable for cloud sidecar upgrade:',
      task.provider,
      'active=',
      activeProvider?.type
    );
    return;
  }
  const sidecarBlob = await activeProvider.downloadFile(task.sidecar);
  console.log('[Cloud OCR Upgrade] Downloaded sidecar bytes:', sidecarBlob.size, task.sidecar.path);
  await upgradeOcrFromSidecarBlob(
    task.volumeUuid,
    task.sidecar.path,
    sidecarBlob,
    attestationOfListedFile(task.provider, task.sidecar)
  );
}

/**
 * Upgrade one image-only volume from sidecar bytes already in hand — the write
 * half of every upgrade, also used for a sidecar fetched outside any provider
 * (a server's volume manifest). `sidecarPath` only has to END like the file
 * (`.mokuro` / `.mokuro.gz`): a URL works. True when the OCR was written; false
 * when the volume may not take it (see `upgradeSkipReason`) or the file is not
 * a sidecar.
 */
export async function upgradeOcrFromSidecarBlob(
  volumeUuid: string,
  sidecarPath: string,
  sidecarBlob: Blob,
  /** The listed file the bytes came from, when they came from a listing. */
  cloud?: MokuroCloudAttestation
): Promise<boolean> {
  const mokuroFile = await decodeMokuroSidecar(sidecarPath, sidecarBlob);
  if (!mokuroFile) {
    console.warn('[Cloud OCR Upgrade] Failed to decode sidecar:', sidecarPath);
    return false;
  }
  const sha256 = await sha256Hex(mokuroFile);

  const parsed = await parseMokuroFile(mokuroFile);
  console.log(
    '[Cloud OCR Upgrade] Parsed mokuro:',
    parsed.series,
    parsed.volume,
    'pages=',
    Array.isArray(parsed.pages) ? parsed.pages.length : 0
  );
  const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
  const { totalChars, cumulative } = buildPageCharCounts(pages);

  // The row is re-read INSIDE the write transaction: the snapshot this task was
  // enqueued with predates a download and a parse, and an edit that commits
  // between a check out here and the put below would be overwritten just the
  // same as one that was never checked for.
  const existingVolume = await db.transaction('rw', [db.volumes, db.volume_ocr], async () => {
    const current = await db.volumes.get(volumeUuid);
    const skip = current ? upgradeSkipReason(current) : 'volume missing';
    if (!current || skip) {
      console.log('[Cloud OCR Upgrade] Skipping task:', volumeUuid, skip);
      return null;
    }

    await db.volume_ocr.put({
      volume_uuid: current.volume_uuid,
      pages: pages as any
    });

    await db.volumes.update(current.volume_uuid, {
      mokuro_version: parsed.version || '0.0.0',
      series_uuid: parsed.seriesUuid || current.series_uuid,
      page_count: pages.length,
      character_count: totalChars,
      page_char_counts: cumulative,
      // The primary now IS these bytes (`mokuro_sha256` = its base revision).
      mokuro_sha256: sha256,
      mokuro_sha256_cloud: sha256 ? cloud : undefined
    });
    return current;
  });
  if (!existingVolume) return false;

  console.log(
    '[Cloud OCR Upgrade] Upgraded image-only volume:',
    existingVolume.series_title,
    existingVolume.volume_title
  );
  return true;
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  console.log('[Cloud OCR Upgrade] Processing queue. pending=', queuedTasks.length);

  try {
    while (queuedTasks.length > 0) {
      const task = queuedTasks.shift()!;
      const taskId = `${task.volumeUuid}:${task.sidecar.fileId}`;
      try {
        await applyUpgrade(task);
      } catch (error) {
        console.warn('[Cloud OCR Upgrade] Failed to auto-upgrade volume:', error);
      } finally {
        pendingTaskIds.delete(taskId);
        console.log('[Cloud OCR Upgrade] Task complete:', taskId, 'remaining=', queuedTasks.length);
      }
    }
  } finally {
    processing = false;
    console.log('[Cloud OCR Upgrade] Queue idle');
  }
}

export function enqueueCloudOcrUpgrade(
  volume: VolumeMetadata,
  sidecar: CloudVolumeWithProvider
): void {
  const skip = upgradeSkipReason(volume);
  if (skip) {
    console.log('[Cloud OCR Upgrade] Skip enqueue:', volume.volume_uuid, skip);
    return;
  }

  const taskId = `${volume.volume_uuid}:${sidecar.fileId}`;
  if (pendingTaskIds.has(taskId)) {
    console.log('[Cloud OCR Upgrade] Skip enqueue duplicate task:', taskId);
    return;
  }
  pendingTaskIds.add(taskId);

  queuedTasks.push({
    volumeUuid: volume.volume_uuid,
    provider: sidecar.provider,
    sidecar
  });
  console.log(
    '[Cloud OCR Upgrade] Enqueued task:',
    taskId,
    `${volume.series_title}/${volume.volume_title}`,
    'queueLength=',
    queuedTasks.length
  );

  void processQueue();
}

// ---------------------------------------------------------------------------
// The hash-driven upgrade: one cloud primary sidecar onto one installed volume
// ---------------------------------------------------------------------------

/**
 * The layer an EDITED volume gets the cloud's newer OCR as. One id, so a still
 * newer file REPLACES it rather than piling up layers; its row carries
 * `source_sha256`/`source_at` (see `VolumeOcrLayer`), which keeps it out of
 * every layer push while untouched — the cloud already holds these exact pages
 * as the volume's primary sidecar.
 */
export const UPDATED_OCR_LAYER_ID = 'updated-ocr';
export const UPDATED_OCR_LAYER_NAME = 'Updated OCR';

/**
 * The layer an UNEDITED volume's replaced primary is kept as, when that
 * primary did not provably come from this cloud (a local re-import after
 * re-running mokuro, an archive's embedded `.mokuro`, a row from before
 * hashes). Device-local: never pushed, exported or embedded while untouched
 * (`isUntouchedUpgradeLayer`), and a later replacement overwrites it only
 * while it is still untouched — once edited it is the user's, and the next
 * keepsake goes under a fresh id (`previous-ocr-2`, ...).
 */
export const PREVIOUS_OCR_LAYER_ID = 'previous-ocr';
export const PREVIOUS_OCR_LAYER_NAME = 'Previous OCR';

/** The read-only pre-edit snapshot (`edit-persist.ts`'s `ORIGINAL_LAYER_ID`; a literal to stay out of its import cycle). */
const ORIGINAL_LAYER = 'original';

/**
 * What one cloud primary sidecar did to one volume:
 *
 * - `upgraded` — an unedited primary was replaced wholesale;
 * - `layered` — an edited primary was kept, the file went to the `updated-ocr`
 *   layer (created, or an untouched one replaced);
 * - `recorded` — the file is the OCR the volume already has (same pages as the
 *   primary, or for an edited volume the same as its pre-edit `original`):
 *   only its hash was recorded, nothing else changed;
 * - `kept` — edited, and the `updated-ocr` layer is the user's own by now (they
 *   edited it): left alone, the file remembered so it is not re-fetched;
 * - `mismatch` — a different page count, or pages sized for other images:
 *   not this archive's OCR at all;
 * - `skipped` — not installed (any more), or already exactly these bytes.
 */
export type CloudPrimaryOutcome =
  | 'upgraded'
  | 'layered'
  | 'recorded'
  | 'kept'
  | 'mismatch'
  | 'skipped';

export interface CloudPrimaryOcr {
  /** The provider the sidecar is listed on (else `cloud.provider`). */
  provider?: string;
  /** The sidecar's pages as parsed (`img_path` as the FILE names them). */
  pages: Page[];
  /** The sidecar's mokuro `version`. */
  version: string;
  /** `mokuro_sha256` of the decoded bytes the pages were parsed from. */
  sha256: string;
  /** The listed file the bytes came from (see `MokuroCloudAttestation`). */
  cloud?: MokuroCloudAttestation;
}

/**
 * Apply one cloud primary sidecar to an INSTALLED volume, by the rules of the
 * OCR upgrade (see `CloudPrimaryOutcome`). Everything is decided against the
 * rows as they stand INSIDE one write transaction — the download and parse
 * before it take long enough for an edit, a delete or another pass to land.
 *
 * The volume keeps its `volume_uuid` (read history and progress are keyed by
 * it) and its page count (a different count is a `mismatch`, never applied).
 * An upgrade recounts `character_count`/`page_char_counts` from the new pages:
 * the progress PAGE is untouched, and characters read are re-derived from it
 * against the new per-page counts wherever they are computed from
 * `page_char_counts` (series/catalog views at once; the synced
 * `VolumeData.chars` at the next page turn).
 */
export async function applyCloudPrimaryOcr(
  volumeUuid: string,
  ocr: CloudPrimaryOcr
): Promise<CloudPrimaryOutcome> {
  return db.transaction('rw', [db.volumes, db.volume_ocr, ...layerTables(db)], async () => {
    const current = await db.volumes.get(volumeUuid);
    if (!current || !isVolumeInstalled(current)) return 'skipped';
    if (current.mokuro_sha256 === ocr.sha256) return 'skipped';
    const local = await db.volume_ocr.get(volumeUuid);
    if (!local) return 'skipped';

    if (ocr.pages.length !== current.page_count || ocr.pages.length !== local.pages.length) {
      console.debug(
        `[Cloud OCR Upgrade] not applying a ${ocr.pages.length}-page sidecar to ` +
          `'${current.series_title}/${current.volume_title}' (${current.page_count} pages): ` +
          'a different archive, not an OCR upgrade'
      );
      return 'mismatch';
    }

    // Same count, but made for images of another size: its boxes would land
    // in the wrong places on every page of this volume's own images.
    const sizeMismatch = firstImageSizeMismatch(ocr.pages, local.pages);
    if (sizeMismatch >= 0) {
      const a = ocr.pages[sizeMismatch];
      const b = local.pages[sizeMismatch];
      console.debug(
        `[Cloud OCR Upgrade] not applying the cloud sidecar to ` +
          `'${current.series_title}/${current.volume_title}': page ${sizeMismatch + 1} is ` +
          `${a.img_width}x${a.img_height} there, ${b.img_width}x${b.img_height} here — ` +
          'OCR made for other images'
      );
      return 'mismatch';
    }

    const pages = fitPagesToVolume(ocr.pages, local.pages);
    const base = {
      mokuro_sha256: ocr.sha256,
      mokuro_sha256_cloud: ocr.cloud
    };

    // The OCR this volume already has, arriving as different bytes (a
    // re-serialization, another producer's key order): learn its hash.
    if (sameOcrPages(pages, local.pages)) {
      await db.volumes.update(volumeUuid, base);
      return 'recorded';
    }

    if (current.ocr_edited_at) {
      // The pre-edit snapshot IS what the user's edits sit on: the cloud file
      // equal to it is nothing new from the server, only its hash is.
      const original = await getLayerPages(db, volumeUuid, ORIGINAL_LAYER);
      if (original && sameOcrPages(pages, original)) {
        await db.volumes.update(volumeUuid, base);
        return 'recorded';
      }
      const existing = await getLayerMeta(db, volumeUuid, UPDATED_OCR_LAYER_ID);
      if (existing && !isUntouchedUpgradeLayer(existing)) {
        // The user edited the previous server OCR layer: it is their work now.
        console.debug(
          `[Cloud OCR Upgrade] '${current.volume_title}': newer cloud OCR not filed — ` +
            `the '${UPDATED_OCR_LAYER_ID}' layer has local edits`
        );
        await db.volumes.update(volumeUuid, { updated_ocr_sha256: ocr.sha256 });
        return 'kept';
      }
      const now = new Date().toISOString();
      await putLayerWithPages(db, {
        volume_uuid: volumeUuid,
        layer_id: UPDATED_OCR_LAYER_ID,
        name: existing?.name ?? UPDATED_OCR_LAYER_NAME,
        kind: 'ocr',
        created_at: existing?.created_at ?? now,
        updated_at: now,
        source_sha256: ocr.sha256,
        source_at: now,
        pages
      });
      await db.volumes.update(volumeUuid, { updated_ocr_sha256: ocr.sha256 });
      return 'layered';
    }

    // Unedited: replaced. When the primary is provably THIS cloud's file (its
    // hash attested for this provider), it is only an older revision of the
    // same file. Otherwise it came from somewhere else — a local import, an
    // archive's embedded `.mokuro`, a row from before hashes — and may be OCR
    // the cloud never had: kept as the local `previous-ocr` layer first.
    const provider = ocr.provider ?? ocr.cloud?.provider;
    const attested =
      !!current.mokuro_sha256 &&
      isMokuroCloudAttestation(current.mokuro_sha256_cloud) &&
      current.mokuro_sha256_cloud.provider === provider;
    if (!attested) await keepReplacedPrimary(current, local.pages);
    await dropSnapshotsOfReplacedPrimary(volumeUuid, provider);

    const { totalChars, cumulative } = buildPageCharCounts(pages);
    await db.volume_ocr.put({ volume_uuid: volumeUuid, pages });
    await db.volumes.update(volumeUuid, {
      ...base,
      mokuro_version: ocr.version || current.mokuro_version || '0.0.0',
      character_count: totalChars,
      page_char_counts: cumulative,
      updated_ocr_sha256: undefined
    });
    return 'upgraded';
  });
}

/**
 * The snapshots a replaced primary leaves stale (inside the caller's
 * transaction). An unedited row can still hold an `original` layer — the
 * pre-edit snapshot of the OLD OCR, pulled by layer-sync or attached by a
 * reinstall — and an untouched `updated-ocr`. After the swap, Revert would
 * restore the pre-upgrade OCR, the next edit would keep that stale `original`
 * as its base, and promoting the stale `updated-ocr` would adopt an old hash.
 * Both go; an `updated-ocr` the user edited is theirs and stays. The
 * `original`'s cloud copy (if any) is tombstoned so a listing never pulls it
 * back.
 */
async function dropSnapshotsOfReplacedPrimary(
  volumeUuid: string,
  provider: string | undefined
): Promise<void> {
  const original = await getLayerMeta(db, volumeUuid, ORIGINAL_LAYER);
  if (original) {
    await deleteLayerRows(db, volumeUuid, ORIGINAL_LAYER);
    notePendingLayerDelete({
      volume_uuid: volumeUuid,
      layer_id: ORIGINAL_LAYER,
      provider: original.cloud?.provider ?? provider
    });
  }
  const updated = await getLayerMeta(db, volumeUuid, UPDATED_OCR_LAYER_ID);
  // Untouched, it is a mirror of a cloud primary: never pushed, so no cloud copy.
  if (updated && isUntouchedUpgradeLayer(updated)) {
    await deleteLayerRows(db, volumeUuid, UPDATED_OCR_LAYER_ID);
  }
}

/**
 * Keep an unedited primary that is about to be replaced and did not come from
 * this cloud, as the local `previous-ocr` layer (inside the caller's
 * transaction). Overwrites an untouched `previous-ocr`; one the user edited is
 * theirs, so the keepsake goes under the next free `previous-ocr-<n>` id.
 */
async function keepReplacedPrimary(current: VolumeMetadata, pages: Page[]): Promise<void> {
  const existing = await getLayerMeta(db, current.volume_uuid, PREVIOUS_OCR_LAYER_ID);
  let layerId = PREVIOUS_OCR_LAYER_ID;
  let name = PREVIOUS_OCR_LAYER_NAME;
  if (existing && !isUntouchedUpgradeLayer(existing)) {
    const taken = new Set(await listLayerIds(db, current.volume_uuid));
    let n = 2;
    while (taken.has(`${PREVIOUS_OCR_LAYER_ID}-${n}`)) n++;
    layerId = `${PREVIOUS_OCR_LAYER_ID}-${n}`;
    name = `${PREVIOUS_OCR_LAYER_NAME} (${n})`;
  }
  const keep = existing && layerId === PREVIOUS_OCR_LAYER_ID ? existing : undefined;
  const now = new Date().toISOString();
  await putLayerWithPages(db, {
    volume_uuid: current.volume_uuid,
    layer_id: layerId,
    name: keep?.name ?? name,
    kind: 'ocr',
    created_at: keep?.created_at ?? now,
    updated_at: now,
    ...(current.mokuro_sha256 ? { source_sha256: current.mokuro_sha256 } : {}),
    source_at: now,
    pages
  });
}
