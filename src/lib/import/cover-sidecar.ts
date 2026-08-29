import type { VolumeMetadata } from '$lib/types';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import { normalizeFilename } from '$lib/util/misc';

function normalizeTitle(value: string): string {
  return normalizeFilename(value).trim().toLowerCase();
}

/**
 * The uuids that were already INSTALLED before an import ran.
 *
 * Deliberately not "every uuid that had a row": an import can fill a
 * metadata-only row, which keeps its uuid, and that row IS one of the volumes
 * this import brought in. Treating it as pre-existing would drop the cover
 * sidecar — or, worse, hand it to whichever unrelated volume happened to be
 * first in the "newly imported" list.
 */
export function installedUuids(volumes: VolumeMetadata[]): Set<string> {
  return new Set(volumes.filter(isVolumeInstalled).map((volume) => volume.volume_uuid));
}

/**
 * Which volume a downloaded cover sidecar belongs to: one that is installed now
 * and was not installed before, preferring the volume the request named.
 *
 * Returns `undefined` when the import produced nothing to attach it to.
 */
export function pickCoverTarget(
  volumes: VolumeMetadata[],
  installedBefore: Set<string>,
  requestVolume: string
): VolumeMetadata | undefined {
  const imported = volumes.filter(
    (volume) => isVolumeInstalled(volume) && !installedBefore.has(volume.volume_uuid)
  );
  if (imported.length === 0) return undefined;

  const wanted = normalizeTitle(requestVolume);
  return (
    imported.find((volume) => normalizeTitle(volume.volume_title) === wanted) ||
    imported.find((volume) => normalizeTitle(volume.volume_uuid) === wanted) ||
    imported[0]
  );
}
