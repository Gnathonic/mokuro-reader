# OneDrive Cloud Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth real sync provider (`'onedrive'`) that authenticates with MSAL.js against the Microsoft `common` tenant and syncs manga volumes to OneDrive via the Microsoft Graph API, with full worker-thread upload and download support.

**Architecture:** A new provider module under `src/lib/util/sync/providers/onedrive/` implements the existing `SyncProvider` interface. Authentication uses `@azure/msal-browser` (silent refresh via refresh tokens eliminates the popup-every-hour UX Drive suffers from). File transfers use Graph API resumable upload sessions (10 MiB chunks) and streaming downloads. A new `onedrive-core.ts` in the worker-core registry handles parallel worker-thread I/O under `WorkerPool`'s existing memory and concurrency throttling.

**Tech Stack:** SvelteKit 5, TypeScript, `@azure/msal-browser` (new dependency), Microsoft Graph API v1.0, XMLHttpRequest (for upload progress), native `fetch`, Vitest, Flowbite Svelte.

---

## File Structure

### Create

- `src/lib/util/sync/providers/onedrive/constants.ts` — env var, authority, scopes, folder names, storage keys, Graph base URL
- `src/lib/util/sync/providers/onedrive/token-manager.ts` — thin MSAL wrapper: login, logout, acquire tokens, active-account management
- `src/lib/util/sync/providers/onedrive/upload-session.ts` — pure chunking helpers for Graph resumable uploads
- `src/lib/util/sync/providers/onedrive/graph-client.ts` — typed wrapper over the Graph REST endpoints this provider uses
- `src/lib/util/sync/providers/onedrive/onedrive-provider.ts` — implements `SyncProvider`
- `src/lib/util/sync/providers/onedrive/onedrive-cache.ts` — `CloudCache<CloudFileMetadata>` wrapper, mirrors `webdav-cache.ts`
- `src/lib/util/sync/providers/onedrive/__tests__/upload-session.test.ts` — pure-function tests
- `src/lib/util/sync/providers/onedrive/__tests__/graph-client.test.ts` — fetch-mock tests for Graph operations
- `src/lib/util/sync/core/providers/onedrive-core.ts` — `CloudProviderCore` worker adapter (download + upload-session)
- `src/lib/util/sync/core/providers/__tests__/onedrive-core.test.ts` — fetch + XHR-mock tests for worker adapter

### Modify

- `package.json` — add `@azure/msal-browser` dependency
- `src/lib/util/sync/provider-interface.ts` — extend `ProviderType` to include `'onedrive'`, add `OneDriveFileMetadata` interface, extend `AnyCloudFileMetadata`, extend `isRealProvider`
- `src/lib/util/sync/provider-detection.ts` — add `'onedrive'` to `getActiveProviderKey` type guard
- `src/lib/util/sync/provider-manager.ts` — add `onedrive: null` slot to status-store provider records (two spots)
- `src/lib/util/sync/init-providers.ts` — add `'onedrive'` case in `loadProvider`; include onedrive in the `whenReady` branch
- `src/lib/util/sync/core/cloud-provider-core-registry.ts` — register `onedriveCore`
- `src/lib/views/CloudView.svelte` — new "OneDrive" provider button, `providerNames` + `providerInfo` entries, `onedriveAuth` derived, login/logout handlers, connected-state rendering

---

## Task 1: Add MSAL dependency

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install `@azure/msal-browser`**

Run:

```bash
npm install @azure/msal-browser
```

Expected: `@azure/msal-browser` added to `dependencies` in `package.json` (MSAL 3.x).

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @azure/msal-browser for OneDrive provider"
```

---

## Task 2: Add `'onedrive'` to `ProviderType` and related types

**Files:**

- Modify: `src/lib/util/sync/provider-interface.ts`

- [ ] **Step 1: Extend `ProviderType`**

Open `src/lib/util/sync/provider-interface.ts`. Replace:

```typescript
export type ProviderType = 'google-drive' | 'mega' | 'webdav' | 'filesystem';
```

with:

```typescript
export type ProviderType = 'google-drive' | 'mega' | 'webdav' | 'filesystem' | 'onedrive';
```

- [ ] **Step 2: Extend `isRealProvider`**

Replace:

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

with:

```typescript
export function isRealProvider(provider: BackupProviderType): provider is ProviderType {
  return (
    provider === 'google-drive' ||
    provider === 'mega' ||
    provider === 'webdav' ||
    provider === 'filesystem' ||
    provider === 'onedrive'
  );
}
```

- [ ] **Step 3: Add `OneDriveFileMetadata` and extend `AnyCloudFileMetadata`**

After the `FilesystemFileMetadata` interface, add:

```typescript
/**
 * OneDrive (Microsoft Graph) specific metadata.
 * `fileId` holds the opaque Graph driveItem.id.
 */
export interface OneDriveFileMetadata extends CloudFileMetadata {
  provider: 'onedrive';
  /** Parent folder driveItem id (useful for move/rename) */
  parentId?: string;
  /** Entity tag for conditional updates */
  etag?: string;
}
```

Replace the `AnyCloudFileMetadata` union to include the new type:

```typescript
export type AnyCloudFileMetadata =
  | DriveFileMetadata
  | MegaFileMetadata
  | WebDAVFileMetadata
  | FilesystemFileMetadata
  | OneDriveFileMetadata;
```

- [ ] **Step 4: Type-check**

Run: `npm run check`
Expected: file itself is internally valid. Errors in other files (`provider-manager.ts`, `CloudView.svelte`, etc.) are expected and are handled by later tasks.

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/sync/provider-interface.ts
git commit -m "feat(sync): add 'onedrive' to ProviderType union"
```

---

## Task 3: Extend `provider-detection.ts` for onedrive

**Files:**

- Modify: `src/lib/util/sync/provider-detection.ts`

- [ ] **Step 1: Extend type guard**

Replace the `if` block in `getActiveProviderKey`:

```typescript
if (value === 'google-drive' || value === 'mega' || value === 'webdav' || value === 'filesystem') {
  return value;
}
```

with:

```typescript
if (
  value === 'google-drive' ||
  value === 'mega' ||
  value === 'webdav' ||
  value === 'filesystem' ||
  value === 'onedrive'
) {
  return value;
}
```

Do NOT add a branch to `detectProviderFromCredentials()` — no legacy OneDrive credentials exist to migrate from.

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: the modified file is internally valid.

- [ ] **Step 3: Commit**

```bash
git add src/lib/util/sync/provider-detection.ts
git commit -m "feat(sync): recognize onedrive in active-provider detection"
```

---

## Task 4: Add `onedrive: null` slot to provider-manager

**Files:**

- Modify: `src/lib/util/sync/provider-manager.ts`

- [ ] **Step 1: Extend constructor record**

Find the `writable<MultiProviderStatus>` initialization. Replace:

```typescript
    providers: {
      'google-drive': null,
      mega: null,
      webdav: null,
      filesystem: null
    },
```

with:

```typescript
    providers: {
      'google-drive': null,
      mega: null,
      webdav: null,
      filesystem: null,
      onedrive: null
    },
```

- [ ] **Step 2: Extend `updateStatus()` record**

Find the second occurrence of the same record inside `updateStatus()` and apply the same change.

- [ ] **Step 3: Type-check**

Run: `npm run check`
Expected: no errors from provider-manager.ts itself.

- [ ] **Step 4: Commit**

```bash
git add src/lib/util/sync/provider-manager.ts
git commit -m "feat(sync): add onedrive slot to provider-manager status records"
```

---

## Task 5: Add `constants.ts`

**Files:**

- Create: `src/lib/util/sync/providers/onedrive/constants.ts`

- [ ] **Step 1: Create the constants file**

Create `src/lib/util/sync/providers/onedrive/constants.ts`:

```typescript
export const ONEDRIVE_CONFIG = {
  CLIENT_ID: import.meta.env.VITE_ONEDRIVE_CLIENT_ID as string | undefined,
  AUTHORITY: 'https://login.microsoftonline.com/common',
  SCOPES: ['Files.ReadWrite', 'offline_access', 'User.Read'],

  GRAPH_BASE_URL: 'https://graph.microsoft.com/v1.0',
  MOKURO_FOLDER: 'mokuro-reader',

  /** 10 MiB — Microsoft's recommended chunk size for upload sessions */
  UPLOAD_CHUNK_SIZE: 10 * 1024 * 1024,

  STORAGE_KEYS: {
    HAS_AUTHENTICATED: 'onedrive_has_authenticated'
  }
} as const;
```

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/lib/util/sync/providers/onedrive/constants.ts
git commit -m "feat(onedrive): add provider constants"
```

---

## Task 6: Upload-session chunking helpers + tests (TDD)

**Files:**

- Create: `src/lib/util/sync/providers/onedrive/upload-session.ts`
- Create: `src/lib/util/sync/providers/onedrive/__tests__/upload-session.test.ts`

Pure functions handling Graph upload-session chunking — easy to unit-test in isolation.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/util/sync/providers/onedrive/__tests__/upload-session.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createChunkRanges, parseNextExpectedRange } from '../upload-session';

describe('createChunkRanges', () => {
  it('produces a single chunk when payload fits in one chunk', () => {
    const chunks = [...createChunkRanges(500, 1024)];
    expect(chunks).toEqual([{ start: 0, end: 499, total: 500 }]);
  });

  it('splits at chunk boundary', () => {
    const chunks = [...createChunkRanges(2048, 1024)];
    expect(chunks).toEqual([
      { start: 0, end: 1023, total: 2048 },
      { start: 1024, end: 2047, total: 2048 }
    ]);
  });

  it('handles a last chunk smaller than chunk size', () => {
    const chunks = [...createChunkRanges(1500, 1024)];
    expect(chunks).toEqual([
      { start: 0, end: 1023, total: 1500 },
      { start: 1024, end: 1499, total: 1500 }
    ]);
  });

  it('throws on zero-length payload', () => {
    expect(() => [...createChunkRanges(0, 1024)]).toThrow();
  });

  it('throws on non-positive chunk size', () => {
    expect(() => [...createChunkRanges(500, 0)]).toThrow();
    expect(() => [...createChunkRanges(500, -10)]).toThrow();
  });

  it('supports resuming from a given start byte', () => {
    const chunks = [...createChunkRanges(2048, 1024, 1024)];
    expect(chunks).toEqual([{ start: 1024, end: 2047, total: 2048 }]);
  });
});

describe('parseNextExpectedRange', () => {
  it('returns start byte of the first range', () => {
    expect(parseNextExpectedRange(['1024-2047'])).toBe(1024);
  });

  it('handles open-ended ranges', () => {
    expect(parseNextExpectedRange(['1024-'])).toBe(1024);
  });

  it('returns null for empty array', () => {
    expect(parseNextExpectedRange([])).toBeNull();
  });

  it('returns null for malformed range', () => {
    expect(parseNextExpectedRange(['not-a-range'])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/util/sync/providers/onedrive/__tests__/upload-session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `upload-session.ts`**

Create `src/lib/util/sync/providers/onedrive/upload-session.ts`:

```typescript
/**
 * Yields one ChunkRange per Graph upload-session PUT request.
 * Resumable from any byte offset (use `resumeFrom` after a partial upload).
 *
 * Ranges are inclusive-inclusive: `start` and `end` both name actual byte
 * positions, matching the HTTP `Content-Range` header format Graph expects.
 */
export interface ChunkRange {
  start: number;
  end: number;
  total: number;
}

export function* createChunkRanges(
  totalSize: number,
  chunkSize: number,
  resumeFrom = 0
): Generator<ChunkRange> {
  if (totalSize <= 0) {
    throw new Error('totalSize must be positive');
  }
  if (chunkSize <= 0) {
    throw new Error('chunkSize must be positive');
  }

  let start = resumeFrom;
  while (start < totalSize) {
    const end = Math.min(start + chunkSize - 1, totalSize - 1);
    yield { start, end, total: totalSize };
    start = end + 1;
  }
}

/**
 * Parses Graph's `nextExpectedRanges` (e.g. ["1024-2047"] or ["1024-"]).
 * Returns the first start byte, or null if no valid range is present.
 * Used after a network blip to resume the upload at the correct offset.
 */
export function parseNextExpectedRange(ranges: string[]): number | null {
  if (ranges.length === 0) return null;
  const match = ranges[0].match(/^(\d+)-/);
  if (!match) return null;
  return parseInt(match[1], 10);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/util/sync/providers/onedrive/__tests__/upload-session.test.ts`
Expected: PASS (12 assertions across 10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/sync/providers/onedrive/upload-session.ts src/lib/util/sync/providers/onedrive/__tests__/upload-session.test.ts
git commit -m "feat(onedrive): add upload-session chunking helpers"
```

---

## Task 7: Graph API client + tests (TDD)

**Files:**

- Create: `src/lib/util/sync/providers/onedrive/graph-client.ts`
- Create: `src/lib/util/sync/providers/onedrive/__tests__/graph-client.test.ts`

The Graph client wraps the specific endpoints this provider uses. Credentials are passed in per-call rather than stored — keeps it stateless and testable.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/util/sync/providers/onedrive/__tests__/graph-client.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getDriveQuota,
  listChildren,
  createFolder,
  deleteItem,
  patchItem,
  createUploadSession,
  getItemByPath
} from '../graph-client';

const BASE = 'https://graph.microsoft.com/v1.0';

describe('graph-client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  describe('getDriveQuota', () => {
    it('returns quota object from /me/drive', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ quota: { used: 100, total: 1000, remaining: 900 } })
      } as Response);

      const quota = await getDriveQuota('TOKEN');

      expect(quota).toEqual({ used: 100, total: 1000, remaining: 900 });
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(`${BASE}/me/drive`);
      expect((call[1] as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer TOKEN'
      });
    });

    it('throws on non-ok response', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => ''
      } as Response);

      await expect(getDriveQuota('TOKEN')).rejects.toThrow(/401/);
    });
  });

  describe('listChildren', () => {
    it('fetches children of a path', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          value: [
            { id: 'a', name: 'Series', folder: {} },
            { id: 'b', name: 'v1.cbz', file: {}, size: 100, lastModifiedDateTime: 'x' }
          ]
        })
      } as Response);

      const items = await listChildren('TOKEN', 'mokuro-reader');

      expect(items).toHaveLength(2);
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(`${BASE}/me/drive/root:/mokuro-reader:/children`);
    });

    it('returns empty array for an empty folder', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ value: [] })
      } as Response);
      expect(await listChildren('TOKEN', 'x')).toEqual([]);
    });

    it('URL-encodes path segments', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ value: [] })
      } as Response);
      await listChildren('TOKEN', 'mokuro-reader/Test Series');
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toContain('Test%20Series');
    });
  });

  describe('getItemByPath', () => {
    it('returns the item when found', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'abc', name: 'thing' })
      } as Response);
      const item = await getItemByPath('TOKEN', 'mokuro-reader');
      expect(item).toEqual({ id: 'abc', name: 'thing' });
    });

    it('returns null on 404', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => ''
      } as Response);
      const item = await getItemByPath('TOKEN', 'missing');
      expect(item).toBeNull();
    });
  });

  describe('createFolder', () => {
    it('POSTs to children with folder facet', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'new-folder', name: 'mokuro-reader' })
      } as Response);

      const item = await createFolder('TOKEN', '', 'mokuro-reader');

      expect(item.id).toBe('new-folder');
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(`${BASE}/me/drive/root/children`);
      expect((call[1] as RequestInit).method).toBe('POST');
      expect(JSON.parse((call[1] as RequestInit).body as string)).toMatchObject({
        name: 'mokuro-reader',
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail'
      });
    });

    it('creates a nested folder under an existing path', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'nested' })
      } as Response);

      await createFolder('TOKEN', 'mokuro-reader', 'Series X');

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(`${BASE}/me/drive/root:/mokuro-reader:/children`);
    });
  });

  describe('deleteItem', () => {
    it('DELETEs /items/{id}', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 204 } as Response);

      await deleteItem('TOKEN', 'item-id-123');

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(`${BASE}/me/drive/items/item-id-123`);
      expect((call[1] as RequestInit).method).toBe('DELETE');
    });

    it('treats 404 as success (idempotent delete)', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => ''
      } as Response);
      await expect(deleteItem('TOKEN', 'missing')).resolves.toBeUndefined();
    });
  });

  describe('patchItem', () => {
    it('PATCHes /items/{id} with name/parent body', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'item', name: 'new-name' })
      } as Response);

      await patchItem('TOKEN', 'item', { name: 'new-name', parentReference: { id: 'parent' } });

      const call = vi.mocked(fetch).mock.calls[0];
      expect((call[1] as RequestInit).method).toBe('PATCH');
      expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
        name: 'new-name',
        parentReference: { id: 'parent' }
      });
    });
  });

  describe('createUploadSession', () => {
    it('POSTs to createUploadSession and returns uploadUrl', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ uploadUrl: 'https://upload.microsoft.com/xyz' })
      } as Response);

      const url = await createUploadSession('TOKEN', 'mokuro-reader/Series/v1.cbz');

      expect(url).toBe('https://upload.microsoft.com/xyz');
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(
        `${BASE}/me/drive/root:/mokuro-reader/Series/v1.cbz:/createUploadSession`
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/util/sync/providers/onedrive/__tests__/graph-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `graph-client.ts`**

Create `src/lib/util/sync/providers/onedrive/graph-client.ts`:

```typescript
import { ONEDRIVE_CONFIG } from './constants';

const BASE = ONEDRIVE_CONFIG.GRAPH_BASE_URL;

export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  eTag?: string;
  folder?: Record<string, unknown>;
  file?: Record<string, unknown>;
  parentReference?: { id?: string; path?: string };
}

export interface DriveQuota {
  used: number;
  total: number;
  remaining: number;
}

function authHeaders(accessToken: string, extra?: HeadersInit): HeadersInit {
  return { Authorization: `Bearer ${accessToken}`, ...(extra ?? {}) };
}

function encodePath(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

async function parseError(response: Response): Promise<never> {
  const text = await response.text().catch(() => '');
  throw new Error(`Graph ${response.status} ${response.statusText}: ${text || '(no body)'}`);
}

export async function getDriveQuota(accessToken: string): Promise<DriveQuota> {
  const response = await fetch(`${BASE}/me/drive`, { headers: authHeaders(accessToken) });
  if (!response.ok) await parseError(response);
  const data = (await response.json()) as { quota?: DriveQuota };
  return (
    data.quota ?? {
      used: 0,
      total: 0,
      remaining: 0
    }
  );
}

export async function listChildren(accessToken: string, path: string): Promise<DriveItem[]> {
  const url = path
    ? `${BASE}/me/drive/root:/${encodePath(path)}:/children`
    : `${BASE}/me/drive/root/children`;
  const response = await fetch(url, { headers: authHeaders(accessToken) });
  if (!response.ok) await parseError(response);
  const data = (await response.json()) as { value: DriveItem[] };
  return data.value;
}

export async function getItemByPath(accessToken: string, path: string): Promise<DriveItem | null> {
  const url = path ? `${BASE}/me/drive/root:/${encodePath(path)}` : `${BASE}/me/drive/root`;
  const response = await fetch(url, { headers: authHeaders(accessToken) });
  if (response.status === 404) return null;
  if (!response.ok) await parseError(response);
  return (await response.json()) as DriveItem;
}

export async function createFolder(
  accessToken: string,
  parentPath: string,
  name: string
): Promise<DriveItem> {
  const url = parentPath
    ? `${BASE}/me/drive/root:/${encodePath(parentPath)}:/children`
    : `${BASE}/me/drive/root/children`;
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(accessToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail'
    })
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as DriveItem;
}

export async function deleteItem(accessToken: string, itemId: string): Promise<void> {
  const response = await fetch(`${BASE}/me/drive/items/${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
    headers: authHeaders(accessToken)
  });
  // Treat 404 as idempotent success
  if (response.status === 404) return;
  if (!response.ok && response.status !== 204) await parseError(response);
}

export interface PatchItemBody {
  name?: string;
  parentReference?: { id: string };
}

export async function patchItem(
  accessToken: string,
  itemId: string,
  body: PatchItemBody
): Promise<DriveItem> {
  const response = await fetch(`${BASE}/me/drive/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers: authHeaders(accessToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as DriveItem;
}

export async function createUploadSession(accessToken: string, path: string): Promise<string> {
  const response = await fetch(`${BASE}/me/drive/root:/${encodePath(path)}:/createUploadSession`, {
    method: 'POST',
    headers: authHeaders(accessToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      item: { '@microsoft.graph.conflictBehavior': 'replace' }
    })
  });
  if (!response.ok) await parseError(response);
  const data = (await response.json()) as { uploadUrl: string };
  return data.uploadUrl;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/util/sync/providers/onedrive/__tests__/graph-client.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/sync/providers/onedrive/graph-client.ts src/lib/util/sync/providers/onedrive/__tests__/graph-client.test.ts
git commit -m "feat(onedrive): add Microsoft Graph REST client"
```

---

## Task 8: Token manager (MSAL wrapper)

**Files:**

- Create: `src/lib/util/sync/providers/onedrive/token-manager.ts`

The token manager is a thin singleton wrapping MSAL's `PublicClientApplication`. No dedicated unit tests — MSAL has its own extensive tests and mocking the MSAL internals provides little real coverage. The adapter is small and exercised end-to-end via the provider's integration with Graph and via the manual smoke test in Task 16.

- [ ] **Step 1: Create `token-manager.ts`**

Create `src/lib/util/sync/providers/onedrive/token-manager.ts`:

```typescript
import { browser } from '$app/environment';
import { writable, type Readable } from 'svelte/store';
import type {
  PublicClientApplication,
  AccountInfo,
  AuthenticationResult,
  Configuration,
  PopupRequest,
  SilentRequest
} from '@azure/msal-browser';
import { ONEDRIVE_CONFIG } from './constants';

type Msal = typeof import('@azure/msal-browser');

class OneDriveTokenManager {
  private instance: PublicClientApplication | null = null;
  private account: AccountInfo | null = null;
  private msal: Msal | null = null;

  private tokenStore = writable<string>('');
  private needsAttentionStore = writable<boolean>(false);

  get token(): Readable<string> {
    return this.tokenStore;
  }

  get needsAttention(): Readable<boolean> {
    return this.needsAttentionStore;
  }

  private initPromise: Promise<void> | null = null;

  /**
   * Initialize MSAL. Safe to call multiple times — returns the same promise.
   */
  async initialize(): Promise<void> {
    if (!browser) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const clientId = ONEDRIVE_CONFIG.CLIENT_ID;
      if (!clientId) {
        throw new Error(
          'VITE_ONEDRIVE_CLIENT_ID is not set. Register an Azure AD app and set the env var.'
        );
      }

      this.msal = await import('@azure/msal-browser');
      const config: Configuration = {
        auth: {
          clientId,
          authority: ONEDRIVE_CONFIG.AUTHORITY,
          redirectUri: window.location.origin
        },
        cache: {
          cacheLocation: 'localStorage',
          storeAuthStateInCookie: false
        }
      };
      this.instance = new this.msal.PublicClientApplication(config);
      await this.instance.initialize();

      // Restore account from MSAL cache (if a previous session exists)
      const accounts = this.instance.getAllAccounts();
      if (accounts.length > 0) {
        this.account = accounts[0];
        this.instance.setActiveAccount(this.account);
      }
    })();

    return this.initPromise;
  }

  isAuthenticated(): boolean {
    return this.account !== null && !!this.instance;
  }

  hasStoredCredentials(): boolean {
    if (!browser) return false;
    return localStorage.getItem(ONEDRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED) === 'true';
  }

  getActiveAccountName(): string | null {
    return this.account?.name ?? this.account?.username ?? null;
  }

  async login(): Promise<void> {
    await this.initialize();
    if (!this.instance || !this.msal) {
      throw new Error('MSAL instance not initialized');
    }

    const request: PopupRequest = { scopes: ONEDRIVE_CONFIG.SCOPES };
    const result: AuthenticationResult = await this.instance.loginPopup(request);

    this.account = result.account;
    this.instance.setActiveAccount(result.account);
    this.tokenStore.set(result.accessToken);
    this.needsAttentionStore.set(false);

    localStorage.setItem(ONEDRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED, 'true');
  }

  async logout(): Promise<void> {
    if (this.instance && this.account) {
      await this.instance.logoutPopup({
        account: this.account,
        mainWindowRedirectUri: window.location.origin
      });
    }
    this.account = null;
    this.tokenStore.set('');
    this.needsAttentionStore.set(false);
    if (browser) {
      localStorage.removeItem(ONEDRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED);
    }
  }

  /**
   * Acquire an access token. Uses the silent cache first, throws if MSAL
   * signals interaction required (the caller should prompt the user via
   * reauthenticate()).
   */
  async getAccessToken(): Promise<string> {
    await this.initialize();
    if (!this.instance || !this.account || !this.msal) {
      throw new Error('Not authenticated with OneDrive');
    }
    const request: SilentRequest = {
      scopes: ONEDRIVE_CONFIG.SCOPES,
      account: this.account
    };
    try {
      const result = await this.instance.acquireTokenSilent(request);
      this.tokenStore.set(result.accessToken);
      this.needsAttentionStore.set(false);
      return result.accessToken;
    } catch (error) {
      if (error instanceof this.msal.InteractionRequiredAuthError) {
        this.needsAttentionStore.set(true);
      }
      throw error;
    }
  }

  /**
   * Popup-based re-authentication. Used by the UI when silent refresh fails
   * and the user clicks a "reconnect" action.
   */
  async reauthenticate(): Promise<void> {
    await this.initialize();
    if (!this.instance) {
      throw new Error('MSAL not initialized');
    }
    const request: PopupRequest = {
      scopes: ONEDRIVE_CONFIG.SCOPES,
      account: this.account ?? undefined
    };
    const result = await this.instance.acquireTokenPopup(request);
    this.account = result.account;
    this.instance.setActiveAccount(result.account);
    this.tokenStore.set(result.accessToken);
    this.needsAttentionStore.set(false);
  }
}

export const onedriveTokenManager = new OneDriveTokenManager();
```

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: passes (the import of `@azure/msal-browser` is resolvable now that Task 1 added the dependency).

- [ ] **Step 3: Commit**

```bash
git add src/lib/util/sync/providers/onedrive/token-manager.ts
git commit -m "feat(onedrive): add MSAL-based token manager"
```

---

## Task 9: OneDrive worker core + tests

**Files:**

- Create: `src/lib/util/sync/core/providers/onedrive-core.ts`
- Create: `src/lib/util/sync/core/providers/__tests__/onedrive-core.test.ts`

The worker-core implementation. Download uses XHR for progress events; upload uses `fetch` with upload-session chunking. Both receive `{ accessToken }` credentials.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/util/sync/core/providers/__tests__/onedrive-core.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { onedriveCore } from '../onedrive-core';

describe('onedriveCore', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  describe('uploadFile', () => {
    it('creates an upload session and PUTs the full payload in one chunk', async () => {
      const seriesFolderPath = 'mokuro-reader/Series';
      const filename = 'v1.cbz';

      // 1st call: createUploadSession
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
      } as Response);

      // 2nd call: PUT chunk returns the completed driveItem
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'new-item-id', name: filename })
      } as Response);

      const blob = new Blob([new Uint8Array(1000)]);
      const id = await onedriveCore.uploadFile({
        seriesTitle: seriesFolderPath,
        filename,
        blob,
        credentials: { accessToken: 'TOKEN' }
      });

      expect(id).toBe('new-item-id');
      const initCall = vi.mocked(fetch).mock.calls[0];
      expect(initCall[0]).toContain(':/createUploadSession');
      const putCall = vi.mocked(fetch).mock.calls[1];
      expect(putCall[0]).toBe('https://upload.example/xyz');
      expect((putCall[1] as RequestInit).method).toBe('PUT');
      expect((putCall[1] as RequestInit).headers).toMatchObject({
        'Content-Range': 'bytes 0-999/1000',
        'Content-Length': '1000'
      });
    });

    it('splits payload into multiple chunks when larger than chunk size', async () => {
      // Session init
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
      } as Response);
      // Chunk 1 (accepted, continue)
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ nextExpectedRanges: [`${10 * 1024 * 1024}-`] })
      } as Response);
      // Chunk 2 (completed)
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'done', name: 'v1.cbz' })
      } as Response);

      const blob = new Blob([new Uint8Array(15 * 1024 * 1024)]);
      const id = await onedriveCore.uploadFile({
        seriesTitle: 'Series',
        filename: 'v1.cbz',
        blob,
        credentials: { accessToken: 'TOKEN' }
      });

      expect(id).toBe('done');
      expect(vi.mocked(fetch).mock.calls).toHaveLength(3);
      const firstChunk = vi.mocked(fetch).mock.calls[1];
      expect((firstChunk[1] as RequestInit).headers).toMatchObject({
        'Content-Range': `bytes 0-${10 * 1024 * 1024 - 1}/${15 * 1024 * 1024}`
      });
      const secondChunk = vi.mocked(fetch).mock.calls[2];
      expect((secondChunk[1] as RequestInit).headers).toMatchObject({
        'Content-Range': `bytes ${10 * 1024 * 1024}-${15 * 1024 * 1024 - 1}/${15 * 1024 * 1024}`
      });
    });

    it('throws if accessToken is missing', async () => {
      await expect(
        onedriveCore.uploadFile({
          seriesTitle: 'x',
          filename: 'y',
          blob: new Blob([]),
          credentials: {}
        })
      ).rejects.toThrow(/access token/i);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run src/lib/util/sync/core/providers/__tests__/onedrive-core.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `onedrive-core.ts`**

Create `src/lib/util/sync/core/providers/onedrive-core.ts`:

```typescript
import type { CloudProviderCore } from '../cloud-provider-core-types';
import { requireCredentialString } from '../cloud-provider-core-types';
import { ONEDRIVE_CONFIG } from '../../providers/onedrive/constants';
import { createChunkRanges } from '../../providers/onedrive/upload-session';

const BASE = ONEDRIVE_CONFIG.GRAPH_BASE_URL;

function encodePath(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

export const onedriveCore: CloudProviderCore = {
  async downloadFile({ fileId, credentials, onProgress }): Promise<ArrayBuffer> {
    const accessToken = requireCredentialString(
      credentials,
      'accessToken',
      'OneDrive access token'
    );

    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `${BASE}/me/drive/items/${encodeURIComponent(fileId)}/content`);
      xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
      xhr.responseType = 'arraybuffer';
      xhr.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      };
      xhr.onerror = () => reject(new Error('Network error during OneDrive download'));
      xhr.ontimeout = () => reject(new Error('OneDrive download timed out'));
      xhr.onabort = () => reject(new Error('OneDrive download aborted'));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response as ArrayBuffer);
        } else {
          reject(new Error(`OneDrive download HTTP ${xhr.status}: ${xhr.statusText}`));
        }
      };
      xhr.send();
    });
  },

  async uploadFile({ seriesTitle, filename, blob, credentials, onProgress }): Promise<string> {
    const accessToken = requireCredentialString(
      credentials,
      'accessToken',
      'OneDrive access token'
    );

    // Path relative to drive root
    const targetPath = seriesTitle ? `${seriesTitle}/${filename}` : filename;

    // Create the upload session
    const sessionResponse = await fetch(
      `${BASE}/me/drive/root:/${encodePath(targetPath)}:/createUploadSession`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          item: { '@microsoft.graph.conflictBehavior': 'replace' }
        })
      }
    );
    if (!sessionResponse.ok) {
      throw new Error(
        `Failed to create OneDrive upload session: ${sessionResponse.status} ${sessionResponse.statusText}`
      );
    }
    const { uploadUrl } = (await sessionResponse.json()) as { uploadUrl: string };

    // Upload in chunks
    let lastItemId: string | null = null;
    for (const range of createChunkRanges(blob.size, ONEDRIVE_CONFIG.UPLOAD_CHUNK_SIZE)) {
      const chunk = blob.slice(range.start, range.end + 1);
      const chunkResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(range.end - range.start + 1),
          'Content-Range': `bytes ${range.start}-${range.end}/${range.total}`
        },
        body: chunk
      });
      if (!chunkResponse.ok) {
        throw new Error(
          `OneDrive upload chunk failed: ${chunkResponse.status} ${chunkResponse.statusText}`
        );
      }
      onProgress?.(range.end + 1, range.total);

      // Final chunk returns the completed driveItem (201 Created or 200 OK).
      // Non-final chunks return 202 Accepted with nextExpectedRanges.
      if (chunkResponse.status === 201 || chunkResponse.status === 200) {
        const item = (await chunkResponse.json()) as { id: string };
        lastItemId = item.id;
      }
    }

    if (!lastItemId) {
      throw new Error('OneDrive upload session did not return a final driveItem');
    }
    return lastItemId;
  }
};
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/util/sync/core/providers/__tests__/onedrive-core.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/sync/core/providers/onedrive-core.ts src/lib/util/sync/core/providers/__tests__/onedrive-core.test.ts
git commit -m "feat(onedrive): add worker-core adapter for Graph uploads and downloads"
```

---

## Task 10: Register onedrive-core in the registry

**Files:**

- Modify: `src/lib/util/sync/core/cloud-provider-core-registry.ts`

- [ ] **Step 1: Register `onedriveCore`**

Read the current file, then add:

- `import { onedriveCore } from './providers/onedrive-core';` (add near the other core imports)
- `onedrive: onedriveCore` to the `Record<CloudCoreProviderType, CloudProviderCore>` registry

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: cloud-provider-core-registry.ts now passes. Other errors remain in files fixed by later tasks.

- [ ] **Step 3: Commit**

```bash
git add src/lib/util/sync/core/cloud-provider-core-registry.ts
git commit -m "feat(sync): register onedrive-core in worker-core registry"
```

---

## Task 11: OneDrive cache wrapper

**Files:**

- Create: `src/lib/util/sync/providers/onedrive/onedrive-cache.ts`

Structural copy of `webdav-cache.ts`, bound to the onedrive provider.

- [ ] **Step 1: Create the cache file**

Create `src/lib/util/sync/providers/onedrive/onedrive-cache.ts`:

```typescript
import { writable } from 'svelte/store';
import type { CloudCache } from '../../cloud-cache-interface';
import type { CloudFileMetadata } from '../../provider-interface';
import { onedriveProvider } from './onedrive-provider';

class OneDriveCacheManager implements CloudCache<CloudFileMetadata> {
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
    if (this.fetchingFlag) return;
    if (!onedriveProvider.isAuthenticated()) return;

    this.fetchingFlag = true;
    this.isFetchingStore.set(true);
    try {
      const volumes = await onedriveProvider.listCloudVolumes();
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
        `✅ OneDrive cache populated with ${volumes.length} files in ${cacheMap.size} series`
      );
    } catch (error) {
      console.error('Failed to fetch OneDrive cache:', error);
    } finally {
      this.fetchingFlag = false;
      this.isFetchingStore.set(false);
    }
  }

  has(path: string): boolean {
    let current: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((v) => {
      current = v;
    })();
    const seriesTitle = path.split('/')[0];
    return current.get(seriesTitle)?.some((f) => f.path === path) || false;
  }

  get(path: string): CloudFileMetadata | null {
    let current: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((v) => {
      current = v;
    })();
    const seriesTitle = path.split('/')[0];
    return current.get(seriesTitle)?.find((f) => f.path === path) || null;
  }

  getAll(path: string): CloudFileMetadata[] {
    let current: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((v) => {
      current = v;
    })();
    const seriesTitle = path.split('/')[0];
    return current.get(seriesTitle)?.filter((f) => f.path === path) || [];
  }

  getBySeries(seriesTitle: string): CloudFileMetadata[] {
    let current: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((v) => {
      current = v;
    })();
    const result: CloudFileMetadata[] = [];
    for (const files of current.values()) {
      result.push(...files.filter((file) => file.path.startsWith(`${seriesTitle}/`)));
    }
    return result;
  }

  getAllFiles(): CloudFileMetadata[] {
    let current: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((v) => {
      current = v;
    })();
    const result: CloudFileMetadata[] = [];
    for (const files of current.values()) result.push(...files);
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
        if (filtered.length === 0) newCache.delete(path);
        else if (filtered.length !== files.length) newCache.set(path, filtered);
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

export const onedriveCache = new OneDriveCacheManager();
```

- [ ] **Step 2: Commit (skip type-check — depends on Task 12's onedrive-provider.ts)**

```bash
git add src/lib/util/sync/providers/onedrive/onedrive-cache.ts
git commit -m "feat(onedrive): add cache wrapper"
```

---

## Task 12: OneDrive provider implementation

**Files:**

- Create: `src/lib/util/sync/providers/onedrive/onedrive-provider.ts`

- [ ] **Step 1: Create the provider file**

Create `src/lib/util/sync/providers/onedrive/onedrive-provider.ts`:

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
import { ONEDRIVE_CONFIG } from './constants';
import { onedriveTokenManager } from './token-manager';
import {
  createFolder,
  deleteItem,
  getDriveQuota,
  getItemByPath,
  listChildren,
  patchItem,
  type DriveItem
} from './graph-client';
import { getCloudProviderCore } from '../../core/cloud-provider-core-registry';

function isSyncableFile(path: string): boolean {
  const lower = path.toLowerCase();
  const basename = lower.split('/').filter(Boolean).pop() ?? '';
  if (basename === 'volume-data.json' || basename === 'profiles.json') return true;
  return (
    basename.endsWith('.cbz') ||
    basename.endsWith('.mokuro') ||
    basename.endsWith('.mokuro.gz') ||
    basename.endsWith('.webp')
  );
}

export class OneDriveProvider implements SyncProvider {
  readonly type = 'onedrive' as const;
  readonly name = 'OneDrive';
  readonly supportsWorkerDownload = true;
  readonly supportsWorkerUpload = true;
  readonly uploadConcurrencyLimit = 4;
  readonly downloadConcurrencyLimit = 4;

  private cloudCore = getCloudProviderCore('onedrive');
  private initPromise: Promise<void>;

  constructor() {
    if (browser) {
      this.initPromise = onedriveTokenManager.initialize().catch((error) => {
        console.warn('OneDrive MSAL init failed (will retry on login):', error);
      });
    } else {
      this.initPromise = Promise.resolve();
    }
  }

  async whenReady(): Promise<void> {
    await this.initPromise;
  }

  isAuthenticated(): boolean {
    return onedriveTokenManager.isAuthenticated();
  }

  getStatus(): ProviderStatus {
    const authenticated = this.isAuthenticated();
    const hasCredentials = onedriveTokenManager.hasStoredCredentials();
    let needsAttention = false;
    onedriveTokenManager.needsAttention.subscribe((value) => {
      needsAttention = value;
    })();
    const name = onedriveTokenManager.getActiveAccountName();
    const statusMessage = authenticated
      ? needsAttention
        ? 'Session expired — re-authentication required'
        : name
          ? `Connected to OneDrive (${name})`
          : 'Connected to OneDrive'
      : hasCredentials
        ? 'Configured (not connected)'
        : 'Not configured';
    return {
      isAuthenticated: authenticated,
      hasStoredCredentials: hasCredentials,
      needsAttention,
      statusMessage
    };
  }

  async login(_credentials?: ProviderCredentials): Promise<void> {
    if (!browser) {
      throw new ProviderError('OneDrive only works in browser', 'onedrive', 'BROWSER_ONLY');
    }
    try {
      await onedriveTokenManager.login();
      await this.ensureMokuroFolder();
      setActiveProviderKey('onedrive');
      console.log('✅ OneDrive login successful');
    } catch (error) {
      throw new ProviderError(
        `OneDrive login failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'onedrive',
        'LOGIN_FAILED',
        true
      );
    }
  }

  async logout(): Promise<void> {
    await onedriveTokenManager.logout();
    clearActiveProviderKey();
    console.log('OneDrive logged out');
  }

  async reauthenticate(): Promise<void> {
    await onedriveTokenManager.reauthenticate();
  }

  private async ensureMokuroFolder(): Promise<string> {
    const token = await onedriveTokenManager.getAccessToken();
    const existing = await getItemByPath(token, ONEDRIVE_CONFIG.MOKURO_FOLDER);
    if (existing) return existing.id;
    const created = await createFolder(token, '', ONEDRIVE_CONFIG.MOKURO_FOLDER);
    console.log(`Created ${ONEDRIVE_CONFIG.MOKURO_FOLDER} folder in OneDrive`);
    return created.id;
  }

  private async ensureSeriesFolder(seriesTitle: string): Promise<string> {
    const token = await onedriveTokenManager.getAccessToken();
    const path = `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${seriesTitle}`;
    const existing = await getItemByPath(token, path);
    if (existing) return existing.id;
    await this.ensureMokuroFolder();
    const created = await createFolder(token, ONEDRIVE_CONFIG.MOKURO_FOLDER, seriesTitle);
    return created.id;
  }

  async listCloudVolumes(): Promise<CloudFileMetadata[]> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const token = await onedriveTokenManager.getAccessToken();

    const results: CloudFileMetadata[] = [];

    const walk = async (path: string): Promise<void> => {
      const children = await listChildren(token, path).catch((error) => {
        // If the root mokuro folder doesn't exist, treat as empty
        if (error instanceof Error && error.message.includes('404')) {
          return [] as DriveItem[];
        }
        throw error;
      });
      for (const item of children) {
        const childPath = path ? `${path}/${item.name}` : item.name;
        if (item.folder) {
          await walk(childPath);
        } else if (item.file) {
          const relative = childPath.replace(`${ONEDRIVE_CONFIG.MOKURO_FOLDER}/`, '');
          if (!isSyncableFile(relative)) continue;
          results.push({
            provider: 'onedrive',
            fileId: item.id,
            path: relative,
            modifiedTime: item.lastModifiedDateTime ?? new Date().toISOString(),
            size: item.size ?? 0
          });
        }
      }
    };

    await walk(ONEDRIVE_CONFIG.MOKURO_FOLDER);
    console.log(`✅ Listed ${results.length} files from OneDrive`);
    return results;
  }

  async uploadFile(
    path: string,
    blob: UploadPayload,
    _description?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const seriesTitle = path.split('/').slice(0, -1).join('/');
    const filename = path.split('/').pop() ?? path;
    if (seriesTitle) await this.ensureSeriesFolder(seriesTitle);
    else await this.ensureMokuroFolder();

    const credentials = await this.getWorkerUploadCredentials();
    const blobToUpload =
      blob instanceof Blob
        ? blob
        : blob instanceof ArrayBuffer
          ? new Blob([blob])
          : new Blob([blob]);
    const fileId = await this.cloudCore.uploadFile({
      seriesTitle: `${ONEDRIVE_CONFIG.MOKURO_FOLDER}${seriesTitle ? `/${seriesTitle}` : ''}`,
      filename,
      blob: blobToUpload,
      credentials,
      onProgress
    });
    console.log(`✅ Uploaded ${path} to OneDrive`);
    return fileId;
  }

  async downloadFile(
    file: CloudFileMetadata,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const credentials = await this.getWorkerDownloadCredentials(file.fileId);
    const buffer = await this.cloudCore.downloadFile({
      fileId: file.fileId,
      credentials,
      onProgress: onProgress || (() => {})
    });
    return new Blob([buffer], { type: 'application/zip' });
  }

  async deleteFile(file: CloudFileMetadata): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const token = await onedriveTokenManager.getAccessToken();
    await deleteItem(token, file.fileId);
    console.log(`✅ Deleted ${file.path} from OneDrive`);
  }

  async renameFile(file: CloudFileMetadata, newPath: string): Promise<CloudFileMetadata> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const normalizedNew = newPath.replace(/^\/+|\/+$/g, '');
    if (file.path === normalizedNew) return file;

    const token = await onedriveTokenManager.getAccessToken();
    const newFilename = normalizedNew.split('/').pop() ?? normalizedNew;
    const newParent = normalizedNew.split('/').slice(0, -1).join('/');
    const destFolderPath = newParent
      ? `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${newParent}`
      : ONEDRIVE_CONFIG.MOKURO_FOLDER;

    if (newParent) {
      await this.ensureSeriesFolder(newParent);
    } else {
      await this.ensureMokuroFolder();
    }

    const destParentItem = await getItemByPath(token, destFolderPath);
    if (!destParentItem) {
      throw new ProviderError(
        `Destination folder '${destFolderPath}' could not be resolved`,
        'onedrive',
        'NOT_FOUND'
      );
    }

    const updated = await patchItem(token, file.fileId, {
      name: newFilename,
      parentReference: { id: destParentItem.id }
    });

    return {
      provider: 'onedrive',
      fileId: updated.id,
      path: normalizedNew,
      modifiedTime: updated.lastModifiedDateTime ?? new Date().toISOString(),
      size: updated.size ?? file.size
    };
  }

  async renameFolder(oldPath: string, newPath: string): Promise<CloudFileMetadata[]> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const normalizedOld = oldPath.replace(/^\/+|\/+$/g, '');
    const normalizedNew = newPath.replace(/^\/+|\/+$/g, '');
    if (normalizedOld === normalizedNew) {
      return (await this.listCloudVolumes()).filter((f) => f.path.startsWith(`${normalizedOld}/`));
    }

    const token = await onedriveTokenManager.getAccessToken();
    const sourcePath = `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${normalizedOld}`;
    const sourceItem = await getItemByPath(token, sourcePath);
    if (!sourceItem) {
      throw new ProviderError(
        `Source folder '${normalizedOld}' not found`,
        'onedrive',
        'NOT_FOUND'
      );
    }

    const newParent = normalizedNew.split('/').slice(0, -1).join('/');
    const newName = normalizedNew.split('/').pop() ?? normalizedNew;
    const destParentPath = newParent
      ? `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${newParent}`
      : ONEDRIVE_CONFIG.MOKURO_FOLDER;
    if (newParent) await this.ensureSeriesFolder(newParent);
    const destParentItem = await getItemByPath(token, destParentPath);
    if (!destParentItem) {
      throw new ProviderError(
        `Destination parent '${destParentPath}' could not be resolved`,
        'onedrive',
        'NOT_FOUND'
      );
    }

    await patchItem(token, sourceItem.id, {
      name: newName,
      parentReference: { id: destParentItem.id }
    });

    // Return refreshed metadata for all files under the renamed folder
    const all = await this.listCloudVolumes();
    return all.filter((f) => f.path.startsWith(`${normalizedNew}/`));
  }

  async deleteSeriesFolder(seriesTitle: string): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const normalized = seriesTitle.replace(/^\/+|\/+$/g, '');
    if (!normalized) return;
    const token = await onedriveTokenManager.getAccessToken();
    const path = `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${normalized}`;
    const item = await getItemByPath(token, path);
    if (!item) return;
    await deleteItem(token, item.id);
    console.log(`✅ Deleted series folder '${seriesTitle}' from OneDrive`);
  }

  async getStorageQuota(): Promise<StorageQuota> {
    if (!this.isAuthenticated()) {
      return { used: 0, total: null, available: null };
    }
    const token = await onedriveTokenManager.getAccessToken();
    const quota = await getDriveQuota(token);
    return {
      used: quota.used,
      total: quota.total || null,
      available: quota.remaining ?? null
    };
  }

  async getWorkerUploadCredentials(): Promise<Record<string, any>> {
    const accessToken = await onedriveTokenManager.getAccessToken();
    return { accessToken };
  }

  async getWorkerDownloadCredentials(_fileId: string): Promise<Record<string, any>> {
    const accessToken = await onedriveTokenManager.getAccessToken();
    return { accessToken };
  }
}

export const onedriveProvider = new OneDriveProvider();

// Self-register cache when module is loaded (same pattern as other providers)
import { cacheManager } from '../../cache-manager';
import { onedriveCache } from './onedrive-cache';
cacheManager.registerCache('onedrive', onedriveCache);
```

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: zero errors in the onedrive provider files. `CloudView.svelte` and `init-providers.ts` may still error — those are Tasks 13–14.

- [ ] **Step 3: Run full test suite**

Run: `npm test -- --run`
Expected: all existing tests plus the new onedrive tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/util/sync/providers/onedrive/onedrive-provider.ts
git commit -m "feat(onedrive): implement SyncProvider — auth, list, upload, download, rename, delete"
```

---

## Task 13: Wire onedrive into `init-providers.ts`

**Files:**

- Modify: `src/lib/util/sync/init-providers.ts`

- [ ] **Step 1: Add `'onedrive'` case to `loadProvider`**

Inside the `switch (type)` block of `loadProvider`, add after the `'filesystem'` case:

```typescript
    case 'onedrive': {
      const { onedriveProvider } = await import('./providers/onedrive/onedrive-provider');
      return onedriveProvider;
    }
```

- [ ] **Step 2: Extend the `whenReady` branch**

Find the block:

```typescript
  } else if (
    activeProviderType === 'mega' ||
    activeProviderType === 'webdav' ||
    activeProviderType === 'filesystem'
  ) {
```

Replace with:

```typescript
  } else if (
    activeProviderType === 'mega' ||
    activeProviderType === 'webdav' ||
    activeProviderType === 'filesystem' ||
    activeProviderType === 'onedrive'
  ) {
```

- [ ] **Step 3: Type-check**

Run: `npm run check`
Expected: passes for init-providers.ts.

- [ ] **Step 4: Commit**

```bash
git add src/lib/util/sync/init-providers.ts
git commit -m "feat(sync): lazy-load onedrive provider on startup"
```

---

## Task 14: Wire onedrive into CloudView UI

**Files:**

- Modify: `src/lib/views/CloudView.svelte`

Extend the existing pattern for Google Drive / MEGA / WebDAV / filesystem:

1. `providerNames` and `providerInfo` entries
2. `onedriveAuth` / `onedriveLoading` state
3. `handleOneDriveLogin` / `handleLogout` branch
4. Provider-selection button + connected-state messaging

- [ ] **Step 1: Extend `providerNames`**

Replace:

```typescript
const providerNames: Record<ProviderType, string> = {
  'google-drive': 'Google Drive',
  mega: 'MEGA Cloud Storage',
  webdav: 'WebDAV Server',
  filesystem: 'Local Folder'
};
```

with:

```typescript
const providerNames: Record<ProviderType, string> = {
  'google-drive': 'Google Drive',
  mega: 'MEGA Cloud Storage',
  webdav: 'WebDAV Server',
  filesystem: 'Local Folder',
  onedrive: 'OneDrive'
};
```

- [ ] **Step 2: Extend `providerInfo`**

Add an `onedrive` entry to the `providerInfo` object:

```typescript
onedrive: {
  items: [
    'Free 5GB personal storage; 1TB+ for Microsoft 365 subscribers',
    'Works with personal accounts (outlook.com) and work/school accounts',
    'Silent token refresh — no hourly re-authentication popups',
    'Encrypted in transit and at rest'
  ];
}
```

- [ ] **Step 3: Add derived auth state**

After the existing `filesystemAuth` / `filesystemNeedsReconnect` block, add:

```typescript
let onedriveAuth = $derived($providerStatusStore.providers['onedrive']?.isAuthenticated || false);
let onedriveNeedsAttention = $derived(
  $providerStatusStore.providers['onedrive']?.needsAttention || false
);
let onedriveLoading = $state(false);
```

- [ ] **Step 4: Include `onedriveAuth` in the quota-fetch $effect**

Replace:

```typescript
const isAuthenticated = googleDriveAuth || megaAuth || webdavAuth || filesystemAuth;
```

with:

```typescript
const isAuthenticated = googleDriveAuth || megaAuth || webdavAuth || filesystemAuth || onedriveAuth;
```

- [ ] **Step 5: Add login handler**

Below `handleFilesystemReconnect` (or wherever the other handlers are grouped), add:

```typescript
async function handleOneDriveLogin() {
  onedriveLoading = true;
  try {
    const provider = await providerManager.getOrLoadProvider('onedrive');
    await provider.login();
    await providerManager.setCurrentProvider(provider);
    showSnackbar('Connected to OneDrive - loading data...');
    await unifiedCloudManager.fetchAllCloudVolumes();
    providerManager.updateStatus();
    showSnackbar('OneDrive connected');
    await handlePostLogin();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    showSnackbar(message);
  } finally {
    onedriveLoading = false;
  }
}

async function handleOneDriveReconnect() {
  onedriveLoading = true;
  try {
    const provider = await providerManager.getOrLoadProvider('onedrive');
    if (!provider.reauthenticate) {
      throw new Error('Provider does not support reconnect');
    }
    await provider.reauthenticate();
    providerManager.updateStatus();
    showSnackbar('OneDrive reconnected');
    await unifiedCloudManager.fetchAllCloudVolumes();
    await handlePostLogin();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Reconnect failed';
    showSnackbar(message);
  } finally {
    onedriveLoading = false;
  }
}
```

- [ ] **Step 6: Extend `handleLogout` provider-specific cleanup**

Add before the closing brace of the else-if chain:

```typescript
    } else if (provider === 'onedrive') {
      showSnackbar('Logged out of OneDrive');
    }
```

- [ ] **Step 7: Add the OneDrive provider-selection button**

In the `{#if !hasAnyProvider}` branch, after the Local Folder button, add:

```svelte
<!-- OneDrive Option -->
<button
  class="border-opacity-50 w-full rounded-lg border border-slate-600 p-6 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
  onclick={handleOneDriveLogin}
  disabled={onedriveLoading}
>
  <div class="flex items-center gap-4">
    <div class="flex h-8 w-8 items-center justify-center text-2xl">O</div>
    <div class="flex-1 text-left">
      <div class="text-lg font-semibold">OneDrive</div>
      <div class="text-sm text-gray-400">5GB free • Personal or work/school • Silent refresh</div>
    </div>
  </div>
</button>
```

- [ ] **Step 8: Add reconnect banner inside connected branch**

Find the filesystem reconnect banner block. After it, insert:

```svelte
{#if currentProvider === 'onedrive' && onedriveNeedsAttention}
  <Alert color="yellow" class="mb-4">
    {#snippet icon()}
      <InfoCircleSolid class="h-5 w-5" />
    {/snippet}
    <div class="flex flex-col gap-2">
      <span>
        <span class="font-medium">Session expired:</span> Silent refresh failed. Reconnect to continue
        syncing.
      </span>
      <Button size="xs" color="yellow" onclick={handleOneDriveReconnect} disabled={onedriveLoading}>
        {onedriveLoading ? 'Reconnecting...' : 'Reconnect OneDrive'}
      </Button>
    </div>
  </Alert>
{/if}
```

- [ ] **Step 9: Type-check**

Run: `npm run check`
Expected: zero errors.

- [ ] **Step 10: Run full test suite**

Run: `npm test -- --run`
Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/lib/views/CloudView.svelte
git commit -m "feat(onedrive): surface OneDrive option in CloudView"
```

---

## Task 15: Document the env var

**Files:**

- Modify: `.env.example` (only if it already exists)

- [ ] **Step 1: Check for an existing env example**

Run: `ls .env.example .env.local.example 2>/dev/null`

If an example file exists, add a line documenting `VITE_ONEDRIVE_CLIENT_ID`:

```
VITE_ONEDRIVE_CLIENT_ID=your_azure_app_client_id
```

If NO example file exists, do NOT create one (YAGNI — existing project doesn't have the pattern). Note the env var in the commit message instead; the token manager already throws a clear error message guiding users who try to log in without the env var set.

- [ ] **Step 2: Commit if a file was modified**

```bash
git add .env.example
git commit -m "docs: document VITE_ONEDRIVE_CLIENT_ID env var"
```

Otherwise skip.

---

## Task 16: Final smoke test + regression

**Files:** (no code changes)

- [ ] **Step 1: Register an Azure app (manual, by the user)**

The implementer cannot do this step — it requires an Azure subscription. The user registers a public SPA app in Azure, sets `http://localhost:5173` (and any deployed origin) as a redirect URI, and adds the client ID to `.env.local`:

```
VITE_ONEDRIVE_CLIENT_ID=<generated-client-id>
```

- [ ] **Step 2: Run full regression**

Run:

```bash
npm run check
npm test -- --run
npm run lint
```

Expected: `check` zero errors; `test` all pass; `lint` no new warnings attributable to onedrive files.

- [ ] **Step 3: Manual browser smoke test**

Run: `npm run dev`

1. Visit Cloud tab → click "OneDrive". MSAL popup opens.
2. Sign in with a personal Microsoft account. Consent to `Files.ReadWrite`, `User.Read`, and `offline_access`.
3. Verify "OneDrive connected" snackbar, account name in the status message.
4. Import a small volume; click "Backup all series to cloud". Verify the volume appears in `/mokuro-reader/...` in the browser OneDrive web UI.
5. Delete the volume locally; tap the placeholder to restore. Verify round-trip download works.
6. Rename a series from `SeriesView`. Verify the folder is renamed in OneDrive (native move, not copy+delete).
7. Wait > 1 hour (or force-expire the token in DevTools) and try to upload another volume. Verify silent refresh happens without popup.
8. Log out. Verify `active_cloud_provider` and `onedrive_has_authenticated` are cleared in DevTools → Application → Local Storage.
9. Repeat step 2 but with a work/school account (if available). Verify the same flow works.

Stop the dev server.

- [ ] **Step 4: If any step fails, log follow-up issues in the plan**

Add a `## Follow-up issues` section to this plan file listing what failed, commit:

```bash
git add docs/superpowers/plans/2026-04-23-onedrive-provider.md
git commit -m "docs: note onedrive-provider follow-ups from smoke test"
```

Otherwise skip.

---

## Self-Review Notes

1. **Spec coverage:**
   - MSAL authentication (login/logout/silent refresh/reconnect) → Tasks 8, 12, 14 ✓
   - Worker-capable core (upload-session + download) → Task 9 ✓
   - File layout `/mokuro-reader/{Series}/{Volume}.cbz` → Task 12 (ensureMokuroFolder/ensureSeriesFolder, listCloudVolumes filter) ✓
   - Upload-session chunking + resume helpers → Task 6 ✓
   - Graph API client for listing, creating folders, move/rename, delete, quota → Task 7 ✓
   - `ProviderType` / detection / manager / registry plumbing → Tasks 2, 3, 4, 10, 13 ✓
   - CloudView UI surface → Task 14 ✓
   - `cloudProvider` field already widened to `ProviderType` by filesystem work → no change needed ✓
   - Env var `VITE_ONEDRIVE_CLIENT_ID` → Tasks 5, 15 ✓

2. **Placeholder scan:** None. Every task has real code or real commands.

3. **Type / method-name consistency:** `onedriveProvider`, `onedriveTokenManager`, `onedriveCache`, `onedriveCore`, `ONEDRIVE_CONFIG`, `createChunkRanges`, `parseNextExpectedRange` — all consistent across tasks.

4. **Cross-task dependencies:**
   - Task 11 (cache) imports from Task 12 (provider). Same self-register pattern as filesystem — commit Task 11 without a type-check; Task 12 resolves it.
   - Task 9 (onedrive-core) depends on Task 6 (upload-session) for `createChunkRanges`.
   - Task 9 depends on Task 5 (constants) for `UPLOAD_CHUNK_SIZE` and `GRAPH_BASE_URL`.
   - Task 10 (registry) depends on Task 9.
   - Task 12 (provider) depends on Tasks 5, 7, 8, 10.

5. **Test coverage:** Pure-function tests for upload-session chunking; fetch-mock tests for Graph client and onedrive-core. Provider-level integration coverage via manual smoke test (Task 16). Token manager intentionally not unit-tested — MSAL-mocking adds test weight without catching real bugs; the adapter is exercised end-to-end.

6. **Token manager initialization:** MSAL `initialize()` is idempotent via the `initPromise` cache. Constructor-time init is allowed to fail (`.catch()`) because a missing env var is a setup issue, not a runtime crash — login will surface the error.
