import type { VolumeFiles, VolumeMetadata, VolumeOCR } from '$lib/types';
import { generateDeterministicUUID } from './series-extraction';

function hasOcr(mokuroVersion?: string): boolean {
  return typeof mokuroVersion === 'string' && mokuroVersion.trim() !== '';
}

export function shouldReplaceDownloadedVolume(
  existingVolume: VolumeMetadata | undefined,
  existingOcr: VolumeOCR | undefined,
  existingFiles: VolumeFiles | undefined,
  incomingMokuroVersion?: string
): boolean {
  if (!existingVolume) {
    return true;
  }

  if (!existingOcr || !existingFiles) {
    return true;
  }

  return hasOcr(incomingMokuroVersion) && !hasOcr(existingVolume.mokuro_version);
}

export function getLegacyImageOnlyVolumeUuid(volume: VolumeMetadata): string | null {
  const legacyUuid = generateDeterministicUUID(`${volume.series_title}/${volume.volume_title}`);
  return legacyUuid === volume.volume_uuid ? null : legacyUuid;
}
