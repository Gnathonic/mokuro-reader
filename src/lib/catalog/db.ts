import type { Volume } from '$lib/types';
import Dexie, { type Table } from 'dexie';

export interface Catalog {
  id: string;
  manga: Volume[];
}

export interface FileEntry {
  id: string; // volumeUuid + filename
  file: Blob;
  volumeUuid: string;
  filename: string;
}

export class CatalogDexie extends Dexie {
  catalog!: Table<Catalog>;
  files!: Table<FileEntry>;

  constructor() {
    super('mokuro');
    this.version(1).stores({
      catalog: 'id, manga'
    });
    // Add compound index for faster title-based searches and sorting
    this.version(2).stores({
      catalog: 'id, manga, *manga.mokuroData.title'
    });
    // Add files store with indexes
    this.version(3).stores({
      catalog: 'id, manga, *manga.mokuroData.title',
      files: 'id, volumeUuid, filename'
    });
}

export const db = new CatalogDexie();
