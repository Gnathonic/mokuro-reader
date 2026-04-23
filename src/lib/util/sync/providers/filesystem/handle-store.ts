const DB_NAME = 'mokuro-filesystem-provider';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const ROOT_KEY = 'root';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const request = fn(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function saveRootHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore('readwrite', (store) => store.put(handle, ROOT_KEY));
}

export async function loadRootHandle(): Promise<FileSystemDirectoryHandle | null> {
  const result = await withStore('readonly', (store) => store.get(ROOT_KEY));
  return (result as FileSystemDirectoryHandle | undefined) ?? null;
}

export async function clearRootHandle(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(ROOT_KEY));
}
