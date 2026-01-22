import type { VolumeMetadata } from '$lib/types';

// Natural sorting collator that handles numbers properly
const naturalSort = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base'
});

export function sortVolumes(a: VolumeMetadata, b: VolumeMetadata) {
  return naturalSort.compare(a.volume_title, b.volume_title);
}
