import { db } from '$lib/catalog/db';
import { parseMokuroFile } from '$lib/import/processing';
import type { VolumeMetadata } from '$lib/types';
import type { LibraryFileMetadata } from './library-webdav-client';
import { getLibraryById } from '$lib/settings/libraries';
import { getLibraryClient } from './library-cache-manager';
import {
  unifiedCloudManager,
  type CloudVolumeWithProvider
} from '$lib/util/sync/unified-cloud-manager';
import type { ProviderType } from '$lib/util/sync/provider-interface';

type LibraryUpgradeTask = {
  kind: 'library';
  volumeUuid: string;
  libraryId: string;
  sidecar: LibraryFileMetadata;
};

type CloudUpgradeTask = {
  kind: 'cloud';
  volumeUuid: string;
  provider: ProviderType;
  sidecar: CloudVolumeWithProvider;
};

type UpgradeTask = LibraryUpgradeTask | CloudUpgradeTask;

const pendingTaskIds = new Set<string>();
const queuedTasks: UpgradeTask[] = [];
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
    console.log('[Library OCR Upgrade] Decoding plain mokuro sidecar:', sidecarPath, blob.size);
    return new File([blob], sidecarPath.split('/').pop() || sidecarPath, {
      type: 'application/json'
    });
  }

  if (!sidecarPath.toLowerCase().endsWith('.mokuro.gz')) {
    return null;
  }

  if (typeof DecompressionStream === 'undefined') {
    console.warn('[Library OCR Upgrade] DecompressionStream not available for .mokuro.gz');
    return null;
  }

  console.log('[Library OCR Upgrade] Decoding gz mokuro sidecar:', sidecarPath, blob.size);
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  const decompressedBlob = await new Response(stream).blob();
  const filename = (sidecarPath.split('/').pop() || sidecarPath).replace(/\.gz$/i, '');
  return new File([decompressedBlob], filename, { type: 'application/json' });
}

async function applyUpgrade(task: UpgradeTask): Promise<void> {
  const taskScope =
    task.kind === 'library' ? `library:${task.libraryId}` : `cloud:${task.provider}`;
  console.log(
    '[Library OCR Upgrade] Starting task:',
    task.volumeUuid,
    'sidecar=',
    task.sidecar.path,
    'scope=',
    taskScope
  );
  let sidecarBlob: Blob;
  let sidecarPath: string;
  if (task.kind === 'library') {
    const library = getLibraryById(task.libraryId);
    if (!library) {
      console.warn('[Library OCR Upgrade] Library config not found:', task.libraryId);
      return;
    }
    const client = getLibraryClient(library);
    sidecarBlob = await client.downloadFile(task.sidecar.fileId);
    sidecarPath = task.sidecar.path;
  } else {
    const activeProvider = unifiedCloudManager.getActiveProvider();
    if (!activeProvider || activeProvider.type !== task.provider) {
      console.warn(
        '[Library OCR Upgrade] Active provider unavailable for cloud sidecar upgrade:',
        task.provider,
        'active=',
        activeProvider?.type
      );
      return;
    }
    sidecarBlob = await activeProvider.downloadFile(task.sidecar);
    sidecarPath = task.sidecar.path;
  }

  console.log('[Library OCR Upgrade] Downloaded sidecar bytes:', sidecarBlob.size, sidecarPath);
  const mokuroFile = await decodeMokuroSidecar(sidecarPath, sidecarBlob);
  if (!mokuroFile) {
    console.warn('[Library OCR Upgrade] Failed to decode sidecar:', sidecarPath);
    return;
  }

  const parsed = await parseMokuroFile(mokuroFile);
  console.log(
    '[Library OCR Upgrade] Parsed mokuro:',
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
      '[Library OCR Upgrade] Skipping task, volume missing or already OCR:',
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
    '[Library OCR Upgrade] Upgraded image-only volume:',
    existingVolume.series_title,
    existingVolume.volume_title
  );
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  console.log('[Library OCR Upgrade] Processing queue. pending=', queuedTasks.length);

  try {
    while (queuedTasks.length > 0) {
      const task = queuedTasks.shift()!;
      const sidecarId = task.kind === 'library' ? task.sidecar.fileId : task.sidecar.fileId;
      const taskId = `${task.volumeUuid}:${sidecarId}`;
      try {
        await applyUpgrade(task);
      } catch (error) {
        console.warn('[Library OCR Upgrade] Failed to auto-upgrade volume:', error);
      } finally {
        pendingTaskIds.delete(taskId);
        console.log(
          '[Library OCR Upgrade] Task complete:',
          taskId,
          'remaining=',
          queuedTasks.length
        );
      }
    }
  } finally {
    processing = false;
    console.log('[Library OCR Upgrade] Queue idle');
  }
}

export function enqueueLibraryOcrUpgrade(
  volume: VolumeMetadata,
  sidecar: LibraryFileMetadata
): void {
  if (volume.isPlaceholder) {
    console.log('[Library OCR Upgrade] Skip enqueue for placeholder volume:', volume.volume_uuid);
    return;
  }
  const currentMokuroVersion =
    typeof volume.mokuro_version === 'string' ? volume.mokuro_version.trim() : '';
  if (currentMokuroVersion !== '') {
    console.log(
      '[Library OCR Upgrade] Skip enqueue, volume already has OCR:',
      volume.volume_uuid,
      currentMokuroVersion
    );
    return;
  }

  const taskId = `${volume.volume_uuid}:${sidecar.fileId}`;
  if (pendingTaskIds.has(taskId)) {
    console.log('[Library OCR Upgrade] Skip enqueue duplicate task:', taskId);
    return;
  }
  pendingTaskIds.add(taskId);

  queuedTasks.push({
    kind: 'library',
    volumeUuid: volume.volume_uuid,
    libraryId: sidecar.libraryId,
    sidecar
  });
  console.log(
    '[Library OCR Upgrade] Enqueued task:',
    taskId,
    `${volume.series_title}/${volume.volume_title}`,
    'queueLength=',
    queuedTasks.length
  );

  void processQueue();
}

export function enqueueCloudOcrUpgrade(
  volume: VolumeMetadata,
  sidecar: CloudVolumeWithProvider
): void {
  if (volume.isPlaceholder) {
    console.log(
      '[Library OCR Upgrade] Skip cloud enqueue for placeholder volume:',
      volume.volume_uuid
    );
    return;
  }
  const currentMokuroVersion =
    typeof volume.mokuro_version === 'string' ? volume.mokuro_version.trim() : '';
  if (currentMokuroVersion !== '') {
    console.log(
      '[Library OCR Upgrade] Skip cloud enqueue, volume already has OCR:',
      volume.volume_uuid,
      currentMokuroVersion
    );
    return;
  }

  const taskId = `${volume.volume_uuid}:${sidecar.fileId}`;
  if (pendingTaskIds.has(taskId)) {
    console.log('[Library OCR Upgrade] Skip cloud enqueue duplicate task:', taskId);
    return;
  }
  pendingTaskIds.add(taskId);

  queuedTasks.push({
    kind: 'cloud',
    volumeUuid: volume.volume_uuid,
    provider: sidecar.provider,
    sidecar
  });
  console.log(
    '[Library OCR Upgrade] Enqueued cloud task:',
    taskId,
    `${volume.series_title}/${volume.volume_title}`,
    'queueLength=',
    queuedTasks.length
  );

  void processQueue();
}
