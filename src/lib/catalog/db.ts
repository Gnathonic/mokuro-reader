import type { Volume } from '$lib/types';
import Dexie, { type Table } from 'dexie';

export interface Catalog {
  id: string;
  manga: Volume[];
}

export class CatalogDexie extends Dexie {
  catalog!: Table<Catalog>;

  constructor() {
    super('mokuro');
    this.version(1).stores({
      catalog: 'id, manga'
    });
    // Add compound index for faster title-based searches and sorting
    this.version(2).stores({
      catalog: 'id, manga, *manga.mokuroData.title'
    });
  }
}

export const db = new CatalogDexie();
