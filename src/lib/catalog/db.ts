import type { Volume } from '$lib/types';
import Dexie, { type Table } from 'dexie';

export interface Catalog {
  id: string;
  title: string;
  lastAccessed: number;
}

export interface MangaVolume extends Volume {
  catalogId: string;
}

export class CatalogDexie extends Dexie {
  catalog!: Table<Catalog>;
  volumes!: Table<MangaVolume>;

  constructor() {
    super('mokuro');
    
    // Original schema
    this.version(1).stores({
      catalog: 'id, manga'
    });

    // Normalized schema with separate volumes table
    this.version(3)
      .stores({
        catalog: 'id, title, lastAccessed',
        volumes: 'mokuroData.volume_uuid, catalogId, volumeName'
      })
      .upgrade(tx => this.migrateToV3(tx));
  }

  private async migrateToV3(tx: Dexie.Transaction) {
    const oldCatalog = await tx.table('catalog').toArray();
    
    // Create new normalized entries
    for (const entry of oldCatalog) {
      // Add catalog entry
      await tx.table('catalog').put({
        id: entry.id,
        title: entry.manga[0].mokuroData.title,
        lastAccessed: Date.now()
      });

      // Add volumes
      for (const volume of entry.manga) {
        await tx.table('volumes').put({
          ...volume,
          catalogId: entry.id
        });
      }
    }
  }
}

export const db = new CatalogDexie();
