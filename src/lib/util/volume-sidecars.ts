import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { getSeriesIndex } from '$lib/metadata/series-index';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { SERIES_FILE_NAME, buildSeriesFile, type SeriesFile } from '$lib/metadata/series-file';
import { getSeriesMetadataForTitle } from '$lib/metadata/store';
import { buildMokuroMetadata } from './mokuro-metadata';

export interface VolumeSidecarFiles {
  mokuroFile: File | null;
  thumbnailFile: File | null;
  /** The series' `series.json` — one per series, not per volume. */
  seriesFile: File | null;
}

/**
 * The `series.json` a local export should carry: this library's facts plus the
 * index of ALL its volumes of that series, merged on top of the last cached
 * copy so entries another device published survive the round trip.
 *
 * `undefined` when the series has nothing to say (no facts, no volumes) — the
 * export then simply writes no sidecar.
 */
export async function buildSeriesFileForExport(
  seriesTitle: string
): Promise<SeriesFile | undefined> {
  const key = normalizeSeriesKey(seriesTitle);
  if (!key) return undefined;

  const allVolumes = (await db.volumes.toArray()) as VolumeMetadata[];
  const localVolumes = allVolumes.filter(
    (volume) => normalizeSeriesKey(volume.series_title) === key
  );
  const [meta, cached] = await Promise.all([
    getSeriesMetadataForTitle(seriesTitle),
    getSeriesIndex(key)
  ]);

  return buildSeriesFile({ seriesTitle, meta, localVolumes, existing: cached?.file });
}

/** The same file as a downloadable/embeddable sidecar, or `null`. */
export async function loadSeriesFileSidecar(seriesTitle: string): Promise<File | null> {
  const file = await buildSeriesFileForExport(seriesTitle);
  if (!file) return null;
  return new File([JSON.stringify(file, null, 2)], SERIES_FILE_NAME, {
    type: 'application/json'
  });
}

function extensionFromMimeType(contentType: string): string {
  const value = contentType.toLowerCase();
  if (value.includes('webp')) return 'webp';
  if (value.includes('png')) return 'png';
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg';
  if (value.includes('avif')) return 'avif';
  if (value.includes('gif')) return 'gif';
  return 'webp';
}

export async function loadVolumeSidecars(volumeUuid: string): Promise<VolumeSidecarFiles> {
  const volume = await db.volumes.get(volumeUuid);
  if (!volume) {
    throw new Error(`Volume ${volumeUuid} not found`);
  }

  let mokuroFile: File | null = null;
  const hasMokuroVersion =
    typeof volume.mokuro_version === 'string' && volume.mokuro_version.trim() !== '';
  if (hasMokuroVersion) {
    const volumeOcr = await db.volume_ocr.get(volumeUuid);
    if (volumeOcr?.pages) {
      const metadata = buildMokuroMetadata(volume, volumeOcr.pages);
      const blob = new Blob([JSON.stringify(metadata)], { type: 'application/json' });
      mokuroFile = new File([blob], `${volume.volume_title}.mokuro`, { type: 'application/json' });
    }
  }

  let thumbnailFile: File | null = null;
  if (volume.thumbnail) {
    const ext = extensionFromMimeType(volume.thumbnail.type || 'image/webp');
    thumbnailFile = new File([volume.thumbnail], `${volume.volume_title}.${ext}`, {
      type: volume.thumbnail.type || 'image/webp'
    });
  }

  const seriesFile = await loadSeriesFileSidecar(volume.series_title);

  return { mokuroFile, thumbnailFile, seriesFile };
}

export function downloadFileBlob(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  URL.revokeObjectURL(url);
}
