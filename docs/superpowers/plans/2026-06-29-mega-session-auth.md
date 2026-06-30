# MEGA Session-Token Auth, 2FA & Worker Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace MEGA's plaintext email/password storage with a reused, revocable session token (megajs `toJSON`/`fromJSON`), add two-step 2FA login, and replace the worker share-link download hack and upload-worker password with lightweight session-based file access.

**Architecture:** The main-thread `MegaProvider` persists a sanitized `Storage.toJSON()` blob (`sid` + master key, no password) under `localStorage['mega_session']`, restores it with `Storage.fromJSON()` + `reload()`, maps the `EMFAREQUIRED` error to a `MFA_REQUIRED` `ProviderError`, and detects `ESID` to drive a needs-attention reconnect. Upload workers receive the session blob (`fromJSON` + `reload`) instead of a password; download workers (Phase 2) receive `{ sid, nodeId, fileKey }` and build a `File` that downloads the owned node directly — no share link, no master key in the download worker.

**Tech Stack:** SvelteKit 5, TypeScript, megajs ^1.3.9 (browser ESM build), Vitest (jsdom), Dexie.

## Global Constraints

- **megajs resolution:** `import { Storage, File } from 'megajs'` resolves to `dist/main.browser-es.mjs` in Vite (main thread + workers). All API facts below are verified against that build.
- **Security invariant (post-Phase-1):** No plaintext MEGA password is ever persisted in `localStorage` or sent to a worker. The only persisted secret is `localStorage['mega_session']` = `JSON.stringify(sanitizeSessionBlob(storage.toJSON()))` — it contains `sid` + the account master `key`. **Never `console.log` this blob or its `key`.**
- **megajs API contracts (verified):**
  - `new Storage(options, cb?)` — `options.autoload` (default true) gates the file-tree fetch; `options.autologin` (default true) gates login; `options.secondFactorCode` → the `us` command's `mfa` field. The `cb` fires after login completes (after tree load when `autoload:true`).
  - `storage.toJSON()` → `{ key, sid, name, user, options }` (`options` still contains `email` and, if set, `secondFactorCode`).
  - `Storage.fromJSON(json)` rebuilds an authenticated Storage with **no network call**, forcing `autoload:false`+`autologin:false`, and sets `storage.aes`/`storage.sid`/`storage.api.sid`. It leaves `storage.status === 'closed'` and `storage.files === {}` (no tree) until you call `reload`.
  - `await storage.reload(true)` issues `{a:'f',c:1}` and populates `storage.root` + `storage.files`. `storage.root.mkdir()` / `folder.upload()` are `MutableFile` methods that do **not** check `storage.status`, so they work after `fromJSON`+`reload`.
  - A `File` built as `new File({ downloadId, key, api })` with `file.nodeId` set downloads the owned node via `{a:'g', n:nodeId}`, authorized by `api.sid`. `formatKey(string)` base64url-decodes (`d64`) into a real megajs Buffer, so transport the per-file key as MEGA base64url (`encodeMegaKey`).
  - Error strings: `EMFAREQUIRED (-26): Multi-Factor Authentication Required`; `ESID (-15): Invalid or expired user session, please relogin`. No numeric `.code` — match the message.
- **Testing:** Vitest jsdom. Single file run: `npx vitest run <path>`. `localStorage` is auto-mocked by `src/test-setup.ts` (Map-backed; call `localStorage.clear()` in `beforeEach`). Mock `$app/environment` with `vi.mock('$app/environment', () => ({ browser: true }))` and megajs with `vi.mock('megajs', ...)`.
- **Type-check:** `npm run check`. **Lint:** `npm run lint`.
- **Worktree setup:** This worktree (`feat/mega-session-auth`) has **no `node_modules`**. Run `npm install` once before any test/check command.
- **Commits:** Commit after each task. Do **not** push (active development). End commit messages with the project's `Co-Authored-By` trailer.
- **Phasing:** Phase 1 (Tasks 1–7) = token auth + 2FA + migration + upload worker; independently shippable. Phase 2 (Tasks 8–10) = download workers + remove share links.

---

## Phase 1 — Token auth, 2FA, migration, upload worker

### Task 1: Pure session helpers (`mega-session.ts`)

**Files:**
- Create: `src/lib/util/sync/providers/mega/mega-session.ts`
- Test: `src/lib/util/sync/providers/mega/mega-session.test.ts`

**Interfaces:**
- Produces:
  - `interface MegaSessionBlob { key: string; sid: string; name?: string; user?: string; options?: Record<string, any> }`
  - `isMfaRequiredError(error: unknown): boolean`
  - `isSessionExpiredError(error: unknown): boolean`
  - `isAuthRejectionError(error: unknown): boolean`
  - `sanitizeSessionBlob(blob: any): MegaSessionBlob`
  - `encodeMegaKey(key: Uint8Array): string`

- [ ] **Step 1: Run `npm install` in the worktree (one-time prerequisite)**

Run: `npm install`
Expected: completes; `node_modules/megajs` present.

- [ ] **Step 2: Write the failing test**

Create `src/lib/util/sync/providers/mega/mega-session.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  isMfaRequiredError,
  isSessionExpiredError,
  isAuthRejectionError,
  sanitizeSessionBlob,
  encodeMegaKey
} from './mega-session';

describe('mega-session error classifiers', () => {
  it('detects 2FA-required from the EMFAREQUIRED message', () => {
    expect(
      isMfaRequiredError(new Error('EMFAREQUIRED (-26): Multi-Factor Authentication Required'))
    ).toBe(true);
    expect(isMfaRequiredError(new Error('wrong password'))).toBe(false);
  });

  it('detects expired session from the ESID message', () => {
    expect(
      isSessionExpiredError(
        new Error('ESID (-15): Invalid or expired user session, please relogin')
      )
    ).toBe(true);
    expect(isSessionExpiredError(new Error('EAGAIN congestion'))).toBe(false);
  });

  it('detects genuine auth rejection but not transient errors', () => {
    expect(isAuthRejectionError(new Error('wrong password'))).toBe(true);
    expect(isAuthRejectionError(new Error('ENOENT'))).toBe(true);
    expect(isAuthRejectionError(new Error('network timeout'))).toBe(false);
  });
});

describe('sanitizeSessionBlob', () => {
  it('keeps sid/key/user/name and strips password + secondFactorCode from options', () => {
    const blob = sanitizeSessionBlob({
      key: 'KEY',
      sid: 'SID',
      name: 'n',
      user: 'u',
      options: { email: 'a@b.c', password: 'p', secondFactorCode: '123456', autoload: true }
    });
    expect(blob).toEqual({
      key: 'KEY',
      sid: 'SID',
      name: 'n',
      user: 'u',
      options: { email: 'a@b.c', autoload: true }
    });
    expect(blob.options).not.toHaveProperty('password');
    expect(blob.options).not.toHaveProperty('secondFactorCode');
  });
});

describe('encodeMegaKey', () => {
  it('produces URL-safe base64 without padding (matches megajs e64)', () => {
    // btoa('\xff\xff\xff') === '////'  -> '____'
    expect(encodeMegaKey(new Uint8Array([255, 255, 255]))).toBe('____');
    // btoa('\x00') === 'AA==' -> strip padding -> 'AA'
    expect(encodeMegaKey(new Uint8Array([0]))).toBe('AA');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/util/sync/providers/mega/mega-session.test.ts`
Expected: FAIL — cannot resolve `./mega-session`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/util/sync/providers/mega/mega-session.ts`:

```ts
/**
 * Pure helpers for MEGA session-token auth: error classification, session-blob
 * sanitization, and per-file key encoding for worker transport.
 *
 * No side effects, no DOM, no megajs imports — safe to unit test in isolation.
 */

/** Sanitized megajs `Storage.toJSON()` blob persisted under localStorage['mega_session']. */
export interface MegaSessionBlob {
  /** Account master key (base64url) — sensitive. */
  key: string;
  /** Session id. */
  sid: string;
  name?: string;
  user?: string;
  /** megajs options minus password/secondFactorCode. */
  options?: Record<string, any>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** MEGA signals "2FA code required" only via the EMFAREQUIRED (-26) error message. */
export function isMfaRequiredError(error: unknown): boolean {
  return /EMFAREQUIRED|Multi-Factor|-26/i.test(messageOf(error));
}

/** MEGA signals an invalid/expired session via ESID (-15). */
export function isSessionExpiredError(error: unknown): boolean {
  return /ESID|-15|expired user session|please relogin/i.test(messageOf(error));
}

/** Genuine credential rejection (wrong email/password) vs transient/network errors. */
export function isAuthRejectionError(error: unknown): boolean {
  return /ENOENT|incorrect|invalid|authentication failed|wrong password/i.test(messageOf(error));
}

/** Strip single-use / sensitive fields from a `toJSON()` blob before persisting. */
export function sanitizeSessionBlob(blob: any): MegaSessionBlob {
  const options = { ...(blob?.options ?? {}) };
  delete options.password;
  delete options.secondFactorCode;
  return { key: blob.key, sid: blob.sid, name: blob.name, user: blob.user, options };
}

/**
 * Encode a raw MEGA key buffer to MEGA's base64url ("e64") form so a worker's
 * `formatKey` (d64) reconstructs the identical megajs Buffer.
 */
export function encodeMegaKey(key: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < key.length; i++) binary += String.fromCharCode(key[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/util/sync/providers/mega/mega-session.test.ts`
Expected: PASS (3 describe blocks, all green).

- [ ] **Step 6: Commit**

```bash
git add src/lib/util/sync/providers/mega/mega-session.ts src/lib/util/sync/providers/mega/mega-session.test.ts
git commit -m "feat(mega): add pure session-token helpers (error classifiers, blob sanitizer, key encoder)"
```

---

### Task 2: Session-aware `login()` with 2FA + `persistSession()`

**Files:**
- Modify: `src/lib/util/sync/providers/mega/mega-provider.ts` (`MegaCredentials` 16-19; `STORAGE_KEYS` 21-25; imports 10-14; class fields 143-153; `login()` 195-249; `waitForReady()` 302-326 — remove)
- Test: `src/lib/util/sync/providers/mega/mega-provider.test.ts` (new)

**Interfaces:**
- Consumes (Task 1): `sanitizeSessionBlob`, `isMfaRequiredError`.
- Produces: `login({ email, password, secondFactorCode? })` persists `mega_session` and removes legacy keys on success; throws `ProviderError` with `code === 'MFA_REQUIRED'` when 2FA is needed. New private fields `needsReconnect: boolean`, `reconnectEmail: string | null`. New `STORAGE_KEYS.SESSION = 'mega_session'`. New `private persistSession(): void`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/util/sync/providers/mega/mega-provider.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('./mega-cache', () => ({ megaCache: { fetch: vi.fn() } }));
vi.mock('../../cache-manager', () => ({
  cacheManager: { clearAll: vi.fn(), registerCache: vi.fn() }
}));

// Controllable megajs Storage mock.
const storageState = vi.hoisted(() => ({
  // What the next `new Storage(opts, cb)` should do.
  loginError: null as Error | null,
  lastOptions: null as any,
  toJSON: () => ({
    key: 'MASTERKEY',
    sid: 'SID123',
    name: 'n',
    user: 'u',
    options: { email: 'a@b.c', password: 'secret', secondFactorCode: '123456', autoload: true }
  }),
  files: { f1: { name: 'mokuro-reader', directory: true } } as Record<string, any>
}));

vi.mock('megajs', () => {
  class MockStorage {
    files: Record<string, any>;
    sid = 'SID123';
    constructor(options: any, cb?: (e: Error | null) => void) {
      storageState.lastOptions = options;
      this.files = storageState.files;
      // Defer cb so the caller's `const s = new Storage(...)` is assigned first.
      if (cb) queueMicrotask(() => cb(storageState.loginError));
    }
    toJSON() {
      return storageState.toJSON();
    }
    getAccountInfo() {
      return Promise.resolve({ spaceUsed: 0, spaceTotal: 100 });
    }
    static fromJSON = vi.fn();
  }
  return { Storage: MockStorage, File: vi.fn() };
});

import { MegaProvider } from './mega-provider';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  storageState.loginError = null;
  storageState.files = { f1: { name: 'mokuro-reader', directory: true } };
});

describe('MegaProvider.login()', () => {
  it('persists a sanitized session blob and removes legacy password on success', async () => {
    const provider = new MegaProvider();
    await provider.whenReady();

    await provider.login({ email: 'a@b.c', password: 'secret' });

    expect(provider.isAuthenticated()).toBe(true);
    const raw = localStorage.getItem('mega_session');
    expect(raw).toBeTruthy();
    const blob = JSON.parse(raw!);
    expect(blob.sid).toBe('SID123');
    expect(blob.key).toBe('MASTERKEY');
    expect(blob.options).not.toHaveProperty('password');
    expect(blob.options).not.toHaveProperty('secondFactorCode');
    expect(localStorage.getItem('mega_password')).toBeNull();
    expect(localStorage.getItem('active_cloud_provider')).toBe('mega');
  });

  it('forwards secondFactorCode to the Storage constructor', async () => {
    const provider = new MegaProvider();
    await provider.whenReady();

    await provider.login({ email: 'a@b.c', password: 'secret', secondFactorCode: '654321' });

    expect(storageState.lastOptions.secondFactorCode).toBe('654321');
  });

  it('maps EMFAREQUIRED to a MFA_REQUIRED ProviderError', async () => {
    storageState.loginError = new Error(
      'EMFAREQUIRED (-26): Multi-Factor Authentication Required'
    );
    const provider = new MegaProvider();
    await provider.whenReady();

    await expect(provider.login({ email: 'a@b.c', password: 'secret' })).rejects.toMatchObject({
      code: 'MFA_REQUIRED'
    });
    expect(provider.isAuthenticated()).toBe(false);
    expect(localStorage.getItem('mega_session')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/util/sync/providers/mega/mega-provider.test.ts`
Expected: FAIL — `login` still stores `mega_email`/`mega_password`, no `mega_session`, no `MFA_REQUIRED` mapping.

- [ ] **Step 3: Add imports + STORAGE_KEYS.SESSION + MegaCredentials field + class fields**

In `src/lib/util/sync/providers/mega/mega-provider.ts`, update the import of provider-detection (line 13) to also keep existing, and add the session-helper import after line 14:

```ts
import {
  isMfaRequiredError,
  isSessionExpiredError,
  isAuthRejectionError,
  sanitizeSessionBlob,
  encodeMegaKey,
  type MegaSessionBlob
} from './mega-session';
```

Replace the `MegaCredentials` interface (16-19):

```ts
interface MegaCredentials {
  email: string;
  password: string;
  /** One-time TOTP code for 2FA-enabled accounts. Never persisted. */
  secondFactorCode?: string;
}
```

Replace `STORAGE_KEYS` (21-25):

```ts
const STORAGE_KEYS = {
  /** Sanitized Storage.toJSON() blob (sid + master key). The only persisted secret. */
  SESSION: 'mega_session',
  // Legacy keys — read for migration, removed on first successful login.
  EMAIL: 'mega_email',
  PASSWORD: 'mega_password',
  FOLDER_PATH: 'mega_folder_path'
};
```

Add two private fields alongside the existing ones (after line 144 `private mokuroFolder: any = null;`):

```ts
  private needsReconnect = false;
  private reconnectEmail: string | null = null;
```

- [ ] **Step 4: Replace `login()` (195-249) and delete `waitForReady()` (302-326)**

Replace the whole `login()` method body with:

```ts
  async login(credentials?: ProviderCredentials): Promise<void> {
    if (!credentials || !credentials.email || !credentials.password) {
      throw new ProviderError('Email and password are required', 'mega', 'INVALID_CREDENTIALS');
    }

    const { email, password, secondFactorCode } = credentials as MegaCredentials;

    try {
      // Dynamically import megajs to reduce initial bundle size
      const { Storage } = await import('megajs');

      // Fresh interactive login. The constructor cb fires after the tree loads
      // (autoload:true), so the Storage is ready once this promise resolves.
      const storage: any = await new Promise((resolve, reject) => {
        const s = new Storage(
          { email, password, secondFactorCode, autoload: true } as any,
          (error: Error | null) => (error ? reject(error) : resolve(s))
        );
      });

      this.storage = storage;
      await this.ensureMokuroFolder();
      this.persistSession();
      this.needsReconnect = false;
      this.reconnectEmail = email;
      setActiveProviderKey('mega');
      console.log('✅ MEGA login successful');
    } catch (error) {
      this.storage = null;
      this.mokuroFolder = null;

      if (isMfaRequiredError(error)) {
        throw new ProviderError(
          'MEGA requires a two-factor authentication code',
          'mega',
          'MFA_REQUIRED',
          false
        );
      }

      throw new ProviderError(
        `MEGA login failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'LOGIN_FAILED',
        true
      );
    }
  }

  /** Persist the current session as a sanitized toJSON() blob; drop legacy keys. */
  private persistSession(): void {
    if (!browser || !this.storage) return;
    const blob: MegaSessionBlob = sanitizeSessionBlob(this.storage.toJSON());
    localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(blob));
    localStorage.removeItem(STORAGE_KEYS.EMAIL);
    localStorage.removeItem(STORAGE_KEYS.PASSWORD);
  }
```

Delete the now-unused `waitForReady()` method (originally lines 302-326). Confirm no other caller: `grep -n waitForReady src/lib/util/sync/providers/mega/mega-provider.ts` returns nothing after deletion.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/util/sync/providers/mega/mega-provider.test.ts`
Expected: PASS (3 tests in `login()`).

- [ ] **Step 6: Type-check + commit**

Run: `npm run check` (expect no new errors in mega-provider.ts).

```bash
git add src/lib/util/sync/providers/mega/mega-provider.ts src/lib/util/sync/providers/mega/mega-provider.test.ts
git commit -m "feat(mega): session-token login with 2FA support and password-free persistence"
```

---

### Task 3: `restoreSession()`, migration, and `reinitialize()` via session

**Files:**
- Modify: `src/lib/util/sync/providers/mega/mega-provider.ts` (`loadPersistedCredentials()` 266-300 → rewrite as `restorePersistedSession()`; constructor 155-161; `reinitialize()` 332-368)
- Test: `src/lib/util/sync/providers/mega/mega-provider.test.ts` (extend)

**Interfaces:**
- Consumes (Task 1): `isSessionExpiredError`, `isAuthRejectionError`, `isMfaRequiredError`. (Task 2): `login()`, `persistSession`.
- Produces: `private restoreSession(blob: MegaSessionBlob): Promise<void>` (fromJSON + reload); `restorePersistedSession(): Promise<void>` (session-first, legacy migration fallback); `reinitialize()` refreshes via a fresh `fromJSON` of the stored session (no password, no re-login). Constructor calls `restorePersistedSession()`.

- [ ] **Step 1: Write the failing tests (append to mega-provider.test.ts)**

Add a `fromJSON` impl to the megajs mock by replacing the `static fromJSON = vi.fn();` line with a working stub that returns a ready-ish storage, and append these tests:

In the `vi.mock('megajs', ...)` block, replace `static fromJSON = vi.fn();` with:

```ts
    static fromJSON = vi.fn((json: any) => {
      const s = new MockStorage({ autologin: false, autoload: false } as any);
      s.sid = json.sid;
      (s as any).reload = vi.fn(async () => {
        if (storageState.reloadError) throw storageState.reloadError;
      });
      return s;
    });
```

Add `reloadError` to `storageState` hoisted object: `reloadError: null as Error | null,` and reset it in `beforeEach` (`storageState.reloadError = null;`). Also give `MockStorage` a default `reload`: add `reload = vi.fn(async () => {});` as an instance field.

Append:

```ts
describe('MegaProvider session restore + migration', () => {
  it('migrates legacy email/password to a session blob on load', async () => {
    localStorage.setItem('mega_email', 'a@b.c');
    localStorage.setItem('mega_password', 'secret');

    const provider = new MegaProvider();
    await provider.whenReady();

    expect(provider.isAuthenticated()).toBe(true);
    expect(localStorage.getItem('mega_session')).toBeTruthy();
    expect(localStorage.getItem('mega_password')).toBeNull();
  });

  it('restores from an existing session blob without re-login', async () => {
    localStorage.setItem(
      'mega_session',
      JSON.stringify({ key: 'MASTERKEY', sid: 'SID123', name: 'n', user: 'u', options: {} })
    );

    const provider = new MegaProvider();
    await provider.whenReady();

    expect(provider.isAuthenticated()).toBe(true);
    const { Storage } = (await import('megajs')) as any;
    expect(Storage.fromJSON).toHaveBeenCalledOnce();
  });

  it('flags needs-attention when the stored session is expired (ESID)', async () => {
    storageState.reloadError = new Error(
      'ESID (-15): Invalid or expired user session, please relogin'
    );
    localStorage.setItem(
      'mega_session',
      JSON.stringify({ key: 'MASTERKEY', sid: 'DEAD', name: 'n', user: 'u', options: { email: 'a@b.c' } })
    );

    const provider = new MegaProvider();
    await provider.whenReady();

    expect(provider.isAuthenticated()).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(true);
    expect(localStorage.getItem('mega_session')).toBeNull();
  });
});
```

> Note: the ESID test asserts `getStatus().needsAttention` — that wiring lands in Task 4. If executing strictly task-by-task, expect this single assertion to fail until Task 4 and the rest to pass; mark it `it.todo` until Task 4, or implement Task 4's `getStatus`/`markSessionExpired` together with this task. (Subagent-driven execution: keep them in the same task pair.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/util/sync/providers/mega/mega-provider.test.ts`
Expected: FAIL — no `restoreSession`/migration; `fromJSON` not called.

- [ ] **Step 3: Implement `restoreSession()` + `restorePersistedSession()`**

Replace `loadPersistedCredentials()` (266-300) with:

```ts
  /** Rebuild an authenticated Storage from a saved session blob (no password, no login round-trip). */
  private async restoreSession(blob: MegaSessionBlob): Promise<void> {
    const { Storage } = await import('megajs');
    const storage: any = Storage.fromJSON(blob);
    // fromJSON does no network and loads no tree; reload populates root + files.
    // A dead session throws ESID here.
    await storage.reload(true);
    this.storage = storage;
    this.mokuroFolder = null;
    await this.ensureMokuroFolder();
    this.needsReconnect = false;
    this.reconnectEmail = (blob.options && (blob.options as any).email) || this.reconnectEmail;
    setActiveProviderKey('mega');
  }

  /** Restore on app load: session blob first, then one-time legacy email/password migration. */
  async restorePersistedSession(): Promise<void> {
    if (!browser) return;

    const sessionRaw = localStorage.getItem(STORAGE_KEYS.SESSION);
    if (sessionRaw) {
      try {
        await this.restoreSession(JSON.parse(sessionRaw) as MegaSessionBlob);
        console.log('Restored MEGA session from stored token');
      } catch (error) {
        if (isSessionExpiredError(error) || isAuthRejectionError(error)) {
          console.error('Stored MEGA session invalid; reconnect required');
          this.markSessionExpired();
        } else {
          console.warn('Failed to restore MEGA session (temporary error), will retry:', error);
        }
      }
      return;
    }

    // Legacy migration: log in with stored email/password, which persists a session blob
    // and removes the password (see login()/persistSession()).
    const email = localStorage.getItem(STORAGE_KEYS.EMAIL);
    const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);
    if (email && password) {
      try {
        await this.login({ email, password });
        console.log('Migrated MEGA legacy credentials to session token');
      } catch (error) {
        if (isMfaRequiredError(error)) {
          // Account enabled 2FA after the password was stored — cannot migrate silently.
          this.reconnectEmail = email;
          this.markSessionExpired();
        } else if (isAuthRejectionError(error)) {
          this.reconnectEmail = email;
          this.markSessionExpired();
        } else {
          console.warn('MEGA migration deferred (temporary error), keeping legacy creds:', error);
        }
      }
    }
  }
```

Update the constructor (155-161) to call the renamed method:

```ts
  constructor() {
    if (browser) {
      this.initPromise = this.restorePersistedSession();
    } else {
      this.initPromise = Promise.resolve();
    }
  }
```

- [ ] **Step 4: Rewrite `reinitialize()` (332-368) to refresh via the stored session**

```ts
  /**
   * Refresh the file-tree cache by rebuilding the session from the stored token.
   * No password and no re-login round-trip — fromJSON + reload only.
   */
  private async reinitialize(): Promise<void> {
    if (!browser) return;

    const sessionRaw = localStorage.getItem(STORAGE_KEYS.SESSION);
    if (!sessionRaw) {
      console.warn('Cannot reinitialize MEGA: no stored session');
      return;
    }

    const oldStorage = this.storage;
    try {
      const { Storage } = await import('megajs');
      const storage: any = Storage.fromJSON(JSON.parse(sessionRaw));
      await storage.reload(true);
      this.storage = storage;
      this.mokuroFolder = null;
      // Release the previous session's keepalive/sc listeners.
      if (oldStorage && typeof oldStorage.close === 'function') {
        try {
          await oldStorage.close();
        } catch {
          /* best effort */
        }
      }
      console.log('✅ MEGA cache reinitialized from session token');
    } catch (error) {
      if (isSessionExpiredError(error)) {
        this.markSessionExpired();
        return;
      }
      // Transient error: keep the existing (stale) storage so we don't appear logged out.
      this.storage = oldStorage;
      console.warn('Continuing with potentially stale MEGA cache:', error);
    }
  }
```

- [ ] **Step 5: Run tests (with Task 4 implemented, or the ESID test marked todo)**

Run: `npx vitest run src/lib/util/sync/providers/mega/mega-provider.test.ts`
Expected: PASS for migration + restore; the ESID/needs-attention assertion passes once Task 4 lands.

- [ ] **Step 6: Commit**

```bash
git add src/lib/util/sync/providers/mega/mega-provider.ts src/lib/util/sync/providers/mega/mega-provider.test.ts
git commit -m "feat(mega): restore + migrate via session token; refresh cache without re-login"
```

---

### Task 4: `markSessionExpired()`, needs-attention `getStatus()`, `getLastUsername()`

**Files:**
- Modify: `src/lib/util/sync/providers/mega/mega-provider.ts` (`getStatus()` 175-193; add `markSessionExpired()`, `getLastUsername()`)
- Test: `src/lib/util/sync/providers/mega/mega-provider.test.ts` (the ESID test from Task 3 now asserts this)

**Interfaces:**
- Produces: `private markSessionExpired(): void` (clears `mega_session`, captures email for prefill, sets `needsReconnect`); `getStatus()` returns `needsAttention: this.needsReconnect`; `getLastUsername(): string | null` returns the reconnect email.

- [ ] **Step 1: Tests already written in Task 3 (ESID → needsAttention). Add a getLastUsername test.**

Append:

```ts
describe('MegaProvider needs-attention', () => {
  it('exposes the stored email via getLastUsername after session expiry', async () => {
    storageState.reloadError = new Error('ESID (-15): please relogin');
    localStorage.setItem(
      'mega_session',
      JSON.stringify({ key: 'K', sid: 'DEAD', options: { email: 'me@host.dev' } })
    );
    const provider = new MegaProvider();
    await provider.whenReady();
    expect(provider.getLastUsername()).toBe('me@host.dev');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/util/sync/providers/mega/mega-provider.test.ts`
Expected: FAIL — `markSessionExpired`/`getLastUsername` not defined; `needsAttention` always false.

- [ ] **Step 3: Add `markSessionExpired()` and `getLastUsername()`; update `getStatus()`**

Add methods (place near `getStatus`):

```ts
  /** Drop the stored session and flag the UI to prompt for reconnect (password never stored). */
  private markSessionExpired(): void {
    // Capture email for reconnect pre-fill before clearing.
    if (browser && !this.reconnectEmail) {
      const sessionRaw = localStorage.getItem(STORAGE_KEYS.SESSION);
      if (sessionRaw) {
        try {
          this.reconnectEmail = JSON.parse(sessionRaw)?.options?.email ?? null;
        } catch {
          /* ignore */
        }
      }
      this.reconnectEmail = this.reconnectEmail ?? localStorage.getItem(STORAGE_KEYS.EMAIL);
    }

    this.storage = null;
    this.mokuroFolder = null;
    this.needsReconnect = true;

    if (browser) {
      localStorage.removeItem(STORAGE_KEYS.SESSION);
      // Keep active_cloud_provider so the UI still shows MEGA in a needs-attention state.
    }
  }

  /** Email captured for reconnect pre-fill (mirrors WebDAV's getLastUsername). */
  getLastUsername(): string | null {
    if (this.reconnectEmail) return this.reconnectEmail;
    if (!browser) return null;
    const sessionRaw = localStorage.getItem(STORAGE_KEYS.SESSION);
    if (sessionRaw) {
      try {
        return JSON.parse(sessionRaw)?.options?.email ?? null;
      } catch {
        return null;
      }
    }
    return localStorage.getItem(STORAGE_KEYS.EMAIL);
  }
```

Replace `getStatus()` (175-193) with:

```ts
  getStatus(): ProviderStatus {
    const hasSession = !!(browser && localStorage.getItem(STORAGE_KEYS.SESSION));
    const hasLegacy = !!(
      browser &&
      localStorage.getItem(STORAGE_KEYS.EMAIL) &&
      localStorage.getItem(STORAGE_KEYS.PASSWORD)
    );
    const isConnected = this.isAuthenticated();

    return {
      isAuthenticated: isConnected,
      hasStoredCredentials: hasSession || hasLegacy,
      needsAttention: this.needsReconnect,
      statusMessage: isConnected
        ? 'Connected to MEGA'
        : this.needsReconnect
          ? 'MEGA session expired — please reconnect'
          : hasSession || hasLegacy
            ? 'Configured (not connected)'
            : 'Not configured'
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/util/sync/providers/mega/mega-provider.test.ts`
Expected: PASS (including the Task 3 ESID test and getLastUsername).

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/sync/providers/mega/mega-provider.ts src/lib/util/sync/providers/mega/mega-provider.test.ts
git commit -m "feat(mega): needs-attention state on session expiry with reconnect email prefill"
```

---

### Task 5: `logout()` + detection + manager key hygiene for `mega_session`

**Files:**
- Modify: `src/lib/util/sync/providers/mega/mega-provider.ts` (`logout()` 251-264)
- Modify: `src/lib/util/sync/provider-detection.ts` (`detectProviderFromCredentials()` 53-58)
- Modify: `src/lib/util/sync/provider-manager.ts` (logout key removal 197-199)
- Test: `src/lib/util/sync/providers/mega/mega-provider.test.ts`; `src/lib/util/sync/provider-detection.test.ts` (new)

**Interfaces:**
- Produces: `logout()` clears `mega_session` + legacy keys + reconnect flags; `detectProviderFromCredentials()` recognizes `mega_session` OR legacy pair.

- [ ] **Step 1: Write failing tests**

Append to `mega-provider.test.ts`:

```ts
describe('MegaProvider.logout()', () => {
  it('clears session, legacy keys, and needs-attention flag', async () => {
    localStorage.setItem('mega_session', JSON.stringify({ key: 'K', sid: 'S', options: {} }));
    localStorage.setItem('mega_email', 'a@b.c');
    localStorage.setItem('mega_password', 'p');
    localStorage.setItem('active_cloud_provider', 'mega');

    const provider = new MegaProvider();
    await provider.whenReady();
    await provider.logout();

    expect(localStorage.getItem('mega_session')).toBeNull();
    expect(localStorage.getItem('mega_email')).toBeNull();
    expect(localStorage.getItem('mega_password')).toBeNull();
    expect(localStorage.getItem('active_cloud_provider')).toBeNull();
    expect(provider.getStatus().needsAttention).toBe(false);
    expect(provider.isAuthenticated()).toBe(false);
  });
});
```

Create `src/lib/util/sync/provider-detection.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/util/sync/providers/google-drive/constants', () => ({
  GOOGLE_DRIVE_CONFIG: {
    STORAGE_KEYS: { HAS_AUTHENTICATED: 'gdrive_has_authenticated', TOKEN: 'gdrive_token' }
  }
}));

import { getConfiguredProviderType } from './provider-detection';

beforeEach(() => {
  localStorage.clear();
});

describe('provider detection (MEGA)', () => {
  it('detects MEGA from a session blob (new key)', () => {
    localStorage.setItem('mega_session', JSON.stringify({ sid: 'S', key: 'K' }));
    expect(getConfiguredProviderType()).toBe('mega');
  });

  it('still detects MEGA from legacy email/password (pre-migration)', () => {
    localStorage.setItem('mega_email', 'a@b.c');
    localStorage.setItem('mega_password', 'p');
    expect(getConfiguredProviderType()).toBe('mega');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/util/sync/providers/mega/mega-provider.test.ts src/lib/util/sync/provider-detection.test.ts`
Expected: FAIL — logout doesn't clear `mega_session`; detection ignores `mega_session`.

- [ ] **Step 3: Update `logout()`**

Replace `logout()` (251-264):

```ts
  async logout(): Promise<void> {
    this.storage = null;
    this.mokuroFolder = null;
    this.needsReconnect = false;
    this.reconnectEmail = null;

    if (browser) {
      localStorage.removeItem(STORAGE_KEYS.SESSION);
      localStorage.removeItem(STORAGE_KEYS.EMAIL);
      localStorage.removeItem(STORAGE_KEYS.PASSWORD);
      localStorage.removeItem(STORAGE_KEYS.FOLDER_PATH);
    }

    clearActiveProviderKey();
    console.log('MEGA logged out');
  }
```

- [ ] **Step 4: Update `detectProviderFromCredentials()` (provider-detection.ts 53-58)**

Replace the MEGA block:

```ts
  // Check MEGA credentials (new session token or legacy email/password)
  const megaSession = localStorage.getItem('mega_session');
  const megaEmail = localStorage.getItem('mega_email');
  const megaPassword = localStorage.getItem('mega_password');
  if (megaSession || (megaEmail && megaPassword)) {
    return 'mega';
  }
```

- [ ] **Step 5: Update `provider-manager.ts` logout key removal (197-199)**

Add `mega_session` removal alongside the existing MEGA keys:

```ts
      localStorage.removeItem('mega_session');
      localStorage.removeItem('mega_email');
      localStorage.removeItem('mega_password');
      localStorage.removeItem('mega_folder_path');
```

- [ ] **Step 6: Run tests + commit**

Run: `npx vitest run src/lib/util/sync/providers/mega/mega-provider.test.ts src/lib/util/sync/provider-detection.test.ts`
Expected: PASS.

```bash
git add src/lib/util/sync/providers/mega/mega-provider.ts src/lib/util/sync/provider-detection.ts src/lib/util/sync/provider-detection.test.ts src/lib/util/sync/provider-manager.ts
git commit -m "feat(mega): clear mega_session on logout and detect it for provider restore"
```

---

### Task 6: Upload worker uses the session blob (no password)

**Files:**
- Modify: `src/lib/util/sync/providers/mega/mega-provider.ts` (`getWorkerUploadCredentials()` 1197-1202)
- Modify: `src/lib/util/sync/core/providers/mega-core.ts` (`getUploadStorage` 22-50; `uploadFile` 98-101)
- Test: `src/lib/util/sync/providers/mega/mega-provider.test.ts`

**Interfaces:**
- Consumes: `localStorage['mega_session']`.
- Produces: `getWorkerUploadCredentials()` returns `{ megaSession: string }`; worker `getUploadStorage(session)` builds via `Storage.fromJSON(JSON.parse(session))` + `reload(true)`, cached by `sid`.

- [ ] **Step 1: Write failing test (provider side)**

Append to `mega-provider.test.ts`:

```ts
describe('MegaProvider.getWorkerUploadCredentials()', () => {
  it('returns the session blob, never a password', async () => {
    const sessionRaw = JSON.stringify({ key: 'K', sid: 'S', options: { email: 'a@b.c' } });
    localStorage.setItem('mega_session', sessionRaw);

    const provider = new MegaProvider();
    await provider.whenReady();
    const creds = await provider.getWorkerUploadCredentials();

    expect(creds).toEqual({ megaSession: sessionRaw });
    expect(creds).not.toHaveProperty('megaPassword');
    expect(creds).not.toHaveProperty('megaEmail');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/util/sync/providers/mega/mega-provider.test.ts`
Expected: FAIL — returns `{ megaEmail, megaPassword }`.

- [ ] **Step 3: Update `getWorkerUploadCredentials()` (1197-1202)**

```ts
  async getWorkerUploadCredentials(): Promise<Record<string, any>> {
    if (!browser) return {};
    const session = localStorage.getItem(STORAGE_KEYS.SESSION);
    return { megaSession: session };
  }
```

- [ ] **Step 4: Update the worker core (`mega-core.ts`)**

Replace `getUploadStorage()` (22-50) so it rebuilds from a session blob (no email/password). The cache key becomes the session's `sid`:

```ts
async function getUploadStorage(session: string): Promise<Storage> {
  const parsed = JSON.parse(session);
  const sessionKey: string = parsed.sid;

  if (uploadStoragePromise && uploadSessionKey === sessionKey) {
    return await uploadStoragePromise;
  }

  if (uploadStoragePromise && uploadSessionKey !== sessionKey) {
    await resetUploadStorage();
  }

  uploadSessionKey = sessionKey;
  const pendingSession = (async () => {
    const storage = Storage.fromJSON(parsed) as any;
    // fromJSON loads no tree; reload populates storage.root for folder navigation/upload.
    await storage.reload(true);
    return storage as Storage;
  })();
  uploadStoragePromise = pendingSession;

  try {
    return await pendingSession;
  } catch (error) {
    if (uploadStoragePromise === pendingSession) {
      uploadStoragePromise = null;
      uploadSessionKey = null;
    }
    throw error;
  }
}
```

Replace the credential reads in `uploadFile()` (99-101):

```ts
  async uploadFile({ seriesTitle, filename, blob, credentials, onProgress }): Promise<string> {
    const session = requireCredentialString(credentials, 'megaSession', 'MEGA session');
    const storage = await getUploadStorage(session);
```

(Leave the rest of `uploadFile` unchanged — `storage.root.children` / `storage.root.mkdir` / `folder.upload` work after `reload`.)

- [ ] **Step 5: Run provider test + type-check**

Run: `npx vitest run src/lib/util/sync/providers/mega/mega-provider.test.ts`
Expected: PASS.
Run: `npm run check`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/util/sync/providers/mega/mega-provider.ts src/lib/util/sync/core/providers/mega-core.ts
git commit -m "feat(mega): upload worker authenticates via session blob instead of password"
```

---

### Task 7: 2FA two-step UI + needs-attention reconnect (`CloudView.svelte`)

**Files:**
- Modify: `src/lib/views/CloudView.svelte` (MEGA state 99-101; `handleMegaLogin` 370-400; `handleLogout` 412-415; `onMount` prefill 326-337; MEGA form 648-674)

**Interfaces:**
- Consumes (Task 2/4): `megaProvider.login({ email, password, secondFactorCode })` throws `ProviderError` with `code === 'MFA_REQUIRED'`; `megaProvider.getLastUsername?.()`.

This task is UI; verify by manual run (no Vitest component test required — keep parity with the existing untested CloudView handlers). Steps below are edits, then a manual verification step.

- [ ] **Step 1: Add MEGA 2FA/reconnect state (after line 101)**

```svelte
  let megaTwoFactorCode = $state('');
  let megaNeeds2fa = $state(false);
  let megaNeedsReLogin = $state(false);
```

- [ ] **Step 2: Update `handleMegaLogin()` (370-400) for the two-step flow**

```svelte
  async function handleMegaLogin() {
    megaLoading = true;
    try {
      const megaProvider = await providerManager.getOrLoadProvider('mega');
      await megaProvider.login({
        email: megaEmail,
        password: megaPassword,
        secondFactorCode: megaNeeds2fa ? megaTwoFactorCode : undefined
      });

      await providerManager.setCurrentProvider(megaProvider);

      showSnackbar('Connected to MEGA - loading cloud data...');
      await unifiedCloudManager.fetchAllCloudVolumes();

      providerManager.updateStatus();
      showSnackbar('MEGA connected');

      // Clear form + 2FA/reconnect state
      megaEmail = '';
      megaPassword = '';
      megaTwoFactorCode = '';
      megaNeeds2fa = false;
      megaNeedsReLogin = false;

      await handlePostLogin();
    } catch (error) {
      if (error && (error as { code?: string }).code === 'MFA_REQUIRED') {
        // Reveal the 2FA field and keep email/password so the user just adds the code.
        megaNeeds2fa = true;
        showSnackbar('Enter your MEGA two-factor authentication code');
      } else {
        const message = error instanceof Error ? error.message : 'Unknown error';
        showSnackbar(message);
      }
    } finally {
      megaLoading = false;
    }
  }
```

- [ ] **Step 3: Reset 2FA state on logout (412-415)**

```svelte
    if (provider === 'mega') {
      megaEmail = '';
      megaPassword = '';
      megaTwoFactorCode = '';
      megaNeeds2fa = false;
      megaNeedsReLogin = false;
      showSnackbar('Logged out of MEGA');
    } else if (provider === 'webdav') {
```

- [ ] **Step 4: Prefill email + reconnect banner in `onMount` (extend the block at 326-337)**

After the WebDAV prefill block, add MEGA prefill:

```svelte
    // Pre-fill MEGA email + reconnect banner from last session (needs-attention)
    try {
      const megaProviderInstance = await providerManager.getOrLoadProvider('mega');
      const lastEmail = megaProviderInstance.getLastUsername?.();
      if (!megaEmail && lastEmail) megaEmail = lastEmail;
      if (megaProviderInstance.getStatus().needsAttention) {
        megaNeedsReLogin = true;
        const megaForm = document.getElementById('mega-login-form');
        if (megaForm) megaForm.classList.remove('hidden');
      }
    } catch {
      // Provider not loadable, ignore
    }
```

- [ ] **Step 5: Add the 2FA field + reconnect banner to the MEGA form (648-674)**

Replace the `<div id="mega-login-form" ...>` block contents:

```svelte
          <div id="mega-login-form" class="hidden pr-4 pb-4 pl-12">
            {#if megaNeedsReLogin}
              <p class="mb-3 text-sm text-amber-400">
                Your MEGA session expired — sign in again to reconnect.
              </p>
            {/if}
            <form
              onsubmit={(e) => {
                e.preventDefault();
                handleMegaLogin();
              }}
              class="flex flex-col gap-3"
            >
              <input
                type="email"
                bind:value={megaEmail}
                placeholder="Email"
                required
                class="rounded-lg border border-gray-600 bg-gray-700 p-2.5 text-sm text-white"
              />
              <input
                type="password"
                bind:value={megaPassword}
                placeholder="Password"
                required
                class="rounded-lg border border-gray-600 bg-gray-700 p-2.5 text-sm text-white"
              />
              {#if megaNeeds2fa}
                <input
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  bind:value={megaTwoFactorCode}
                  placeholder="6-digit 2FA code"
                  class="rounded-lg border border-amber-600 bg-gray-700 p-2.5 text-sm text-white"
                />
              {/if}
              <Button type="submit" disabled={megaLoading} color="blue" size="sm">
                {megaLoading
                  ? 'Connecting...'
                  : megaNeeds2fa
                    ? 'Verify & Connect'
                    : 'Connect to MEGA'}
              </Button>
            </form>
          </div>
```

- [ ] **Step 6: Type-check, lint, manual verify**

Run: `npm run check` and `npm run lint` — expect no new errors.
Run: `npm run dev`, open the cloud view:
- Non-2FA account: email+password connects; reload the page → still connected with **no** `mega_password` in `localStorage` and a `mega_session` present (DevTools → Application → Local Storage).
- 2FA account: email+password → "Enter your 2FA code" → field appears → code → connects.

- [ ] **Step 7: Commit**

```bash
git add src/lib/views/CloudView.svelte
git commit -m "feat(mega): two-step 2FA login UI and session-expiry reconnect prompt"
```

- [ ] **Step 8: Full Phase 1 regression**

Run: `npx vitest run` (whole suite) and `npm run check`.
Expected: all pass; no regressions in other providers.

---

## Phase 2 — Download workers without share links

### Task 8: `getWorkerDownloadCredentials()` → `{ sid, nodeId, fileKey }`; remove share-link machinery

**Files:**
- Modify: `src/lib/util/sync/providers/mega/mega-provider.ts` (`supportsWorkerDownload` comment 139; remove fields 146-148; remove `createShareLink` 1011-1061, `deleteShareLink` 1067-1110, `cleanupWorkerDownload` 1223-1233; rewrite `getWorkerDownloadCredentials` 1209-1221)
- Test: `src/lib/util/sync/providers/mega/mega-provider.test.ts`

**Interfaces:**
- Consumes (Task 1): `encodeMegaKey`. Existing `getNodeById()` (439-442).
- Produces: `getWorkerDownloadCredentials(fileId)` returns `{ sid: string, nodeId: string, fileKey: string }`. `createShareLink`/`deleteShareLink`/`cleanupWorkerDownload` removed (download-queue guards on their presence).

- [ ] **Step 1: Write failing test**

Append to `mega-provider.test.ts`:

```ts
describe('MegaProvider.getWorkerDownloadCredentials() (Phase 2)', () => {
  it('returns sid + nodeId + encoded per-file key, never a share link or master key', async () => {
    localStorage.setItem('mega_session', JSON.stringify({ key: 'K', sid: 'SID123', options: {} }));
    const provider = new MegaProvider();
    await provider.whenReady();

    // Seed the restored storage's tree with a target node.
    (provider as any).storage = {
      sid: 'SID123',
      files: {
        node1: { nodeId: 'node1', directory: false, key: new Uint8Array([255, 255, 255]) }
      }
    };

    const creds = await provider.getWorkerDownloadCredentials('node1');
    expect(creds).toEqual({ sid: 'SID123', nodeId: 'node1', fileKey: '____' });
    expect(creds).not.toHaveProperty('megaShareUrl');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/util/sync/providers/mega/mega-provider.test.ts`
Expected: FAIL — still returns `{ megaShareUrl }`.

- [ ] **Step 3: Rewrite `getWorkerDownloadCredentials()` (1209-1221)**

```ts
  async getWorkerDownloadCredentials(fileId: string): Promise<Record<string, any>> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }
    const node = this.getNodeById(fileId);
    if (!node || !node.key) {
      throw new ProviderError(
        `MEGA node not found or missing key: ${fileId}`,
        'mega',
        'NODE_NOT_FOUND',
        false,
        true
      );
    }
    // sid authorizes the owned-node download; the per-file key decrypts it.
    // The download worker never receives the account master key.
    return {
      sid: this.storage.sid,
      nodeId: node.nodeId,
      fileKey: encodeMegaKey(node.key as Uint8Array)
    };
  }
```

- [ ] **Step 4: Remove the now-dead share-link machinery**

Delete: the `createShareLink()` method (1011-1061), `deleteShareLink()` (1067-1110), and `cleanupWorkerDownload()` (1223-1233). Delete the three fields (146-148): `workerShareLinksToCleanup`, `workerShareLinkMutex`, `WORKER_SHARE_LINK_THROTTLE_MS`. Update the `supportsWorkerDownload` comment (139):

```ts
  readonly supportsWorkerDownload = true; // Workers download owned nodes via sid + per-file key
```

Verify nothing else references the removed symbols:
`grep -n "createShareLink\|deleteShareLink\|cleanupWorkerDownload\|workerShareLink\|WORKER_SHARE_LINK" src/lib/util/sync/providers/mega/mega-provider.ts` → no matches.

- [ ] **Step 5: Run tests + type-check**

Run: `npx vitest run src/lib/util/sync/providers/mega/mega-provider.test.ts`
Expected: PASS.
Run: `npm run check`
Expected: no new errors (download-queue's `cleanupWorkerDownload?` guard tolerates the method's absence).

- [ ] **Step 6: Commit**

```bash
git add src/lib/util/sync/providers/mega/mega-provider.ts src/lib/util/sync/providers/mega/mega-provider.test.ts
git commit -m "feat(mega): worker download credentials use sid + per-file key; drop share links"
```

---

### Task 9: Worker download via owned-node `File` (`mega-core.ts`)

**Files:**
- Modify: `src/lib/util/sync/core/providers/mega-core.ts` (`downloadFile` 53-96; add `getDownloadApi` helper)
- Test: `src/lib/util/sync/core/providers/mega-core.test.ts` (new)

**Interfaces:**
- Consumes: credentials `{ sid, nodeId, fileKey }` from Task 8.
- Produces: `downloadFile` builds `new File({ downloadId: nodeId, key: fileKey, api })` with `file.nodeId = nodeId` and streams `downloadBuffer`/`download`.

- [ ] **Step 1: Write failing test (mock megajs File + a sid-bearing api)**

Create `src/lib/util/sync/core/providers/mega-core.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const state = vi.hoisted(() => ({
  lastFileOpts: null as any,
  fileNodeIdAfterConstruct: null as any,
  chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]
}));

vi.mock('megajs', () => {
  class MockStorage {
    api: any = { sid: null };
    constructor(_opts: any) {}
  }
  class MockFile extends EventEmitter {
    nodeId: any = null;
    constructor(opts: any) {
      super();
      state.lastFileOpts = opts;
    }
    download() {
      state.fileNodeIdAfterConstruct = this.nodeId;
      const stream = new EventEmitter() as any;
      queueMicrotask(() => {
        let loaded = 0;
        for (const c of state.chunks) {
          loaded += c.length;
          stream.emit('data', c);
          stream.emit('progress', { bytesLoaded: loaded, bytesTotal: 5 });
        }
        stream.emit('end');
      });
      return stream;
    }
  }
  return { Storage: MockStorage, File: MockFile };
});

import { megaCore } from './mega-core';

beforeEach(() => {
  vi.clearAllMocks();
  state.lastFileOpts = null;
  state.fileNodeIdAfterConstruct = null;
});

describe('megaCore.downloadFile() (Phase 2)', () => {
  it('builds an owned-node File (downloadId+key+api) and forces file.nodeId', async () => {
    const onProgress = vi.fn();
    const buf = await megaCore.downloadFile({
      fileId: 'node1',
      credentials: { sid: 'SID123', nodeId: 'node1', fileKey: '____' },
      onProgress
    } as any);

    expect(state.lastFileOpts.downloadId).toBe('node1');
    expect(state.lastFileOpts.key).toBe('____');
    expect(state.lastFileOpts.api.sid).toBe('SID123');
    expect(state.fileNodeIdAfterConstruct).toBe('node1'); // owned-node path forced
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(onProgress).toHaveBeenLastCalledWith(5, 5);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/util/sync/core/providers/mega-core.test.ts`
Expected: FAIL — `downloadFile` still reads `megaShareUrl` / calls `fromURL`.

- [ ] **Step 3: Rewrite `downloadFile()` + add `getDownloadApi`**

In `mega-core.ts`, after the upload-storage helpers, add:

```ts
// Lightweight, per-sid API instances for owned-node downloads. A Storage built with
// autologin/autoload false makes no network call and loads no tree; we only need its
// `api` (with the session id) to authorize `a:"g", n:<nodeId>` requests.
const downloadApiBySid = new Map<string, any>();

function getDownloadApi(sid: string): any {
  let api = downloadApiBySid.get(sid);
  if (!api) {
    const storage: any = new Storage({ autologin: false, autoload: false, keepalive: false } as any);
    storage.api.sid = sid;
    api = storage.api;
    downloadApiBySid.set(sid, api);
  }
  return api;
}
```

Replace `downloadFile()` (53-96):

```ts
  async downloadFile({ credentials, onProgress }): Promise<ArrayBuffer> {
    const sid = requireCredentialString(credentials, 'sid', 'MEGA session id');
    const nodeId = requireCredentialString(credentials, 'nodeId', 'MEGA node id');
    const fileKey = requireCredentialString(credentials, 'fileKey', 'MEGA file key');
    const api = getDownloadApi(sid);

    return await new Promise<ArrayBuffer>((resolve, reject) => {
      try {
        // formatKey(fileKey) base64url-decodes into a real megajs Buffer.
        const file: any = new MegaFile({ downloadId: nodeId, key: fileKey, api });
        // Force the owned-node download path (req.n = nodeId, authorized by api.sid).
        file.nodeId = nodeId;

        const stream = file.download({});
        const chunks: Uint8Array[] = [];

        stream.on('data', (chunk: Uint8Array) => {
          chunks.push(chunk);
        });
        stream.on('progress', (p: { bytesLoaded: number; bytesTotal: number }) => {
          onProgress(p.bytesLoaded, p.bytesTotal);
        });
        stream.on('end', async () => {
          const blob = new Blob(chunks as BlobPart[]);
          const buffer = await blob.arrayBuffer();
          chunks.length = 0;
          resolve(buffer);
        });
        stream.on('error', (streamError: Error) => {
          reject(new Error(`MEGA download failed: ${streamError.message}`));
        });
      } catch (error) {
        reject(
          new Error(
            `MEGA download init failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          )
        );
      }
    });
  },
```

(The top-of-file `import { File as MegaFile, Storage } from 'megajs';` already provides both. `requireCredentialString` is already imported.)

- [ ] **Step 4: Run test + type-check**

Run: `npx vitest run src/lib/util/sync/core/providers/mega-core.test.ts`
Expected: PASS.
Run: `npm run check`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/sync/core/providers/mega-core.ts src/lib/util/sync/core/providers/mega-core.test.ts
git commit -m "feat(mega): download owned nodes in workers via sid + per-file key (no share links)"
```

---

### Task 10: Integration cleanup + live verification

**Files:**
- Verify: `src/lib/util/download-queue.ts` (cleanup call sites 622-623, 732, 741), `src/lib/util/backup-queue.ts` (268-269)
- Test: whole suite + manual live MEGA verification

**Interfaces:** none new — this task confirms the removed `cleanupWorkerDownload` and changed credential shapes integrate cleanly.

- [ ] **Step 1: Confirm no dangling references to removed symbols / old credential keys**

Run:
```bash
grep -rn "megaShareUrl\|createShareLink\|deleteShareLink\|cleanupWorkerDownload\|megaEmail\|megaPassword" src --include="*.ts" --include="*.svelte"
```
Expected: no matches in `src/lib/util/sync/**` or `src/lib/workers/**` or `src/lib/util/*queue*.ts`. (`download-queue.ts:622` guards `if (activeProvider.cleanupWorkerDownload)`, which is now always false for MEGA — that's correct and needs no change.)

- [ ] **Step 2: Full automated regression**

Run: `npx vitest run` and `npm run check` and `npm run lint`.
Expected: all green; no regressions.

- [ ] **Step 3: Live verification against a real MEGA account (not CI)**

Run `npm run dev` (or a Playwright session with a test account) and confirm in DevTools → Network/Application:
- **Download a volume from MEGA via the worker:** no `link`/`unshare` API calls are issued (search Network for `cs?` requests with `"a":"l"` / `"a":"l2"`); the file downloads and imports correctly.
- **Upload a volume:** the worker `postMessage` payload contains `megaSession` and **no** `megaPassword`/`megaEmail` (inspect via a temporary `console.log` of credential keys — never log the value — then remove it).
- **Reconnect on expiry:** in MEGA web → Settings → Session history, close this app's session; back in the app trigger a sync → the UI shows the needs-attention reconnect prompt with the email pre-filled; re-login restores sync.

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore(mega): finalize session-token worker integration and verification"
```

---

## Self-Review (completed against the spec)

**Spec coverage:** §A stored artifact → Task 2 (`persistSession`, `STORAGE_KEYS.SESSION`) + Task 1 (`sanitizeSessionBlob`). §B login/restore → Tasks 2–3. §C 2FA → Task 2 (provider) + Task 7 (UI). §D needs-attention → Task 4 + Task 7. §E migration → Task 3 + Task 5 (detection/manager). §F download workers → Tasks 8–9. §G upload worker → Task 6. Testing → per-task Vitest + Task 10 live. Build-time verifications #1/#3/#4 land in Phase 1 (Tasks 3/6); #2 (owned-node download) lands in Task 9 + Task 10 live check.

**Placeholder scan:** none — every code/test step contains full content.

**Type consistency:** `MegaSessionBlob`, `STORAGE_KEYS.SESSION`, `needsReconnect`, `reconnectEmail`, `persistSession`, `restoreSession`, `restorePersistedSession`, `markSessionExpired`, `getLastUsername`, and credential shapes (`{ megaSession }`, `{ sid, nodeId, fileKey }`) are defined once and used consistently across tasks. The megajs mock's `fromJSON`/`reload`/`Storage`/`File` shapes match the real browser-build signatures verified in the spec.
