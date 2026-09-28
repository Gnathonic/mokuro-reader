import { db } from '$lib/catalog/db';
import { parseMokuroFile } from '$lib/import/processing';
import type { VolumeMetadata } from '$lib/types';
import {
  unifiedCloudManager,
  type CloudVolumeWithProvider
} from '$lib/util/sync/unified-cloud-manager';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import type { ProviderType } from '$lib/util/sync/provider-interface';

/**
 * Background queue that upgrades image-only local volumes with OCR data from
 * a cloud provider's .mokuro/.mokuro.gz sidecar. (Extracted from the removed
 * libraries feature — this cloud half is used by cloud placeholders.)
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
  await upgradeOcrFromSidecarBlob(task.volumeUuid, task.sidecar.path, sidecarBlob);
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
  sidecarBlob: Blob
): Promise<boolean> {
  const mokuroFile = await decodeMokuroSidecar(sidecarPath, sidecarBlob);
  if (!mokuroFile) {
    console.warn('[Cloud OCR Upgrade] Failed to decode sidecar:', sidecarPath);
    return false;
  }

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
      page_char_counts: cumulative
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
