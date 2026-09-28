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
