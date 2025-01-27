import { page } from '$app/stores';
import { db, type Catalog } from '$lib/catalog/db';
import type { Volume } from '$lib/types';
import { liveQuery } from 'dexie';
import { derived, type Readable } from 'svelte/store';
import { VolumeCompat } from './VolumeCompat';

export const catalog = liveQuery(() => db.catalog.toArray());

function sortManga(a: Volume, b: Volume) {
  if (a.volumeName < b.volumeName) {
    return -1;
  }
  if (a.volumeName > b.volumeName) {
    return 1;
  }
  return 0;
}


export const manga = derived([page, catalog as unknown as Readable<Catalog[]>], ([$page, $catalog]) => {
  if ($page && $catalog) {
    const volumes = $catalog.find((item) => item.id === $page.params.manga)?.manga.sort(sortManga);
    return volumes?.map(v => VolumeCompat.from(v));
  }
});

export const volume = derived(([page, manga]), ([$page, $manga]) => {
  if ($page && $manga) {
    return $manga.find((item) => item.mokuroData.volume_uuid === $page.params.volume);
  }
})

export { VolumeCompat };