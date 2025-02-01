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
  }
}

export const db = new CatalogDexie();
