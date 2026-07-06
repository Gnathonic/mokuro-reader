# OneDrive + Filesystem Provider Deployment Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the OneDrive and Filesystem sync providers to parity with the mature providers (Google Drive, MEGA, WebDAV) so `feat/filesystem-provider` is deployment-ready.

**Architecture:** All five providers implement `SyncProvider` (`src/lib/util/sync/provider-interface.ts`). Fixes are provider-local except one shared `isSyncableFile` module (new) and small UI/docs updates. Error signaling follows existing conventions: typed `ProviderError` (code `NOT_FOUND` consumed by `unified-cloud-manager.ts:28`; message substrings `not found`/`404`/`ENOENT` sniffed by `unified-sync-service.ts:360-364`), and `getStatus().needsAttention` drives the UI reconnect state (refreshed via the dynamic-import `providerManager.updateStatus()` pattern from `webdav-provider.ts:110-115`).

**Tech Stack:** SvelteKit 5 (runes), TypeScript, Vitest (jsdom), MSAL (`@azure/msal-browser`, redirect flow), Microsoft Graph REST, File System Access API, Dexie-free IndexedDB helper (`handle-store.ts`).

## Global Constraints

- All work happens in the worktree `/home/nathan/Projects/mokuro-reader-worktrees/feat/filesystem-provider` on branch `feat/filesystem-provider`. Never commit in the main checkout.
- Do NOT push. Local commits only.
- Commit hooks run prettier + eslint via lint-staged; if a commit fails on formatting, run `npm run format` and re-stage.
- Test command: `npx vitest run <path>` (or `npm test -- --run <path>`). Full gates at the end: `npm run check`, `npx vitest run`, `npm run lint`.
- Svelte 5 runes (`$state`, `$derived`) in components; no legacy `$:` reactivity.
- Baseline before Task 1: 887 tests passing, 0 svelte-check errors (verified at HEAD `07803b9e`).
- Do not regress the EXCEED items: onedrive `@odata.nextLink` pagination, onedrive deep-404 propagation in `listCloudVolumes`, onedrive per-segment `encodeURIComponent` path escaping, both new providers' `reauthenticate()` support, filesystem synchronous logout ordering.

---

### Task 1: Shared `isSyncableFile` module (adds `libraries.json` + `.jpg/.jpeg` for filesystem/onedrive)

The filter is duplicated at 6 sites with two divergences: filesystem/onedrive silently drop `.jpg/.jpeg` sidecars that the mature providers sync, and **no** provider lists `libraries.json`, so `unified-sync-service.ts:738-739` (`cache.get('libraries.json')`) always returns null and library sync silently no-ops on every provider.

**Files:**

- Create: `src/lib/util/sync/syncable-file.ts`
- Create: `src/lib/util/sync/syncable-file.test.ts`
- Modify: `src/lib/util/sync/providers/filesystem/filesystem-paths.ts:20-29`
- Modify: `src/lib/util/sync/providers/onedrive/onedrive-provider.ts:24-34`
- Modify: `src/lib/util/sync/providers/webdav/webdav-provider.ts:685-694` and `:747-756`
- Modify: `src/lib/util/sync/providers/mega/mega-provider.ts:593-603`
- Modify: `src/lib/util/sync/providers/google-drive/google-drive-provider.ts:210-227`

**Interfaces:**

- Produces: `isSyncableFile(path: string): boolean`, `isCbzFile(basename: string): boolean`, `isSidecarFile(basename: string): boolean`, `isRootConfigFile(basename: string): boolean` — all case-insensitive, exported from `$lib/util/sync/syncable-file`.

- [ ] **Step 1: Write the failing test**

`src/lib/util/sync/syncable-file.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isSyncableFile, isCbzFile, isSidecarFile, isRootConfigFile } from './syncable-file';

describe('syncable-file', () => {
  it('accepts cbz, mokuro, mokuro.gz anywhere in the tree', () => {
    expect(isSyncableFile('Series/Vol 1.cbz')).toBe(true);
    expect(isSyncableFile('Series/Vol 1.mokuro')).toBe(true);
    expect(isSyncableFile('Series/Vol 1.mokuro.gz')).toBe(true);
  });

  it('accepts webp AND jpg/jpeg sidecar thumbnails (parity with mature providers)', () => {
    expect(isSyncableFile('Series/Vol 1.webp')).toBe(true);
    expect(isSyncableFile('Series/Vol 1.jpg')).toBe(true);
    expect(isSyncableFile('Series/Vol 1.JPEG')).toBe(true);
  });

  it('accepts the three root config files, including libraries.json', () => {
    expect(isSyncableFile('volume-data.json')).toBe(true);
    expect(isSyncableFile('profiles.json')).toBe(true);
    expect(isSyncableFile('libraries.json')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isSyncableFile('Series/notes.txt')).toBe(false);
    expect(isSyncableFile('Series/random.json')).toBe(false);
    expect(isSyncableFile('desktop.ini')).toBe(false);
  });

  it('is case-insensitive and uses the basename only', () => {
    expect(isSyncableFile('Series/VOL.CBZ')).toBe(true);
    expect(isSyncableFile('a/b/c/LIBRARIES.JSON')).toBe(true);
  });

  it('exposes category predicates for providers that bucket by type', () => {
    expect(isCbzFile('v.cbz')).toBe(true);
    expect(isSidecarFile('v.mokuro')).toBe(true);
    expect(isSidecarFile('v.jpeg')).toBe(true);
    expect(isSidecarFile('v.cbz')).toBe(false);
    expect(isRootConfigFile('libraries.json')).toBe(true);
    expect(isRootConfigFile('v.cbz')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/util/sync/syncable-file.test.ts`
Expected: FAIL — module `./syncable-file` not found.

- [ ] **Step 3: Write the implementation**

`src/lib/util/sync/syncable-file.ts`:

```typescript
/**
 * The single source of truth for which files sync providers list and cache.
 * Shared by ALL five providers — do not fork per-provider copies again.
 *
 * Categories:
 * - CBZ archives (the volumes themselves)
 * - Sidecars: OCR data (.mokuro / .mokuro.gz) and thumbnails (.webp/.jpg/.jpeg)
 * - Root config files: volume-data.json (read progress), profiles.json
 *   (settings profiles), libraries.json (library definitions)
 */

const ROOT_CONFIG_FILENAMES = new Set(['volume-data.json', 'profiles.json', 'libraries.json']);
const SIDECAR_IMAGE_RE = /\.(webp|jpe?g)$/i;

function basenameOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '';
}

export function isCbzFile(basename: string): boolean {
  return basename.toLowerCase().endsWith('.cbz');
}

export function isSidecarFile(basename: string): boolean {
  const lower = basename.toLowerCase();
  return lower.endsWith('.mokuro') || lower.endsWith('.mokuro.gz') || SIDECAR_IMAGE_RE.test(lower);
}

export function isRootConfigFile(basename: string): boolean {
  return ROOT_CONFIG_FILENAMES.has(basename.toLowerCase());
}

export function isSyncableFile(path: string): boolean {
  const basename = basenameOf(path);
  return isCbzFile(basename) || isSidecarFile(basename) || isRootConfigFile(basename);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/util/sync/syncable-file.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire filesystem** — replace the local filter in `filesystem-paths.ts` (keep the export so `filesystem-provider.ts:14` and existing path tests keep working):

Replace lines 20-29 of `src/lib/util/sync/providers/filesystem/filesystem-paths.ts`:

```typescript
export { isSyncableFile } from '../../syncable-file';
```

(Delete the `SYNCABLE_EXTENSIONS` / `SYNCABLE_ROOT_FILENAMES` constants and the old function body.)

- [ ] **Step 6: Wire onedrive** — in `onedrive-provider.ts`, delete the module-level `isSyncableFile` function (lines 24-34) and add to the imports from `'../../provider-interface'` block area:

```typescript
import { isSyncableFile } from '../../syncable-file';
```

- [ ] **Step 7: Wire webdav (both sites)** — in `webdav-provider.ts`, add `import { isSyncableFile } from '../../syncable-file';` and replace BOTH inline conditions (at ~:687-694 and ~:749-756):

```typescript
            // Include CBZ files, sidecars, and JSON config files
            if (isSyncableFile(item.basename)) {
```

(Delete the multi-line `name.endsWith(...) || ... || item.basename === 'profiles.json'` condition and the now-unused `const name = item.basename.toLowerCase();` line at each site.)

- [ ] **Step 8: Wire mega** — in `mega-provider.ts` (~:593-603), add the same import and replace the `isCbz`/`isSidecar`/`isJson` block. The downstream code uses those three booleans — check with `grep -n "isCbz\|isSidecar\|isJson" src/lib/util/sync/providers/mega/mega-provider.ts` and keep them, deriving from the shared helpers:

```typescript
const name = (file as any).name || '';
const isCbz = isCbzFile(name);
const isSidecar = isSidecarFile(name);
const isJson = isRootConfigFile(name);

if (!isCbz && !isSidecar && !isJson) continue;
```

Import: `import { isCbzFile, isSidecarFile, isRootConfigFile } from '../../syncable-file';`

- [ ] **Step 9: Wire google-drive** — in `google-drive-provider.ts:210-227` the filter buckets into `cbzFiles`/`sidecarFiles`/`jsonFiles`. Replace the conditions with the shared predicates (keep the buckets):

```typescript
for (const item of allItems) {
  if (item.mimeType === GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER) {
    folderNames.set(item.id, item.name);
  } else if (isCbzFile(item.name)) {
    cbzFiles.push(item);
  } else if (isSidecarFile(item.name)) {
    sidecarFiles.push(item);
  } else if (isRootConfigFile(item.name)) {
    jsonFiles.push(item);
  }
}
```

Import: `import { isCbzFile, isSidecarFile, isRootConfigFile } from '../../syncable-file';`

BEFORE editing, check what the `jsonFiles` bucket feeds (`grep -n "jsonFiles" src/lib/util/sync/providers/google-drive/google-drive-provider.ts`) — it must simply become cache entries keyed by name at root (same as volume-data.json/profiles.json). If it special-cases the two known names, extend it generically; do not hardcode a third name.

- [ ] **Step 10: Run affected tests + typecheck**

Run: `npx vitest run src/lib/util/sync` and `npm run check`
Expected: all pass. The existing `filesystem-paths` tests (7) must still pass — if one asserts `.jpg` is NOT syncable, update that assertion (the old behavior was the bug).

- [ ] **Step 11: Commit**

```bash
git add -A && git commit -m "fix(sync): shared isSyncableFile — libraries.json syncs, jpg sidecars on all providers"
```

---

### Task 2: OneDrive token-manager hardening (logout ordering, interaction_in_progress, markNeedsAttention, delete dead code)

**Files:**

- Modify: `src/lib/util/sync/providers/onedrive/token-manager.ts`
- Create: `src/lib/util/sync/providers/onedrive/__tests__/token-manager.test.ts`

**Interfaces:**

- Produces: `onedriveTokenManager.markNeedsAttention(): void` (used by Task 4's graph-client 401 handling).
- Removes: `hasPendingRedirect()` — it is called nowhere, and its `url.searchParams.has('code')` check is wrong anyway (MSAL SPA redirect returns the code in the URL _fragment_, so it could never return true). Deleting dead+broken beats wiring it in; the `whenReady()` flow in `init-providers.ts:108-118` already sequences redirect completion before any bootstrap fetch.

- [ ] **Step 1: Write the failing tests**

`src/lib/util/sync/providers/onedrive/__tests__/token-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

// Capture-order log shared between the msal mock and assertions.
const calls: string[] = [];

class FakeBrowserAuthError extends Error {
  constructor(public errorCode: string) {
    super(errorCode);
  }
}
class FakeInteractionRequiredAuthError extends Error {}

const fakeAccount = { name: 'Test User', username: 'test@example.com' };

const fakeInstance = {
  initialize: vi.fn(async () => {}),
  handleRedirectPromise: vi.fn(async () => null),
  getAllAccounts: vi.fn(() => [fakeAccount]),
  setActiveAccount: vi.fn(),
  loginRedirect: vi.fn(async () => {
    calls.push('loginRedirect');
  }),
  acquireTokenRedirect: vi.fn(async () => {
    calls.push('acquireTokenRedirect');
  }),
  acquireTokenSilent: vi.fn(async () => ({ accessToken: 'tok' })),
  logoutRedirect: vi.fn(async () => {
    calls.push(`logoutRedirect(hasAuth=${localStorage.getItem('onedrive_has_authenticated')})`);
  })
};

vi.mock('@azure/msal-browser', () => ({
  PublicClientApplication: vi.fn(() => fakeInstance),
  BrowserAuthError: FakeBrowserAuthError,
  InteractionRequiredAuthError: FakeInteractionRequiredAuthError
}));

async function freshManager() {
  vi.resetModules();
  vi.stubEnv('VITE_ONEDRIVE_CLIENT_ID', 'test-client-id');
  const { onedriveTokenManager } = await import('../token-manager');
  return onedriveTokenManager;
}

describe('OneDriveTokenManager', () => {
  beforeEach(() => {
    calls.length = 0;
    localStorage.clear();
    vi.clearAllMocks();
    fakeInstance.getAllAccounts.mockReturnValue([fakeAccount]);
  });

  it('logout clears local state BEFORE the logoutRedirect navigation', async () => {
    localStorage.setItem('onedrive_has_authenticated', 'true');
    localStorage.setItem('onedrive_login_pending', 'true');
    const mgr = await freshManager();
    await mgr.initialize();

    await mgr.logout();

    // The redirect call must observe already-cleared storage.
    expect(calls).toContain('logoutRedirect(hasAuth=null)');
    expect(localStorage.getItem('onedrive_login_pending')).toBeNull();
  });

  it('login surfaces a friendly error when an interaction is already in progress', async () => {
    fakeInstance.loginRedirect.mockRejectedValueOnce(
      new FakeBrowserAuthError('interaction_in_progress')
    );
    const mgr = await freshManager();
    await expect(mgr.login()).rejects.toThrow(/already in progress/i);
  });

  it('reauthenticate surfaces a friendly error when an interaction is already in progress', async () => {
    fakeInstance.acquireTokenRedirect.mockRejectedValueOnce(
      new FakeBrowserAuthError('interaction_in_progress')
    );
    const mgr = await freshManager();
    await mgr.initialize();
    await expect(mgr.reauthenticate()).rejects.toThrow(/already in progress/i);
  });

  it('markNeedsAttention flips the needsAttention store', async () => {
    const mgr = await freshManager();
    let value = false;
    mgr.needsAttention.subscribe((v) => (value = v))();
    mgr.markNeedsAttention();
    mgr.needsAttention.subscribe((v) => (value = v))();
    expect(value).toBe(true);
  });

  it('no longer exposes the dead hasPendingRedirect helper', async () => {
    const mgr = await freshManager();
    expect((mgr as any).hasPendingRedirect).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/util/sync/providers/onedrive/__tests__/token-manager.test.ts`
Expected: FAIL — logout ordering (hasAuth=true at redirect time), no friendly error, `markNeedsAttention` undefined, `hasPendingRedirect` defined.

- [ ] **Step 3: Implement in `token-manager.ts`**

3a. Delete the `hasPendingRedirect()` method (lines 99-109) entirely.

3b. Replace `logout()` (lines 147-161):

```typescript
  async logout(): Promise<void> {
    // Snapshot what we need for the redirect, then clear ALL local state
    // FIRST — logoutRedirect() navigates the window away, so anything after
    // it never runs.
    const instance = this.instance;
    const account = this.account;
    this.account = null;
    this.tokenStore.set('');
    this.needsAttentionStore.set(false);
    if (browser) {
      localStorage.removeItem(ONEDRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED);
      localStorage.removeItem(PENDING_LOGIN_KEY);
    }
    if (instance && account) {
      await instance.logoutRedirect({
        account,
        postLogoutRedirectUri: window.location.origin
      });
    }
  }
```

3c. Add a private helper and use it in `login()` and `reauthenticate()`:

```typescript
  /**
   * MSAL throws BrowserAuthError("interaction_in_progress") when a redirect
   * is already in flight (double-clicked button, or a stale lock after the
   * user backed out of the Microsoft login page). Surface it as a friendly,
   * actionable message instead of a raw MSAL crash.
   */
  private translateInteractionError(error: unknown): Error {
    if (
      this.msal &&
      error instanceof this.msal.BrowserAuthError &&
      error.errorCode === 'interaction_in_progress'
    ) {
      return new Error(
        'Microsoft sign-in is already in progress. Finish the login window, or reload this page and try again.'
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }
```

In `login()`, wrap the redirect call:

```typescript
try {
  await this.instance.loginRedirect(request);
} catch (error) {
  localStorage.removeItem(PENDING_LOGIN_KEY);
  throw this.translateInteractionError(error);
}
```

In `reauthenticate()`, wrap the same way:

```typescript
try {
  await this.instance.acquireTokenRedirect(request);
} catch (error) {
  localStorage.removeItem(PENDING_LOGIN_KEY);
  throw this.translateInteractionError(error);
}
```

3d. Add the public method next to `getAccessToken()`:

```typescript
  /** Flag the session as needing user re-authentication (e.g. Graph 401). */
  markNeedsAttention(): void {
    this.needsAttentionStore.set(true);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/util/sync/providers/onedrive/__tests__/token-manager.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix(onedrive): logout clears state before redirect; handle interaction_in_progress"
```

---

### Task 3: OneDrive provider logout ordering, init-error surfacing, provider-manager force-clear

**Files:**

- Modify: `src/lib/util/sync/providers/onedrive/onedrive-provider.ts:44-55` (constructor), `:65-88` (getStatus), `:131-135` (logout)
- Modify: `src/lib/util/sync/provider-manager.ts:191-203`
- Modify: `src/lib/util/sync/providers/onedrive/__tests__/onedrive-provider.test.ts` (follow its existing mock setup — it already mocks the token manager for `listCloudVolumes` tests)

**Interfaces:**

- Consumes: Task 2's reordered `onedriveTokenManager.logout()`.
- Produces: `getStatus()` distinguishes a failed MSAL init (`statusMessage: 'OneDrive initialization failed: …'`) from "Not configured".

- [ ] **Step 1: Write the failing tests** (add to `onedrive-provider.test.ts`, reusing its mock style):

```typescript
describe('logout', () => {
  it('clears the active provider key before the token-manager redirect', async () => {
    const order: string[] = [];
    vi.mocked(clearActiveProviderKey).mockImplementation(() => {
      order.push('clearActiveProviderKey');
    });
    vi.mocked(onedriveTokenManager.logout).mockImplementation(async () => {
      order.push('tokenManager.logout');
    });

    const provider = new OneDriveProvider();
    await provider.logout();

    expect(order).toEqual(['clearActiveProviderKey', 'tokenManager.logout']);
  });
});

describe('getStatus after failed MSAL init', () => {
  it('reports an initialization failure instead of "Not configured"', async () => {
    vi.mocked(onedriveTokenManager.initialize).mockRejectedValueOnce(
      new Error('VITE_ONEDRIVE_CLIENT_ID is not set')
    );
    const provider = new OneDriveProvider();
    await provider.whenReady();
    const status = provider.getStatus();
    expect(status.statusMessage).toMatch(/initialization failed/i);
    expect(status.isAuthenticated).toBe(false);
  });
});
```

(Adjust mock references to match the file's existing `vi.mock` declarations; the test file already mocks `../token-manager` and `../../provider-detection` — check its top-of-file setup with `head -40` and mirror it. If it only mocks partially, extend the mock factory with `logout`, `initialize` fns.)

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run src/lib/util/sync/providers/onedrive/__tests__/onedrive-provider.test.ts`
Expected: FAIL — wrong order (`tokenManager.logout` first) and status says "Not configured".

- [ ] **Step 3: Implement**

3a. Constructor — track init errors (replace lines 47-55):

```typescript
  private initError: Error | null = null;

  constructor() {
    if (browser) {
      this.initPromise = onedriveTokenManager.initialize().catch((error) => {
        // A missing/invalid client id is a deployment misconfiguration, not
        // a "user never connected" state. Track it so getStatus() can say so.
        this.initError = error instanceof Error ? error : new Error(String(error));
        console.warn('OneDrive MSAL init failed:', error);
      });
    } else {
      this.initPromise = Promise.resolve();
    }
  }
```

3b. `getStatus()` — add at the top of the method:

```typescript
if (this.initError) {
  return {
    isAuthenticated: false,
    hasStoredCredentials: onedriveTokenManager.hasStoredCredentials(),
    needsAttention: false,
    statusMessage: `OneDrive initialization failed: ${this.initError.message}`
  };
}
```

3c. `logout()` — reorder (replace lines 131-135):

```typescript
  async logout(): Promise<void> {
    // Clear the active-provider key BEFORE the token manager's logout —
    // logoutRedirect() navigates the window away and nothing after it runs.
    clearActiveProviderKey();
    console.log('OneDrive logged out');
    await onedriveTokenManager.logout();
  }
```

3d. `provider-manager.ts` force-clear — extend the block at lines 193-203:

```typescript
// MEGA
localStorage.removeItem('mega_session');
localStorage.removeItem('mega_email');
localStorage.removeItem('mega_password');
localStorage.removeItem('mega_folder_path');
// OneDrive (MSAL's own msal.* cache entries are cleared by MSAL itself)
localStorage.removeItem('onedrive_has_authenticated');
localStorage.removeItem('onedrive_login_pending');
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/util/sync/providers/onedrive`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix(onedrive): surface init errors, clear provider key before logout redirect"
```

---

### Task 4: Graph error classification → typed ProviderError + 401 needsAttention

Every Graph failure currently surfaces as a plain `Error('Graph 401 …')` — never `isAuthError`, never flips the reconnect UI. WebDAV's `classifyWriteError` is the bar.

**Files:**

- Modify: `src/lib/util/sync/providers/onedrive/graph-client.ts:30-33` (parseError)
- Modify: `src/lib/util/sync/providers/onedrive/onedrive-provider.ts` (`uploadFile`/`downloadFile` wrap)
- Modify: `src/lib/util/sync/providers/onedrive/__tests__/graph-client.test.ts`

**Interfaces:**

- Consumes: `onedriveTokenManager.markNeedsAttention()` from Task 2.
- Produces: all graph-client throws are `ProviderError` with `providerType: 'onedrive'`, `code: 'GRAPH_<status>'`, `isAuthError` on 401, `isNetworkError` on 429/5xx. Message keeps the `Graph <status> <statusText>: <body>` shape (the `404` token is sniffed by `unified-sync-service.ts:360-364`).

- [ ] **Step 1: Write the failing tests** (add to `graph-client.test.ts`):

```typescript
import { ProviderError } from '../../../provider-interface';
import { onedriveTokenManager } from '../token-manager';

describe('error classification', () => {
  it('throws ProviderError with isAuthError on 401 and flags needsAttention', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'token expired'
    } as Response);

    const err = await getDriveQuota('TOKEN').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.isAuthError).toBe(true);
    expect(err.code).toBe('GRAPH_401');

    let attention = false;
    onedriveTokenManager.needsAttention.subscribe((v) => (attention = v))();
    expect(attention).toBe(true);
  });

  it('marks 429 and 5xx as network errors (retryable), not auth errors', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => ''
    } as Response);

    const err = await getDriveQuota('TOKEN').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.isNetworkError).toBe(true);
    expect(err.isAuthError).toBe(false);
  });

  it('keeps the Graph <status> message shape for not-found sniffing', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => ''
    } as Response);
    // listChildren (not getItemByPath, which maps 404 to null)
    await expect(listChildren('TOKEN', 'mokuro-reader/x')).rejects.toThrow(/404/);
  });
});
```

Note: this test file will now transitively import `token-manager` → `$app/environment`. If that import fails in the vitest environment, add `vi.mock('$app/environment', () => ({ browser: true }));` at the top of the test file.

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run src/lib/util/sync/providers/onedrive/__tests__/graph-client.test.ts`
Expected: FAIL — plain Error, no classification.

- [ ] **Step 3: Implement** — replace `parseError` in `graph-client.ts`:

```typescript
import { ProviderError } from '../../provider-interface';
import { onedriveTokenManager } from './token-manager';

async function parseError(response: Response): Promise<never> {
  const text = await response.text().catch(() => '');
  if (response.status === 401) {
    // Token rejected server-side (revocation, password change). Silent
    // refresh alone won't detect this — flag the session for reconnect.
    onedriveTokenManager.markNeedsAttention();
  }
  throw new ProviderError(
    `Graph ${response.status} ${response.statusText}: ${text || '(no body)'}`,
    'onedrive',
    `GRAPH_${response.status}`,
    response.status === 401,
    response.status === 429 || response.status >= 500
  );
}
```

- [ ] **Step 4: Wrap provider transfer errors** — in `onedrive-provider.ts`, wrap the `uploadFile` core call (lines 225-233):

```typescript
let fileId: string;
try {
  fileId = await this.cloudCore.uploadFile({
    // onedrive-core prefixes its own mokuro-reader root, so pass just the
    // bare series title here.
    seriesTitle,
    filename,
    blob: blobToUpload,
    credentials,
    onProgress
  });
} catch (error) {
  if (error instanceof ProviderError) throw error;
  const message = error instanceof Error ? error.message : 'Unknown error';
  throw new ProviderError(
    `OneDrive upload failed: ${message}`,
    'onedrive',
    'UPLOAD_FAILED',
    /\b401\b/.test(message),
    /network|timed out|\b429\b|\b5\d\d\b/i.test(message)
  );
}
console.log(`✅ Uploaded ${path} to OneDrive`);
return fileId;
```

And the `downloadFile` core call (lines 246-251):

```typescript
let buffer: ArrayBuffer;
try {
  buffer = await this.cloudCore.downloadFile({
    fileId: file.fileId,
    credentials,
    onProgress: onProgress || (() => {})
  });
} catch (error) {
  if (error instanceof ProviderError) throw error;
  const message = error instanceof Error ? error.message : 'Unknown error';
  throw new ProviderError(
    `OneDrive download failed: ${message}`,
    'onedrive',
    'DOWNLOAD_FAILED',
    /\b401\b/.test(message),
    /network|timed out|\b429\b|\b5\d\d\b/i.test(message)
  );
}
return new Blob([buffer], { type: 'application/zip' });
```

- [ ] **Step 5: Run the onedrive suite + typecheck**

Run: `npx vitest run src/lib/util/sync/providers/onedrive && npm run check`
Expected: PASS. If existing tests asserted plain-Error messages from graph-client, update them to expect `ProviderError` (message shape is unchanged).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(onedrive): typed ProviderError classification; 401 flags reconnect"
```

---

### Task 5: OneDrive folder-creation mutex + 409 tolerance

`ensureMokuroFolder`/`ensureSeriesFolder` are unguarded check-then-create with `conflictBehavior: 'fail'` — N parallel uploads into a new series race to a Graph 409. MEGA's coalescing pattern (`mega-provider.ts:165-166`, `:458-497`, `:1282-1321`) is the reference.

**Files:**

- Modify: `src/lib/util/sync/providers/onedrive/onedrive-provider.ts:141-158`
- Modify: `src/lib/util/sync/providers/onedrive/__tests__/onedrive-provider.test.ts`

**Interfaces:**

- Produces: `ensureMokuroFolder`/`ensureSeriesFolder` are concurrency-safe (single in-flight create per path) and tolerate a 409 from an external racer by re-fetching.

- [ ] **Step 1: Write the failing test** (add to `onedrive-provider.test.ts`; `prepareUploadTarget` is the public entry into `ensureSeriesFolder`):

```typescript
describe('folder creation coalescing', () => {
  it('creates a missing series folder exactly once under concurrent prepareUploadTarget calls', async () => {
    // Follow the file's existing graph-client mock setup. Arrange:
    // - getItemByPath: mokuro root exists; series folder missing (null) until created
    // - createFolder: resolves after a tick, records call count
    let created = false;
    vi.mocked(getItemByPath).mockImplementation(async (_t, path) => {
      if (path === 'mokuro-reader') return { id: 'root-id', name: 'mokuro-reader', folder: {} };
      return created ? { id: 'series-id', name: 'Series', folder: {} } : null;
    });
    vi.mocked(createFolder).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      created = true;
      return { id: 'series-id', name: 'Series', folder: {} };
    });

    const provider = new OneDriveProvider();
    await Promise.all([
      provider.prepareUploadTarget('Series'),
      provider.prepareUploadTarget('Series'),
      provider.prepareUploadTarget('Series')
    ]);

    expect(vi.mocked(createFolder)).toHaveBeenCalledTimes(1);
  });

  it('recovers when createFolder 409s because another client already created it', async () => {
    const { ProviderError } = await import('../../../provider-interface');
    let calls = 0;
    vi.mocked(getItemByPath).mockImplementation(async (_t, path) => {
      if (path === 'mokuro-reader') return { id: 'root-id', name: 'mokuro-reader', folder: {} };
      calls++;
      return calls > 1 ? { id: 'series-id', name: 'Series', folder: {} } : null;
    });
    vi.mocked(createFolder).mockRejectedValue(
      new ProviderError('Graph 409 Conflict: nameAlreadyExists', 'onedrive', 'GRAPH_409')
    );

    const provider = new OneDriveProvider();
    await expect(provider.prepareUploadTarget('Series')).resolves.not.toThrow();
  });
});
```

(If the test file mocks graph-client differently — e.g. via `vi.mock('../graph-client')` with a factory — adapt the `vi.mocked(...)` handles to that factory. Requires the provider mock for `isAuthenticated` to return true; mirror the `listCloudVolumes` tests' arrangement.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/util/sync/providers/onedrive/__tests__/onedrive-provider.test.ts`
Expected: FAIL — `createFolder` called 3 times; 409 propagates.

- [ ] **Step 3: Implement** — replace `ensureMokuroFolder`/`ensureSeriesFolder` (lines 141-158):

```typescript
  // Coalesce concurrent folder creation (MEGA pattern): parallel uploads into
  // a new series must not each POST createFolder — Graph 409s on the losers.
  private mokuroFolderPromise: Promise<string> | null = null;
  private seriesFolderPromises = new Map<string, Promise<string>>();

  /**
   * createFolder uses conflictBehavior 'fail'; if ANOTHER client (worker,
   * second tab) won the race, re-fetch and return the existing folder.
   */
  private async createFolderTolerant(parentPath: string, name: string): Promise<string> {
    const token = await onedriveTokenManager.getAccessToken();
    try {
      const created = await createFolder(token, parentPath, name);
      return created.id;
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'GRAPH_409') {
        const fullPath = parentPath ? `${parentPath}/${name}` : name;
        const existing = await getItemByPath(token, fullPath);
        if (existing) return existing.id;
      }
      throw error;
    }
  }

  private async ensureMokuroFolder(): Promise<string> {
    const token = await onedriveTokenManager.getAccessToken();
    const existing = await getItemByPath(token, ONEDRIVE_CONFIG.MOKURO_FOLDER);
    if (existing) return existing.id;

    if (this.mokuroFolderPromise) return this.mokuroFolderPromise;
    this.mokuroFolderPromise = (async () => {
      try {
        const id = await this.createFolderTolerant('', ONEDRIVE_CONFIG.MOKURO_FOLDER);
        console.log(`Created ${ONEDRIVE_CONFIG.MOKURO_FOLDER} folder in OneDrive`);
        return id;
      } finally {
        this.mokuroFolderPromise = null;
      }
    })();
    return this.mokuroFolderPromise;
  }

  private async ensureSeriesFolder(seriesTitle: string): Promise<string> {
    const token = await onedriveTokenManager.getAccessToken();
    const path = `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${seriesTitle}`;
    const existing = await getItemByPath(token, path);
    if (existing) return existing.id;

    const inFlight = this.seriesFolderPromises.get(seriesTitle);
    if (inFlight) return inFlight;

    const promise = (async () => {
      try {
        await this.ensureMokuroFolder();
        return await this.createFolderTolerant(ONEDRIVE_CONFIG.MOKURO_FOLDER, seriesTitle);
      } finally {
        this.seriesFolderPromises.delete(seriesTitle);
      }
    })();
    this.seriesFolderPromises.set(seriesTitle, promise);
    return promise;
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/util/sync/providers/onedrive`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix(onedrive): coalesce folder creation; tolerate 409 from concurrent clients"
```

---

### Task 6: OneDrive chunked-upload resilience (retry, resume, 202 drain, timeout)

The chunk loop (`onedrive-core.ts:79-103`) has zero retry — any blip aborts the whole session; 202 bodies are never read; no fetch has a timeout. `parseNextExpectedRange` exists (`upload-session.ts:39-44`, tested) but was never wired in.

**Files:**

- Modify: `src/lib/util/sync/core/providers/onedrive-core.ts:42-109`
- Modify: `src/lib/util/sync/core/providers/__tests__/onedrive-core.test.ts`

**Interfaces:**

- Consumes: `parseNextExpectedRange(ranges: string[]): number | null` from `../../providers/onedrive/upload-session`.
- Produces: unchanged `onedriveCore.uploadFile(...)` signature; now survives transient chunk failures (408/429/5xx/network) with 400ms→5s backoff, resumes from Graph's `nextExpectedRanges`, and every response body is consumed.

- [ ] **Step 1: Write the failing tests** (add to `onedrive-core.test.ts`, matching its `vi.stubGlobal('fetch', vi.fn())` style):

```typescript
it('retries a transient 503 chunk failure, resuming from nextExpectedRanges', async () => {
  const CHUNK = 10 * 1024 * 1024;
  // Session init
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
  } as Response);
  // Chunk 1 OK (202)
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 202,
    json: async () => ({ nextExpectedRanges: [`${CHUNK}-`] })
  } as Response);
  // Chunk 2 fails transiently
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    text: async () => ''
  } as Response);
  // Session status query → resume where we left off
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ nextExpectedRanges: [`${CHUNK}-`] })
  } as Response);
  // Chunk 2 retry succeeds (final → 201 + driveItem)
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 201,
    json: async () => ({ id: 'item-after-retry' })
  } as Response);

  const blob = new Blob([new Uint8Array(CHUNK + 100)]);
  const id = await onedriveCore.uploadFile({
    seriesTitle: 'S',
    filename: 'v.cbz',
    blob,
    credentials: { accessToken: 'TOKEN' }
  });
  expect(id).toBe('item-after-retry');
  // init + chunk1 + failed chunk2 + status query + retried chunk2
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(5);
}, 15000);

it('gives up after repeated transient failures with a descriptive error', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
  } as Response);
  // Every subsequent call (chunk PUTs and status queries) fails
  vi.mocked(fetch).mockResolvedValue({
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    text: async () => '',
    json: async () => ({})
  } as Response);

  const blob = new Blob([new Uint8Array(100)]);
  await expect(
    onedriveCore.uploadFile({
      seriesTitle: 'S',
      filename: 'v.cbz',
      blob,
      credentials: { accessToken: 'TOKEN' }
    })
  ).rejects.toThrow(/after 5 attempts/i);
}, 30000);

it('fails fast on a non-retryable 4xx without retrying', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
  } as Response);
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: async () => 'invalid range'
  } as Response);

  const blob = new Blob([new Uint8Array(100)]);
  await expect(
    onedriveCore.uploadFile({
      seriesTitle: 'S',
      filename: 'v.cbz',
      blob,
      credentials: { accessToken: 'TOKEN' }
    })
  ).rejects.toThrow(/400/);
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2); // no retry
});

it('consumes 202 response bodies (no unread streams)', async () => {
  const CHUNK = 10 * 1024 * 1024;
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
  } as Response);
  const json202 = vi.fn(async () => ({ nextExpectedRanges: [`${CHUNK}-`] }));
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 202,
    json: json202
  } as unknown as Response);
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 201,
    json: async () => ({ id: 'done' })
  } as Response);

  await onedriveCore.uploadFile({
    seriesTitle: 'S',
    filename: 'v.cbz',
    blob: new Blob([new Uint8Array(CHUNK + 1)]),
    credentials: { accessToken: 'TOKEN' }
  });
  expect(json202).toHaveBeenCalled();
});
```

Note: the existing multi-chunk test already mocks `json` on its 202 response, so it keeps passing once bodies are read.

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run src/lib/util/sync/core/providers/__tests__/onedrive-core.test.ts`
Expected: retry tests FAIL (upload throws on first 503); 202-drain test FAIL (`json202` never called).

- [ ] **Step 3: Implement** — in `onedrive-core.ts`, change the import to include the parser:

```typescript
import { createChunkRanges, parseNextExpectedRange } from '../../providers/onedrive/upload-session';
```

(`createChunkRanges` stays exported/tested but is no longer used here — remove it from the import if eslint flags it, and leave `upload-session.ts` untouched.)

Add module-level helpers under `encodePath`:

```typescript
const MAX_CHUNK_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 400;
const RETRY_MAX_DELAY_MS = 5000;
const CHUNK_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_TIMEOUT_MS = 30 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Ask the upload session where to resume (Graph tracks received ranges
 * server-side). Returns null when the session can't say — caller retries
 * from its own counter.
 */
async function queryResumeOffset(uploadUrl: string): Promise<number | null> {
  try {
    const response = await fetch(uploadUrl, { signal: AbortSignal.timeout(SESSION_TIMEOUT_MS) });
    if (!response.ok) {
      await response.text().catch(() => '');
      return null;
    }
    const data = (await response.json()) as { nextExpectedRanges?: string[] };
    return data.nextExpectedRanges ? parseNextExpectedRange(data.nextExpectedRanges) : null;
  } catch {
    return null;
  }
}
```

Replace the session-creation fetch options (add a timeout signal):

```typescript
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
    }),
    signal: AbortSignal.timeout(SESSION_TIMEOUT_MS)
  }
);
```

Replace the chunk loop (lines 79-108) entirely:

```typescript
let lastItemId: string | null = null;
let offset = 0;
let attempt = 0;

const retryOrThrow = async (reason: string): Promise<void> => {
  attempt++;
  if (attempt >= MAX_CHUNK_ATTEMPTS) {
    throw new Error(`OneDrive upload failed after ${MAX_CHUNK_ATTEMPTS} attempts: ${reason}`);
  }
  await sleep(Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS));
  // Trust Graph's record of received bytes over our own counter.
  const resume = await queryResumeOffset(uploadUrl);
  if (resume !== null) offset = resume;
};

while (offset < blob.size) {
  const end = Math.min(offset + ONEDRIVE_CONFIG.UPLOAD_CHUNK_SIZE - 1, blob.size - 1);

  let chunkResponse: Response;
  try {
    chunkResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(end - offset + 1),
        'Content-Range': `bytes ${offset}-${end}/${blob.size}`
      },
      body: blob.slice(offset, end + 1),
      signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS)
    });
  } catch (error) {
    await retryOrThrow(error instanceof Error ? error.message : 'network error');
    continue;
  }

  if (chunkResponse.status === 200 || chunkResponse.status === 201) {
    // Final chunk returns the completed driveItem.
    const item = (await chunkResponse.json()) as { id: string };
    lastItemId = item.id;
    offset = end + 1;
    attempt = 0;
    onProgress?.(offset, blob.size);
    continue;
  }

  if (chunkResponse.status === 202) {
    // Intermediate chunk. Drain the body (avoids stream retention) and
    // use Graph's nextExpectedRanges as the authoritative next offset.
    const body = (await chunkResponse.json().catch(() => null)) as {
      nextExpectedRanges?: string[];
    } | null;
    const next = body?.nextExpectedRanges ? parseNextExpectedRange(body.nextExpectedRanges) : null;
    offset = next ?? end + 1;
    attempt = 0;
    onProgress?.(offset, blob.size);
    continue;
  }

  await chunkResponse.text().catch(() => '');
  if (!isRetryableStatus(chunkResponse.status)) {
    throw new Error(
      `OneDrive upload chunk failed: ${chunkResponse.status} ${chunkResponse.statusText}`
    );
  }
  await retryOrThrow(`HTTP ${chunkResponse.status} ${chunkResponse.statusText}`);
}

if (!lastItemId) {
  throw new Error('OneDrive upload session did not return a final driveItem');
}
return lastItemId;
```

Note: the give-up test spends ~7.6s in real backoff sleeps (400+800+1600+3200ms ×(no fake timers)) — the `30000` test timeout covers it. If the suite feels slow later, switch that one test to `vi.useFakeTimers()` + `vi.runAllTimersAsync()`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/util/sync/core/providers/__tests__/onedrive-core.test.ts src/lib/util/sync/providers/onedrive`
Expected: PASS, including the pre-existing 5 upload tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(onedrive): chunk upload retry/resume via nextExpectedRanges, timeouts, 202 drain"
```

---

### Task 7: Filesystem restore hardening, typed errors, honest quota

Three gaps: a broken stored handle (folder deleted/moved → `queryPermission` throws) is never cleared, so Reconnect loops forever; mid-session `NotFoundError`/`NotAllowedError` escape as raw DOMExceptions (never typed `NOT_FOUND`, never flip needs-reconnect); `getStorageQuota` reports the browser-origin estimate as if it were folder disk space.

**Files:**

- Modify: `src/lib/util/sync/providers/filesystem/filesystem-provider.ts`
- Modify: `src/lib/util/sync/providers/filesystem/__tests__/filesystem-provider.test.ts` (reuse its existing fake-handle helpers — read the file first; it already fabricates directory/file handles for the `renameFolder` tests)

**Interfaces:**

- Produces: private `toProviderError(error, operation, path): ProviderError` used by all ops — `NotFoundError` → code `'NOT_FOUND'`, message contains `not found` (consumed by `unified-cloud-manager.ts:28` and the `unified-sync-service.ts:360` sniffer); `NotAllowedError`/`SecurityError` → code `'PERMISSION_REVOKED'`, `isAuthError: true`, nulls `rootHandle`, and pings `providerManager.updateStatus()` via dynamic import (webdav's `notifyStatusChanged` pattern, `webdav-provider.ts:110-115`).
- Produces: `getStorageQuota()` always returns `{ used: 0, total: null, available: null }`.

- [ ] **Step 1: Read the existing test file's fake-handle helpers** (`head -80 src/lib/util/sync/providers/filesystem/__tests__/filesystem-provider.test.ts`) and write failing tests in its style:

```typescript
describe('error classification', () => {
  it('converts NotFoundError to a typed NOT_FOUND ProviderError with a sniffable message', async () => {
    const provider = connectedProvider(); // root handle whose getFileHandle throws NotFoundError
    // Arrange the fake root to throw:
    root.getFileHandle = vi.fn().mockRejectedValue(new DOMException('missing', 'NotFoundError'));

    const err = await provider
      .downloadFile({
        provider: 'filesystem',
        fileId: 'S/v.cbz',
        path: 'S/v.cbz',
        modifiedTime: '',
        size: 1
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toMatch(/not found/i);
  });

  it('converts NotAllowedError to isAuthError and flips into needs-reconnect state', async () => {
    const provider = connectedProvider();
    root.getFileHandle = vi.fn().mockRejectedValue(new DOMException('revoked', 'NotAllowedError'));

    const err = await provider
      .downloadFile({
        provider: 'filesystem',
        fileId: 'v.cbz',
        path: 'v.cbz',
        modifiedTime: '',
        size: 1
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.isAuthError).toBe(true);
    expect(provider.isAuthenticated()).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(true);
  });
});

describe('restoreHandle', () => {
  it('clears a stored handle whose queryPermission throws (folder deleted/moved)', async () => {
    const broken = {
      name: 'gone',
      queryPermission: vi.fn().mockRejectedValue(new DOMException('x', 'InvalidStateError'))
    };
    vi.mocked(loadRootHandle).mockResolvedValue(broken as any);

    const provider = new FilesystemProvider();
    await provider.whenReady();

    expect(clearRootHandle).toHaveBeenCalled();
    expect(provider.getStatus().hasStoredCredentials).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(false);
  });
});

describe('getStorageQuota', () => {
  it('returns the unavailable shape — origin estimate is not folder disk space', async () => {
    const provider = connectedProvider();
    await expect(provider.getStorageQuota()).resolves.toEqual({
      used: 0,
      total: null,
      available: null
    });
  });
});
```

(Exact helper names — `connectedProvider()`, `root`, the `handle-store` mock — must match what the existing test file provides; adapt while keeping the assertions identical. The file already mocks `$app/environment` and `feature-detect` if it constructs providers.)

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run src/lib/util/sync/providers/filesystem`
Expected: new tests FAIL (raw DOMException, no clear-on-throw, quota returns estimate).

- [ ] **Step 3: Implement in `filesystem-provider.ts`**

3a. Add the two private helpers after `requireRoot()` (~line 158):

```typescript
  /** Refresh provider-manager status after an in-provider state change
   *  (dynamic import avoids a circular dependency — same as WebDAV). */
  private notifyStatusChanged(): void {
    import('../../provider-manager').then(({ providerManager }) => {
      providerManager.updateStatus();
    });
  }

  /**
   * Convert raw File System Access API failures into typed ProviderErrors.
   * NOT_FOUND code + "not found" message are load-bearing: unified-cloud-manager
   * keys idempotent deletes off the code, and unified-sync-service sniffs the
   * message for missing-file-is-fine paths.
   */
  private toProviderError(error: unknown, operation: string, path: string): ProviderError {
    if (error instanceof ProviderError) return error;
    if (error instanceof DOMException) {
      if (error.name === 'NotFoundError') {
        return new ProviderError(
          `${operation} failed: '${path}' not found`,
          'filesystem',
          'NOT_FOUND'
        );
      }
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
        // Permission revoked mid-session — flip to needs-reconnect so the UI
        // stops pretending we're connected.
        this.rootHandle = null;
        this.notifyStatusChanged();
        return new ProviderError(
          `${operation} failed: folder permission was revoked`,
          'filesystem',
          'PERMISSION_REVOKED',
          true
        );
      }
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new ProviderError(`${operation} failed: ${message}`, 'filesystem', 'OPERATION_FAILED');
  }
```

3b. Wrap each public op body. Pattern (apply to `listCloudVolumes`, `uploadFile`, `downloadFile`, `deleteFile`, `renameFile`, `renameFolder` — keeping each body identical inside the try):

```typescript
  async downloadFile(
    file: CloudFileMetadata,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    try {
      this.requireRoot();
      const fileHandle = await this.resolveFileHandle(file.fileId, { create: false });
      const data = await fileHandle.getFile();
      onProgress?.(data.size, data.size);
      console.log(`✅ Downloaded ${file.path} from filesystem`);
      return data;
    } catch (error) {
      throw this.toProviderError(error, 'Download', file.path);
    }
  }
```

Operation labels: `'List'` (path `''`), `'Upload'`, `'Download'`, `'Delete'`, `'Rename'`, `'Rename folder'` (path `oldPath`). `renameFolder`'s internal best-effort `catch { /* Already gone */ }` cleanup block stays as-is. `deleteSeriesFolder` already handles NotFoundError — leave it.

3c. Replace `restoreHandle()` (lines 126-146):

```typescript
  private async restoreHandle(): Promise<void> {
    let stored: FileSystemDirectoryHandle | null = null;
    try {
      stored = await loadRootHandle();
    } catch (error) {
      // IndexedDB read failed (transient) — keep config; a reload can retry.
      console.warn('Failed to load stored filesystem handle:', error);
      return;
    }
    if (!stored) return;
    this.hasStoredHandle = true;
    try {
      // @ts-expect-error — queryPermission is Chromium-only, not in all TS lib.dom targets
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
      // queryPermission threw: the handle itself is dead (folder deleted or
      // moved). Clear it so the user gets a fresh picker instead of a
      // Reconnect button that can never succeed.
      console.warn('Stored filesystem handle is unusable; clearing:', error);
      this.hasStoredHandle = false;
      await clearRootHandle().catch(() => {});
      clearActiveProviderKey();
    }
  }
```

3d. In `reauthenticate()` (lines 106-124), wrap the `requestPermission` call the same way:

```typescript
let permission: string;
try {
  // @ts-expect-error — requestPermission is Chromium-only, not in all TS lib.dom targets
  permission = await stored.requestPermission({ mode: 'readwrite' });
} catch (error) {
  // Handle is dead (folder deleted/moved) — clear it so login() offers a fresh picker.
  this.hasStoredHandle = false;
  await clearRootHandle().catch(() => {});
  clearActiveProviderKey();
  throw new ProviderError(
    'The previously chosen folder no longer exists — choose a folder again',
    'filesystem',
    'NOT_CONFIGURED'
  );
}
```

3e. Replace `getStorageQuota()` (lines 367-376):

```typescript
  async getStorageQuota(): Promise<StorageQuota> {
    // navigator.storage.estimate() reports the browser-origin quota, which has
    // nothing to do with the chosen folder's free disk space. Report "unknown"
    // rather than a misleading number; the UI hides bars for null totals.
    return { used: 0, total: null, available: null };
  }
```

Then verify the CloudView quota section renders sanely with `total: null` (read the block at `src/lib/views/CloudView.svelte:1213-1253`); if it assumes non-null totals, guard it with an `{#if quota.total !== null}` around the bar and show "Storage info unavailable" otherwise.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib/util/sync/providers/filesystem && npm run check`
Expected: PASS (existing renameFolder/paths/handle-store/feature-detect tests plus new ones).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix(filesystem): typed errors, dead-handle recovery, honest quota"
```

---

### Task 8: Filesystem renameFile idempotency (source gone + destination matches → converged)

Filesystem rename is copy-then-delete (not atomic). If a retry runs after a prior attempt completed, the source is gone → after Task 7 that's a typed NOT*FOUND, which `unified-cloud-manager.moveFile` (`:501-514`) correctly treats as a genuine failure — so a \_successful* prior move would be reported as failed. WebDAV solves exactly this with a source-gone + destination-size-match check (`webdav-provider.ts` renameFile); mirror it.

**Files:**

- Modify: `src/lib/util/sync/providers/filesystem/filesystem-provider.ts` (renameFile)
- Modify: `src/lib/util/sync/providers/filesystem/__tests__/filesystem-provider.test.ts`

**Interfaces:**

- Consumes: `toProviderError` from Task 7.
- Produces: `renameFile` returns destination metadata when the source is missing but the destination exists with the source's recorded size; throws typed NOT_FOUND otherwise.

- [ ] **Step 1: Write the failing test** (same fake-handle style):

```typescript
describe('renameFile idempotency', () => {
  it('treats source-gone + matching destination as an already-completed rename', async () => {
    // Fake tree: destination 'B/v.cbz' exists with size 42; source 'A/v.cbz' missing.
    const provider = providerWithTree({ 'B/v.cbz': fileOfSize(42) });
    const result = await provider.renameFile(
      { provider: 'filesystem', fileId: 'A/v.cbz', path: 'A/v.cbz', modifiedTime: '', size: 42 },
      'B/v.cbz'
    );
    expect(result.path).toBe('B/v.cbz');
    expect(result.size).toBe(42);
  });

  it('still throws typed NOT_FOUND when the source is gone and no matching destination exists', async () => {
    const provider = providerWithTree({});
    const err = await provider
      .renameFile(
        { provider: 'filesystem', fileId: 'A/v.cbz', path: 'A/v.cbz', modifiedTime: '', size: 42 },
        'B/v.cbz'
      )
      .catch((e) => e);
    expect(err.code).toBe('NOT_FOUND');
  });
});
```

(Adapt `providerWithTree`/`fileOfSize` to whatever fake-handle helpers the test file actually has.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/util/sync/providers/filesystem`
Expected: FAIL — first test throws NOT_FOUND.

- [ ] **Step 3: Implement** — in `renameFile`, replace the unconditional source resolution (`const sourceHandle = await this.resolveFileHandle(file.fileId, { create: false }); const sourceFile = await sourceHandle.getFile();`) with:

```typescript
let sourceFile: File;
try {
  const sourceHandle = await this.resolveFileHandle(file.fileId, { create: false });
  sourceFile = await sourceHandle.getFile();
} catch (error) {
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    // Idempotent retry: copy-then-delete isn't atomic, so a prior attempt
    // may have completed. Source gone + destination matching the source's
    // recorded size = already renamed (same convergence rule as WebDAV).
    try {
      const destHandle = await this.resolveFileHandle(normalizedNewPath, { create: false });
      const destFile = await destHandle.getFile();
      if (typeof file.size === 'number' && destFile.size === file.size) {
        console.log(`↩️ ${normalizedNewPath} already at destination (idempotent retry)`);
        return {
          provider: 'filesystem',
          fileId: normalizedNewPath,
          path: normalizedNewPath,
          modifiedTime: new Date(destFile.lastModified).toISOString(),
          size: destFile.size
        };
      }
    } catch {
      // No destination either — fall through to the typed NOT_FOUND below.
    }
  }
  throw this.toProviderError(error, 'Rename', file.path);
}
```

(This sits inside Task 7's outer try/catch; nested handling is fine because `toProviderError` passes through existing `ProviderError`s.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/util/sync/providers/filesystem`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix(filesystem): idempotent renameFile retry (source gone, destination matches)"
```

---

### Task 9: `removeDirectoryIfEmpty` for OneDrive and Filesystem

Develop's rename flow prunes emptied series folders via the optional `removeDirectoryIfEmpty` (`unified-cloud-manager.ts:363-373`); gdrive/mega/webdav implement it, the two new providers don't — cross-series moves leave orphan folders. Contract (`provider-interface.ts:333-341`): server-verified emptiness, never a blind recursive delete, best-effort (swallow failures).

**Files:**

- Modify: `src/lib/util/sync/providers/onedrive/onedrive-provider.ts` (add method after `deleteSeriesFolder`)
- Modify: `src/lib/util/sync/providers/filesystem/filesystem-provider.ts` (add method after `deleteSeriesFolder`)
- Modify: both providers' test files

**Interfaces:**

- Produces: `removeDirectoryIfEmpty(relativePath: string): Promise<void>` on both providers, matching the optional method on `SyncProvider`.

- [ ] **Step 1: Write the failing tests**

OneDrive (`onedrive-provider.test.ts`, graph-client mocked as in Task 5):

```typescript
describe('removeDirectoryIfEmpty', () => {
  it('deletes a folder the server reports empty', async () => {
    vi.mocked(getItemByPath).mockResolvedValue({ id: 'dir-id', name: 'Old', folder: {} });
    vi.mocked(listChildren).mockResolvedValue([]);
    const provider = new OneDriveProvider();
    await provider.removeDirectoryIfEmpty('Old Series');
    expect(vi.mocked(deleteItem)).toHaveBeenCalledWith(expect.anything(), 'dir-id');
  });

  it('keeps a folder that still has children', async () => {
    vi.mocked(getItemByPath).mockResolvedValue({ id: 'dir-id', name: 'Old', folder: {} });
    vi.mocked(listChildren).mockResolvedValue([{ id: 'x', name: 'v.cbz', file: {} }]);
    const provider = new OneDriveProvider();
    await provider.removeDirectoryIfEmpty('Old Series');
    expect(vi.mocked(deleteItem)).not.toHaveBeenCalled();
  });

  it('no-ops when the folder is already gone', async () => {
    vi.mocked(getItemByPath).mockResolvedValue(null);
    const provider = new OneDriveProvider();
    await expect(provider.removeDirectoryIfEmpty('Old Series')).resolves.toBeUndefined();
    expect(vi.mocked(deleteItem)).not.toHaveBeenCalled();
  });
});
```

Filesystem (`filesystem-provider.test.ts`, fake-handle style — empty dir yields no entries from `values()`):

```typescript
describe('removeDirectoryIfEmpty', () => {
  it('removes an empty directory non-recursively', async () => {
    const provider = providerWithTree({ 'Old Series/': emptyDir() });
    await provider.removeDirectoryIfEmpty('Old Series');
    expect(rootRemoveEntry).toHaveBeenCalledWith('Old Series');
  });

  it('keeps a directory that still has entries', async () => {
    const provider = providerWithTree({ 'Old Series/v.cbz': fileOfSize(1) });
    await provider.removeDirectoryIfEmpty('Old Series');
    expect(rootRemoveEntry).not.toHaveBeenCalled();
  });

  it('is best-effort: swallows a missing directory', async () => {
    const provider = providerWithTree({});
    await expect(provider.removeDirectoryIfEmpty('Old Series')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failures** — both suites: method doesn't exist.

- [ ] **Step 3: Implement**

OneDrive (after `deleteSeriesFolder`, ~line 363):

```typescript
  /**
   * Remove a series directory only if the SERVER confirms it is empty — never
   * a blind recursive delete (Graph folder deletion is recursive). Best-effort:
   * an orphaned empty directory is harmless.
   */
  async removeDirectoryIfEmpty(relativePath: string): Promise<void> {
    if (!this.isAuthenticated()) return;
    const normalized = relativePath.replace(/^\/+|\/+$/g, '');
    if (!normalized) return;
    try {
      const token = await onedriveTokenManager.getAccessToken();
      const path = `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${normalized}`;
      const item = await getItemByPath(token, path);
      if (!item || !item.folder) return;
      const children = await listChildren(token, path);
      if (children.length > 0) return;
      await deleteItem(token, item.id);
      console.log(`✅ Pruned empty series folder '${normalized}' from OneDrive`);
    } catch (error) {
      console.warn(`Could not prune OneDrive folder '${normalized}':`, error);
    }
  }
```

Filesystem (after `deleteSeriesFolder`, ~line 365):

```typescript
  /**
   * Remove a directory only if it is verifiably empty — never recursive.
   * Best-effort: an orphaned empty directory is harmless.
   */
  async removeDirectoryIfEmpty(relativePath: string): Promise<void> {
    if (!this.isAuthenticated()) return;
    const normalized = relativePath.replace(/^\/+|\/+$/g, '');
    if (!normalized) return;
    try {
      const dir = await this.resolveDirectoryHandle(normalized, { create: false });
      // @ts-expect-error — values() is defined on FileSystemDirectoryHandle at runtime
      for await (const _entry of dir.values()) {
        return; // any entry → not empty → keep
      }
      const parentPath = getParentPath(normalized);
      const parent = parentPath
        ? await this.resolveDirectoryHandle(parentPath, { create: false })
        : this.requireRoot();
      await parent.removeEntry(getBasename(normalized));
      console.log(`✅ Pruned empty folder '${normalized}' from filesystem`);
    } catch {
      // Already gone or unreadable — harmless.
    }
  }
```

(If eslint flags the unused `_entry`, use `for await (const _ of dir.values())` or add an inline eslint-disable for that line — match repo conventions.)

- [ ] **Step 4: Run tests** — `npx vitest run src/lib/util/sync/providers` — PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(sync): removeDirectoryIfEmpty for onedrive and filesystem providers"
```

---

### Task 10: UI parity — CloudView action gating, OneDrive config gate, shared provider display names

Three UI gaps: Sync/Backup/Profile buttons stay clickable while filesystem/onedrive need reconnect (`CloudView.svelte:1184` only gates webdav read-only); the OneDrive selection button renders even when `VITE_ONEDRIVE_CLIENT_ID` is unset (throws only at click time — filesystem feature-gates, OneDrive should config-gate); `PlaceholderVolumeItem.svelte:40-75` labels the new providers "Cloud"/gray and `VolumeItem.svelte:476` shows raw slugs in the delete snackbar.

**Files:**

- Create: `src/lib/util/sync/provider-display.ts`
- Create: `src/lib/util/sync/provider-display.test.ts`
- Modify: `src/lib/views/CloudView.svelte` (~:56, ~:77-86, ~:918-933, ~:1184)
- Modify: `src/lib/components/PlaceholderVolumeItem.svelte:39-78`
- Modify: `src/lib/components/VolumeItem.svelte:476`

**Interfaces:**

- Produces: `PROVIDER_LABELS`, `PROVIDER_SHORT_LABELS`, `PROVIDER_BADGE_COLORS` — all `Record<ProviderType, …>` so adding a sixth provider is a compile error until every map is updated.

- [ ] **Step 1: Write the display-map test**

`src/lib/util/sync/provider-display.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PROVIDER_LABELS, PROVIDER_SHORT_LABELS, PROVIDER_BADGE_COLORS } from './provider-display';

const ALL = ['google-drive', 'mega', 'webdav', 'filesystem', 'onedrive'] as const;

describe('provider-display', () => {
  it('covers every provider in every map', () => {
    for (const p of ALL) {
      expect(PROVIDER_LABELS[p]).toBeTruthy();
      expect(PROVIDER_SHORT_LABELS[p]).toBeTruthy();
      expect(PROVIDER_BADGE_COLORS[p]).toBeTruthy();
    }
  });

  it('names the new providers properly (no "Cloud" fallback)', () => {
    expect(PROVIDER_SHORT_LABELS.onedrive).toBe('OneDrive');
    expect(PROVIDER_SHORT_LABELS.filesystem).toBe('Local Folder');
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement**

`src/lib/util/sync/provider-display.ts`:

```typescript
import type { ProviderType } from './provider-interface';

/** Full names for headers and provider-selection screens. */
export const PROVIDER_LABELS: Record<ProviderType, string> = {
  'google-drive': 'Google Drive',
  mega: 'MEGA Cloud Storage',
  webdav: 'WebDAV Server',
  filesystem: 'Local Folder',
  onedrive: 'OneDrive'
};

/** Short names for badges and snackbars. */
export const PROVIDER_SHORT_LABELS: Record<ProviderType, string> = {
  'google-drive': 'Drive',
  mega: 'MEGA',
  webdav: 'WebDAV',
  filesystem: 'Local Folder',
  onedrive: 'OneDrive'
};

export type ProviderBadgeColor = 'blue' | 'purple' | 'green' | 'yellow' | 'indigo' | 'gray';

export const PROVIDER_BADGE_COLORS: Record<ProviderType, ProviderBadgeColor> = {
  'google-drive': 'blue',
  mega: 'purple',
  webdav: 'green',
  filesystem: 'yellow',
  onedrive: 'indigo'
};
```

- [ ] **Step 4: Wire the components**

4a. `PlaceholderVolumeItem.svelte` — delete `getProviderDisplayName`, the local `BadgeColor` type, and `getProviderBadgeColor` (lines 39-78); import and use the maps:

```typescript
import { PROVIDER_SHORT_LABELS, PROVIDER_BADGE_COLORS } from '$lib/util/sync/provider-display';
// …
const providerName = cloudProvider ? PROVIDER_SHORT_LABELS[cloudProvider] : 'Cloud';
const badgeColor = cloudProvider ? PROVIDER_BADGE_COLORS[cloudProvider] : 'gray';
```

(Flowbite's Badge `color` prop accepts these values; run `npm run check` to confirm the type union matches — if Flowbite's type is wider, no change needed.)

4b. `VolumeItem.svelte:476` — replace the ternary:

```typescript
const providerName = PROVIDER_SHORT_LABELS[providerType];
```

with import `import { PROVIDER_SHORT_LABELS } from '$lib/util/sync/provider-display';` added to the script block.

4c. `CloudView.svelte` — replace the local `providerNames` map (lines 80-86) with the shared one:

```typescript
import { PROVIDER_LABELS } from '$lib/util/sync/provider-display';
const providerNames = PROVIDER_LABELS;
```

4d. `CloudView.svelte` — action-button gating. Near the other derived state (~line 76), add:

```typescript
// Sync/Backup/Profile actions are pointless while the session is unusable —
// mirror the webdav read-only gate for the two reconnect states.
let providerActionsUnavailable = $derived(
  (currentProvider === 'webdav' && webdavIsReadOnly) ||
    (currentProvider === 'filesystem' && filesystemNeedsReconnect) ||
    (currentProvider === 'onedrive' && onedriveNeedsAttention)
);
```

And change line 1184 from `{:else if !(currentProvider === 'webdav' && webdavIsReadOnly)}` to:

```svelte
            {:else if !providerActionsUnavailable}
```

4e. `CloudView.svelte` — config-gate the OneDrive selection button. Near `filesystemSupported` (~line 56):

```typescript
const onedriveConfigured = !!import.meta.env.VITE_ONEDRIVE_CLIENT_ID;
```

Wrap the OneDrive selection button (lines ~918-933) in `{#if onedriveConfigured}` … `{/if}`, exactly like the filesystem button's `{#if filesystemSupported}` block above it.

- [ ] **Step 5: Verify** — `npx vitest run src/lib/util/sync/provider-display.test.ts && npm run check` → PASS, 0 errors. Also run the full component tests: `npx vitest run src/lib/components` → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(ui): gate actions on reconnect states; shared provider labels; config-gate OneDrive"
```

---

### Task 11: Deployment docs (CLAUDE.md, README, .env.example)

`VITE_ONEDRIVE_CLIENT_ID` is required (`onedrive/constants.ts:2`, enforced `token-manager.ts:46`) but documented nowhere; a deployer also needs the Azure app-registration steps (SPA redirect URI = deploy origin).

**Files:**

- Modify: `CLAUDE.md` ("Environment Variables" section, ~lines 251-260)
- Modify: `README.md` (env section, ~line 189 — locate with `grep -n "VITE_GDRIVE" README.md`)
- Create: `.env.example`

- [ ] **Step 1: Update CLAUDE.md** — replace the Environment Variables section body:

```markdown
## Environment Variables

Create a `.env.local` file for cloud provider integration:

​`
VITE_GDRIVE_CLIENT_ID=your_client_id
VITE_GDRIVE_API_KEY=your_api_key
VITE_ONEDRIVE_CLIENT_ID=your_azure_app_client_id
​`

- `VITE_GDRIVE_*`: required only for Google Drive sync.
- `VITE_ONEDRIVE_CLIENT_ID`: required only for OneDrive sync. Register an
  Azure AD app (any Microsoft account tenant, "common" authority) and add the
  deploy origin as a **Single-page application** redirect URI. Scopes used:
  `Files.ReadWrite`, `offline_access`, `User.Read`. When unset, the OneDrive
  option is hidden from the cloud screen.
- MEGA, WebDAV, and Local Folder require no env vars.
```

(Remove the stray zero-width characters around the code fence when writing the actual file — they're only here to nest the fences.)

- [ ] **Step 2: Update README.md** — find its env-var section and make the same addition (match the README's existing formatting/tone; include the SPA-redirect-URI note).

- [ ] **Step 3: Create `.env.example`**:

```
# Google Drive sync (optional — omit to disable)
VITE_GDRIVE_CLIENT_ID=
VITE_GDRIVE_API_KEY=

# OneDrive sync (optional — omit to hide the OneDrive option)
# Azure AD app registration with the deploy origin as an SPA redirect URI.
VITE_ONEDRIVE_CLIENT_ID=
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: document VITE_ONEDRIVE_CLIENT_ID and Azure app registration"
```

---

### Task 12: Full verification gates

- [ ] **Step 1: Typecheck** — `npm run check` → 0 errors, 0 warnings.
- [ ] **Step 2: Full test suite** — `npx vitest run` → all pass (baseline 887 + ~25 new).
- [ ] **Step 3: Lint** — `npm run lint` → clean (run `npm run format` first if prettier complains).
- [ ] **Step 4: Build** — `npm run build` → succeeds.
- [ ] **Step 5:** If anything fails, fix before declaring done; re-run the failing gate. Do NOT push.

---

## Explicitly out of scope (noted for follow-up, do not do here)

- **WebDAV folder-creation mutex** — same race as OneDrive's (pre-existing on develop, `webdav-provider.ts:445,824`); fix on develop separately.
- **Cache triplication** (webdav-cache/onedrive-cache/filesystem-cache ~95% identical) — mechanical dedup refactor, no behavior change; separate cleanup branch.
- **MEGA-style reactive cache for onedrive/filesystem** — MEGA has push events; Graph delta/polling is a feature, not parity.
- **OneDrive byte-level upload progress** — 10 MiB chunk granularity is acceptable.
- **Filesystem provider-level filename sanitization** — higher layers already sanitize (develop's `sanitize-title.ts` at import/rename); provider-level OS-char handling is theoretical until a bug proves otherwise.
