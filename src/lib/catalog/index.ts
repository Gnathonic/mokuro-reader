import { page } from '$app/stores';
import { db } from '$lib/catalog/db';
import { liveQuery } from 'dexie';
import { derived } from 'svelte/store';

// Get catalog entries sorted by last access time
export const catalog = liveQuery(() => 
  db.catalog
    .orderBy('lastAccessed')
    .reverse()
    .toArray()
);

// Get volumes for a specific manga, sorted by volume name
export const manga = derived([page], ([$page], set) => {
  if ($page?.params.manga) {
    db.volumes
      .where('catalogId')
      .equals($page.params.manga)
      .sortBy('volumeName')
      .then(set);
  }
});

// Get a specific volume by UUID
export const volume = derived([page], ([$page], set) => {
  if ($page?.params.volume) {
    db.volumes
      .get($page.params.volume)
      .then(set);
  }
});