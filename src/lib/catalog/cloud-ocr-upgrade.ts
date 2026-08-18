import { db } from '$lib/catalog/db';
import { parseMokuroFile } from '$lib/import/processing';
import type { VolumeMetadata } from '$lib/types';
import {
  unifiedCloudManager,
  type CloudVolumeWithProvider
} from '$lib/util/sync/unified-cloud-manager';
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

function countCharsInLines(lines: unknown): number {
  if (!Array.isArray(lines)) return 0;
  const japaneseRegex =
    /[○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
  let total = 0;
  for (const line of lines) {
    if (typeof line !== 'string') continue;
    total += Array.from(line).filter((char) => japaneseRegex.test(char)).length;
  }
  return total;
}

function buildPageCharCounts(pages: unknown[]): { totalChars: number; cumulative: number[] } {
  let totalChars = 0;
  const cumulative: number[] = [];

  for (const page of pages) {
    let pageChars = 0;
    const blocks = (page as { blocks?: unknown[] })?.blocks;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        pageChars += countCharsInLines((block as { lines?: unknown[] })?.lines);
      }
    }
    totalChars += pageChars;
    cumulative.push(totalChars);
  }

  return { totalChars, cumulative };
}

async function decodeMokuroSidecar(sidecarPath: string, blob: Blob): Promise<File | null> {
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

  const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
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
  if (volume.isPlaceholder) {
    console.log('[Cloud OCR Upgrade] Skip enqueue for placeholder volume:', volume.volume_uuid);
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
