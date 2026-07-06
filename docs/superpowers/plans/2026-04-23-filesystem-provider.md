# Filesystem Cloud Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `ProviderType = 'filesystem'` cloud sync provider that uses the File System Access API to back up and sync volumes to a user-chosen local directory, feature-gated on Chromium browsers.

**Architecture:** A new provider module under `src/lib/util/sync/providers/filesystem/` implements the existing `SyncProvider` interface. The picked `FileSystemDirectoryHandle` is persisted to a **dedicated IndexedDB database** owned by `handle-store.ts` — the main Dexie database is untouched. Existing sync orchestration (`unified-sync-service`, `backup-queue`, `cache-manager`) does not branch on this provider — it wires in through the same extension points as MEGA/WebDAV.

**Tech Stack:** SvelteKit 5, TypeScript, File System Access API (`window.showDirectoryPicker`), native IndexedDB (no Dexie here — isolated DB per spec), Vitest, Flowbite Svelte.

---

## File Structure

### Create

- `src/lib/util/sync/providers/filesystem/feature-detect.ts` — tiny pure function `isFilesystemProviderSupported()`
- `src/lib/util/sync/providers/filesystem/handle-store.ts` — dedicated IDB (`mokuro-filesystem-provider`, store `handles`, row key `'root'`), exposes `saveRootHandle` / `loadRootHandle` / `clearRootHandle`
- `src/lib/util/sync/providers/filesystem/filesystem-paths.ts` — pure path helpers (split path into segments, file-pattern matching for `.cbz` / `.mokuro` / `.mokuro.gz` / `.webp` / `volume-data.json` / `profiles.json`)
- `src/lib/util/sync/providers/filesystem/filesystem-provider.ts` — the `SyncProvider` implementation
- `src/lib/util/sync/providers/filesystem/filesystem-cache.ts` — `CloudCache<CloudFileMetadata>` wrapper, mirrors `webdav-cache.ts`
- `src/lib/util/sync/providers/filesystem/__tests__/filesystem-paths.test.ts` — unit tests for path helpers
- `src/lib/util/sync/providers/filesystem/__tests__/feature-detect.test.ts` — unit tests for feature detection
- `src/lib/util/sync/providers/filesystem/__tests__/handle-store.test.ts` — integration tests using `fake-indexeddb`

### Modify

- `src/lib/util/sync/provider-interface.ts` — extend `ProviderType`, add `FilesystemFileMetadata`, add `AnyCloudFileMetadata` union entry, extend `isRealProvider`
- `src/lib/util/sync/provider-detection.ts` — extend `'filesystem'` into `getActiveProviderKey`'s type guard
- `src/lib/util/sync/provider-manager.ts` — add `'filesystem': null` to status-store provider records (2 spots)
- `src/lib/util/sync/init-providers.ts` — add `'filesystem'` case in `loadProvider` (lazy import); extend whenReady branch to cover filesystem
- `src/lib/views/CloudView.svelte` — add provider button gated on `isFilesystemProviderSupported()`, add `filesystemAuth` derived, add `providerNames` + `providerInfo` entries, add login/reconnect/logout handlers, connected-state rendering
- `src/lib/components/BackupButton.svelte`, `src/lib/components/PlaceholderVolumeItem.svelte`, `src/lib/components/VolumeItem.svelte`, `src/lib/components/NavBar.svelte`, `src/lib/components/Catalog.svelte`, `src/lib/views/SeriesView.svelte` — _only_ if they pattern-match on specific provider literals in ways that would break with the new value; Task 11 inspects and touches them as needed.

---

## Task 1: Add `'filesystem'` to `ProviderType` union and related types

**Files:**

- Modify: `src/lib/util/sync/provider-interface.ts`

- [ ] **Step 1: Extend `ProviderType` and `isRealProvider`**

Open `src/lib/util/sync/provider-interface.ts`. Replace line 8:

```typescript
export type ProviderType = 'google-drive' | 'mega' | 'webdav';
```

with:

```typescript
export type ProviderType = 'google-drive' | 'mega' | 'webdav' | 'filesystem';
```

And on line 27-29, replace `isRealProvider`:

```typescript
export function isRealProvider(provider: BackupProviderType): provider is ProviderType {
  return (
    provider === 'google-drive' ||
    provider === 'mega' ||
    provider === 'webdav' ||
    provider === 'filesystem'
  );
}
```

- [ ] **Step 2: Add `FilesystemFileMetadata` and extend `AnyCloudFileMetadata`**

After the `WebDAVFileMetadata` interface (around line 187), add:

```typescript
/**
 * Filesystem (File System Access API) specific metadata
 * Extends base with no additional fields — path acts as the identifier.
 */
export interface FilesystemFileMetadata extends CloudFileMetadata {
  provider: 'filesystem';
}
```

Replace the `AnyCloudFileMetadata` union:

```typescript
export type AnyCloudFileMetadata =
  | DriveFileMetadata
  | MegaFileMetadata
  | WebDAVFileMetadata
  | FilesystemFileMetadata;
```

- [ ] **Step 3: Type-check**

Run: `npm run check`
Expected: passes. If it fails on `provider-manager.ts` or `provider-detection.ts` because of exhaustive Record keys, the later tasks cover those; proceed anyway but capture the error list.

- [ ] **Step 4: Commit**

```bash
git add src/lib/util/sync/provider-interface.ts
git commit -m "feat(sync): add 'filesystem' to ProviderType union"
```

---

## Task 2: Extend provider-detection for 'filesystem'

**Files:**

- Modify: `src/lib/util/sync/provider-detection.ts`

- [ ] **Step 1: Extend the type guard in `getActiveProviderKey`**

Open `src/lib/util/sync/provider-detection.ts`. Replace the `if` block on line 32:

```typescript
if (value === 'google-drive' || value === 'mega' || value === 'webdav') {
  return value;
}
```

with:

```typescript
if (value === 'google-drive' || value === 'mega' || value === 'webdav' || value === 'filesystem') {
  return value;
}
```

Do not add a legacy-detection branch inside `detectProviderFromCredentials()` — filesystem has no pre-existing localStorage credentials to migrate from.

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/lib/util/sync/provider-detection.ts
git commit -m "feat(sync): recognize filesystem provider in active-provider detection"
```

---

## Task 3: Add `'filesystem': null` to provider-manager status records

**Files:**

- Modify: `src/lib/util/sync/provider-manager.ts`

- [ ] **Step 1: Extend initial status-store record (constructor)**

Find the `writable<MultiProviderStatus>` initialization around line 27-36. Replace the `providers` record:

```typescript
    providers: {
      'google-drive': null,
      mega: null,
      webdav: null
    },
```

with:

```typescript
    providers: {
      'google-drive': null,
      mega: null,
      webdav: null,
      filesystem: null
    },
```

- [ ] **Step 2: Extend `updateStatus()` record (second occurrence)**

Find the identical `providers` initialization inside `updateStatus()` around line 214-218. Apply the same change.

- [ ] **Step 3: Type-check**

Run: `npm run check`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/lib/util/sync/provider-manager.ts
git commit -m "feat(sync): add filesystem slot to provider-manager status records"
```

---

## Task 4: Feature detection module + tests

**Files:**

- Create: `src/lib/util/sync/providers/filesystem/feature-detect.ts`
- Create: `src/lib/util/sync/providers/filesystem/__tests__/feature-detect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/util/sync/providers/filesystem/__tests__/feature-detect.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { isFilesystemProviderSupported } from '../feature-detect';

describe('isFilesystemProviderSupported', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'showDirectoryPicker');

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(window, 'showDirectoryPicker', originalDescriptor);
    } else {
      // @ts-expect-error — cleanup
      delete window.showDirectoryPicker;
    }
  });

  it('returns true when showDirectoryPicker is present on window', () => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: () => {},
      configurable: true
    });
    expect(isFilesystemProviderSupported()).toBe(true);
  });

  it('returns false when showDirectoryPicker is absent', () => {
    // @ts-expect-error — deliberate delete for test
    delete window.showDirectoryPicker;
    expect(isFilesystemProviderSupported()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/util/sync/providers/filesystem/__tests__/feature-detect.test.ts`
Expected: FAIL — `Cannot find module '../feature-detect'`.

- [ ] **Step 3: Implement `feature-detect.ts`**

Create `src/lib/util/sync/providers/filesystem/feature-detect.ts`:

```typescript
/**
 * Returns true when the current environment supports the File System Access API
 * (specifically `window.showDirectoryPicker`). Chromium-based browsers only.
 */
export function isFilesystemProviderSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/util/sync/providers/filesystem/__tests__/feature-detect.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/sync/providers/filesystem/feature-detect.ts src/lib/util/sync/providers/filesystem/__tests__/feature-detect.test.ts
git commit -m "feat(filesystem-provider): add feature-detect helper"
```

---

## Task 5: Path helpers + tests

**Files:**

- Create: `src/lib/util/sync/providers/filesystem/filesystem-paths.ts`
- Create: `src/lib/util/sync/providers/filesystem/__tests__/filesystem-paths.test.ts`

Sidecar filter list and `splitPathSegments` are shared across provider operations. Extract first so later tasks can import.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/util/sync/providers/filesystem/__tests__/filesystem-paths.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { splitPathSegments, isSyncableFile, getParentPath, getBasename } from '../filesystem-paths';

describe('splitPathSegments', () => {
  it('splits a typical volume path', () => {
    expect(splitPathSegments('Series/Volume.cbz')).toEqual(['Series', 'Volume.cbz']);
  });

  it('handles single-segment paths', () => {
    expect(splitPathSegments('volume-data.json')).toEqual(['volume-data.json']);
  });

  it('trims leading and trailing slashes', () => {
    expect(splitPathSegments('/Series/Volume.cbz/')).toEqual(['Series', 'Volume.cbz']);
  });

  it('drops empty segments from duplicate slashes', () => {
    expect(splitPathSegments('Series//Volume.cbz')).toEqual(['Series', 'Volume.cbz']);
  });

  it('returns empty array for empty string', () => {
    expect(splitPathSegments('')).toEqual([]);
  });
});

describe('isSyncableFile', () => {
  it.each([
    ['Series/Volume.cbz', true],
    ['Series/Volume.mokuro', true],
    ['Series/Volume.mokuro.gz', true],
    ['Series/Volume.webp', true],
    ['volume-data.json', true],
    ['profiles.json', true],
    ['Series/cover.jpg', false],
    ['.DS_Store', false],
    ['Series/Notes.txt', false],
    ['random.json', false]
  ])('%s -> %s', (name, expected) => {
    expect(isSyncableFile(name)).toBe(expected);
  });

  it('is case-insensitive on extensions', () => {
    expect(isSyncableFile('Series/Volume.CBZ')).toBe(true);
    expect(isSyncableFile('Series/Volume.Mokuro.GZ')).toBe(true);
  });
});

describe('getParentPath / getBasename', () => {
  it('splits a nested path', () => {
    expect(getParentPath('Series/Volume.cbz')).toBe('Series');
    expect(getBasename('Series/Volume.cbz')).toBe('Volume.cbz');
  });

  it('handles root-level files', () => {
    expect(getParentPath('volume-data.json')).toBe('');
    expect(getBasename('volume-data.json')).toBe('volume-data.json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/util/sync/providers/filesystem/__tests__/filesystem-paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `filesystem-paths.ts`**

Create `src/lib/util/sync/providers/filesystem/filesystem-paths.ts`:

```typescript
/**
 * Pure path helpers for the filesystem provider.
 * Paths are POSIX-style, relative to the picked root directory.
 */

export function splitPathSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

export function getBasename(path: string): string {
  const segments = splitPathSegments(path);
  return segments.length === 0 ? '' : segments[segments.length - 1];
}

export function getParentPath(path: string): string {
  const segments = splitPathSegments(path);
  return segments.slice(0, -1).join('/');
}

const SYNCABLE_EXTENSIONS = ['.cbz', '.mokuro', '.mokuro.gz', '.webp'];
const SYNCABLE_ROOT_FILENAMES = new Set(['volume-data.json', 'profiles.json']);

export function isSyncableFile(path: string): boolean {
  const basename = getBasename(path).toLowerCase();
  if (SYNCABLE_ROOT_FILENAMES.has(basename)) {
    return true;
  }
  return SYNCABLE_EXTENSIONS.some((ext) => basename.endsWith(ext));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/util/sync/providers/filesystem/__tests__/filesystem-paths.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/sync/providers/filesystem/filesystem-paths.ts src/lib/util/sync/providers/filesystem/__tests__/filesystem-paths.test.ts
git commit -m "feat(filesystem-provider): add path helpers"
```

---

## Task 6: Dedicated IDB handle store + tests

**Files:**

- Create: `src/lib/util/sync/providers/filesystem/handle-store.ts`
- Create: `src/lib/util/sync/providers/filesystem/__tests__/handle-store.test.ts`

This owns a standalone IndexedDB database (no Dexie) so the main app DB stays clean.

- [ ] **Step 1: Install fake-indexeddb if not already present**

Run: `npm ls fake-indexeddb 2>/dev/null | grep fake-indexeddb || npm install --save-dev fake-indexeddb`
Expected: either already installed or installed now. Check the added devDependency — if a new install, it will appear in `package.json`.

- [ ] **Step 2: Write the failing tests**

Create `src/lib/util/sync/providers/filesystem/__tests__/handle-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { saveRootHandle, loadRootHandle, clearRootHandle } from '../handle-store';

// Minimal fake that satisfies structured clone
function makeFakeHandle(name: string): FileSystemDirectoryHandle {
  return {
    kind: 'directory' as const,
    name
    // structured-clonable no-op methods not required for the test;
    // fake-indexeddb only needs the object to be structured-clonable
  } as unknown as FileSystemDirectoryHandle;
}

describe('handle-store', () => {
  beforeEach(async () => {
    // Reset the fake IDB for each test
    const { IDBFactory } = await import('fake-indexeddb');
    // @ts-expect-error — replace globally for isolation
    globalThis.indexedDB = new IDBFactory();
  });

  it('returns null when no handle has been saved', async () => {
    expect(await loadRootHandle()).toBeNull();
  });

  it('round-trips a saved handle', async () => {
    const handle = makeFakeHandle('Pictures');
    await saveRootHandle(handle);
    const loaded = await loadRootHandle();
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe('Pictures');
  });

  it('overwrites the previous handle on re-save', async () => {
    await saveRootHandle(makeFakeHandle('First'));
    await saveRootHandle(makeFakeHandle('Second'));
    const loaded = await loadRootHandle();
    expect(loaded?.name).toBe('Second');
  });

  it('clears a saved handle', async () => {
    await saveRootHandle(makeFakeHandle('Pictures'));
    await clearRootHandle();
    expect(await loadRootHandle()).toBeNull();
  });

  it('clear is idempotent when nothing is stored', async () => {
    await expect(clearRootHandle()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/util/sync/providers/filesystem/__tests__/handle-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `handle-store.ts`**

Create `src/lib/util/sync/providers/filesystem/handle-store.ts`:

```typescript
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/util/sync/providers/filesystem/__tests__/handle-store.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/util/sync/providers/filesystem/handle-store.ts src/lib/util/sync/providers/filesystem/__tests__/handle-store.test.ts package.json package-lock.json
git commit -m "feat(filesystem-provider): add dedicated IDB handle store"
```

---

## Task 7: FilesystemCacheManager (cache wrapper)

**Files:**

- Create: `src/lib/util/sync/providers/filesystem/filesystem-cache.ts`

This is a structural copy of `mega-cache.ts` / `webdav-cache.ts`. It has no provider-specific logic — it just groups metadata by series and exposes reactive stores. No new tests: it is covered by the existing cache-manager test suite once the filesystem provider is registered.

- [ ] **Step 1: Create `filesystem-cache.ts` by adapting the webdav-cache pattern**

Create `src/lib/util/sync/providers/filesystem/filesystem-cache.ts`:

```typescript
import { writable } from 'svelte/store';
import type { CloudCache } from '../../cloud-cache-interface';
import type { CloudFileMetadata } from '../../provider-interface';
import { filesystemProvider } from './filesystem-provider';

/**
 * Filesystem Cache Wrapper
 *
 * Returns Map<seriesTitle, CloudFileMetadata[]> for efficient series-based operations.
 * Cache is grouped by series folder names extracted from file paths.
 */
class FilesystemCacheManager implements CloudCache<CloudFileMetadata> {
  private cache = writable<Map<string, CloudFileMetadata[]>>(new Map());
  private isFetchingStore = writable<boolean>(false);
  private fetchingFlag = false;
  private loadedFlag = false;

  get store() {
    return this.cache;
  }

  get isFetchingState() {
    return this.isFetchingStore;
  }

  async fetch(): Promise<void> {
    if (this.fetchingFlag) {
      console.log('Filesystem cache fetch already in progress');
      return;
    }

    if (!filesystemProvider.isAuthenticated()) {
      console.log('Filesystem not authenticated, skipping cache fetch');
      return;
    }

    this.fetchingFlag = true;
    this.isFetchingStore.set(true);
    try {
      const volumes = await filesystemProvider.listCloudVolumes();

      const cacheMap = new Map<string, CloudFileMetadata[]>();
      for (const volume of volumes) {
        const seriesTitle = volume.path.split('/')[0];
        const existing = cacheMap.get(seriesTitle);
        if (existing) {
          existing.push(volume);
        } else {
          cacheMap.set(seriesTitle, [volume]);
        }
      }

      this.cache.set(cacheMap);
      this.loadedFlag = true;
      console.log(
        `✅ Filesystem cache populated with ${volumes.length} files in ${cacheMap.size} series`
      );
    } catch (error) {
      console.error('Failed to fetch filesystem cache:', error);
    } finally {
      this.fetchingFlag = false;
      this.isFetchingStore.set(false);
    }
  }

  has(path: string): boolean {
    let currentCache: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();
    const seriesTitle = path.split('/')[0];
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.some((f) => f.path === path) || false;
  }

  get(path: string): CloudFileMetadata | null {
    let currentCache: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();
    const seriesTitle = path.split('/')[0];
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.find((f) => f.path === path) || null;
  }

  getAll(path: string): CloudFileMetadata[] {
    let currentCache: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();
    const seriesTitle = path.split('/')[0];
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.filter((f) => f.path === path) || [];
  }

  getBySeries(seriesTitle: string): CloudFileMetadata[] {
    let currentCache: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();
    const result: CloudFileMetadata[] = [];
    for (const files of currentCache.values()) {
      result.push(...files.filter((file) => file.path.startsWith(`${seriesTitle}/`)));
    }
    return result;
  }

  getAllFiles(): CloudFileMetadata[] {
    let currentCache: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();
    const result: CloudFileMetadata[] = [];
    for (const files of currentCache.values()) {
      result.push(...files);
    }
    return result;
  }

  clear(): void {
    this.cache.set(new Map());
    this.loadedFlag = false;
  }

  isFetching(): boolean {
    return this.fetchingFlag;
  }

  isLoaded(): boolean {
    return this.loadedFlag;
  }

  add(path: string, metadata: CloudFileMetadata): void {
    this.cache.update((cache) => {
      const newCache = new Map(cache);
      const seriesTitle = path.split('/')[0];
      const existing = newCache.get(seriesTitle);
      if (existing) {
        const index = existing.findIndex((f) => f.fileId === metadata.fileId);
        if (index >= 0) {
          newCache.set(seriesTitle, [
            ...existing.slice(0, index),
            metadata,
            ...existing.slice(index + 1)
          ]);
        } else {
          newCache.set(seriesTitle, [...existing, metadata]);
        }
      } else {
        newCache.set(seriesTitle, [metadata]);
      }
      return newCache;
    });
  }

  removeById(fileId: string): void {
    this.cache.update((cache) => {
      const newCache = new Map(cache);
      for (const [path, files] of newCache.entries()) {
        const filtered = files.filter((f) => f.fileId !== fileId);
        if (filtered.length === 0) {
          newCache.delete(path);
        } else if (filtered.length !== files.length) {
          newCache.set(path, filtered);
        }
      }
      return newCache;
    });
  }

  update(fileId: string, updates: Partial<CloudFileMetadata>): void {
    this.cache.update((cache) => {
      const newCache = new Map(cache);
      for (const [path, files] of newCache.entries()) {
        const updated = files.map((file) =>
          file.fileId === fileId ? { ...file, ...updates } : file
        );
        newCache.set(path, updated);
      }
      return newCache;
    });
  }
}

export const filesystemCache = new FilesystemCacheManager();
```

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: will currently fail because `./filesystem-provider` doesn't exist yet. That is fine — Task 8 creates it and the check will pass after Task 8's type-check step. Commit now anyway; this is intentional: cache depends on provider, provider depends on cache, they self-register as a pair in Task 9.

- [ ] **Step 3: Commit**

```bash
git add src/lib/util/sync/providers/filesystem/filesystem-cache.ts
git commit -m "feat(filesystem-provider): add cache wrapper"
```

---

## Task 8: FilesystemProvider — class skeleton + login/logout/auth

**Files:**

- Create: `src/lib/util/sync/providers/filesystem/filesystem-provider.ts`

- [ ] **Step 1: Create the provider file with auth-only methods first**

Create `src/lib/util/sync/providers/filesystem/filesystem-provider.ts`:

```typescript
import { browser } from '$app/environment';
import type {
  SyncProvider,
  ProviderCredentials,
  ProviderStatus,
  CloudFileMetadata,
  StorageQuota,
  UploadPayload
} from '../../provider-interface';
import { ProviderError } from '../../provider-interface';
import { setActiveProviderKey, clearActiveProviderKey } from '../../provider-detection';
import { isFilesystemProviderSupported } from './feature-detect';
import { saveRootHandle, loadRootHandle, clearRootHandle } from './handle-store';
import { splitPathSegments, isSyncableFile, getBasename, getParentPath } from './filesystem-paths';

export class FilesystemProvider implements SyncProvider {
  readonly type = 'filesystem' as const;
  readonly name = 'Local Folder';
  readonly supportsWorkerDownload = false;
  readonly uploadConcurrencyLimit = 4;
  readonly downloadConcurrencyLimit = 4;

  private rootHandle: FileSystemDirectoryHandle | null = null;
  private hasStoredHandle = false;
  private initPromise: Promise<void>;

  constructor() {
    if (browser && isFilesystemProviderSupported()) {
      this.initPromise = this.restoreHandle();
    } else {
      this.initPromise = Promise.resolve();
    }
  }

  async whenReady(): Promise<void> {
    await this.initPromise;
  }

  isAuthenticated(): boolean {
    return this.rootHandle !== null;
  }

  getStatus(): ProviderStatus {
    return {
      isAuthenticated: this.isAuthenticated(),
      hasStoredCredentials: this.hasStoredHandle,
      needsAttention: this.hasStoredHandle && !this.isAuthenticated(),
      statusMessage: this.isAuthenticated()
        ? `Connected to folder "${this.rootHandle?.name ?? ''}"`
        : this.hasStoredHandle
          ? 'Folder permission needs to be reconnected'
          : 'Not configured'
    };
  }

  async login(_credentials?: ProviderCredentials): Promise<void> {
    if (!browser || !isFilesystemProviderSupported()) {
      throw new ProviderError(
        'File System Access API is not available in this browser',
        'filesystem',
        'UNSUPPORTED'
      );
    }

    let handle: FileSystemDirectoryHandle;
    try {
      // @ts-expect-error — File System Access API is Chromium-only, no lib.dom typing in all TS targets
      handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (error) {
      // User cancelled the picker or permission dismissed
      const message = error instanceof Error ? error.message : 'Folder selection cancelled';
      throw new ProviderError(message, 'filesystem', 'PICKER_CANCELLED');
    }

    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      throw new ProviderError(
        'Read-write permission was not granted for the selected folder',
        'filesystem',
        'PERMISSION_DENIED'
      );
    }

    this.rootHandle = handle;
    this.hasStoredHandle = true;
    await saveRootHandle(handle);
    setActiveProviderKey('filesystem');
    console.log(`✅ Filesystem provider connected to folder "${handle.name}"`);
  }

  async logout(): Promise<void> {
    this.rootHandle = null;
    this.hasStoredHandle = false;
    await clearRootHandle();
    clearActiveProviderKey();
    console.log('Filesystem provider logged out');
  }

  /**
   * Re-attempt to acquire read-write permission on the previously stored handle.
   * Must be called from a user-gesture event handler (button click).
   * Returns true on success, false if the user denied or the handle is invalid.
   */
  async reauthenticate(): Promise<void> {
    if (!this.hasStoredHandle) {
      throw new ProviderError('No stored folder to reconnect', 'filesystem', 'NOT_CONFIGURED');
    }
    const stored = await loadRootHandle();
    if (!stored) {
      this.hasStoredHandle = false;
      throw new ProviderError('Stored folder reference is missing', 'filesystem', 'NOT_CONFIGURED');
    }
    const permission = await stored.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      // Keep the stored handle — user may grant on a later attempt
      throw new ProviderError('Permission was not granted', 'filesystem', 'PERMISSION_DENIED');
    }
    this.rootHandle = stored;
    setActiveProviderKey('filesystem');
    console.log(`✅ Filesystem provider reconnected to folder "${stored.name}"`);
  }

  private async restoreHandle(): Promise<void> {
    try {
      const stored = await loadRootHandle();
      if (!stored) return;
      this.hasStoredHandle = true;
      const permission = await stored.queryPermission({ mode: 'readwrite' });
      if (permission === 'granted') {
        this.rootHandle = stored;
        console.log(`✅ Filesystem provider restored folder "${stored.name}"`);
      } else if (permission === 'denied') {
        // Clear on outright denial
        this.hasStoredHandle = false;
        await clearRootHandle();
        clearActiveProviderKey();
      }
      // 'prompt' → leave rootHandle null; UI will show "Reconnect"
    } catch (error) {
      console.warn('Failed to restore filesystem handle:', error);
    }
  }

  // Placeholder bodies — filled in by Task 9
  async listCloudVolumes(): Promise<CloudFileMetadata[]> {
    throw new Error('not implemented yet');
  }

  async uploadFile(
    _path: string,
    _blob: UploadPayload,
    _description?: string,
    _onProgress?: (loaded: number, total: number) => void
  ): Promise<string> {
    throw new Error('not implemented yet');
  }

  async downloadFile(
    _file: CloudFileMetadata,
    _onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    throw new Error('not implemented yet');
  }

  async deleteFile(_file: CloudFileMetadata): Promise<void> {
    throw new Error('not implemented yet');
  }

  async renameFile(_file: CloudFileMetadata, _newPath: string): Promise<CloudFileMetadata> {
    throw new Error('not implemented yet');
  }

  async renameFolder(_oldPath: string, _newPath: string): Promise<CloudFileMetadata[]> {
    throw new Error('not implemented yet');
  }

  async deleteSeriesFolder(_seriesTitle: string): Promise<void> {
    throw new Error('not implemented yet');
  }

  async getStorageQuota(): Promise<StorageQuota> {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
      return { used: 0, total: null, available: null };
    }
    const estimate = await navigator.storage.estimate();
    const used = estimate.usage ?? 0;
    const total = estimate.quota ?? null;
    const available = total !== null ? total - used : null;
    return { used, total, available };
  }
}

export const filesystemProvider = new FilesystemProvider();

// Self-register cache when module is loaded (same pattern as MEGA/WebDAV)
import { cacheManager } from '../../cache-manager';
import { filesystemCache } from './filesystem-cache';
cacheManager.registerCache('filesystem', filesystemCache);
```

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: passes.

- [ ] **Step 3: Verify the test suite still passes (sanity check — nothing references the provider yet beyond itself)**

Run: `npm test -- --run`
Expected: PASS — existing tests plus the new feature-detect / paths / handle-store suites.

- [ ] **Step 4: Commit**

```bash
git add src/lib/util/sync/providers/filesystem/filesystem-provider.ts
git commit -m "feat(filesystem-provider): scaffold provider with auth/restore/logout"
```

---

## Task 9: Implement file operations on FilesystemProvider

**Files:**

- Modify: `src/lib/util/sync/providers/filesystem/filesystem-provider.ts`

All of these methods share two private helpers: `resolveDirectoryHandle(path, { create })` and `resolveFileHandle(path, { create })`. Add those first, then replace each placeholder method body.

- [ ] **Step 1: Replace the placeholder implementations**

Open `src/lib/util/sync/providers/filesystem/filesystem-provider.ts`. Before the placeholder method bodies (i.e., immediately after the `restoreHandle` method), add these private helpers:

```typescript
  private requireRoot(): FileSystemDirectoryHandle {
    if (!this.rootHandle) {
      throw new ProviderError(
        'Filesystem provider is not connected',
        'filesystem',
        'NOT_AUTHENTICATED',
        true
      );
    }
    return this.rootHandle;
  }

  private async resolveDirectoryHandle(
    relativePath: string,
    options: { create: boolean }
  ): Promise<FileSystemDirectoryHandle> {
    const segments = splitPathSegments(relativePath);
    let handle: FileSystemDirectoryHandle = this.requireRoot();
    for (const segment of segments) {
      handle = await handle.getDirectoryHandle(segment, { create: options.create });
    }
    return handle;
  }

  private async resolveFileHandle(
    relativePath: string,
    options: { create: boolean }
  ): Promise<FileSystemFileHandle> {
    const parentPath = getParentPath(relativePath);
    const filename = getBasename(relativePath);
    if (!filename) {
      throw new ProviderError(
        `Invalid file path '${relativePath}'`,
        'filesystem',
        'INVALID_PATH'
      );
    }
    const parent = parentPath
      ? await this.resolveDirectoryHandle(parentPath, { create: options.create })
      : this.requireRoot();
    return parent.getFileHandle(filename, { create: options.create });
  }

  private async *walkDirectory(
    dir: FileSystemDirectoryHandle,
    prefix: string
  ): AsyncGenerator<{ path: string; fileHandle: FileSystemFileHandle }> {
    // @ts-expect-error — values() is defined on FileSystemDirectoryHandle at runtime; TS lib may not have it
    for await (const entry of dir.values()) {
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        yield* this.walkDirectory(entry as FileSystemDirectoryHandle, entryPath);
      } else if (entry.kind === 'file') {
        yield { path: entryPath, fileHandle: entry as FileSystemFileHandle };
      }
    }
  }
```

Now replace each placeholder method body in turn.

**`listCloudVolumes`:**

```typescript
  async listCloudVolumes(): Promise<CloudFileMetadata[]> {
    const root = this.requireRoot();
    const results: CloudFileMetadata[] = [];
    for await (const { path, fileHandle } of this.walkDirectory(root, '')) {
      if (!isSyncableFile(path)) continue;
      const file = await fileHandle.getFile();
      results.push({
        provider: 'filesystem',
        fileId: path,
        path,
        modifiedTime: new Date(file.lastModified).toISOString(),
        size: file.size
      });
    }
    console.log(`✅ Listed ${results.length} files from filesystem provider`);
    return results;
  }
```

**`uploadFile`:**

```typescript
  async uploadFile(
    path: string,
    blob: UploadPayload,
    _description?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string> {
    this.requireRoot();
    const fileHandle = await this.resolveFileHandle(path, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      const payload =
        blob instanceof Blob
          ? blob
          : blob instanceof ArrayBuffer
            ? new Blob([blob])
            : new Blob([blob]);
      await writable.write(payload);
      onProgress?.(payload.size, payload.size);
    } finally {
      await writable.close();
    }
    console.log(`✅ Uploaded ${path} to filesystem`);
    return path;
  }
```

**`downloadFile`:**

```typescript
  async downloadFile(
    file: CloudFileMetadata,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    this.requireRoot();
    const fileHandle = await this.resolveFileHandle(file.fileId, { create: false });
    const data = await fileHandle.getFile();
    onProgress?.(data.size, data.size);
    console.log(`✅ Downloaded ${file.path} from filesystem`);
    return data;
  }
```

**`deleteFile`:**

```typescript
  async deleteFile(file: CloudFileMetadata): Promise<void> {
    this.requireRoot();
    const parentPath = getParentPath(file.fileId);
    const filename = getBasename(file.fileId);
    const parent = parentPath
      ? await this.resolveDirectoryHandle(parentPath, { create: false })
      : this.requireRoot();
    await parent.removeEntry(filename);
    console.log(`✅ Deleted ${file.path} from filesystem`);
  }
```

**`renameFile`:**

The File System Access API has no native rename. Copy the bytes to the new path, then remove the old entry.

```typescript
  async renameFile(file: CloudFileMetadata, newPath: string): Promise<CloudFileMetadata> {
    this.requireRoot();
    const normalizedNewPath = newPath.replace(/^\/+|\/+$/g, '');
    if (file.path === normalizedNewPath) {
      return file;
    }

    // Read source
    const sourceHandle = await this.resolveFileHandle(file.fileId, { create: false });
    const sourceFile = await sourceHandle.getFile();

    // Write to destination
    const destHandle = await this.resolveFileHandle(normalizedNewPath, { create: true });
    const writable = await destHandle.createWritable();
    try {
      await writable.write(sourceFile);
    } finally {
      await writable.close();
    }

    // Delete source
    const sourceParentPath = getParentPath(file.fileId);
    const sourceParent = sourceParentPath
      ? await this.resolveDirectoryHandle(sourceParentPath, { create: false })
      : this.requireRoot();
    await sourceParent.removeEntry(getBasename(file.fileId));

    console.log(`✅ Renamed ${file.path} → ${normalizedNewPath} in filesystem`);
    const destFile = await destHandle.getFile();
    return {
      provider: 'filesystem',
      fileId: normalizedNewPath,
      path: normalizedNewPath,
      modifiedTime: new Date(destFile.lastModified).toISOString(),
      size: destFile.size
    };
  }
```

**`renameFolder`:**

```typescript
  async renameFolder(oldPath: string, newPath: string): Promise<CloudFileMetadata[]> {
    this.requireRoot();
    const normalizedOld = oldPath.replace(/^\/+|\/+$/g, '');
    const normalizedNew = newPath.replace(/^\/+|\/+$/g, '');
    if (normalizedOld === normalizedNew) {
      const all = await this.listCloudVolumes();
      return all.filter((f) => f.path.startsWith(`${normalizedOld}/`));
    }

    // List all files currently under the old folder and rename each one
    const all = await this.listCloudVolumes();
    const affected = all.filter((f) => f.path.startsWith(`${normalizedOld}/`));
    const renamed: CloudFileMetadata[] = [];
    for (const file of affected) {
      const suffix = file.path.slice(normalizedOld.length);
      const target = `${normalizedNew}${suffix}`;
      renamed.push(await this.renameFile(file, target));
    }

    // Best-effort cleanup of the now-empty old folder
    try {
      const parentPath = getParentPath(normalizedOld);
      const parent = parentPath
        ? await this.resolveDirectoryHandle(parentPath, { create: false })
        : this.requireRoot();
      await parent.removeEntry(getBasename(normalizedOld), { recursive: true });
    } catch {
      // Already gone or never existed — fine
    }

    console.log(`✅ Renamed folder ${normalizedOld} → ${normalizedNew} in filesystem`);
    return renamed;
  }
```

**`deleteSeriesFolder`:**

```typescript
  async deleteSeriesFolder(seriesTitle: string): Promise<void> {
    const root = this.requireRoot();
    const normalized = seriesTitle.replace(/^\/+|\/+$/g, '');
    if (!normalized) return;
    try {
      await root.removeEntry(normalized, { recursive: true });
      console.log(`✅ Deleted series folder '${seriesTitle}' from filesystem`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (/NotFoundError/.test(message)) {
        console.log(`Series folder '${seriesTitle}' not found in filesystem`);
        return;
      }
      throw new ProviderError(
        `Failed to delete series folder: ${message}`,
        'filesystem',
        'DELETE_FAILED'
      );
    }
  }
```

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: passes.

- [ ] **Step 3: Run full test suite**

Run: `npm test -- --run`
Expected: all existing tests plus the three new filesystem suites pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/util/sync/providers/filesystem/filesystem-provider.ts
git commit -m "feat(filesystem-provider): implement list/upload/download/delete/rename"
```

---

## Task 10: Wire filesystem provider into `init-providers.ts`

**Files:**

- Modify: `src/lib/util/sync/init-providers.ts`

- [ ] **Step 1: Add the dynamic-import case to `loadProvider`**

Open `src/lib/util/sync/init-providers.ts`. Inside the `switch (type)` block (around lines 16-31), add a new case:

```typescript
    case 'filesystem': {
      const { filesystemProvider } = await import(
        './providers/filesystem/filesystem-provider'
      );
      return filesystemProvider;
    }
```

Place it alphabetically — after the `'webdav'` case is fine, or rearrange if you prefer strict alpha. Keep it before the closing brace.

- [ ] **Step 2: Extend the `whenReady` branch to include filesystem**

Find the block starting `} else if (activeProviderType === 'mega' || activeProviderType === 'webdav') {` (around line 100). Replace it with:

```typescript
if (
  activeProviderType === 'mega' ||
  activeProviderType === 'webdav' ||
  activeProviderType === 'filesystem'
) {
  // MEGA, WebDAV, and filesystem restore credentials in their constructors via whenReady()
  console.log(`⏳ Waiting for ${activeProviderType} to restore credentials...`);
  await (activeProvider as any).whenReady();
  console.log(`✅ ${activeProviderType} credentials restored`);
}
```

- [ ] **Step 3: Type-check**

Run: `npm run check`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/lib/util/sync/init-providers.ts
git commit -m "feat(sync): lazy-load filesystem provider on startup"
```

---

## Task 11: Audit other files for literal provider-type matching

**Files (read-only audit first; may be modified):**

- `src/lib/components/Catalog.svelte`
- `src/lib/components/NavBar.svelte`
- `src/lib/components/PlaceholderVolumeItem.svelte`
- `src/lib/components/BackupButton.svelte`
- `src/lib/components/VolumeItem.svelte`
- `src/lib/components/UploadModal.svelte`
- `src/lib/components/AddLibraryModal.svelte`
- `src/lib/components/WebDAVErrorModal.svelte`
- `src/lib/views/LibraryManagerView.svelte`
- `src/lib/views/SeriesView.svelte`
- `src/lib/util/cloud-fields.ts`
- `src/lib/util/download-queue.ts`
- `src/lib/util/libraries/library-placeholders.ts`
- `src/lib/util/libraries/library-webdav-client.ts`
- `src/lib/import/types.ts`
- `src/lib/util/sync/unified-sync-service.ts`

- [ ] **Step 1: Audit**

Run the following:

```bash
grep -n "'mega'\|'webdav'\|'google-drive'" \
  src/lib/components/Catalog.svelte \
  src/lib/components/NavBar.svelte \
  src/lib/components/PlaceholderVolumeItem.svelte \
  src/lib/components/BackupButton.svelte \
  src/lib/components/VolumeItem.svelte \
  src/lib/components/UploadModal.svelte \
  src/lib/components/AddLibraryModal.svelte \
  src/lib/views/LibraryManagerView.svelte \
  src/lib/views/SeriesView.svelte \
  src/lib/util/cloud-fields.ts \
  src/lib/util/download-queue.ts \
  src/lib/util/libraries/library-placeholders.ts \
  src/lib/import/types.ts \
  src/lib/util/sync/unified-sync-service.ts
```

For every match, determine whether the code is provider-agnostic (calling methods on a `SyncProvider`) or pattern-matching on a specific literal. If it is provider-agnostic, no change needed. If it is matching literals, decide per site:

- **If the code handles provider-specific UX (e.g., "Google Drive" label, error formatting like `WebDAVErrorModal`)** — do nothing; filesystem does not need any of this.
- **If the code has an exhaustive `switch`/`if` over `ProviderType` that will miss `'filesystem'`** — add a filesystem branch matching the default/least-specific existing branch (usually the MEGA/WebDAV branch).

- [ ] **Step 2: For each file requiring a change, apply the minimum change**

Make those edits one file at a time. For each edit, type-check after:

```bash
npm run check
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test -- --run`
Expected: all tests pass. If any existing test fails because its mock data didn't include `'filesystem'`, update the test to include the new key with a `null` value (matching MEGA/WebDAV null-value patterns in the same test).

- [ ] **Step 4: Commit**

Only run this step if any file was actually modified.

```bash
git add <modified files>
git commit -m "feat(sync): include filesystem in exhaustive provider-type branches"
```

If no file was modified, skip this commit.

---

## Task 12: Wire filesystem into CloudView UI

**Files:**

- Modify: `src/lib/views/CloudView.svelte`

This is the main UX entry point. It needs:

1. A feature-detection import
2. A new provider button, hidden when unsupported
3. `providerNames` and `providerInfo` entries
4. Auth-state derived
5. Login / reconnect / logout handlers
6. Connected-state rendering for the new provider (simple — no file-picker, no RAM toggle, etc.)

- [ ] **Step 1: Add imports**

Near the top of the `<script>` block, add:

```typescript
import { isFilesystemProviderSupported } from '$lib/util/sync/providers/filesystem/feature-detect';
```

- [ ] **Step 2: Extend `providerNames`**

Replace:

```typescript
const providerNames: Record<ProviderType, string> = {
  'google-drive': 'Google Drive',
  mega: 'MEGA Cloud Storage',
  webdav: 'WebDAV Server'
};
```

with:

```typescript
const providerNames: Record<ProviderType, string> = {
  'google-drive': 'Google Drive',
  mega: 'MEGA Cloud Storage',
  webdav: 'WebDAV Server',
  filesystem: 'Local Folder'
};
```

- [ ] **Step 3: Extend `providerInfo`**

Replace the `providerInfo` object with:

```typescript
const providerInfo = {
  'google-drive': {
    items: [
      '15GB free storage',
      'Seamless Google account integration',
      'Back up from app, download on any device',
      'Auto re-authentication support'
    ]
  },
  mega: {
    items: [
      '20GB free storage',
      'End-to-end encryption',
      'Persistent login (no re-authentication needed)'
    ]
  },
  webdav: {
    items: [
      'Compatible with Nextcloud, ownCloud, and NAS devices',
      'Persistent login (no re-authentication needed)',
      'Self-hosted and private'
    ]
  },
  filesystem: {
    items: [
      'Uses a folder on this device',
      'Works offline — no account needed',
      'Browser-quota limited (not your disk free space)',
      'Chromium browsers only (Chrome, Edge, etc.)'
    ]
  }
};
```

- [ ] **Step 4: Add derived auth state and loading state**

After the existing `webdavAuth` / `webdavIsReadOnly` lines:

```typescript
let filesystemAuth = $derived(
  $providerStatusStore.providers['filesystem']?.isAuthenticated || false
);
let filesystemNeedsReconnect = $derived(
  ($providerStatusStore.providers['filesystem']?.hasStoredCredentials ?? false) &&
    !($providerStatusStore.providers['filesystem']?.isAuthenticated ?? false)
);

let filesystemLoading = $state(false);
let filesystemSupported = $state(false);
```

Inside `onMount`, after the existing setup, add:

```typescript
filesystemSupported = isFilesystemProviderSupported();
```

- [ ] **Step 5: Include filesystemAuth in the quota-fetch $effect**

Find the `$effect` that fetches storage quota (around line 131). Replace:

```typescript
const isAuthenticated = googleDriveAuth || megaAuth || webdavAuth;
```

with:

```typescript
const isAuthenticated = googleDriveAuth || megaAuth || webdavAuth || filesystemAuth;
```

- [ ] **Step 6: Add login / reconnect / logout wiring**

Below the existing `handleWebDAVLogin`, add:

```typescript
async function handleFilesystemLogin() {
  filesystemLoading = true;
  try {
    const provider = await providerManager.getOrLoadProvider('filesystem');
    await provider.login();
    await providerManager.setCurrentProvider(provider);
    showSnackbar('Connected to local folder - loading data...');
    await unifiedCloudManager.fetchAllCloudVolumes();
    providerManager.updateStatus();
    showSnackbar('Local folder connected');
    await handlePostLogin();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    showSnackbar(message);
  } finally {
    filesystemLoading = false;
  }
}

async function handleFilesystemReconnect() {
  filesystemLoading = true;
  try {
    const provider = await providerManager.getOrLoadProvider('filesystem');
    if (!provider.reauthenticate) {
      throw new Error('Provider does not support reconnect');
    }
    await provider.reauthenticate();
    await providerManager.setCurrentProvider(provider);
    providerManager.updateStatus();
    showSnackbar('Local folder reconnected');
    await unifiedCloudManager.fetchAllCloudVolumes();
    await handlePostLogin();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Reconnect failed';
    showSnackbar(message);
  } finally {
    filesystemLoading = false;
  }
}
```

Extend the `handleLogout` provider-specific cleanup:

```typescript
    } else if (provider === 'google-drive') {
      showSnackbar('Logged out of Google Drive');
    } else if (provider === 'filesystem') {
      showSnackbar('Local folder disconnected');
    }
```

- [ ] **Step 7: Add the "Local Folder" button to the provider-selection list**

Inside the `{#if !hasAnyProvider}` branch of the template, after the WebDAV button+form block (approximately line 700), add:

```svelte
<!-- Local Folder Option (Chromium-only) -->
{#if filesystemSupported}
  <button
    class="border-opacity-50 w-full rounded-lg border border-slate-600 p-6 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
    onclick={handleFilesystemLogin}
    disabled={filesystemLoading}
  >
    <div class="flex items-center gap-4">
      <div class="flex h-8 w-8 items-center justify-center text-2xl">📁</div>
      <div class="flex-1 text-left">
        <div class="text-lg font-semibold">Local Folder</div>
        <div class="text-sm text-gray-400">Any folder on this device • Offline • No account</div>
      </div>
    </div>
  </button>
{/if}
```

The emoji is acceptable here because it's already the pattern used for the MEGA ("M") and WebDAV ("W") buttons' icon-equivalent positions — do not add emojis elsewhere.

- [ ] **Step 8: Handle the "configured but needs reconnect" case**

The existing connected-state branch `{#if currentProvider}` renders whenever `hasAnyProvider` is true. When the handle needs reconnection, `filesystemNeedsReconnect` is true but the provider is not yet authenticated. Add a reconnect banner inside the connected branch, before the existing content, gated on the filesystem-specific case:

Find the block around line 726 that begins:

```svelte
          {#if currentProvider === 'webdav' && webdavIsReadOnly}
            <Alert color="yellow" class="mb-4">
```

Immediately before that `{#if}`, add:

```svelte
{#if currentProvider === 'filesystem' && filesystemNeedsReconnect}
  <Alert color="yellow" class="mb-4">
    {#snippet icon()}
      <InfoCircleSolid class="h-5 w-5" />
    {/snippet}
    <div class="flex flex-col gap-2">
      <span>
        <span class="font-medium">Permission needed:</span> Reconnect to grant the browser access to
        the folder you chose previously.
      </span>
      <Button
        size="xs"
        color="yellow"
        onclick={handleFilesystemReconnect}
        disabled={filesystemLoading}
      >
        {filesystemLoading ? 'Reconnecting...' : 'Reconnect folder'}
      </Button>
    </div>
  </Alert>
{/if}
```

- [ ] **Step 9: Type-check**

Run: `npm run check`
Expected: passes.

- [ ] **Step 10: Run dev server for smoke test**

Run: `npm run dev`

Manually verify in a Chromium browser:

1. Visit the Cloud tab. The "Local Folder" button is present.
2. Click it. Pick a folder. Grant read/write.
3. Observe the "Local folder connected" snackbar; UI switches to connected state.
4. Reload the tab. Observe it auto-reconnects silently (if the browser preserved permission) or shows the "Reconnect folder" banner (if it did not).
5. Click "Reconnect folder" → same flow, now authenticated.
6. Click "Log out". Confirm `active_cloud_provider` is cleared in Application DevTools → Local Storage.
7. Open Application DevTools → IndexedDB → `mokuro-filesystem-provider` → confirm it exists after connect, and is empty (no `root` row) after logout.

Then in a **Firefox** or **Safari** window, visit the Cloud tab and confirm the "Local Folder" button is _not_ rendered.

Stop the dev server.

- [ ] **Step 11: Commit**

```bash
git add src/lib/views/CloudView.svelte
git commit -m "feat(filesystem-provider): surface Local Folder option in CloudView"
```

---

## Task 13: End-to-end smoke test — backup, list, download, delete

**Files:** (no code changes)

- [ ] **Step 1: Manual end-to-end verification**

Run: `npm run dev`

In a Chromium browser:

1. Import a small volume (zip or cbz) into the library from the normal upload flow.
2. On Cloud tab, connect a fresh empty folder as Local Folder.
3. Click **Backup all series to cloud**. Confirm.
4. Verify on disk (outside the app) that the folder now contains `{SeriesTitle}/{VolumeTitle}.cbz` and a `volume-data.json` at root.
5. Delete the volume from the in-app catalog.
6. Tap the placeholder in the catalog to download it back — confirm it restores from the local folder.
7. Delete the series folder from the in-app catalog. Confirm the folder is removed from disk.
8. Rename a series from `SeriesView`. Confirm the folder on disk is renamed.
9. Log out. Log back in by picking the same folder. Confirm the list of volumes re-populates.

- [ ] **Step 2: If any step fails, open an issue note in the plan**

If anything fails, add a `## Follow-up issues` section to this plan file with a bullet describing what failed. Commit the plan update:

```bash
git add docs/superpowers/plans/2026-04-23-filesystem-provider.md
git commit -m "docs: note filesystem-provider follow-ups from smoke test"
```

Otherwise skip this step.

- [ ] **Step 3: Run the full suite once more to make sure nothing regressed**

Run:

```bash
npm run check
npm test -- --run
npm run lint
```

Expected: all three pass.

- [ ] **Step 4: Final commit (if any formatting touch-ups were needed from `npm run lint --fix` etc.)**

If `npm run lint` suggested auto-fixable issues, accept them and commit:

```bash
npm run format
git add -u
git commit -m "chore: formatting"
```

Otherwise skip.

---

## Self-Review Notes

Completed after drafting:

1. **Spec coverage:**
   - Feature detection → Task 4 ✓
   - Dedicated IDB handle store → Task 6 ✓
   - Login / restore / reconnect / logout → Task 8 ✓
   - File operations (list/upload/download/delete/rename/deleteSeriesFolder/getStorageQuota) → Task 9 ✓
   - `ProviderType` / `provider-detection` / `provider-manager` / `init-providers` extensions → Tasks 1-3, 10 ✓
   - CloudView UI gated on feature support → Task 12 ✓
   - No read-only support → enforced in Task 8's `login()` (throws unless permission is `'granted'`) ✓
   - File layout: picked root treated as root, sidecars filtered via `isSyncableFile` → Tasks 5, 9 ✓

2. **Placeholder scan:** No TODOs, no "add appropriate error handling" lines, every code step is complete.

3. **Type / method-name consistency:** `rootHandle`, `hasStoredHandle`, `saveRootHandle`, `loadRootHandle`, `clearRootHandle`, `resolveDirectoryHandle`, `resolveFileHandle`, `walkDirectory`, `requireRoot`, `isFilesystemProviderSupported`, `splitPathSegments`, `isSyncableFile`, `getBasename`, `getParentPath`, `filesystemProvider`, `filesystemCache` — all used consistently.

4. **Cross-task dependencies:** Task 7 (cache) imports from Task 8 (provider), and Task 8 imports from Task 7 — this is a self-register pattern matching MEGA/WebDAV, so Step 2 of Task 7 will fail type-check but Step 2 of Task 8 will succeed. Noted inline in Task 7.

5. **Audit task (Task 11):** Deliberately underspecified — the audit determines scope. If the audit finds no changes needed, the task is a no-op and produces no commit, which is fine.
