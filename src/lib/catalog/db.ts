import type { Volume, VolumeFile } from '$lib/types';
import Dexie, { type Table } from 'dexie';

export interface Catalog {
  id: string;
  manga: Volume[];
}

export class CatalogDexie extends Dexie {
  catalog!: Table<Catalog>;
  volumeFiles!: Table<VolumeFile>;

  constructor() {
    super('mokuro');
    this.version(1).stores({
      catalog: 'id, manga'
    });
    // Add compound index for faster title-based searches and sorting
    this.version(2).stores({
      catalog: 'id, manga, *manga.mokuroData.title'
    });
    // Separate files into their own table for better performance
    this.version(3).stores({
      catalog: 'id, manga, *manga.mokuroData.title',
      volumeFiles: 'id, volumeId, path'
    }).upgrade(async tx => {
      // Migrate existing data
      const catalogs = await tx.table('catalog').toArray();
      const volumeFiles: VolumeFile[] = [];

      for (const catalog of catalogs) {
        for (const volume of catalog.manga) {
          // Generate an ID for the volume if it doesn't have one
          if (!volume.id) {
            volume.id = crypto.randomUUID();
          }

          // Convert files to file references
          const fileIds: Record<string, string> = {};
          for (const [path, file] of Object.entries(volume.files)) {
            const fileId = crypto.randomUUID();
            fileIds[path] = fileId;
            volumeFiles.push({
              id: fileId,
              volumeId: volume.id,
              path,
              file
            });
          }

          // Update volume to use file references
          delete (volume as any).files;
          volume.fileIds = fileIds;

          // Generate thumbnail from first page if available
          if (volume.mokuroData.pages.length > 0) {
            const firstPagePath = volume.mokuroData.pages[0].img_path;
            const firstPageFile = volumeFiles.find(f => f.path === firstPagePath)?.file;
            if (firstPageFile) {
              try {
                const img = document.createElement('img');
                img.src = URL.createObjectURL(firstPageFile);
                await new Promise((resolve, reject) => {
                  img.onload = resolve;
                  img.onerror = reject;
                });
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d')!;
                canvas.width = 200;
                canvas.height = (img.height * 200) / img.width;
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                volume.thumbnail = canvas.toDataURL('image/jpeg', 0.7);
                URL.revokeObjectURL(img.src);
              } catch (e) {
                console.error('Failed to generate thumbnail:', e);
              }
            }
          }
        }
      }

      // Save the updated catalogs
      await Promise.all(catalogs.map(catalog => 
        tx.table('catalog').put(catalog)
      ));

      // Save all volume files
      await tx.table('volumeFiles').bulkAdd(volumeFiles);
    });
  }
}

export const db = new CatalogDexie();
