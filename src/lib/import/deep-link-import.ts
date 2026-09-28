import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { pickCoverTarget } from './cover-sidecar';
import type { HtmlDownloadResult } from './html-download-provider';
import { importArchiveWithOptionalMokuro } from './import-service';
import { recordSeriesFile } from './series-file-import';

/**
 * The provider stamp a deep-linked layer row carries (`cloud.provider`), so a
 * later listing of the same file on a real provider takes the row over.
 */
export const DEEP_LINK_LAYER_SOURCE = 'html-download';

/**
 * The server is still making OCR for this volume (`pending`): watch it on the
 * server's queue file. An `ocr: null` manifest imported the volume image-only;
 * the queue poller upgrades it when the primary lands.
 */
async function rememberPendingOcr(
  downloaded: HtmlDownloadResult,
  target: VolumeMetadata | undefined
): Promise<void> {
  const manifest = downloaded.manifest;
  if (!target || !manifest || !downloaded.manifestUrl || manifest.pending.length === 0) return;
  try {
    const { queueUrlForArchive, watchServerOcr } = await import('$lib/catalog/server-ocr-queue');
    const queueUrl = queueUrlForArchive(manifest.archive.url);
    if (!queueUrl) return;
    // The queue file names the volume as the server does (folder / archive
    // stem), which a deep-linked row need not share: the manifest says it.
    watchServerOcr({
      volumeUuid: target.volume_uuid,
      series: manifest.series ?? target.series_title,
      volume: manifest.volume ?? target.volume_title,
      queueUrl,
      manifestUrl: downloaded.manifestUrl,
      auth: 'none',
      source: DEEP_LINK_LAYER_SOURCE
    });
  } catch (error) {
    console.warn('[HTML Download] Could not watch the server OCR queue:', error);
  }
}

/**
 * Import a deep-linked `.cbz` with what its manifest brought along:
 *
 * - the `series.json` joins the import batch BEFORE the archive is queued, so
 *   the batch applies it once the volume is saved — exactly as a `series.json`
 *   inside an imported ZIP (keyed by the title the volume was stored under);
 * - the layers go through the same importer a cloud listing's pull uses
 *   (`importFetchedLayers`), onto the volume this import installed.
 *
 * Returns the volume this import installed, when there is one. Layer failures
 * are warnings; only the archive's own import can fail the call.
 */
export async function importDeepLinkedArchive(
  downloaded: HtmlDownloadResult,
  requestVolume: string,
  installedBefore: Set<string>
): Promise<VolumeMetadata | undefined> {
  if (!downloaded.archiveFile) throw new Error('No archive to import');
  if (downloaded.seriesFile) recordSeriesFile(downloaded.seriesFile);

  await importArchiveWithOptionalMokuro(downloaded.archiveFile, downloaded.mokuroFile);

  const target = pickCoverTarget(await db.volumes.toArray(), installedBefore, requestVolume);
  await rememberPendingOcr(downloaded, target);
  if (downloaded.layers.length === 0) return target;
  if (!target) {
    console.warn(
      `[HTML Download] ${downloaded.layers.length} OCR layer(s) not attached: this import installed no volume`
    );
    return target;
  }
  // Loaded on demand: the layer importer drags the sync provider stack along.
  const { importFetchedLayers } = await import('$lib/metadata/layer-sync');
  const attached = await importFetchedLayers(
    target.volume_uuid,
    DEEP_LINK_LAYER_SOURCE,
    downloaded.layers
  );
  console.log(
    `[HTML Download] Attached ${attached} of ${downloaded.layers.length} OCR layer(s) to`,
    target.volume_title
  );
  return target;
}
