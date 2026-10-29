import { browser } from '$app/environment';
import type {
  SyncProvider,
  ProviderCredentials,
  ProviderStatus,
  CloudFileMetadata,
  StorageQuota,
  UploadPayload,
  UploadFileResult
} from '../../provider-interface';
import { ProviderError } from '../../provider-interface';
import { megaCache } from './mega-cache';
import { cacheManager } from '../../cache-manager';
import { setActiveProviderKey, clearActiveProviderKey } from '../../provider-detection';
import { isCbzFile, isSidecarFile, isRootConfigFile } from '../../syncable-file';
import type { FolderOperations, FolderInfo, FolderItem } from '../../folder-deduplicator';
import {
  isMfaRequiredError,
  isSessionExpiredError,
  isAuthRejectionError,
  sanitizeSessionBlob,
  encodeMegaKey,
  type MegaSessionBlob
} from './mega-session';

interface MegaCredentials {
  email: string;
  password: string;
  /** One-time TOTP code for 2FA-enabled accounts. Never persisted. */
  secondFactorCode?: string;
}

const STORAGE_KEYS = {
  /** Sanitized Storage.toJSON() blob (sid + master key). The only persisted secret. */
  SESSION: 'mega_session',
  // Legacy keys — read for migration, removed on first successful login.
  EMAIL: 'mega_email',
  PASSWORD: 'mega_password',
  FOLDER_PATH: 'mega_folder_path'
};

const MOKURO_FOLDER = 'mokuro-reader';
const VOLUME_DATA_FILE = 'volume-data.json';
const PROFILES_FILE = 'profiles.json';
function getUploadPayloadSize(payload: UploadPayload): number {
  if (payload instanceof Blob) return payload.size;
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  return payload.byteLength;
}

/**
 * Exponential backoff with jitter for retrying MEGA API calls
 */
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 8,
  baseDelay: number = 500,
  operationName: string = 'operation'
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // Check if error is retryable (EAGAIN, rate limit, temporary congestion)
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isRetryable =
        errorMessage.includes('EAGAIN') ||
        errorMessage.includes('congestion') ||
        errorMessage.includes('rate') ||
        errorMessage.includes('429');

      if (!isRetryable || attempt === maxRetries) {
        // Non-retryable error or max retries reached
        throw error;
      }

      // Calculate exponential backoff with jitter
      // Formula: delay = baseDelay * 2^attempt + random(0, 1000)
      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const jitter = Math.random() * 1000;
      const delay = exponentialDelay + jitter;

      console.warn(
        `${operationName} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${errorMessage}. Retrying in ${Math.round(delay)}ms...`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/** megajs surfaces a server-side missing node as `ENOENT (-9)`. */
function isMegaNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ENOENT') || message.includes('(-9)');
}

/** megajs surfaces a full account as `EOVERQUOTA (-17)`. */
function isMegaOverQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('EOVERQUOTA') || message.includes('(-17)');
}

/**
 * Oldest first by MEGA's own node stamp (missing counts as oldest), then by
 * handle. The same order FolderDeduplicator keeps the first of: it sorts each
 * group by age, stably, over the order listFolders() hands it — this one.
 */
function compareByAge(a: any, b: any): number {
  const age = (a?.timestamp || 0) - (b?.timestamp || 0);
  if (age !== 0) return age;
  const ha = String(a?.nodeId ?? '');
  const hb = String(b?.nodeId ?? '');
  return ha < hb ? -1 : ha > hb ? 1 : 0;
}

/** Same node, across tree loads: a load replaces every node object, handles stay. */
function sameNode(a: any, b: any): boolean {
  return a === b || (!!a?.nodeId && a.nodeId === b?.nodeId);
}

/** How often a dead server-change poll is retried (1 s, 2 s, 4 s, …) before waiting for the next load. */
const SC_RECOVERY_ATTEMPTS = 6;

/**
 * Smart retry wrapper for MEGA operations that may fail due to stale cache
 * When two devices sync back and forth, file IDs change but local cache is stale
 * This wrapper detects ENOENT errors, refreshes the cache, and retries once
 */
async function retryWithCacheRefresh<T>(
  operation: () => Promise<T>,
  operationName: string = 'operation',
  forceReload?: () => Promise<void>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check if error is ENOENT (file/object not found)
    const isStaleCache =
      errorMessage.includes('ENOENT') ||
      errorMessage.includes('not found') ||
      errorMessage.includes('Object');

    if (isStaleCache) {
      console.warn(
        `${operationName} failed with ENOENT - cache may be stale. Waiting for MEGA to sync and retrying...`
      );

      // Give MEGA time to propagate server changes to storage.files
      // MEGA.js updates storage.files via events, but server changes take time
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Force reload of MEGA's storage.files if provided
      if (forceReload) {
        await forceReload();
      }

      // Refresh our app's cloud cache from MEGA's now-fresh storage.files
      // Skip reinitialize since forceReload already did that
      await megaCache.fetch(true);

      // Retry the operation once with fresh cache
      try {
        return await operation();
      } catch (retryError) {
        console.error(`${operationName} failed again after cache refresh:`, retryError);
        throw retryError;
      }
    }

    // Non-stale-cache error, throw immediately
    throw error;
  }
}

export class MegaProvider implements SyncProvider {
  readonly type = 'mega' as const;
  readonly name = 'MEGA';
  readonly supportsWorkerDownload = true; // Workers download owned nodes via sid + per-file key
  readonly supportsWorkerUpload = true;
  readonly uploadConcurrencyLimit = 6;
  readonly downloadConcurrencyLimit = 6;

  private storage: any = null;
  private mokuroFolder: any = null;
  private needsReconnect = false;
  private reconnectEmail: string | null = null;
  private initPromise: Promise<void>;

  // Mutexes preventing concurrent uploads from racing to create the same folder.
  // Without these, N parallel uploads each find no folder and call mkdir N times.
  private mokuroFolderPromise: Promise<any> | null = null;
  private seriesFolderPromises = new Map<string, Promise<any>>();

  private cacheRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** The full-tree load in flight; concurrent callers share it (see refreshTree). */
  private treeRefresh: Promise<void> | null = null;
  /** Stops the running server-change poll (see startServerChanges). */
  private stopServerChanges: (() => void) | null = null;
  /** Bumped on logout/expiry so a load that lands afterwards starts no poll. */
  private sessionEpoch = 0;
  /**
   * Consecutive sc recoveries whose poll has not yet answered once. Only a
   * poll that delivers resets it, so a poll that dies straight after every
   * reload backs off (1 s, 2 s, … 32 s) and then stops, instead of reloading
   * the whole tree once a second forever.
   */
  private scRecoveryAttempt = 0;

  /**
   * Reactive cache: megajs's sc stream applies every change (ours AND other
   * devices') to storage.files and emits these events. A debounced rebuild
   * from that now-authoritative tree keeps the UI cache — and therefore the
   * GUI, which subscribes to it — in sync without any forced refreshes.
   * The unified manager's incremental cache updates still give instant
   * feedback for our own operations; this converges everything shortly after.
   */
  private attachChangeListeners(storage: any): void {
    const schedule = () => {
      if (this.cacheRefreshTimer) clearTimeout(this.cacheRefreshTimer);
      this.cacheRefreshTimer = setTimeout(() => {
        this.cacheRefreshTimer = null;
        if (this.storage !== storage) return; // logged out / replaced
        megaCache.fetch(true).catch((err) => {
          console.error('[MEGA] reactive cache refresh failed:', err);
        });
      }, 500);
    };
    for (const event of ['add', 'move', 'delete', 'update']) {
      storage.on(event, schedule);
    }
  }

  constructor() {
    if (browser) {
      this.initPromise = this.restorePersistedSession();
    } else {
      this.initPromise = Promise.resolve();
    }
  }

  /**
   * Wait for provider initialization to complete
   * Use this to ensure credentials have been restored before checking authentication
   */
  async whenReady(): Promise<void> {
    await this.initPromise;
  }

  isAuthenticated(): boolean {
    return this.storage !== null;
  }

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
            : 'Not configured',
      // Lowercased: MEGA email login is case-insensitive, so 'A@B.com' and
      // 'a@b.com' authenticate the same account and must not split the cache.
      accountScope: this.reconnectEmail ? `mega:${this.reconnectEmail.toLowerCase()}` : undefined
    };
  }

  /** Forget the live Storage and stop its server-change poll. */
  private endSession(): void {
    this.startSessionEpoch();
    this.stopServerChanges?.();
    this.storage = null;
    this.mokuroFolder = null;
  }

  /**
   * A new session (or none) from here on: a load still running for the
   * previous Storage must not start its poll over this one's, nor be joined.
   */
  private startSessionEpoch(): void {
    this.sessionEpoch++;
    this.treeRefresh = null;
    this.scRecoveryAttempt = 0;
  }

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

    this.endSession();
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

  async login(credentials?: ProviderCredentials): Promise<void> {
    if (!credentials || !credentials.email || !credentials.password) {
      throw new ProviderError('Email and password are required', 'mega', 'INVALID_CREDENTIALS');
    }

    const { email, password, secondFactorCode } = credentials as MegaCredentials;

    try {
      // Dynamically import megajs to reduce initial bundle size
      const { Storage } = await import('megajs');

      // Fresh interactive login (the constructor cb fires once logged in).
      // autoload:false: the tree loads through loadTree() like every later
      // load. keepalive:false: megajs would start a NEW server-change (sc)
      // long-poll for every response carrying `sn` and never stop the old
      // ones; the provider runs exactly one itself (startServerChanges).
      const storage: any = await new Promise((resolve, reject) => {
        const s = new Storage(
          { email, password, secondFactorCode, autoload: false, keepalive: false } as any,
          (error: Error | null) => (error ? reject(error) : resolve(s))
        );
      });
      this.startSessionEpoch();
      await this.loadTree(storage);

      this.storage = storage;
      this.attachChangeListeners(storage);
      await this.ensureMokuroFolder();
      this.persistSession();
      this.needsReconnect = false;
      this.reconnectEmail = email;
      setActiveProviderKey('mega');
      console.log('✅ MEGA login successful');
    } catch (error) {
      this.endSession();

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

  async logout(): Promise<void> {
    this.endSession();
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

  /** Rebuild an authenticated Storage from a saved session blob (no password, no login round-trip). */
  private async restoreSession(blob: MegaSessionBlob): Promise<void> {
    const { Storage } = await import('megajs');
    // keepalive:false whatever the blob says (blobs persisted before carry
    // true): the provider runs the one sc poll itself, see login().
    const storage: any = Storage.fromJSON({
      ...(blob as any),
      options: { ...((blob as any).options ?? {}), keepalive: false }
    });
    // fromJSON does no network and loads no tree. A dead session throws ESID here.
    this.startSessionEpoch();
    await this.loadTree(storage);
    this.storage = storage;
    this.attachChangeListeners(storage);
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

  /**
   * Refresh the file tree from the server. No password and no re-login
   * round-trip — one full-tree load on the live session.
   */
  private async reinitialize(): Promise<void> {
    if (!browser) return;

    // No live session to refresh — fall back to restoring from the stored token.
    if (!this.storage) {
      await this.restorePersistedSession();
      return;
    }

    try {
      // In place, on the EXISTING session. Never rebuild the storage and
      // close the old one: megajs `storage.close()` issues `{a:'sml'}`, which
      // TERMINATES the session sid server-side. Every storage (login, restore,
      // upload worker) reuses the one persisted sid, so closing any of them
      // makes every later request fail with ESID (-15).
      await this.refreshTree();
      this.mokuroFolder = null;
      console.log('✅ MEGA tree reloaded');
    } catch (error) {
      if (isSessionExpiredError(error)) {
        this.markSessionExpired();
        return;
      }
      // Transient error: keep the existing storage so we don't appear logged out.
      console.warn('Continuing with potentially stale MEGA cache:', error);
    }
  }

  /** One full-tree load at a time: concurrent callers share the one in flight. */
  private refreshTree(): Promise<void> {
    if (!this.treeRefresh) {
      const refresh: Promise<void> = this.loadTree(this.storage).finally(() => {
        if (this.treeRefresh === refresh) this.treeRefresh = null;
      });
      this.treeRefresh = refresh;
    }
    return this.treeRefresh;
  }

  /**
   * Load the whole tree from one `{a:'f'}` snapshot and swap it in at once.
   *
   * megajs's reload() imports ADDITIVELY (_importFile skips known handles)
   * and its sc delete handler only unlinks a node, so a node deleted while
   * this device missed the packet would survive every reload as a ghost that
   * fails every operation with ENOENT (-9). The import therefore runs into a
   * fresh map — but only once the snapshot has ARRIVED, synchronously inside
   * megajs's callback. Emptying storage.files for the round trip (seconds,
   * more with -3 retries) made the library look absent, and every upload in
   * that window created another mokuro-reader root. Readers only ever see the
   * old full tree or the new full tree; a failed load keeps the old one.
   */
  private async loadTree(storage: any): Promise<void> {
    const api = storage.api;
    const epoch = this.sessionEpoch;
    const knownBefore = new Set(Object.keys(storage.files || {}));
    let importFailed!: (error: unknown) => void;
    const failed = new Promise<never>((_, reject) => (importFailed = reject));

    // Intercept the one request reload() issues; megajs's -3 retries re-send
    // it with the callback given here.
    const hasOwnRequest = Object.prototype.hasOwnProperty.call(api, 'request');
    const request = api.request;
    const restoreRequest = () => {
      if (hasOwnRequest) api.request = request;
      else delete api.request;
    };
    api.request = (
      json: any,
      megajsCallback: (e: Error | null, r?: any) => void,
      retry?: number
    ) => {
      restoreRequest();
      return request.call(
        api,
        json,
        (error: Error | null, response?: any) => {
          const snapshot = !error && Array.isArray(response?.f);
          const previous = {
            files: storage.files,
            root: storage.root,
            trash: storage.trash,
            inbox: storage.inbox
          };
          if (snapshot) storage.files = {};
          try {
            megajsCallback(error, response); // megajs imports the snapshot
          } catch (importError) {
            // megajs calls this from a bare promise reaction: a throw would
            // leave reload() pending forever. Keep the old tree, fail the load.
            if (snapshot) Object.assign(storage, previous);
            importFailed(importError);
            return;
          }
          if (!snapshot) return;
          this.settleSnapshot(storage, response.f, previous.files, knownBefore);
          if (response.sn && epoch === this.sessionEpoch) {
            this.startServerChanges(storage, response.sn);
          }
        },
        retry
      );
    };
    let reloaded: Promise<unknown>;
    try {
      reloaded = storage.reload(true);
    } finally {
      restoreRequest();
    }
    this.guardServerChanges(storage);
    await Promise.race([reloaded, failed]);
  }

  /**
   * Finish a snapshot megajs just imported, in the same synchronous turn:
   * - megajs links a node only to a parent imported BEFORE it; link the rest.
   * - Nodes this device created while the snapshot was in flight (mkdir and
   *   upload answers, sc packets of the previous poll) are newer than the
   *   snapshot. Graft them over so a folder made a moment ago is not made
   *   again; the new poll replays their packets, which find them known.
   */
  private settleSnapshot(
    storage: any,
    snapshot: any[],
    previousFiles: Record<string, any>,
    knownBefore: Set<string>
  ): void {
    const files = storage.files;
    for (const entry of snapshot) {
      const node = files[entry?.h];
      const parent = entry?.p ? files[entry.p] : undefined;
      if (node && parent && !node.parent && parent.children) {
        node.parent = parent;
        parent.children.push(node);
      }
    }

    const grafts = Object.entries(previousFiles).filter(
      ([handle, node]) =>
        !knownBefore.has(handle) && !files[handle] && !!node.parent?.children?.includes(node)
    );
    for (const [handle, node] of grafts) {
      const parent = files[node.parent.nodeId];
      if (!parent?.children) continue;
      files[handle] = node;
      node.parent = parent;
      if (!parent.children.includes(node)) parent.children.push(node);
    }
    // A grafted folder keeps only children that made it into this tree.
    for (const [, node] of grafts) {
      if (node.children) node.children = node.children.filter((c: any) => files[c.nodeId] === c);
    }
  }

  /**
   * Keep exactly one 'sc' handler on the api, behind applyServerChanges.
   * reload() attaches a new handler on every call without removing the old
   * one, and stacked handlers apply every packet once per handler.
   */
  private guardServerChanges(storage: any): void {
    const api = storage.api;
    const handlers = api.listeners('sc');
    const megajsHandler = handlers[handlers.length - 1];
    api.removeAllListeners('sc');
    if (!megajsHandler) return;
    api.on('sc', (packets: any[]) => this.applyServerChanges(storage, packets, megajsHandler));
  }

  /**
   * Feed an sc batch to megajs's handler one step at a time, each step made
   * safe against the tree as it stands right then. megajs's handler assumes
   * every packet is new and every node it names is linked into this tree:
   * - a `d` for a node this tree lacks throws (`.parent` of undefined) and
   *   ends the poll; a `d` for a node already unlinked (a replayed packet)
   *   runs `splice(indexOf === -1, 1)`, silently dropping the parent's LAST
   *   child — a live sibling, possibly the library itself.
   * - a `t` for a known node linked nowhere throws on its old parent; one
   *   moving a node to a parent this tree lacks throws on the new one.
   *
   * A batch holds every action since the poll's sequence number, and later
   * actions depend on earlier ones (a folder created, then a node moved into
   * it; a node created, then deleted), so nothing is judged against the tree
   * as it was before the batch. megajs's own order is kept: `t` and `u`
   * apply in sequence, entry by entry; `d` waits for the end of the batch,
   * and a later `t` for a node it already knows cancels it (a move).
   */
  private applyServerChanges(
    storage: any,
    packets: any[],
    megajsHandler: (packets: any[]) => void
  ): void {
    if (!Array.isArray(packets)) return;
    const linked = (node: any) => !!node?.parent?.children?.includes(node);
    const deletes = new Map<string, any>();

    for (const packet of packets) {
      if (packet?.a === 'd') {
        if (!deletes.has(packet.n)) deletes.set(packet.n, packet);
        continue;
      }
      if (packet?.a !== 't' || !Array.isArray(packet.t?.f)) {
        megajsHandler([packet]);
        continue;
      }
      for (const entry of packet.t.f) {
        const files = storage.files;
        const node = files[entry?.h];
        if (node) {
          deletes.delete(entry.h); // megajs: a known node's `t` cancels its `d`
          if (!entry.p) continue; // a top-level node: nothing to link
          const parent = files[entry.p];
          if (!parent?.children) {
            // Moved out of this tree (e.g. into a share it cannot see): gone here.
            if (linked(node)) node.parent.children.splice(node.parent.children.indexOf(node), 1);
            node.emit('delete');
            storage.emit('delete', node);
            continue;
          }
          if (!linked(node)) {
            // The server says it lives under `parent`; re-link it, and megajs
            // then sees an unchanged parent.
            const oldParent = node.parent;
            node.parent = parent;
            if (!parent.children.includes(node)) parent.children.push(node);
            node.emit('move', oldParent);
            storage.emit('move', node, oldParent);
          }
        }
        // Unknown here: megajs imports it (under its parent, if known by now).
        megajsHandler([{ ...packet, t: { ...packet.t, f: [entry] } }]);
      }
    }

    const live = [...deletes.values()].filter((packet) => linked(storage.files[packet.n]));
    if (live.length > 0) megajsHandler(live);
  }

  /**
   * Run the ONE server-change (sc) long-poll, from a snapshot's sequence
   * number, superseding the previous one. megajs (keepalive:true) starts a
   * new poll for every response carrying `sn` — every full load — and never
   * stops the old ones, so each packet was applied once per poll. This drives
   * megajs's own pull/wait on a per-poll view of the api that goes inert once
   * superseded, and forwards its packets to the api's (single) sc handler.
   */
  private startServerChanges(storage: any, sn: string): void {
    this.stopServerChanges?.();
    const api = storage.api;
    const megajsApi = Object.getPrototypeOf(api);
    const poll = Object.create(api);
    let current = true;
    let lastSn = sn;
    const answered = () => {
      if (current) this.scRecoveryAttempt = 0;
    };
    const stop = () => {
      current = false;
      poll.sn?.abort?.(); // megajs keeps the open request's AbortController there
      if (this.stopServerChanges === stop) this.stopServerChanges = null;
    };
    // megajs pulls a NEW sequence number, or waits, only after a poll answered.
    poll.pull = function (...args: unknown[]) {
      if (!current) return;
      if (args[0] !== lastSn) {
        lastSn = args[0] as string;
        answered();
      }
      megajsApi.pull.apply(this, args);
    };
    poll.wait = function (...args: unknown[]) {
      if (!current) return;
      answered();
      megajsApi.wait.apply(this, args);
    };
    poll.emit = (event: string, ...args: unknown[]) => {
      if (!current) return false;
      if (event === 'sc') return api.emit('sc', ...args);
      if (event === 'error') {
        // megajs ends the poll here (and would throw with no listener):
        // reload instead of letting the tree silently stop updating.
        stop();
        this.recoverServerChanges(storage, args[0], this.scRecoveryAttempt);
      }
      return true;
    };
    this.stopServerChanges = stop;
    poll.pull(sn);
  }

  /**
   * Restart a dead sc poll through a fresh tree load, with bounded backoff.
   * `attempt` counts every recovery since a poll last answered — reloads that
   * failed AND reloads whose new poll died before answering.
   */
  private recoverServerChanges(storage: any, error: unknown, attempt: number): void {
    if (attempt >= SC_RECOVERY_ATTEMPTS) {
      console.error('[MEGA] server-change stream not restarted; next load will:', error);
      return;
    }
    if (attempt === 0) console.warn('[MEGA] server-change stream stopped; reloading:', error);
    setTimeout(
      () => {
        // Logged out, replaced, or another load already restarted the poll.
        if (this.storage !== storage || this.stopServerChanges) return;
        // The poll this reload starts has not answered yet.
        this.scRecoveryAttempt = attempt + 1;
        this.refreshTree().then(
          () => {
            megaCache.fetch(true).catch((err) => {
              console.error('[MEGA] cache refresh after reload failed:', err);
            });
          },
          (reloadError) => {
            if (isSessionExpiredError(reloadError)) {
              if (this.storage === storage) this.markSessionExpired();
            } else {
              this.recoverServerChanges(storage, reloadError, attempt + 1);
            }
          }
        );
      },
      1000 * 2 ** attempt
    );
  }

  private async ensureMokuroFolder(): Promise<any> {
    // Fast path: folder already exists in storage cache.
    const existing = this.findMokuroFolder();
    if (existing) {
      this.mokuroFolder = existing;
      return existing;
    }

    // Coalesce concurrent calls so only one mkdir runs.
    if (this.mokuroFolderPromise) {
      return this.mokuroFolderPromise;
    }

    this.mokuroFolderPromise = (async () => {
      try {
        // Re-check after acquiring the mutex; another caller may have created it.
        const recheck = this.findMokuroFolder();
        if (recheck) {
          this.mokuroFolder = recheck;
          return recheck;
        }

        const folder = await this.createFolder(MOKURO_FOLDER);
        console.log('Created mokuro-reader folder in MEGA');
        this.mokuroFolder = folder;
        return folder;
      } catch (error) {
        console.error('ensureMokuroFolder error:', error);
        throw new ProviderError(
          `Failed to ensure mokuro folder exists: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'mega',
          'FOLDER_ERROR'
        );
      } finally {
        this.mokuroFolderPromise = null;
      }
    })();

    return this.mokuroFolderPromise;
  }

  /**
   * THE library folder, when there are several live `mokuro-reader` folders
   * (duplicates, or one the user moved): one directly in the Cloud Drive
   * first, then the oldest, then by handle — the folder FolderDeduplicator
   * keeps when it merges them (see compareByAge and listFolders), so writes
   * never go to the copy the next merge empties. Not the first in
   * storage.files order: that is the server's listing order, newest first
   * as often as not.
   */
  private findMokuroFolder(): any | null {
    const root = this.storage.root;
    const atRoot = (f: any) => (root && f.parent === root ? 0 : 1);
    const candidates = Object.values(this.storage.files || {}).filter(
      (f: any) => f.name === MOKURO_FOLDER && f.directory && this.isLiveNode(f)
    );
    candidates.sort((a: any, b: any) => atRoot(a) - atRoot(b) || compareByAge(a, b));
    return candidates[0] ?? null;
  }

  /** The node object the current tree holds for `node` (a full load replaces them all). */
  private current<T>(node: T): T {
    const handle = (node as any)?.nodeId;
    return (handle && this.storage?.files?.[handle]) || node;
  }

  /**
   * Is this node still in the user's drive? Between full loads megajs never
   * evicts a node from storage.files: the sc delete handler only splices it
   * out of parent.children, and a move to the Rubbish Bin only re-parents
   * it. So a node is gone when any link up its ancestry is broken, or the
   * chain ends in the Rubbish Bin — exactly the nodes MEGA's own apps no
   * longer show. (Every megajs create path — mkdir, upload, copy — links the
   * new node into its parent's children, and loadTree links nodes listed
   * before their parent, so a live node always passes.)
   */
  private isLiveNode(node: any): boolean {
    let current = node;
    while (current) {
      if (current === this.storage?.trash) return false;
      const parent = current.parent;
      if (parent && !parent.children?.includes(current)) return false;
      current = parent;
    }
    return true;
  }

  private listFolder(folder: any): Promise<any[]> {
    return new Promise((resolve) => {
      // Get all files from storage
      const files = Object.values(this.storage.files || {});

      // Children by handle: `folder` may be an object from before a tree load.
      const children = files.filter((f: any) => sameNode(f.parent, folder) && this.isLiveNode(f));
      resolve(children);
    });
  }

  /** The live subfolder `name` of `folder` — the oldest, as the deduplicator keeps it. */
  private async findSubfolder(folder: any, name: string): Promise<any | null> {
    const children = await this.listFolder(folder);
    const matches = children.filter((f: any) => f.name === name && f.directory);
    return matches.sort(compareByAge)[0] ?? null;
  }

  private createFolder(name: string): Promise<any> {
    return new Promise((resolve, reject) => {
      // The Cloud Drive node's own mkdir, not storage.mkdir: that one refuses
      // unless status is 'ready', which only login() sets — a session restored
      // from the stored token could never create the library folder.
      this.storage.root.mkdir(name, (error: Error | null, folder: any) => {
        if (error) {
          reject(error);
        } else {
          resolve(folder);
        }
      });
    });
  }

  private getNodeById(fileId: string): any | null {
    const files = Object.values(this.storage.files || {});
    return files.find((f: any) => (f.nodeId === fileId || f.id === fileId) && !f.directory) || null;
  }

  private async findFolderByPath(folderPath: string, rootFolder: any): Promise<any | null> {
    const pathParts = folderPath.split('/').filter(Boolean);
    let currentFolder = rootFolder;

    for (const folderName of pathParts) {
      const nextFolder = await this.findSubfolder(currentFolder, folderName);
      if (!nextFolder) {
        return null;
      }
      currentFolder = nextFolder;
    }

    return currentFolder;
  }

  /**
   * A rename/move never changes file content, so the returned entry must
   * carry the ORIGINAL file's real `modifiedTime` (and provisional flag, if
   * it was never more than a client-clock guess) — never a freshly minted
   * `new Date()`. `modifiedTime`/`modifiedTimeProvisional` are REQUIRED
   * (not defaulted) so a caller can't silently fall through to fabrication;
   * every caller has them because it is renaming a known cached entry.
   *
   * NOTE the deliberate contrast with Google Drive: a Drive rename is a
   * metadata-only PATCH, and Drive's own server bumps that file's
   * `modifiedTime` in response to it — Drive's `renameFile`/`renameFolder`
   * therefore return the SERVER'S fresh timestamp, not the cached one. MEGA
   * has no such signal to read back, so preserving the cached `modifiedTime`
   * here (rather than fabricating a new one from the client clock) is the
   * correct trade: the cached record and the next real listing then disagree
   * by exactly one rename's worth of nothing, which self-corrects on the
   * next fetch instead of poisoning `series.json` with a client-clock stamp.
   */
  private buildRenamedCloudFile(
    file: CloudFileMetadata,
    nextPath: string,
    fileId: string,
    modifiedTime: string,
    modifiedTimeProvisional?: boolean
  ): CloudFileMetadata {
    const result: CloudFileMetadata = {
      ...file,
      fileId,
      path: nextPath,
      modifiedTime
    };
    if (modifiedTimeProvisional) {
      result.modifiedTimeProvisional = true;
    } else {
      delete result.modifiedTimeProvisional;
    }
    return result;
  }

  // VOLUME STORAGE METHODS

  async listCloudVolumes(
    skipReinitialize = false
  ): Promise<import('../../provider-interface').CloudFileMetadata[]> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    try {
      // Only reinitialize if needed (cache miss, initial load)
      // Skip for post-operation refreshes where storage.files is already fresh
      if (!skipReinitialize) {
        await this.reinitialize();
      }
      await this.ensureMokuroFolder();

      // Get all files from storage
      const files = Object.values(this.storage.files || {});

      // Find ALL mokuro-reader folders (there may be multiple from different sessions)
      // Note: We don't check parent because MEGA's root folder location varies by account/locale
      const mokuroFolders = files.filter((f: any) => f.name === MOKURO_FOLDER && f.directory);

      // Filter CBZ and JSON files that are in ANY mokuro-reader folder or its subfolders
      const allFiles: import('../../provider-interface').CloudFileMetadata[] = [];

      for (const file of files) {
        // Skip non-files
        if ((file as any).directory) continue;

        // Check if file is a CBZ, sidecar, or JSON
        const name = (file as any).name || '';
        const isCbz = isCbzFile(name);
        const isSidecar = isSidecarFile(name);
        const isJson = isRootConfigFile(name);

        if (!isCbz && !isSidecar && !isJson) continue;

        // Deleted (still in storage.files) or in the Rubbish Bin — including a
        // whole mokuro-reader folder moved there, which the walk below would
        // stop at before ever reaching the bin.
        if (!this.isLiveNode(file)) continue;

        // Check if file is in ANY mokuro-reader folder or subfolder
        let parent = (file as any).parent;
        let pathParts: string[] = [];
        let foundMokuroRoot = false;

        // Walk up the tree to build path and verify it's under a mokuro-reader folder
        while (parent) {
          // Check if this parent is ANY mokuro-reader folder
          const isMokuroFolder = mokuroFolders.some((mf: any) => mf === parent);
          if (isMokuroFolder) {
            foundMokuroRoot = true;
            break;
          }
          if (parent.name) {
            pathParts.unshift(parent.name);
          }
          parent = parent.parent;
        }

        // If we found mokuro root, this file is under a mokuro-reader folder
        if (foundMokuroRoot) {
          // For JSON files in the mokuro root, use just the filename as path
          // For CBZ files, build full path as "SeriesTitle/VolumeTitle.cbz"
          let path: string;
          if (isJson && pathParts.length === 0) {
            // JSON file directly in mokuro folder
            path = name;
          } else {
            // CBZ file or JSON in subfolder
            pathParts.push(name);
            path = pathParts.join('/');
          }

          // Get file metadata
          const fileId = (file as any).nodeId || (file as any).id || '';
          const modifiedTime = (file as any).timestamp
            ? new Date((file as any).timestamp * 1000).toISOString()
            : new Date().toISOString();
          const size = (file as any).size || 0;

          allFiles.push({
            provider: 'mega',
            fileId,
            path,
            modifiedTime,
            size
          });
        }
      }

      console.log(`✅ Listed ${allFiles.length} files from MEGA`);
      return allFiles;
    } catch (error) {
      throw new ProviderError(
        `Failed to list cloud volumes: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'LIST_FAILED',
        false,
        true
      );
    }
  }

  async uploadFile(
    path: string,
    blob: UploadPayload,
    description?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<UploadFileResult> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    const payloadSize = getUploadPayloadSize(blob);
    try {
      if (onProgress) {
        onProgress(0, payloadSize);
      }
      // Wrap upload in retry logic to handle stale cache
      const uploaded = await retryWithCacheRefresh(
        async () => {
          const mokuroFolder = await this.ensureMokuroFolder();

          // Parse path: "SeriesTitle/VolumeTitle.cbz"
          const pathParts = path.split('/');
          const fileName = pathParts.pop() || path;
          const seriesFolderName = pathParts.join('/');

          // Find or create series folder if path includes subfolder
          let targetFolder = mokuroFolder;
          if (seriesFolderName) {
            targetFolder = await this.ensureSeriesFolder(seriesFolderName, mokuroFolder);
          }

          let buffer: Uint8Array;
          if (blob instanceof Uint8Array) {
            buffer = blob;
          } else if (blob instanceof ArrayBuffer) {
            buffer = new Uint8Array(blob);
          } else {
            const arrayBuffer = await blob.arrayBuffer();
            buffer = new Uint8Array(arrayBuffer);
          }

          // Reading the payload can take a while; a tree load meanwhile
          // replaces every node object, so look the folder up again.
          targetFolder = this.current(targetFolder);
          const children = await this.listFolder(targetFolder);

          // Replace semantics: delete EVERY same-name copy (MEGA allows
          // duplicate names, so racing uploads can leave several). Do NOT
          // remove them from storage.files manually — the sc stream delivers
          // the delete and megajs applies it. A copy can also be a ghost —
          // deleted server-side but never evicted from storage.files by
          // megajs — so a server "already gone" answer means converged, not
          // failed.
          const existingFiles = children.filter((f: any) => f.name === fileName && !f.directory);
          for (const existingFile of existingFiles) {
            await new Promise<void>((resolve, reject) => {
              existingFile.delete(true, (error: Error | null) => {
                if (error && !isMegaNotFoundError(error)) reject(error);
                else resolve();
              });
            });
          }

          // Upload new file. The completed node's `timestamp` is the SERVER's
          // epoch-seconds stamp — the same field `listCloudVolumes` maps to
          // `modifiedTime` — so the result can carry a real server mtime.
          const uploadResult = await new Promise<UploadFileResult>((resolve, reject) => {
            const uploadStream = targetFolder.upload(
              {
                name: fileName,
                size: buffer.length
              },
              buffer,
              (error: Error | null, file: any) => {
                if (error) {
                  reject(error);
                } else {
                  const fileId = file?.nodeId || file?.id || '';
                  if (onProgress) {
                    onProgress(buffer.length, buffer.length);
                  }
                  console.log(`✅ Uploaded ${fileName} to MEGA (${fileId})`);
                  const ts = file?.timestamp;
                  const nodeSize = file?.size;
                  resolve({
                    fileId,
                    modifiedTime:
                      typeof ts === 'number' && Number.isFinite(ts)
                        ? new Date(ts * 1000).toISOString()
                        : undefined,
                    size:
                      typeof nodeSize === 'number' && Number.isFinite(nodeSize)
                        ? nodeSize
                        : undefined
                  });
                }
              }
            );
            if (onProgress && uploadStream && typeof uploadStream.on === 'function') {
              uploadStream.on('progress', (progress: any) => {
                const loaded = Number(progress?.bytesUploaded ?? progress?.bytesLoaded ?? 0);
                const total = Number(progress?.bytesTotal ?? buffer.length);
                onProgress(loaded, total > 0 ? total : buffer.length);
              });
            }
          });
          return uploadResult;
        },
        `Upload ${path} to MEGA`,
        () => this.reinitialize()
      );
      // No cache rebuild here: uploads emit a local 'add' event (megajs adds
      // the node from the API response), which the change listeners turn into
      // a debounced refresh. A mid-operation rebuild would clobber the
      // manager's incremental cache updates with a not-yet-synced tree.

      return uploaded;
    } catch (error) {
      // Typed QUOTA_EXCEEDED with a message users can act on, instead of
      // megajs's raw "EOVERQUOTA (-17): Request over quota".
      if (isMegaOverQuotaError(error)) {
        throw new ProviderError(
          'MEGA storage is full — free up space or upgrade your plan',
          'mega',
          'QUOTA_EXCEEDED'
        );
      }
      throw new ProviderError(
        `Failed to upload volume CBZ: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'UPLOAD_FAILED',
        false,
        true
      );
    }
  }

  async downloadFile(
    file: CloudFileMetadata,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    // Extract file ID from metadata
    const fileId = file.fileId;

    try {
      // Find the file by ID
      const files = Object.values(this.storage.files || {});
      const megaFile = files.find(
        (f: any) => (f.nodeId === fileId || f.id === fileId) && !f.directory
      );

      if (!megaFile) {
        throw new Error('File not found');
      }

      return new Promise((resolve, reject) => {
        const fileObj = megaFile as any;

        // Use download with progress callback if provided
        if (onProgress) {
          // MEGA.js download supports progress via stream options
          const stream = fileObj.download({ returnCiphertext: false });

          const chunks: Uint8Array[] = [];
          let loaded = 0;
          const total = fileObj.size || 0;

          stream.on('data', (chunk: Uint8Array) => {
            chunks.push(chunk);
            loaded += chunk.length;
            onProgress(loaded, total);
          });

          stream.on('end', () => {
            // Combine all chunks into a single Uint8Array
            const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
            const combined = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
              combined.set(chunk, offset);
              offset += chunk.length;
            }

            const blob = new Blob([combined], { type: 'application/zip' });
            console.log(`✅ Downloaded ${fileObj.name} from MEGA`);
            resolve(blob);
          });

          stream.on('error', (error: Error) => {
            reject(error);
          });
        } else {
          // Simple download without progress
          fileObj.download((error: Error | null, data: Uint8Array) => {
            if (error) {
              reject(error);
            } else {
              // Convert to standard Uint8Array to satisfy TypeScript
              const standardArray = new Uint8Array(Array.from(data));
              const blob = new Blob([standardArray], { type: 'application/zip' });
              console.log(`✅ Downloaded ${fileObj.name} from MEGA`);
              resolve(blob);
            }
          });
        }
      });
    } catch (error) {
      throw new ProviderError(
        `Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'DOWNLOAD_FAILED',
        false,
        true
      );
    }
  }

  async deleteFile(file: CloudFileMetadata): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    // Extract file ID from metadata
    const fileId = file.fileId;

    try {
      // Wrap delete in retry logic to handle stale cache
      await retryWithCacheRefresh(
        async () => {
          // Find the file by ID
          const files = Object.values(this.storage.files || {});
          const megaFile = files.find(
            (f: any) => (f.nodeId === fileId || f.id === fileId) && !f.directory
          );

          if (!megaFile) {
            // Typed: the shared layer treats an already-gone DELETE target as
            // converged, and relies on this code (never message text).
            throw new ProviderError(`File not found: ${file.path}`, 'mega', 'NOT_FOUND');
          }

          return new Promise<void>((resolve, reject) => {
            (megaFile as any).delete(true, (error: Error | null) => {
              if (error) {
                reject(error);
              } else {
                console.log(`✅ Deleted file from MEGA (${fileId})`);
                resolve();
                // No manual storage.files cleanup: the sc stream applies the
                // delete (and a manual removal would crash its handler). megajs
                // only unlinks the node, so the listing skips it via
                // isLiveNode. The caller's cache update + the change listeners
                // keep the UI current.
              }
            });
          });
        },
        `Delete file ${fileId} from MEGA`,
        () => this.reinitialize()
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(
        `Failed to delete volume CBZ: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'DELETE_FAILED',
        false,
        true
      );
    }
  }

  async renameFile(file: CloudFileMetadata, newPath: string): Promise<CloudFileMetadata> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    const normalizedNewPath = newPath.replace(/^\/+|\/+$/g, '');
    if (file.path === normalizedNewPath) {
      return file;
    }

    try {
      return await retryWithCacheRefresh(
        async () => {
          const megaFile = this.getNodeById(file.fileId);
          if (!megaFile) {
            // Typed NOT_FOUND: the source node is gone (deleted elsewhere or a
            // stale cached id). The shared rename layer treats this as a
            // GENUINE failure — never "already moved" — so it must be
            // distinguishable from other rename errors by code, not message.
            throw new ProviderError(`File not found: ${file.path}`, 'mega', 'NOT_FOUND');
          }

          const pathParts = normalizedNewPath.split('/');
          const newFileName = pathParts.pop() || normalizedNewPath;
          const newSeriesPath = pathParts.join('/');
          const mokuroFolder = await this.ensureMokuroFolder();
          const targetFolder = newSeriesPath
            ? await this.ensureSeriesFolder(newSeriesPath, mokuroFolder)
            : mokuroFolder;

          const targetChildren = await this.listFolder(targetFolder);
          const existingTarget = targetChildren.find(
            (child: any) =>
              !child.directory &&
              child.name === newFileName &&
              child !== megaFile &&
              child.nodeId !== megaFile.nodeId &&
              child.id !== megaFile.id
          );
          if (existingTarget) {
            throw new ProviderError(
              `Target file already exists at '${normalizedNewPath}'`,
              'mega',
              'TARGET_EXISTS'
            );
          }

          if (!sameNode(megaFile.parent, targetFolder)) {
            await megaFile.moveTo(targetFolder);
            // megajs applies moves to the local tree only when the sc packet
            // arrives (seconds later). Mirror it now so checks later in this
            // same operation — collision lookups, empty-folder pruning — see
            // the true state. Safe: the sc handler no-ops when the parent
            // already matches.
            const oldParent = megaFile.parent;
            if (oldParent?.children) {
              const idx = oldParent.children.indexOf(megaFile);
              if (idx >= 0) oldParent.children.splice(idx, 1);
            }
            megaFile.parent = targetFolder;
            if (Array.isArray(targetFolder.children)) {
              // The packet may already have landed: never link it twice.
              if (!targetFolder.children.includes(megaFile)) targetFolder.children.push(megaFile);
            } else {
              targetFolder.children = [megaFile];
            }
          }
          if (megaFile.name !== newFileName) {
            await megaFile.rename(newFileName);
          }

          const nextFileId = megaFile.nodeId || megaFile.id || file.fileId;
          return this.buildRenamedCloudFile(
            file,
            normalizedNewPath,
            nextFileId,
            file.modifiedTime,
            file.modifiedTimeProvisional
          );
        },
        `Rename file ${file.fileId} in MEGA`,
        () => this.reinitialize()
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(
        `Failed to rename file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'RENAME_FAILED',
        false,
        true
      );
    }
  }

  async renameFolder(oldPath: string, newPath: string): Promise<CloudFileMetadata[]> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    const normalizedOldPath = oldPath.replace(/^\/+|\/+$/g, '');
    const normalizedNewPath = newPath.replace(/^\/+|\/+$/g, '');
    if (normalizedOldPath === normalizedNewPath) {
      return megaCache.getBySeries(normalizedOldPath);
    }

    const existingFiles = megaCache.getBySeries(normalizedOldPath);
    if (existingFiles.length === 0) {
      return [];
    }

    try {
      await retryWithCacheRefresh(
        async () => {
          const mokuroFolder = await this.ensureMokuroFolder();
          const sourceFolder = await this.findFolderByPath(normalizedOldPath, mokuroFolder);
          if (!sourceFolder) {
            throw new ProviderError(
              `Series folder '${normalizedOldPath}' not found`,
              'mega',
              'FOLDER_NOT_FOUND'
            );
          }

          const existingTargetFolder = await this.findFolderByPath(normalizedNewPath, mokuroFolder);
          if (existingTargetFolder && !sameNode(existingTargetFolder, sourceFolder)) {
            throw new ProviderError(
              `Target series folder already exists at '${normalizedNewPath}'`,
              'mega',
              'TARGET_EXISTS'
            );
          }

          const pathParts = normalizedNewPath.split('/');
          const newFolderName = pathParts.pop() || normalizedNewPath;
          const newParentPath = pathParts.join('/');
          const targetParent = newParentPath
            ? await this.ensureSeriesFolder(newParentPath, mokuroFolder)
            : mokuroFolder;

          const targetChildren = await this.listFolder(targetParent);
          const conflictingFolder = targetChildren.find(
            (child: any) =>
              child.directory &&
              child.name === newFolderName &&
              child !== sourceFolder &&
              child.nodeId !== sourceFolder.nodeId &&
              child.id !== sourceFolder.id
          );
          if (conflictingFolder) {
            throw new ProviderError(
              `Target series folder already exists at '${normalizedNewPath}'`,
              'mega',
              'TARGET_EXISTS'
            );
          }

          if (!sameNode(sourceFolder.parent, targetParent)) {
            await sourceFolder.moveTo(targetParent);
          }
          if (sourceFolder.name !== newFolderName) {
            await sourceFolder.rename(newFolderName);
          }
        },
        `Rename series folder '${normalizedOldPath}' in MEGA`,
        () => this.reinitialize()
      );

      return existingFiles.map((file) =>
        this.buildRenamedCloudFile(
          file,
          `${normalizedNewPath}${file.path.slice(normalizedOldPath.length)}`,
          file.fileId,
          file.modifiedTime,
          file.modifiedTimeProvisional
        )
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(
        `Failed to rename series folder: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'RENAME_FAILED',
        false,
        true
      );
    }
  }

  /**
   * How many nodes the SERVER holds under a folder: a live `f` query, NOT the
   * local tree, which lags behind other devices and just-completed moves
   * until their sc packets land. `n` asks for the folder's subtree only, but
   * the count does not rely on the server honouring it: it counts just the
   * nodes whose parent chain reaches the folder, so a whole-account answer
   * gives the same number.
   */
  private async serverFolderContentCount(folderId: string): Promise<number> {
    const response: any = await new Promise((resolve, reject) => {
      this.storage.api.request({ a: 'f', c: 1, n: folderId }, (error: Error | null, result: any) =>
        error ? reject(error) : resolve(result)
      );
    });
    const nodes: any[] = Array.isArray(response?.f) ? response.f : [];
    const parentOf = new Map<string, string | undefined>(nodes.map((n: any) => [n?.h, n?.p]));
    const inside = (handle: string): boolean => {
      const seen = new Set<string>();
      for (let p = parentOf.get(handle); p && !seen.has(p); p = parentOf.get(p)) {
        if (p === folderId) return true;
        seen.add(p);
      }
      return false;
    };
    return nodes.filter((n: any) => n?.h && n.h !== folderId && inside(n.h)).length;
  }

  /**
   * Remove a series directory only if the SERVER confirms it is empty — never
   * a blind recursive delete (folder.delete on MEGA is recursive). Emptiness
   * is checked with a live `f` API query for the folder's nodes, NOT the local
   * tree, which can lag behind just-completed moves until the sc packet lands.
   */
  async removeDirectoryIfEmpty(relativePath: string): Promise<void> {
    if (!this.isAuthenticated()) return;

    const normalized = relativePath.replace(/^\/+|\/+$/g, '');
    if (!normalized) return;

    try {
      const mokuroFolder = await this.ensureMokuroFolder();
      const children = await this.listFolder(mokuroFolder);
      const target = children.find((f: any) => f.directory && f.name === normalized);
      if (!target?.nodeId) return;

      const remaining = await this.serverFolderContentCount(target.nodeId);
      if (remaining > 0) {
        console.log(
          `MEGA folder '${normalized}' not pruned: server still reports ${remaining} node(s)`
        );
        return;
      }

      await new Promise<void>((resolve, reject) => {
        target.delete(true, (error: Error | null) => (error ? reject(error) : resolve()));
      });
      console.log(`✅ Pruned empty series folder '${normalized}' from MEGA`);
    } catch (error) {
      // Best-effort: an orphaned empty directory is harmless.
      console.warn(`Could not prune MEGA folder '${normalized}':`, error);
    }
  }

  async deleteSeriesFolder(seriesTitle: string): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    try {
      // Wrap delete in retry logic to handle stale cache
      await retryWithCacheRefresh(
        async () => {
          const mokuroFolder = await this.ensureMokuroFolder();

          // Find the series folder
          const children = await this.listFolder(mokuroFolder);
          const seriesFolder = children.find((f: any) => f.name === seriesTitle && f.directory);

          if (!seriesFolder) {
            console.log(`Series folder '${seriesTitle}' not found in MEGA`);
            return;
          }

          // Delete the folder (recursive delete)
          await new Promise<void>((resolve, reject) => {
            seriesFolder.delete(true, (error: Error | null) => {
              if (error) {
                reject(error);
              } else {
                console.log(`✅ Deleted series folder '${seriesTitle}' from MEGA`);
                resolve();
              }
            });
          });
        },
        `Delete series folder '${seriesTitle}' from MEGA`,
        () => this.reinitialize()
      );
      // Cache upkeep is the caller's incremental updates + the sc-driven
      // change listeners; a rebuild here races the not-yet-synced tree.
    } catch (error) {
      throw new ProviderError(
        `Failed to delete series folder: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'DELETE_FAILED',
        false,
        true
      );
    }
  }

  /**
   * Get storage quota information from MEGA
   * Returns used, total, and available storage in bytes
   */
  async getStorageQuota(): Promise<StorageQuota> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    try {
      // Use getAccountInfo() for accurate quota information
      const info = await this.storage.getAccountInfo();

      const used = info.spaceUsed || 0;
      const total = info.spaceTotal || null;

      return {
        used,
        total,
        available: total !== null ? total - used : null
      };
    } catch (error) {
      throw new ProviderError(
        `Failed to get storage quota: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'QUOTA_FETCH_FAILED',
        false,
        true
      );
    }
  }

  async getWorkerUploadCredentials(): Promise<Record<string, any>> {
    if (!browser) return {};
    const session = localStorage.getItem(STORAGE_KEYS.SESSION);
    if (!session) return {};
    return { megaSession: session };
  }

  async prepareUploadTarget(seriesTitle: string): Promise<Record<string, any>> {
    // Create the series folder once here (coalesced by ensureSeriesFolder's mutex) and pass
    // its node id to the upload workers. Workers must NOT mkdir — each worker has its own
    // Storage tree, so parallel mkdir would create duplicate series folders.
    const mokuroFolder = await this.ensureMokuroFolder();
    const seriesFolder = await this.ensureSeriesFolder(seriesTitle, mokuroFolder);
    const nodeId = seriesFolder?.nodeId ?? seriesFolder?.id;
    return nodeId ? { megaSeriesFolderNodeId: nodeId } : {};
  }

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

  /**
   * Ensure a series folder exists (may be nested path like "Series/Subseries")
   */
  private async ensureSeriesFolder(folderPath: string, mokuroFolder: any): Promise<any> {
    // Coalesce concurrent ensureSeriesFolder calls for the same path so parallel
    // uploads to one series don't each mkdir the same intermediate folders.
    const key = folderPath;
    const inFlight = this.seriesFolderPromises.get(key);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      try {
        const pathParts = folderPath.split('/').filter(Boolean);
        // Held across awaits: re-resolve, a tree load may have replaced it.
        let currentFolder = this.current(mokuroFolder);

        for (const folderName of pathParts) {
          let subfolder = await this.findSubfolder(currentFolder, folderName);

          if (!subfolder) {
            subfolder = await new Promise((resolve, reject) => {
              currentFolder.mkdir(folderName, (error: Error | null, folder: any) => {
                if (error) reject(error);
                else resolve(folder);
              });
            });
            console.log(`Created folder: ${folderName}`);
          }

          currentFolder = this.current(subfolder);
        }

        return currentFolder;
      } finally {
        this.seriesFolderPromises.delete(key);
      }
    })();

    this.seriesFolderPromises.set(key, promise);
    return promise;
  }

  private getFileNodeId(file: any): string | null {
    return file?.nodeId || file?.id || null;
  }

  /**
   * MEGA.js mutates node.parent only when the server's 'sc' (state-change) action
   * stream arrives — the API callback for moveTo/delete fires earlier. Without
   * waiting for the event, subsequent listFolders() reads stale parent refs and
   * dedup pass 2 fails to group the now-sibling duplicates.
   */
  private waitForNodeEvent(node: any, eventName: string, timeoutMs = 5000): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const handler = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        if (typeof node.off === 'function') node.off(eventName, handler);
        else if (typeof node.removeListener === 'function') node.removeListener(eventName, handler);
        console.warn(`[MEGA] '${eventName}' event timeout after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
      node.once(eventName, handler);
    });
  }

  /** A `mokuro-reader` folder, or anything inside one. */
  private isInLibrary(node: any): boolean {
    for (let current = node; current; current = current.parent) {
      if (current.directory && current.name === MOKURO_FOLDER) return true;
    }
    return false;
  }

  private findNodeById(id: string): any | null {
    const files = Object.values(this.storage?.files || {}) as any[];
    return files.find((f: any) => this.getFileNodeId(f) === id) || null;
  }

  /**
   * FolderOperations interface used by FolderDeduplicator to merge duplicate folders.
   */
  getFolderOperations(): FolderOperations {
    // Duplicates this run already kept once because the server still had
    // nodes in them (see deleteFolder).
    const keptOnce = new Set<string>();
    return {
      rootFolderName: MOKURO_FOLDER,

      listFolders: async (): Promise<FolderInfo[]> => {
        await this.initPromise;
        if (!this.storage) return [];
        // In age order: the deduplicator keeps the first of a group after a
        // STABLE sort by age, so ties fall to handle order here — the same
        // folder findMokuroFolder and findSubfolder write to.
        const files = (Object.values(this.storage.files || {}) as any[]).sort(compareByAge);

        const folders: FolderInfo[] = [];
        for (const f of files) {
          if (!f.directory) continue;
          if (!this.isLiveNode(f)) continue;
          // The session sees the user's WHOLE drive: two same-named folders
          // of their own elsewhere are not ours to merge.
          if (!this.isInLibrary(f)) continue;
          const id = this.getFileNodeId(f);
          if (!id) continue;
          const parentId = f.parent ? this.getFileNodeId(f.parent) : null;
          folders.push({
            id,
            name: f.name,
            parentId,
            createdTime: f.timestamp ? new Date(f.timestamp * 1000).toISOString() : undefined
          });
        }
        return folders;
      },

      listFolderContents: async (folderId: string): Promise<FolderItem[]> => {
        await this.initPromise;
        if (!this.storage) return [];
        const target = this.findNodeById(folderId);
        if (!target) return [];

        const files = Object.values(this.storage.files || {}) as any[];
        const items: FolderItem[] = [];
        for (const f of files) {
          if (!sameNode(f.parent, target) || !this.isLiveNode(f)) continue;
          const id = this.getFileNodeId(f);
          if (!id) continue;
          items.push({
            id,
            name: f.name,
            isFolder: !!f.directory,
            modifiedTime: f.timestamp ? new Date(f.timestamp * 1000).toISOString() : undefined
          });
        }
        return items;
      },

      moveItem: async (itemId, newParentId, _oldParentId): Promise<void> => {
        const item = this.findNodeById(itemId);
        const newParent = this.findNodeById(newParentId);
        if (!item) throw new Error(`MEGA dedup: item ${itemId} not found`);
        if (!newParent) throw new Error(`MEGA dedup: parent ${newParentId} not found`);
        const stateSynced = this.waitForNodeEvent(item, 'move');
        await item.moveTo(newParent);
        await stateSynced;
      },

      deleteFolder: async (folderId): Promise<void> => {
        const folder = this.findNodeById(folderId);
        if (!folder) return;
        // The deduplicator judged it empty from THIS tree, which lags other
        // devices' uploads and packets still in flight — and a MEGA folder
        // delete is recursive. Delete only what the server says is empty;
        // otherwise reload, so the next pass moves what this tree missed.
        const remaining = await this.serverFolderContentCount(folderId);
        if (remaining > 0) {
          // Still not empty after a reload and a second merge (another
          // device keeps writing there): stop this run rather than reload
          // the whole tree on each of the deduplicator's passes.
          if (keptOnce.has(folderId)) {
            throw new Error(
              `MEGA dedup: duplicate folder ${folderId} still holds ${remaining} node(s) after a reload; stopping`
            );
          }
          keptOnce.add(folderId);
          console.warn(
            `[MEGA] duplicate folder ${folderId} kept: server still reports ${remaining} node(s)`
          );
          await this.refreshTree();
          return;
        }
        const stateSynced = this.waitForNodeEvent(folder, 'delete');
        await new Promise<void>((resolve, reject) => {
          folder.delete(true, (error: Error | null) => {
            if (error) reject(error);
            else resolve();
          });
        });
        // No manual storage.files eviction: the sc packet unlinks it, which
        // is all isLiveNode needs.
        await stateSynced;
      },

      trashFile: async (fileId): Promise<void> => {
        const file = this.findNodeById(fileId);
        if (!file) return;
        // The Rubbish Bin, never a permanent delete; without one, stop.
        const trash = this.storage?.trash;
        if (!trash) throw new Error('MEGA dedup: no Rubbish Bin in the tree');
        const stateSynced = this.waitForNodeEvent(file, 'move');
        await file.moveTo(trash);
        await stateSynced;
      },

      onRootFolderConfirmed: (folderId): void => {
        const canonical = this.findNodeById(folderId);
        if (canonical) {
          this.mokuroFolder = canonical;
        }
      }
    };
  }
}

export const megaProvider = new MegaProvider();

// Self-register cache when module is loaded
cacheManager.registerCache('mega', megaCache);
