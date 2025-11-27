/* global indexedDB, IDBDatabase */
import Dexie from 'dexie';

/**
 * Check if migration is needed by detecting if the old 'mokuro' database exists.
 * Returns the source version (1 or 2) if migration is needed, null otherwise.
 */
export async function checkMigrationNeeded(): Promise<1 | 2 | null> {
  // Check if old DB exists
  const databases = await indexedDB.databases();
  const oldDb = databases.find((db) => db.name === 'mokuro');

  if (!oldDb) return null;

  // Open without specifying version to detect schema
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('mokuro');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const stores = Array.from(db.objectStoreNames);
  db.close();

  // v1 has 'catalog' table but not 'volumes'
  if (stores.includes('catalog') && !stores.includes('volumes')) {
    return 1;
  }

  // v2 has both 'volumes' and 'volumes_data'
  if (stores.includes('volumes') && stores.includes('volumes_data')) {
    return 2;
  }

  // Unknown state - delete the old DB and continue
  return null;
}

/**
 * Delete the old 'mokuro' database.
 */
export async function deleteOldDatabase(): Promise<void> {
  await Dexie.delete('mokuro');
}
