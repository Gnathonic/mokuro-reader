import { db } from '$lib/catalog/db';
import { parseMokuroFile } from '$lib/import/processing';
import { stampCharOffsetsMethod } from '$lib/reader/char-offsets';
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
  const sidecarPath = task.sidecar.path;

  console.log('[Cloud OCR Upgrade] Downloaded sidecar bytes:', sidecarBlob.size, sidecarPath);
  const mokuroFile = await decodeMokuroSidecar(sidecarPath, sidecarBlob);
  if (!mokuroFile) {
    console.warn('[Cloud OCR Upgrade] Failed to decode sidecar:', sidecarPath);
    return;
  }

  const parsed = await parseMokuroFile(mokuroFile);
  console.log(
    '[Cloud OCR Upgrade] Parsed mokuro:',
    parsed.series,
    parsed.volume,
    'pages=',
    Array.isArray(parsed.pages) ? parsed.pages.length : 0
  );
  const existingVolume = await db.volumes.get(task.volumeUuid);
  const existingMokuroVersion =
    typeof existingVolume?.mokuro_version === 'string' ? existingVolume.mokuro_version.trim() : '';
  if (!existingVolume || existingMokuroVersion !== '') {
    console.log(
      '[Cloud OCR Upgrade] Skipping task, volume missing or already OCR:',
      task.volumeUuid,
      'existingVersion=',
      existingMokuroVersion
    );
    return;
  }

  // This path skips processVolume's page mapping, so it applies the same stamp
  // rule itself: engine sidecars name their method only at the file's top level.
  const pages = stampCharOffsetsMethod(
    Array.isArray(parsed.pages) ? parsed.pages : [],
    parsed.charOffsetsMethod
  );
  const { totalChars, cumulative } = buildPageCharCounts(pages);

  await db.transaction('rw', [db.volumes, db.volume_ocr], async () => {
    await db.volume_ocr.put({
      volume_uuid: existingVolume.volume_uuid,
      pages: pages as any
    });

    await db.volumes.update(existingVolume.volume_uuid, {
      mokuro_version: parsed.version || '0.0.0',
      series_uuid: parsed.seriesUuid || existingVolume.series_uuid,
      page_count: pages.length,
      character_count: totalChars,
      page_char_counts: cumulative
    });
  });

  console.log(
    '[Cloud OCR Upgrade] Upgraded image-only volume:',
    existingVolume.series_title,
    existingVolume.volume_title
  );
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
  // Nothing to upgrade unless the pages are actually here: writing OCR onto a
  // placeholder is meaningless, and writing it onto a metadata-only row would
  // leave OCR without images and a row that still claims to be metadata only.
  if (!isVolumeInstalled(volume)) {
    console.log('[Cloud OCR Upgrade] Skip enqueue, volume not installed:', volume.volume_uuid);
    return;
  }
  const currentMokuroVersion =
    typeof volume.mokuro_version === 'string' ? volume.mokuro_version.trim() : '';
  if (currentMokuroVersion !== '') {
    console.log(
      '[Cloud OCR Upgrade] Skip enqueue, volume already has OCR:',
      volume.volume_uuid,
      currentMokuroVersion
    );
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
