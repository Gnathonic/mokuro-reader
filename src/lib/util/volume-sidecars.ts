import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import type { MokuroMetadata } from './compress-volume';

export interface VolumeSidecarFiles {
  mokuroFile: File | null;
  thumbnailFile: File | null;
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

function buildMokuroMetadata(volume: VolumeMetadata, pages: unknown[]): MokuroMetadata {
  return {
    version: volume.mokuro_version,
    title: volume.series_title,
    title_uuid: volume.series_uuid,
    volume: volume.volume_title,
    volume_uuid: volume.volume_uuid,
    pages,
    chars: volume.character_count
  };
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

  return { mokuroFile, thumbnailFile };
}

export function downloadFileBlob(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  URL.revokeObjectURL(url);
}
