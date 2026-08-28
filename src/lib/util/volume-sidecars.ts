import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { getSeriesIndex } from '$lib/metadata/series-index';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { buildSeriesFileFrom, type SeriesFile } from '$lib/metadata/series-file';
import { getSeriesMetadataForTitle } from '$lib/metadata/store';
import { buildMokuroMetadata } from './mokuro-metadata';

export interface VolumeSidecarFiles {
  mokuroFile: File | null;
  thumbnailFile: File | null;
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

  const [volumes, meta, cached] = await Promise.all([
    db.volumes.toArray() as Promise<VolumeMetadata[]>,
    getSeriesMetadataForTitle(seriesTitle),
    getSeriesIndex(key)
  ]);

  return buildSeriesFileFrom({ seriesTitle, meta, volumes, existing: cached?.file });
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

/**
 * Build a volume's sidecar Files from ALREADY-LOADED data — the single
 * serializer behind both feeds of the sidecar backfill: `loadVolumeSidecars`
 * hands it the Dexie rows, and the import-time feed (`sidecar-backfill.ts`)
 * hands it the exact objects `saveVolume` just committed. One serializer is
 * the byte-identity guarantee: a `.mokuro` uploaded at import time is
 * byte-for-byte the one a later backup would re-serialize from the database,
 * so the published size never drifts and `isSidecarStale` never fires on a
 * sidecar this device itself wrote.
 *
 * `pages` must therefore be DB-SHAPED — the stripped pages `volume_ocr`
 * stores (`cumulativeChars` removed, exactly what `saveVolume` writes) —
 * never the import pipeline's in-flight pages. Pass `null` when there is no
 * OCR row; an image-only volume (empty `mokuro_version`) never yields a
 * `.mokuro` either way.
 */
export function buildVolumeSidecarsFromData(
  volume: VolumeMetadata,
  pages: unknown[] | null
): VolumeSidecarFiles {
  let mokuroFile: File | null = null;
  const hasMokuroVersion =
    typeof volume.mokuro_version === 'string' && volume.mokuro_version.trim() !== '';
  if (hasMokuroVersion && pages) {
    const metadata = buildMokuroMetadata(volume, pages);
    const blob = new Blob([JSON.stringify(metadata)], { type: 'application/json' });
    mokuroFile = new File([blob], `${volume.volume_title}.mokuro`, { type: 'application/json' });
  }

  let thumbnailFile: File | null = null;
  if (volume.thumbnail) {
    const ext = extensionFromMimeType(volume.thumbnail.type || 'image/webp');
    thumbnailFile = new File([volume.thumbnail], `${volume.volume_title}.${ext}`, {
      type: volume.thumbnail.type || 'image/webp'
    });
  }

  return { mokuroFile, thumbnailFile };
}

/**
 * The per-VOLUME sidecars, loaded from the database. The series' `series.json`
 * is deliberately not one of them: building it reads the whole volumes table,
 * which a per-volume caller (the export loop) must not pay once per volume —
 * `buildSeriesFileForExport` is called once per series instead.
 */
export async function loadVolumeSidecars(volumeUuid: string): Promise<VolumeSidecarFiles> {
  const volume = await db.volumes.get(volumeUuid);
  if (!volume) {
    throw new Error(`Volume ${volumeUuid} not found`);
  }

  const hasMokuroVersion =
    typeof volume.mokuro_version === 'string' && volume.mokuro_version.trim() !== '';
  const volumeOcr = hasMokuroVersion ? await db.volume_ocr.get(volumeUuid) : undefined;
  return buildVolumeSidecarsFromData(volume, volumeOcr?.pages ?? null);
}

export function downloadFileBlob(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  URL.revokeObjectURL(url);
}
