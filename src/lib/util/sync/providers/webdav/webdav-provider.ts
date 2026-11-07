import { browser } from '$app/environment';
import type {
  SyncProvider,
  ProviderCredentials,
  ProviderStatus,
  StorageQuota,
  CloudFileMetadata,
  DownloadOptions,
  FileStamp,
  UploadFileResult,
  ControlFileResult
} from '../../provider-interface';
import { ProviderError } from '../../provider-interface';
import { setActiveProviderKey, clearActiveProviderKey } from '../../provider-detection';
import type { WebDAVClient } from 'webdav';
import { getCloudProviderCore } from '../../core/cloud-provider-core-registry';
import { webdavAuthOptions } from '../../core/providers/webdav-auth';
import {
  bearerOf,
  webdavAuthHeaders,
  webdavAuthorization,
  type WebdavAuthMaterial
} from '../../core/providers/webdav-authorization';
import { isVerifiedPutHeader, WebdavUploadError } from './webdav-upload';
import { fetchWithRetryAfter, wrapWebdavClient } from './webdav-retry-after';
import { fetchServerIdentity, type IdentityResult, type ServerPermissions } from './identity';
import {
  requestBunkoToken,
  revokeBunkoToken,
  tokenEndpointFor,
  tokenNeedsRenewal
} from './bunko-token';
import {
  isTransientAuthRefreshError,
  registerWorkerAuthRefresher,
  TransientAuthRefreshError
} from '$lib/util/worker-auth-refresh';
import { classifyWriteError, type WriteErrorKind } from './webdav-errors';
import { CANNOT_RENAME_MESSAGE, OWNERSHIP_REFRESH_MAX_AGE_MS } from '../../account-capabilities';
import {
  isBestEffortMetadataPath,
  isReservedLayerSidecarPath,
  isSyncableFile
} from '../../syncable-file';
import { controlSetEtag } from '../../control-file-read';
import { withCloudBunkoStatus } from '$lib/catalog/cloud-bunko-marker';
import { bunkoSupportsHistory } from './bunko-version';

interface WebDAVCredentials {
  serverUrl: string;
  username?: string;
  password?: string;
}

const STORAGE_KEYS = {
  SERVER_URL: 'webdav_server_url',
  USERNAME: 'webdav_username',
  PASSWORD: 'webdav_password',
  /** The server URL that answered `X-Mokuro-Put: verified` (staged, verified PUTs). */
  PUT_VERIFIED: 'webdav_put_verified',
  /**
   * A mokuro-bunko bearer token (`bunko-token.ts`). Sent instead of the
   * password while held; the password stays stored so a dead token is
   * replaced silently. `TOKEN_ACCOUNT` binds it to the server URL + username
   * it was issued for (`tokenAccountKey`): any other account never sends it.
   */
  TOKEN: 'webdav_token',
  /** Epoch ms the token expires at (absent when the server did not say). */
  TOKEN_EXPIRES_AT: 'webdav_token_expires_at',
  /** The token endpoint that issued it: re-issue and revoke go there. */
  TOKEN_ENDPOINT: 'webdav_token_endpoint',
  TOKEN_ACCOUNT: 'webdav_token_account'
};

/** Every localStorage key a WebDAV token occupies (cleared together). */
export const WEBDAV_TOKEN_STORAGE_KEYS = [
  STORAGE_KEYS.TOKEN,
  STORAGE_KEYS.TOKEN_EXPIRES_AT,
  STORAGE_KEYS.TOKEN_ENDPOINT,
  STORAGE_KEYS.TOKEN_ACCOUNT
] as const;

/** Wait this long after a rate-limited re-issue before spending the password again. */
const REISSUE_RATE_LIMIT_COOLDOWN_MS = 60_000;

/** What a re-issue achieved (`reissueToken`). */
type ReissueOutcome =
  /** A fresh token is held: retry. */
  | 'replaced'
  /** The server has no token endpoint any more: the session is back on Basic: retry. */
  | 'basic'
  /** The password was refused: the auth-failed flow ran. */
  | 'refused'
  /** The login limiter is hot: no retry, no loop (cooldown). TRANSIENT. */
  | 'rate-limited'
  /** The token endpoint could not be reached (network, timeout, 5xx). TRANSIENT. */
  | 'unreachable'
  /** Nothing to re-issue with (no stored password): the 401 stands. */
  | 'unavailable';

/**
 * What the caller of a request refused with 401 under a token does next:
 * `retry` under the session's (new) header; `final` — the 401 stands (the
 * re-issue was REFUSED, or there is nothing to re-issue with); `transient` —
 * fail with a `TransientAuthRefreshError`, never the 401: a rate-limited or
 * unreachable re-issue says nothing about the password, and a 401 reaching a
 * write path would wipe it (`handleWriteFailure` -> `markAuthFailed`).
 */
type ReissueVerdict = 'retry' | 'final' | 'transient';

function isUnauthorized(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 401;
}

/** Last-resort version of a body when the server sent neither ETag nor Last-Modified. */
async function bodyFingerprint(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let hash = 0x811c9dc5; // FNV-1a
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return `len${bytes.length}-${hash.toString(16)}`;
}

/** The account a token belongs to: server URL (userinfo stripped) + username. */
function tokenAccountKey(serverUrl: string, username: string | null | undefined): string {
  return `${stripUrlUserinfo(serverUrl.replace(/\/$/, ''))}|${username ?? ''}`;
}

/**
 * Drop any embedded userinfo (`user:pass@`) from a server URL before it feeds
 * `accountScope`, which is persisted to IndexedDB. The login form has separate
 * username/password fields, but nothing stops a user pasting
 * `https://user:pass@host/dav` into the URL field itself — that must never
 * leak a password into a persisted cache key.
 */
export function stripUrlUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Not a parseable absolute URL — fall back to stripping an
    // authority-embedded `user:pass@` prefix by hand.
    return url.replace(/^(\w+:\/\/)[^/@]*@/, '$1');
  }
}

const MOKURO_FOLDER = '/mokuro-reader';
const VOLUME_DATA_FILE = '/mokuro-reader/volume-data.json';
const PROFILES_FILE = '/mokuro-reader/profiles.json';

/**
 * A 403 on a reserved layer file (`isReservedLayerSidecarPath`): bunko refuses
 * some of those by design (a case merge's `curated-<n>`, `curated` without the
 * rights, a 0.7.x `edit`), so the refusal is that file's alone — reported as
 * one (layer-sync stops asking), never as a read-only server.
 */
function reservedLayerRefusal(path: string): ProviderError {
  return new ProviderError(
    `The server refused the layer file ${path}`,
    'webdav',
    'PERMISSION_DENIED',
    false,
    false,
    'permission'
  );
}

/**
 * A 403 on a library file from a bunko that records series owners
 * (`permissions.addFiles` reported): another account owns the series, or the
 * volume the file is named after. That file's refusal alone, with the
 * server's reason when it sent one — never a read-only server, never a
 * credential failure (`handleWriteFailure` is not reached).
 */
function libraryFileRefusal(path: string, error: unknown): ProviderError {
  const detail = error instanceof WebdavUploadError && error.status === 403 ? error.detail : '';
  return new ProviderError(
    detail
      ? `The server refused ${path}: ${detail}`
      : `The server refused ${path} for this account`,
    'webdav',
    'PERMISSION_DENIED',
    false,
    false,
    'permission'
  );
}

/** A file in the shared library (a series folder), not a root config file or history. */
function isLibraryFilePath(path: string): boolean {
  return path.includes('/') && !path.startsWith('history/');
}

/**
 * Methods whose presence in a COLLECTION's `Allow` shows it can be written.
 *
 * `Allow` lists what the target resource itself supports (RFC 9110 §10.2.1),
 * and the probe targets the library folder, an existing collection. Per
 * RFC 4918 such a collection never lists PUT (files are PUT to member URLs;
 * PUT on a collection is undefined, §9.7.2) and lists MKCOL only while its URL
 * is unmapped (§9.3.1). So writability shows instead as the methods that
 * change the collection's membership: DELETE (§9.6) and MOVE (§9.9). PUT and
 * MKCOL still count, for servers that send one fixed `Allow` for every URL.
 *
 * Left out on purpose: PROPPATCH changes only properties (§9.2), which a
 * server may let a read-only account keep; COPY only reads its source (the
 * write lands at the Destination, §9.8); LOCK/UNLOCK come with class 2
 * compliance and change no content themselves (§9.10, §9.11); POST is not a
 * WebDAV write.
 */
const COLLECTION_WRITE_METHODS = ['PUT', 'MKCOL', 'DELETE', 'MOVE'] as const;

/**
 * Privileges (RFC 3744 §3) that let an account upload into the library
 * folder: DAV:write, its DAV:write-content part, DAV:all, and DAV:bind /
 * DAV:unbind (adding and removing a collection's members, §3.9-3.10, which an
 * account may hold without the DAV:write aggregate). Matched as whole element
 * names, any namespace prefix: DAV:write-properties and DAV:write-acl share
 * the `write` prefix but upload nothing.
 */
const WRITE_PRIVILEGE_RE = /<(?:[\w-]+:)?(?:write|write-content|all|bind|unbind)\s*\/?>/;

/**
 * Read a collection's `Allow` header: true when it lists any collection write
 * method, false when it lists methods but none of them, null when it is
 * absent, blank or lists nothing (the caller decides; today that is "writable").
 */
export function allowHeaderPermitsCollectionWrite(allow: string | null): boolean | null {
  const methods = (allow ?? '')
    .split(',')
    .map((m) => m.trim().toUpperCase())
    .filter((m) => m.length > 0);
  if (methods.length === 0) return null;
  return COLLECTION_WRITE_METHODS.some((m) => methods.includes(m));
}

export class WebDAVProvider implements SyncProvider {
  readonly type = 'webdav' as const;
  readonly name = 'WebDAV';
  readonly supportsWorkerDownload = true; // Workers download directly (Bearer or Basic)
  readonly supportsWorkerUpload = true;
  readonly uploadConcurrencyLimit = 8; // WebDAV servers can typically handle more concurrent connections
  readonly downloadConcurrencyLimit = 8;

  /** The session's client, wrapped so a 401 under a token re-issues and retries once. */
  private client: WebDAVClient | null = null;
  /** The unwrapped client, whose headers follow the session's auth (`applyClientAuth`). */
  private rawClient: WebDAVClient | null = null;
  /** The connection `login()` is establishing, before its credentials are persisted. */
  private connecting: { serverUrl: string; username: string; password: string } | null = null;
  /** Single-flight re-issue: every refused request waits on the same one. */
  private reissueInFlight: Promise<ReissueOutcome> | null = null;
  private reissueBlockedUntil = 0;
  /**
   * Server URLs whose token endpoint is absent (older bunko, other servers):
   * this session stays on Basic there without asking again. Session memory
   * only — every connect asks afresh.
   */
  private tokenUnsupported = new Set<string>();
  private initPromise: Promise<void>;
  private _isReadOnly: boolean = false;
  private _supportsDepthInfinity: boolean | null = null; // null = unknown, will probe on first use
  /**
   * The reader folder exists on this connection (`ensureMokuroFolder` saw or
   * made it): an upload skips the PROPFIND that asks again. Listings never
   * trust it — they re-create a folder deleted on the server meanwhile.
   * Per session — reset whenever the client is made or dropped.
   */
  private mokuroFolderReady = false;
  /** Server-reported permissions (mokuro-bunko identity endpoint); null = unknown/generic server */
  private _capabilities: ServerPermissions | null = null;
  /** The server answered the mokuro-bunko identity endpoint: it compiles the metadata files. */
  private _serverCompilesMetadata = false;
  /** The bunko version `/login/api/me` reported (bunko >= 0.8.0); undefined otherwise. */
  private _serverVersion: string | undefined;
  /** Root files bunko reports keeping per account (`per_user_files`); undefined = not reported. */
  private _perUserFiles: string[] | undefined;
  /** Layer ids bunko reports keeping per account (`per_user_layers`); undefined = not reported. */
  private _perUserLayers: string[] | undefined;
  /**
   * When the identity endpoint was last asked (login or `refreshIdentity`),
   * whatever it answered — a plain server's 'unsupported' and a failed request
   * included, so `maxAgeMs` throttles every answer kind.
   */
  private identityAt: number | undefined;
  /**
   * The refresh in flight: concurrent callers of the SAME session share its
   * one request (`epoch` = the `sessionEpoch` it was asked under).
   */
  private identityRefresh: { epoch: number; promise: Promise<void> } | null = null;
  /**
   * Moves on every login and logout. An identity answer is applied only to the
   * session that asked: a refresh still in flight when the user switched
   * accounts or servers (two GETs, up to ~20 s) must not turn the bunko gates
   * on, or hand one account's lists to another session.
   */
  private sessionEpoch = 0;
  /** Set when stored credentials were rejected and the user must re-login */
  private _needsAttention = false;
  /** Per control-file name: the last read's set etag and the server's raw ETag for its one node. */
  private controlReads = new Map<string, { setEtag: string; serverEtag: string }>();
  /** Whether the current session was established with a password */
  private _hasPassword = false;
  private cloudCore = getCloudProviderCore('webdav');

  constructor() {
    if (browser) {
      this.initPromise = this.loadPersistedCredentials();
    } else {
      this.initPromise = Promise.resolve();
    }
  }

  /**
   * Fresh worker credentials after a 401 under `staleAuthorization`, or null
   * (the 401 stands). Main-thread uploads/downloads and every worker (through
   * `worker-auth-refresh.ts`) come here, so they share one re-issue.
   */
  async refreshedWorkerCredentials(
    staleAuthorization: string
  ): Promise<Record<string, unknown> | null> {
    const verdict = await this.reissueVerdict(staleAuthorization);
    if (verdict === 'transient') throw new TransientAuthRefreshError();
    if (verdict !== 'retry') return null;
    return this.getWorkerUploadCredentials();
  }

  // ---------------------------------------------------------------- session auth

  /** The account of the session: the one being connected, else the stored one. */
  private sessionAccount(): { serverUrl: string; username: string; password: string } | null {
    if (this.connecting) return this.connecting;
    if (!browser) return null;
    const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
    if (!serverUrl) return null;
    return {
      serverUrl,
      username: localStorage.getItem(STORAGE_KEYS.USERNAME) ?? '',
      password: localStorage.getItem(STORAGE_KEYS.PASSWORD) ?? ''
    };
  }

  /** The stored token, iff it was issued for this server URL + username. */
  private heldToken(
    serverUrl: string,
    username: string
  ): { token: string; expiresAt: number | null; endpoint: string } | null {
    if (!browser) return null;
    const token = localStorage.getItem(STORAGE_KEYS.TOKEN);
    const endpoint = localStorage.getItem(STORAGE_KEYS.TOKEN_ENDPOINT);
    if (!token || !endpoint) return null;
    if (localStorage.getItem(STORAGE_KEYS.TOKEN_ACCOUNT) !== tokenAccountKey(serverUrl, username)) {
      return null;
    }
    const raw = Number(localStorage.getItem(STORAGE_KEYS.TOKEN_EXPIRES_AT));
    return { token, endpoint, expiresAt: Number.isFinite(raw) && raw > 0 ? raw : null };
  }

  private storeToken(
    serverUrl: string,
    username: string,
    token: string,
    expiresAt: number | null,
    endpoint: string
  ): void {
    if (!browser) return;
    localStorage.setItem(STORAGE_KEYS.TOKEN, token);
    localStorage.setItem(STORAGE_KEYS.TOKEN_ENDPOINT, stripUrlUserinfo(endpoint));
    localStorage.setItem(STORAGE_KEYS.TOKEN_ACCOUNT, tokenAccountKey(serverUrl, username));
    if (expiresAt !== null) {
      localStorage.setItem(STORAGE_KEYS.TOKEN_EXPIRES_AT, String(Math.round(expiresAt)));
    } else {
      localStorage.removeItem(STORAGE_KEYS.TOKEN_EXPIRES_AT);
    }
  }

  /**
   * Forget the stored token (whatever account it belongs to). `revoke`: also
   * sign it out on the server that issued it — best effort, not awaited, and
   * only ever to its own endpoint.
   */
  private dropToken(options: { revoke?: boolean } = {}): void {
    if (!browser) return;
    const token = localStorage.getItem(STORAGE_KEYS.TOKEN);
    const endpoint = localStorage.getItem(STORAGE_KEYS.TOKEN_ENDPOINT);
    for (const key of WEBDAV_TOKEN_STORAGE_KEYS) localStorage.removeItem(key);
    if (options.revoke && token && endpoint) void revokeBunkoToken(endpoint, token);
  }

  /** Username, password and (held) token of the session: the input of every header. */
  private sessionAuth(): WebdavAuthMaterial {
    const account = this.sessionAccount();
    if (!account) return {};
    const held = this.heldToken(account.serverUrl, account.username);
    return { username: account.username, password: account.password, token: held?.token };
  }

  /**
   * THE Authorization header of this session (Bearer > Basic > none, see
   * `webdavAuthorization`). Only ever sent to the session's own server.
   */
  authorizationHeader(): string | null {
    return webdavAuthorization(this.sessionAuth());
  }

  /** Point the client at the session's current header (after a token change). */
  private applyClientAuth(): void {
    this.rawClient?.setHeaders(webdavAuthHeaders(this.sessionAuth()));
  }

  /**
   * Wrap a `webdav` client so any request refused with 401 while a token was
   * sent re-issues the token (single-flight) and is retried once, and a short
   * 503 + Retry-After is waited out (`wrapWebdavClient`).
   */
  private wrapClient(raw: WebDAVClient): WebDAVClient {
    return wrapWebdavClient(raw, async (sent) => {
      if (!bearerOf(sent)) return false;
      const verdict = await this.reissueVerdict(sent);
      if (verdict === 'transient') throw new TransientAuthRefreshError();
      if (verdict !== 'retry') return false;
      // Retry under the session's header as it is NOW: the token may have
      // been replaced by another tab (localStorage is shared, this
      // client's headers are not), or the session fell back to Basic.
      raw.setHeaders(webdavAuthHeaders(this.sessionAuth()));
      return true;
    });
  }

  /**
   * A request sent with `staleAuthorization` was answered 401. True when the
   * caller should retry with the session's (new) header: the token was
   * replaced — by this call, or already by a concurrent one — or the session
   * fell back to Basic. Every caller (client, uploads, workers, the OCR queue)
   * shares ONE re-issue in flight.
   */
  async reissueAfterUnauthorized(staleAuthorization: string | null | undefined): Promise<boolean> {
    return (await this.reissueVerdict(staleAuthorization)) === 'retry';
  }

  /** `reissueAfterUnauthorized`, telling a transient failure apart from a final one. */
  private async reissueVerdict(
    staleAuthorization: string | null | undefined
  ): Promise<ReissueVerdict> {
    const stale = bearerOf(staleAuthorization);
    if (!stale) return 'final';
    const auth = this.sessionAuth();
    if (auth.token && auth.token !== stale) {
      // Someone already replaced it — maybe ANOTHER TAB, whose new token is in
      // the shared localStorage while this tab's client still sends the dead
      // one. Point the client at the stored token before the caller retries.
      this.applyClientAuth();
      return 'retry';
    }
    if (!auth.token && auth.password) {
      // The token is gone but the session is on Basic (no endpoint): retry with that.
      const account = this.sessionAccount();
      if (account && this.tokenUnsupported.has(account.serverUrl)) {
        this.applyClientAuth();
        return 'retry';
      }
    }
    const outcome = await this.reissueSingleFlight();
    if (outcome === 'replaced' || outcome === 'basic') return 'retry';
    if (outcome === 'rate-limited' || outcome === 'unreachable') return 'transient';
    return 'final';
  }

  private reissueSingleFlight(): Promise<ReissueOutcome> {
    if (!this.reissueInFlight) {
      this.reissueInFlight = this.reissueToken().finally(() => {
        this.reissueInFlight = null;
      });
    }
    return this.reissueInFlight;
  }

  /**
   * Trade the stored password for a fresh token at the endpoint that issued
   * the last one. Refused (401) -> the existing auth-failed flow; rate limited
   * -> a notice and a cooldown, never a loop.
   */
  private async reissueToken(): Promise<ReissueOutcome> {
    const account = this.sessionAccount();
    if (!account || !account.username || !account.password) return 'unavailable';
    if (Date.now() < this.reissueBlockedUntil) return 'rate-limited';
    const held = this.heldToken(account.serverUrl, account.username);
    const endpoint = held?.endpoint ?? tokenEndpointFor(undefined, account.serverUrl);
    const result = await requestBunkoToken(endpoint, account.username, account.password);
    switch (result.kind) {
      case 'issued':
        this.storeToken(
          account.serverUrl,
          account.username,
          result.token,
          result.expiresAt,
          endpoint
        );
        this.applyClientAuth();
        console.log('[WebDAV] Bearer token re-issued');
        return 'replaced';
      case 'invalid-credentials':
        console.warn('[WebDAV] Token re-issue refused: the stored password was rejected');
        this.dropToken();
        this.markAuthFailed();
        return 'refused';
      case 'rate-limited':
        this.reissueBlockedUntil = Date.now() + REISSUE_RATE_LIMIT_COOLDOWN_MS;
        import('$lib/util/snackbar')
          .then(({ showSnackbar }) =>
            showSnackbar('WebDAV: too many failed attempts - try again later')
          )
          .catch(() => {});
        return 'rate-limited';
      case 'unsupported':
        // The server no longer issues tokens: Basic still works everywhere.
        this.tokenUnsupported.add(account.serverUrl);
        this.dropToken();
        this.applyClientAuth();
        return 'basic';
      case 'unreachable':
      default:
        return 'unreachable';
    }
  }

  /**
   * After a successful identity check: hold a token for this bunko account —
   * issue one when none is held, or replace one with fewer than 7 days left
   * (`tokenNeedsRenewal`). Never fails the connection: without a token the
   * session simply stays on Basic (or on the held, still-valid token).
   */
  private async ensureToken(
    serverUrl: string,
    username: string,
    password: string,
    identityEndpoint: string | undefined
  ): Promise<void> {
    if (!browser || !username || !password) return;
    if (this.tokenUnsupported.has(serverUrl)) return;
    const held = this.heldToken(serverUrl, username);
    if (held && !tokenNeedsRenewal(held.expiresAt)) return;
    const endpoint = held?.endpoint ?? tokenEndpointFor(identityEndpoint, serverUrl);
    const result = await requestBunkoToken(endpoint, username, password);
    switch (result.kind) {
      case 'issued':
        // The old token (if any) is retired: sign it out, then hold the new one.
        if (held) void revokeBunkoToken(held.endpoint, held.token);
        this.storeToken(serverUrl, username, result.token, result.expiresAt, endpoint);
        this.applyClientAuth();
        console.log(`[WebDAV] Bearer token ${held ? 'renewed' : 'issued'}`);
        return;
      case 'unsupported':
        // Older bunko: Basic, exactly as before, without asking again this session.
        this.tokenUnsupported.add(serverUrl);
        if (held) {
          this.dropToken();
          this.applyClientAuth();
        }
        return;
      case 'invalid-credentials':
        // The password just verified (Basic identity) or the held token still
        // works: nothing to act on now. A real re-issue later decides.
        if (!held) this.tokenUnsupported.add(serverUrl);
        console.warn('[WebDAV] Token request refused; keeping the current authentication');
        return;
      default:
        // Rate limited or unreachable: keep what works, ask again at next connect.
        return;
    }
  }

  /**
   * The identity check, under the session's header. A held token the server
   * refuses is re-issued from the password once and the check repeated; a
   * token the server does not understand (endpoint gone) falls back to Basic.
   */
  private async identify(
    serverUrl: string,
    username: string | undefined,
    password: string | undefined,
    options: { refresh?: boolean } = {}
  ): Promise<IdentityResult> {
    const token = this.sessionAuth().token;
    if (!token) return fetchServerIdentity(serverUrl, username, password);
    const identity = await fetchServerIdentity(serverUrl, username, password, undefined, token);
    if (identity.kind === 'invalid-credentials') {
      const outcome =
        this.sessionAuth().token !== token ? 'replaced' : await this.reissueSingleFlight();
      if (outcome === 'refused') return identity;
      if (outcome === 'rate-limited') return { kind: 'rate-limited' };
      // A refresh keeps the token through an unreachable re-issue, as any
      // request does (`reissueVerdict` 'transient'): no answer, not a verdict.
      if (outcome === 'unreachable' && options.refresh) return { kind: 'unsupported' };
      if (outcome === 'unavailable' || outcome === 'unreachable') this.dropToken();
      // The client follows whatever the session holds now (a new token, one
      // another tab stored, or Basic after the drop above).
      this.applyClientAuth();
      const fresh = this.sessionAuth().token;
      return fetchServerIdentity(serverUrl, username, password, undefined, fresh);
    }
    if (identity.kind === 'unsupported') {
      // On a refresh this is most likely a transient failure (both candidates
      // timed out or answered 5xx): keep the token and the last answer; the
      // next connect asks the question below afresh.
      if (options.refresh) return identity;
      // The token went to a server that no longer speaks bunko's identity
      // contract: drop it and ask again with Basic, as any other server.
      this.dropToken();
      this.applyClientAuth();
      return fetchServerIdentity(serverUrl, username, password);
    }
    return identity;
  }

  /**
   * Wait for provider initialization to complete
   * Use this to ensure credentials have been restored before checking authentication
   */
  async whenReady(): Promise<void> {
    await this.initPromise;
  }

  isAuthenticated(): boolean {
    return this.client !== null;
  }

  /**
   * Check if the WebDAV connection is read-only (no write permissions)
   */
  get isReadOnly(): boolean {
    return this._isReadOnly;
  }

  /**
   * Re-fetch the identity endpoint and publish the fresh permissions.
   *
   * Server-side permissions move mid-session: `ownedSeries` grows as this
   * account uploads new series, so a snapshot taken at connect goes stale and
   * wrongly gates edits on series the account now owns. So does the server
   * itself: an upgrade or a rollback while a tab stays open changes what it
   * keeps per user (`version`, `per_user_files`, `per_user_layers`), and the
   * history/positions/edit-layer gates must follow — a 0.7.x files all three
   * into its SHARED library. Called after the backup queue drains and, with
   * `maxAgeMs`, before per-user files are written. Fails quietly — the last
   * answer stays, and a held token is never dropped on a transient answer.
   * One request in flight at a time (concurrent callers share it), and
   * `maxAgeMs` counts every answer, a failure included.
   */
  async refreshIdentity(options: { maxAgeMs?: number } = {}): Promise<void> {
    if (!browser || !this.client) return;
    const epoch = this.sessionEpoch;
    if (this.identityRefresh?.epoch === epoch) return this.identityRefresh.promise;
    if (
      options.maxAgeMs !== undefined &&
      this.identityAt !== undefined &&
      Date.now() - this.identityAt < options.maxAgeMs
    ) {
      return;
    }
    const account = this.sessionAccount();
    if (!account) return;
    const promise = this.askIdentityAgain(account, epoch).finally(() => {
      if (this.identityRefresh?.promise === promise) this.identityRefresh = null;
    });
    this.identityRefresh = { epoch, promise };
    return promise;
  }

  /** Forget the identity refresh state of the session that is ending. */
  private endIdentitySession(): void {
    this.sessionEpoch++;
    this.identityRefresh = null;
    this.identityAt = undefined;
  }

  private async askIdentityAgain(
    account: {
      serverUrl: string;
      username: string;
      password: string;
    },
    epoch: number
  ): Promise<void> {
    try {
      const identity = await this.identify(
        account.serverUrl,
        account.username || undefined,
        account.password || undefined,
        { refresh: true }
      );
      // The session that asked has ended (logout, another login): its answer
      // describes another account, maybe another server.
      if (epoch !== this.sessionEpoch) return;
      if (identity.kind === 'authenticated' || identity.kind === 'anonymous') {
        if (identity.kind === 'authenticated') {
          this._capabilities = identity.permissions;
          this._isReadOnly = !(
            identity.permissions.canWriteProgress || identity.permissions.canAddFiles
          );
        }
        // The endpoint answered in bunko's contract shape: bunko, whatever the
        // connect concluded (/me may have been unreachable then). Never
        // cleared by a refresh — a failed one says nothing.
        this._serverCompilesMetadata = true;
        this._serverVersion = identity.serverVersion;
        this._perUserFiles = identity.perUserFiles;
        this._perUserLayers = identity.perUserLayers;
        this.notifyStatusChanged();
      }
    } catch (error) {
      console.warn('[WebDAV] identity refresh failed (keeping last known):', error);
    } finally {
      // Every answer kind (and a failure) counts: a plain server's
      // 'unsupported' must not cost two GETs on every sync. Only for the
      // session that asked.
      if (epoch === this.sessionEpoch) this.identityAt = Date.now();
    }
  }

  /**
   * Mark the provider as read-only (called when a write operation fails with permission error)
   * Also triggers a status update to refresh the UI
   */
  markAsReadOnly(): void {
    if (!this._isReadOnly) {
      console.log('📖 WebDAV marked as read-only due to write operation failure');
      this._isReadOnly = true;
      this.notifyStatusChanged();
    }
  }

  /**
   * Mark the session as auth-failed: clear only the stored password (keep
   * server URL + username so the login form pre-fills) and flag the provider
   * as needing attention so the UI prompts a re-login.
   */
  private markAuthFailed(): void {
    if (browser) {
      localStorage.removeItem(STORAGE_KEYS.PASSWORD); // keep URL + username
      this.dropToken(); // a token is only as good as the password that re-issues it
    }
    this.setNeedsAttention();
  }

  private setNeedsAttention(): void {
    this._needsAttention = true;
    this.notifyStatusChanged();
  }

  /** Trigger status update to refresh UI (import dynamically to avoid circular deps) */
  private notifyStatusChanged(): void {
    import('../../provider-manager').then(({ providerManager }) => {
      providerManager.updateStatus();
    });
  }

  getStatus(): ProviderStatus {
    // Only serverUrl is required - username/password are optional for some servers
    const serverUrl = browser ? localStorage.getItem(STORAGE_KEYS.SERVER_URL) : null;
    const username = browser ? localStorage.getItem(STORAGE_KEYS.USERNAME) : null;
    const hasCredentials = !!serverUrl;
    const isConnected = this.isAuthenticated();

    // The marker is a fourth `serverCompilesMetadata` source beside the identity
    // endpoint, anonymous access and PUT_VERIFIED: `withCloudBunkoStatus` ORs a
    // fresh marker onto whatever those said.
    return withCloudBunkoStatus(this.type, {
      isAuthenticated: isConnected,
      hasStoredCredentials: hasCredentials,
      needsAttention: this._needsAttention,
      statusMessage: isConnected
        ? this._isReadOnly
          ? 'Connected to WebDAV (read-only)'
          : 'Connected to WebDAV'
        : hasCredentials
          ? 'Configured (not connected)'
          : 'Not configured',
      isReadOnly: this._isReadOnly,
      serverCompilesMetadata: this._serverCompilesMetadata,
      // mokuro-bunko keeps reading history per user only from 0.7.8, and only
      // when it lists `history/` per user; otherwise `history/` lands in the
      // shared library. Plain WebDAV: no limit.
      historySync: this._serverCompilesMetadata
        ? bunkoSupportsHistory(this._serverVersion, this._perUserFiles)
        : undefined,
      // positions.json is per user only where bunko says so; otherwise that
      // path is a shared library file. Plain WebDAV: no limit.
      positionsSync: this._serverCompilesMetadata
        ? (this._perUserFiles?.includes('positions.json') ?? false)
        : undefined,
      // The edit layer goes up only to a bunko that keeps it per account; any
      // other bunko would publish it to every account. Plain WebDAV: the
      // user's own file.
      editLayerSync: this._serverCompilesMetadata
        ? this._perUserLayers?.includes('edit')
          ? 'push'
          : 'local'
        : undefined,
      curatedPublish: this._capabilities?.curated?.scope,
      curatedVolumes: this._capabilities?.curated?.volumes,
      metadataPermissions: this._capabilities?.metadata,
      addFilesPermissions: this._capabilities?.addFiles,
      canModifyDelete: this._capabilities?.canModifyDelete,
      canAddFiles: this._capabilities?.canAddFiles,
      // username is optional (some servers support password-only or no auth),
      // so it's an extra discriminator on top of the required serverUrl, not
      // a requirement in its own right.
      accountScope: serverUrl
        ? `webdav:${stripUrlUserinfo(serverUrl)}${username ? `|${username}` : ''}`
        : undefined
    });
  }

  async login(credentials?: ProviderCredentials): Promise<void> {
    // Only serverUrl is required - some servers support password-only auth (e.g., copyparty)
    if (!credentials || !credentials.serverUrl) {
      throw new ProviderError('Server URL is required', 'webdav', 'INVALID_CREDENTIALS');
    }

    const { serverUrl, username, password } = credentials as WebDAVCredentials;

    // The only anonymous login is a fully blank one (browse a public server).
    // A username with no password is an incomplete credential — never a silent
    // anonymous read-only session. (Password-only auth, e.g. copyparty, is
    // fine: a password with no username still authenticates.)
    if (username && !password) {
      throw new ProviderError(
        'Password is required',
        'webdav',
        'INVALID_CREDENTIALS',
        false,
        false,
        'auth'
      );
    }

    // A new session: a refresh the last one left in flight answers nobody.
    this.endIdentitySession();

    // Normalize server URL (remove trailing slash)
    const normalizedUrl = serverUrl.replace(/\/$/, '');

    // A held token carries over only to the same server, username AND
    // password (a restore, or the same password typed again): a different
    // password must be verified by the server, never vouched for by a token.
    if (browser && localStorage.getItem(STORAGE_KEYS.TOKEN)) {
      const held = this.heldToken(normalizedUrl, username ?? '');
      const samePassword = !!password && password === localStorage.getItem(STORAGE_KEYS.PASSWORD);
      if (!held || !samePassword) this.dropToken({ revoke: true });
    }
    this.tokenUnsupported.delete(normalizedUrl); // ask the server again at every connect
    this.connecting = {
      serverUrl: normalizedUrl,
      username: username ?? '',
      password: password ?? ''
    };

    try {
      // Dynamically import webdav to reduce initial bundle size
      const { createClient } = await import('webdav');

      // Create WebDAV client with the session's Authorization header: Bearer
      // when a token is held, else UTF-8-safe Basic (the webdav lib's own
      // Basic-auth encoder corrupts non-ASCII credentials).
      this.rawClient = createClient(
        normalizedUrl,
        webdavAuthOptions(username, password, {}, this.sessionAuth().token)
      );
      this.client = this.wrapClient(this.rawClient);
      this.mokuroFolderReady = false;

      // Test connection with timeout (Issue #206 Lesson #3)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      try {
        await this.client.getDirectoryContents('/', { signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }

      this._hasPassword = !!password;

      // Ask the server who we are (mokuro-bunko >= 0.1.4 identity endpoint).
      // Runs BEFORE any write and BEFORE credential persistence so invalid
      // credentials throw without side effects. A bare PROPFIND "succeeds"
      // anonymously on mokuro-bunko, so it cannot detect bad credentials.
      const identity = await this.identify(normalizedUrl, username, password);

      switch (identity.kind) {
        case 'invalid-credentials':
          throw new ProviderError(
            'Invalid username or password',
            'webdav',
            'AUTH_FAILED',
            true,
            false,
            'auth'
          );

        case 'rate-limited':
          throw new ProviderError(
            'Too many failed attempts - try again later',
            'webdav',
            'AUTH_FAILED',
            true,
            true,
            'auth'
          );

        case 'authenticated':
          // bunko >= 0.5.1 trades the password for a bearer token here; older
          // bunko keeps Basic. Before any write, so those go out under it.
          await this.ensureToken(normalizedUrl, username ?? '', password ?? '', identity.endpoint);
          // Permissions come straight from the server - skip OPTIONS guessing
          this._capabilities = identity.permissions;
          // The endpoint answered in bunko's contract shape, so bunko compiles
          // series.json/catalog.json itself and this client must not.
          this._serverCompilesMetadata = true;
          this._serverVersion = identity.serverVersion;
          this._perUserFiles = identity.perUserFiles;
          this._perUserLayers = identity.perUserLayers;
          this.identityAt = Date.now();
          this._isReadOnly = !(
            identity.permissions.canWriteProgress || identity.permissions.canAddFiles
          );
          if (!this._isReadOnly) {
            await this.ensureMokuroFolder();
            // Not a permissions guess (those came from the server above): only
            // "does this server stage and verify PUTs?", which decides whether an
            // upload may replace a file in place.
            await this.probeVerifiedPut(normalizedUrl);
          }
          break;

        case 'anonymous':
          // mokuro-bunko, connected without credentials: read-only by definition
          this._capabilities = {
            canWriteProgress: false,
            canAddFiles: false,
            canModifyDelete: false
          };
          this._isReadOnly = true;
          this._serverCompilesMetadata = true;
          this._serverVersion = identity.serverVersion;
          this._perUserFiles = identity.perUserFiles;
          this._perUserLayers = identity.perUserLayers;
          this.identityAt = Date.now();
          break;

        case 'unsupported':
        default:
          // Generic WebDAV server (or older mokuro-bunko): write access is read
          // from the library folder's Allow (checkWritePermissions)
          this._capabilities = null;

          // Ensure mokuro folder exists
          await this.ensureMokuroFolder();

          // Check write permissions via OPTIONS request
          this._isReadOnly = !(await this.checkWritePermissions(normalizedUrl));
          if (this._isReadOnly) {
            console.log(
              '📖 WebDAV server is read-only (no write privilege or write method allowed)'
            );
          }

          // `fetchServerIdentity` also resolves 'unsupported' when the endpoint
          // is unreachable or flaky. A server that has EVER answered
          // `X-Mokuro-Put: verified` (recorded per server URL, and only
          // mokuro-bunko sends it) is bunko whatever this probe said, and stays
          // a non-producer: demoted, this client would compile series.json /
          // catalog.json itself AND the sidecar backfill would treat it as plain
          // storage — re-uploading a hand-edited primary `.mokuro` over the
          // shared server primary, which every other reader then auto-upgrades
          // to. Any other server is plain storage: this client is its producer
          // (defaulting the other way would leave a plain share with no catalog).
          this._serverCompilesMetadata = this.isKnownBunkoServer(normalizedUrl);
          // A bunko recognised only by its verified PUTs reported no version.
          this._serverVersion = undefined;
          this._perUserFiles = undefined;
          this._perUserLayers = undefined;
          this.identityAt = Date.now();
          break;
      }

      this._needsAttention = false;

      // Store credentials in localStorage (username/password are optional)
      if (browser) {
        localStorage.setItem(STORAGE_KEYS.SERVER_URL, normalizedUrl);
        if (username) {
          localStorage.setItem(STORAGE_KEYS.USERNAME, username);
        } else {
          localStorage.removeItem(STORAGE_KEYS.USERNAME);
        }
        if (password) {
          localStorage.setItem(STORAGE_KEYS.PASSWORD, password);
        } else {
          localStorage.removeItem(STORAGE_KEYS.PASSWORD);
        }
      }

      // Set the active provider key for lazy loading on next startup
      setActiveProviderKey('webdav');
      console.log('✅ WebDAV login successful');
    } catch (error) {
      this.client = null;
      this.rawClient = null;
      this.mokuroFolderReady = false;

      // AUTH_FAILED from the identity check is already fully classified and
      // must not be re-wrapped as generic LOGIN_FAILED. Every other error
      // (including ensureMokuroFolder's FOLDER_ERROR) falls through to the
      // message-based classifier below, exactly as on the pre-identity path,
      // so the modal type and restore handling keep their legacy behavior.
      if (error instanceof ProviderError && error.code === 'AUTH_FAILED') {
        throw error;
      }

      // A held token refused while its re-issue was rate limited or could not
      // reach the server: retryable, and NOT a credential rejection — the
      // stored password must survive the restore (M-6), so this never goes
      // through the message classifier below.
      if (isTransientAuthRefreshError(error)) {
        throw new ProviderError(error.message, 'webdav', 'LOGIN_FAILED', false, true, 'network');
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Classify error type for detailed modal guidance
      // CORS, SSL, and DNS errors all appear as opaque network errors from fetch()
      // Browser shows "Failed to fetch" or "NetworkError" - specific cause only visible in DevTools console
      const isOpaqueNetworkError =
        (errorMessage.includes('Failed to fetch') ||
          errorMessage.includes('NetworkError') ||
          errorMessage.includes('Network request failed') ||
          errorMessage.includes('Load failed')) &&
        !errorMessage.includes('401') &&
        !errorMessage.includes('403') &&
        !errorMessage.includes('404') &&
        !errorMessage.includes('timeout') &&
        !errorMessage.includes('abort');

      const isAuthError =
        errorMessage.includes('401') ||
        errorMessage.includes('403') ||
        errorMessage.includes('Unauthorized') ||
        errorMessage.includes('Forbidden');

      const isConnectionError =
        errorMessage.includes('404') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('abort') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('ECONNREFUSED');

      // Determine error type and user message
      let userMessage = errorMessage;
      let webdavErrorType: import('../../provider-interface').WebDAVErrorType = 'unknown';

      if (isOpaqueNetworkError) {
        userMessage = 'Network error - check browser console (F12) for details';
        webdavErrorType = 'network';
      } else if (isAuthError) {
        userMessage = 'Authentication failed - check your credentials';
        webdavErrorType = 'auth';
      } else if (isConnectionError) {
        userMessage = 'Could not connect to server';
        webdavErrorType = 'connection';
      }

      throw new ProviderError(
        userMessage,
        'webdav',
        'LOGIN_FAILED',
        isAuthError,
        isConnectionError || isOpaqueNetworkError,
        webdavErrorType
      );
    } finally {
      this.connecting = null;
    }
  }

  async logout(): Promise<void> {
    this.endIdentitySession();
    this.client = null;
    this.rawClient = null;
    this.mokuroFolderReady = false;
    this._supportsDepthInfinity = null; // Reset for next connection (may be different server)
    this._capabilities = null;
    this._serverCompilesMetadata = false;
    this._serverVersion = undefined;
    this._perUserFiles = undefined;
    this._perUserLayers = undefined;
    this.controlReads.clear();
    this._hasPassword = false;
    this._needsAttention = false; // Deliberate logout - nothing to flag

    if (browser) {
      // Keep URL and username for convenience (Issue #206 Lesson #10)
      // Only clear the password for security
      localStorage.removeItem(STORAGE_KEYS.PASSWORD);
      // Sign the token out on its server (best effort), then forget it.
      this.dropToken({ revoke: true });
    }

    // Clear the active provider key
    clearActiveProviderKey();
    console.log('WebDAV logged out');
  }

  /**
   * Get the last used server URL (for pre-filling login form)
   */
  getLastServerUrl(): string | null {
    return browser ? localStorage.getItem(STORAGE_KEYS.SERVER_URL) : null;
  }

  /**
   * Get the last used username (for pre-filling login form)
   */
  getLastUsername(): string | null {
    return browser ? localStorage.getItem(STORAGE_KEYS.USERNAME) : null;
  }

  /**
   * Clear all stored credentials (for full logout)
   */
  clearAllCredentials(): void {
    this._supportsDepthInfinity = null; // Reset for next connection
    if (browser) {
      localStorage.removeItem(STORAGE_KEYS.SERVER_URL);
      localStorage.removeItem(STORAGE_KEYS.USERNAME);
      localStorage.removeItem(STORAGE_KEYS.PASSWORD);
      localStorage.removeItem(STORAGE_KEYS.PUT_VERIFIED);
      this.dropToken({ revoke: true });
    }
  }

  private async loadPersistedCredentials(): Promise<void> {
    if (!browser || typeof localStorage === 'undefined') return;

    const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
    const username = localStorage.getItem(STORAGE_KEYS.USERNAME);
    const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);

    // Use active_cloud_provider to determine if we should restore
    // This properly handles anonymous connections (no password) vs logged out state
    const activeProvider = localStorage.getItem('active_cloud_provider');
    const shouldRestore = activeProvider === 'webdav' && serverUrl;

    if (!shouldRestore) return;

    // A stored username WITHOUT a password marks a previously auth-failed
    // session (the password was cleared). Leave it logged out and flag for
    // re-login — never silently reconnect anonymously, which would hide that
    // sync has stopped. URL + username remain stored so the form pre-fills.
    if (username && !password) {
      this.setNeedsAttention();
      console.log('WebDAV session needs re-login (stored password was cleared)');
      return;
    }

    try {
      await this.login({
        serverUrl,
        username: username || undefined,
        password: password || undefined
      });
      console.log('Restored WebDAV session from stored credentials');
    } catch (error) {
      // Branch on the typed error - never on message substrings.
      // Retryable errors (isNetworkError, e.g. a rate-limited 429 from the
      // identity check) are NOT credential rejection: the stored password may
      // be perfectly valid while the server-side limiter is hot (shared NAT
      // being brute-forced, the user's own other tab), so it must survive
      // for a later retry (M-6).
      const isAuthFailure =
        error instanceof ProviderError &&
        !error.isNetworkError &&
        (error.code === 'AUTH_FAILED' || error.webdavErrorType === 'auth');

      if (isAuthFailure) {
        // Stale credentials: clear ONLY the password (keep server URL +
        // username, keep the provider active) so the UI prompts a re-login
        // instead of silently dropping the whole configuration. Do NOT
        // reconnect anonymously — a silent read-only fallback hides that
        // sync has stopped; leave the session logged out and flagged.
        console.error('WebDAV credentials rejected, clearing stored password');
        localStorage.removeItem(STORAGE_KEYS.PASSWORD);
        this.dropToken();
        this.setNeedsAttention();
      } else {
        // Temporary error - keep credentials for retry later
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(
          'Failed to restore WebDAV session (temporary error), will retry on next sync:',
          errorMessage
        );
      }
    }
  }

  /**
   * Make sure the reader folder exists. `recheck` ignores the session latch:
   * a listing always asks the server, so a folder deleted there is made again
   * (the latch only spares the upload path a PROPFIND per file).
   */
  private async ensureMokuroFolder(recheck = false): Promise<void> {
    if (!this.client) return;
    if (this.mokuroFolderReady && !recheck) return;

    try {
      const exists = await this.client.exists(MOKURO_FOLDER);

      if (!exists) {
        await this.client.createDirectory(MOKURO_FOLDER);
        console.log('Created mokuro-reader folder in WebDAV');
      }
      this.mokuroFolderReady = true;
    } catch (error) {
      throw new ProviderError(
        `Failed to ensure mokuro folder exists: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'webdav',
        'FOLDER_ERROR'
      );
    }
  }

  /**
   * Check if the server allows write operations
   * Returns true if write is allowed (or if we can't determine)
   *
   * Uses tiered approach:
   * 1. Try PROPFIND with DAV:current-user-privilege-set (most accurate for ACL-enabled servers)
   * 2. Fall back to OPTIONS request to check Allow header for a collection
   *    write method (`COLLECTION_WRITE_METHODS`)
   * 3. If both are inconclusive → assume write access
   * 4. Actual write operations will mark as read-only if they fail with permission errors
   *
   * Runs only when the identity endpoint gave no answer (`unsupported`: a
   * generic server, or a `/login/api/me` that was unreachable or not bunko's
   * shape). Any answer from it, anonymous or rate limited included, decides
   * without this guess.
   *
   * A server known to be mokuro-bunko skips the verdict: bunko decides each
   * request itself, so neither its privilege set nor its Allow speaks for the
   * account. A real refusal still demotes through handleWriteFailure.
   */
  private async checkWritePermissions(baseUrl: string): Promise<boolean> {
    if (this.isKnownBunkoServer(baseUrl)) return true;
    const url = `${baseUrl}${MOKURO_FOLDER}/`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/xml',
      // The session's header (Bearer > UTF-8-safe Basic > none)
      ...webdavAuthHeaders(this.sessionAuth())
    };

    // Try PROPFIND with current-user-privilege-set first (RFC 3744 - WebDAV ACL)
    try {
      console.log('[WebDAV] Checking user privileges via PROPFIND for:', url);

      const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:current-user-privilege-set/>
  </D:prop>
</D:propfind>`;

      const response = await fetchWithRetryAfter(fetch, url, {
        method: 'PROPFIND',
        headers: {
          ...headers,
          Depth: '0'
        },
        body: propfindBody
      });

      console.log('[WebDAV] PROPFIND response status:', response.status);

      if (response.ok || response.status === 207) {
        const text = await response.text();
        console.log('[WebDAV] PROPFIND response:', text.substring(0, 500));

        // Check if the property returned 404 (server doesn't support ACL extension)
        // This is different from having no privileges - it means we can't determine from PROPFIND
        if (text.includes('current-user-privilege-set') && text.includes('404')) {
          console.log(
            '[WebDAV] Server does not support ACL (current-user-privilege-set returned 404), falling back to OPTIONS'
          );
          // Fall through to OPTIONS check
        } else {
          // Server supports ACL - check for actual privileges
          // Look for privilege elements like <D:write/>, <D:read/>, <D:all/>, etc.
          const hasWritePrivilege = WRITE_PRIVILEGE_RE.test(text);

          const hasReadPrivilege =
            text.includes('<D:read') || text.includes('<read') || text.includes(':read/>');

          // Only consider read-only if we found privileges and read is present but write is not
          if (hasReadPrivilege && !hasWritePrivilege) {
            console.log(
              '[WebDAV] PROPFIND indicates read-only access (has read but no write privileges)'
            );
            return false;
          }

          if (hasWritePrivilege) {
            console.log('[WebDAV] PROPFIND confirms write access');
            return true;
          }

          // If we got a response but couldn't parse privileges clearly, fall through to OPTIONS
          console.log('[WebDAV] PROPFIND response unclear, falling back to OPTIONS');
        }
      }
    } catch (error) {
      console.log('[WebDAV] PROPFIND failed, falling back to OPTIONS:', error);
    }

    // Fall back to OPTIONS request
    try {
      console.log('[WebDAV] Checking write permissions via OPTIONS for:', url);

      const response = await fetchWithRetryAfter(fetch, url, {
        method: 'OPTIONS',
        headers: headers['Authorization'] ? { Authorization: headers['Authorization'] } : {}
      });

      console.log('[WebDAV] OPTIONS response status:', response.status);
      const putHeader = response.headers.get('X-Mokuro-Put');
      this.noteVerifiedPutHeader(putHeader, baseUrl);
      // Only mokuro-bunko sends it: a known bunko skips the verdict (see above).
      if (isVerifiedPutHeader(putHeader)) return true;

      if (!response.ok) {
        // If OPTIONS fails, assume full access (fail open for usability)
        console.warn('[WebDAV] OPTIONS request failed, assuming full write access');
        return true;
      }

      const allowHeader = response.headers.get('Allow');
      console.log('[WebDAV] Allow header:', allowHeader);

      // Not all servers send Allow on OPTIONS, and a cross-origin page sees it
      // only when the server exposes it: absent or empty, assume full access.
      const permitsWrite = allowHeaderPermitsCollectionWrite(allowHeader);
      if (permitsWrite === null) {
        console.log('[WebDAV] No usable Allow header, assuming full write access');
        return true;
      }

      console.log(`[WebDAV] Allow lists a collection write method: ${permitsWrite}`);
      return permitsWrite;
    } catch (error) {
      // If we can't check, assume full access (fail open for usability)
      console.warn('[WebDAV] Failed to check write permissions:', error);
      return true;
    }
  }

  // GENERIC FILE OPERATIONS

  async listCloudVolumes(): Promise<import('../../provider-interface').CloudFileMetadata[]> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    try {
      // Ensure mokuro folder exists first — asked for real on every listing
      await this.ensureMokuroFolder(true);

      const client = this.client;

      // Try Depth: infinity first if we haven't determined it's unsupported
      // Only use depth infinity on mokuro-reader folder (not root) for performance + safety
      if (this._supportsDepthInfinity !== false) {
        try {
          const files = await this.listWithDepthInfinity(client);
          // Success - server supports depth infinity
          if (this._supportsDepthInfinity === null) {
            console.log('[WebDAV] Server supports Depth: infinity - using fast listing');
            this._supportsDepthInfinity = true;
          }
          console.log(`✅ Listed ${files.length} files from WebDAV (depth infinity)`);
          return files;
        } catch (error) {
          // Depth infinity not supported - fall back to recursive
          const errorMessage = error instanceof Error ? error.message : String(error);
          // 403 Forbidden, 400 Bad Request, or specific "depth infinity" errors indicate no support
          const isDepthInfinityError =
            errorMessage.includes('403') ||
            errorMessage.includes('400') ||
            errorMessage.includes('infinity') ||
            errorMessage.includes('Depth') ||
            errorMessage.includes('propfind');

          if (isDepthInfinityError && this._supportsDepthInfinity === null) {
            console.log(
              '[WebDAV] Server does not support Depth: infinity - falling back to recursive listing'
            );
            this._supportsDepthInfinity = false;
          } else if (this._supportsDepthInfinity === null) {
            // Unknown error on first try - still fall back but don't cache the result
            console.warn(
              '[WebDAV] Depth: infinity failed with unexpected error, trying recursive:',
              errorMessage
            );
          } else {
            // Re-throw if we thought it was supported but it failed
            throw error;
          }
        }
      }

      // Fall back to manual recursive folder traversal
      const allFiles: import('../../provider-interface').CloudFileMetadata[] = [];

      const processFolder = async (folderPath: string): Promise<void> => {
        const contents = (await client.getDirectoryContents(folderPath)) as Array<{
          type: string;
          filename: string;
          basename: string;
          lastmod: string;
          size: number;
          etag?: string | null;
        }>;

        for (const item of contents) {
          if (item.type === 'directory') {
            // Recurse into subdirectories
            await processFolder(item.filename);
          } else {
            // Include CBZ files, sidecars, JSON config files and reading
            // history — judged by the path RELATIVE to the mokuro folder,
            // since history is recognised by its folders, not its basename.
            const relativePath = item.filename.replace(MOKURO_FOLDER + '/', '');
            if (isSyncableFile(relativePath)) {
              allFiles.push({
                provider: 'webdav',
                fileId: item.filename, // Full WebDAV path as fileId
                path: relativePath,
                modifiedTime: item.lastmod || new Date().toISOString(),
                size: item.size || 0,
                ...etagFields(item.etag)
              });
            }
          }
        }
      };

      await processFolder(MOKURO_FOLDER);

      console.log(`✅ Listed ${allFiles.length} files from WebDAV (recursive)`);
      return allFiles;
    } catch (error) {
      const refused = this.refusedReadAuth(error);
      if (refused) throw refused;
      throw new ProviderError(
        `Failed to list cloud volumes: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'webdav',
        'LIST_FAILED',
        false,
        true
      );
    }
  }

  /**
   * List all files using Depth: infinity PROPFIND (single request)
   * Only used on mokuro-reader folder, not root, for performance and safety
   */
  private async listWithDepthInfinity(
    client: WebDAVClient
  ): Promise<import('../../provider-interface').CloudFileMetadata[]> {
    // Use deep option which sets Depth: infinity
    const contents = (await client.getDirectoryContents(MOKURO_FOLDER, {
      deep: true
    })) as Array<{
      type: string;
      filename: string;
      basename: string;
      lastmod: string;
      size: number;
      etag?: string | null;
    }>;

    const allFiles: import('../../provider-interface').CloudFileMetadata[] = [];

    for (const item of contents) {
      if (item.type === 'file') {
        // Include CBZ files, sidecars, JSON config files and reading history
        // (judged by the relative path — see the recursive listing).
        const relativePath = item.filename.replace(MOKURO_FOLDER + '/', '');
        if (isSyncableFile(relativePath)) {
          allFiles.push({
            provider: 'webdav',
            fileId: item.filename, // Full WebDAV path as fileId
            path: relativePath,
            modifiedTime: item.lastmod || new Date().toISOString(),
            size: item.size || 0,
            ...etagFields(item.etag)
          });
        }
      }
    }

    return allFiles;
  }

  async uploadFile(
    path: string,
    blob: Blob,
    description?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<UploadFileResult> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    try {
      await this.ensureMokuroFolder();

      const pathParts = path.split('/');
      const filename = pathParts.pop() || path;
      const seriesTitle = pathParts.join('/');

      const credentials = await this.getWorkerUploadCredentials();
      const uploaded = await this.cloudCore.uploadFile({
        seriesTitle,
        filename,
        blob,
        credentials,
        onProgress,
        refreshAuth: (stale) => this.refreshedWorkerCredentials(stale)
      });

      console.log(`✅ Uploaded ${path} to WebDAV`);
      if (uploaded.serverPutVerified) this.notePutVerified();
      // The receipt is the PUT response's own ETag or nothing. Never a stat
      // after the PUT: another device's write landing in between would bind
      // OUR bytes to THEIR revision, and the read memo would then call their
      // file unchanged (`root-file-memo.ts`). Without an ETag the memo drops
      // the file, and the next read downloads it once.
      return uploaded;
    } catch (error) {
      // The folder may be what failed: ask again next time.
      this.mokuroFolderReady = false;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Compiled metadata files are best-effort: a server that compiles them
      // itself (mokuro-bunko) rejects the write by design, and that says
      // nothing about progress sync or archive uploads. Demoting the provider
      // here would hide backup and upload for a perfectly writable account.
      if (!isBestEffortMetadataPath(path)) {
        const kind = classifyWriteError(errorMessage);
        if (kind === 'permission' && isReservedLayerSidecarPath(path)) {
          throw reservedLayerRefusal(path);
        }
        const refusal = this.ownershipRefusal(kind, path, error);
        if (refusal) throw refusal;
        if (kind !== 'other') {
          this.handleWriteFailure(kind, 'Write permission denied - server is read-only');
        }
      }

      throw new ProviderError(
        `Failed to upload file: ${errorMessage}`,
        'webdav',
        'UPLOAD_FAILED',
        false,
        true,
        'unknown'
      );
    }
  }

  /**
   * Ensure a series folder exists under mokuro-reader
   */
  private async ensureSeriesFolder(folderPath: string): Promise<void> {
    if (!this.client) return;

    const fullPath = `${MOKURO_FOLDER}/${folderPath}`;
    try {
      const exists = await this.client.exists(fullPath);
      if (!exists) {
        await this.client.createDirectory(fullPath, { recursive: true });
        console.log(`Created series folder: ${folderPath}`);
      }
    } catch (error) {
      // Some servers throw if directory already exists, ignore that
      const errorMessage = error instanceof Error ? error.message : '';
      if (!errorMessage.includes('405') && !errorMessage.includes('already exists')) {
        throw error;
      }
    }
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
   * therefore return the SERVER'S fresh timestamp, not the cached one. A
   * WebDAV MOVE carries no such signal back, so preserving the cached
   * `modifiedTime` here (rather than fabricating a new one from the client
   * clock) is the correct trade: the cached record and the next real listing
   * then disagree by exactly one rename's worth of nothing, which
   * self-corrects on the next fetch instead of poisoning `series.json` with
   * a client-clock stamp.
   */
  private buildWebDAVFileMetadata(
    file: CloudFileMetadata,
    path: string,
    modifiedTime: string,
    modifiedTimeProvisional?: boolean
  ): CloudFileMetadata {
    const result: CloudFileMetadata = {
      ...file,
      fileId: `${MOKURO_FOLDER}/${path}`,
      path,
      modifiedTime
    };
    if (modifiedTimeProvisional) {
      result.modifiedTimeProvisional = true;
    } else {
      delete result.modifiedTimeProvisional;
    }
    return result;
  }

  /** bunko >= 0.8: series owners are recorded, and a 403 may be ownership. */
  private enforcesSeriesOwners(): boolean {
    return this._capabilities?.addFiles !== undefined;
  }

  /**
   * A 403 on a library file from a bunko enforcing series owners: that file's
   * refusal (`libraryFileRefusal`), and the identity is asked again (throttled)
   * so a series that closed since login stops being offered. Null otherwise.
   */
  private ownershipRefusal(
    kind: WriteErrorKind,
    path: string,
    error: unknown
  ): ProviderError | null {
    if (kind !== 'permission' || !this.enforcesSeriesOwners() || !isLibraryFilePath(path)) {
      return null;
    }
    void this.refreshIdentity({ maxAgeMs: OWNERSHIP_REFRESH_MAX_AGE_MS });
    return libraryFileRefusal(path, error);
  }

  /**
   * A read refused 401 in a password-backed session: the server no longer takes the
   * password (changed elsewhere, an app password revoked). The same auth-failed
   * flow as a refused write: a sync reads before it writes, so an idle device would
   * otherwise fail every sync with a retryable read error and never ask for a new
   * sign-in. A transient re-issue failure says nothing about the password, and a
   * credential-less session has none to reject. Null when it is not that.
   */
  private refusedReadAuth(error: unknown): ProviderError | null {
    if (!this._hasPassword || isTransientAuthRefreshError(error)) return null;
    const message = error instanceof Error ? error.message : String(error);
    if (!isUnauthorized(error) && classifyWriteError(message) !== 'auth') return null;
    this.markAuthFailed();
    return new ProviderError(
      'Authentication failed - please sign in again',
      'webdav',
      'AUTH_FAILED',
      true,
      false,
      'auth'
    );
  }

  /**
   * Central policy for failed write operations:
   * - 401 with a password-backed session: credentials were rejected -> clear
   *   the stored password and prompt re-login (NOT a read-only server)
   * - 403 when the server told us we CAN write progress: an isolated
   *   permission error (e.g. library upload as a registered user) -> clear
   *   message, but do NOT demote to read-only (that would hide progress sync)
   * - everything else (405, 403 on unknown/low capabilities, 401 on a
   *   credential-less session): legacy behavior - mark read-only
   * Decided BEFORE this policy, by the callers: a 403 on a reserved layer file
   * (`reservedLayerRefusal`) and, from a bunko reporting `addFiles`, a 403 on
   * a library file (`ownershipRefusal`) are that one file's refusal.
   */
  private handleWriteFailure(
    kind: WriteErrorKind,
    readOnlyMessage: string,
    permissionMessage = 'Your account does not have permission for this operation on this server'
  ): never {
    if (kind === 'auth' && this._hasPassword) {
      this.markAuthFailed();
      throw new ProviderError(
        'Authentication failed - please sign in again',
        'webdav',
        'AUTH_FAILED',
        true,
        false,
        'auth'
      );
    }

    if (kind === 'permission' && this._capabilities?.canWriteProgress === true) {
      throw new ProviderError(
        permissionMessage,
        'webdav',
        'PERMISSION_DENIED',
        false,
        false,
        'permission'
      );
    }

    this.markAsReadOnly();
    throw new ProviderError(
      readOnlyMessage,
      'webdav',
      'PERMISSION_DENIED',
      false,
      false,
      'permission'
    );
  }

  async downloadFile(
    file: import('../../provider-interface').CloudFileMetadata,
    onProgress?: (loaded: number, total: number) => void,
    options?: DownloadOptions
  ): Promise<Blob> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    try {
      const credentials = await this.getWorkerDownloadCredentials(file.fileId);
      const arrayBuffer = await this.cloudCore.downloadFile({
        fileId: file.fileId,
        credentials,
        onProgress: onProgress || (() => {}),
        refreshAuth: (stale) => this.refreshedWorkerCredentials(stale),
        ...(options?.knownSize ? { expectedSize: options.knownSize } : {})
      });
      const blob = new Blob([arrayBuffer], { type: 'application/zip' });
      console.log(`✅ Downloaded ${file.path} from WebDAV`);
      return blob;
    } catch (error) {
      const refused = this.refusedReadAuth(error);
      if (refused) throw refused;
      throw new ProviderError(
        `Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'webdav',
        'DOWNLOAD_FAILED',
        false,
        true
      );
    }
  }

  /**
   * Read `<server>/mokuro-reader/<name>` with ONE conditional GET (the server
   * does the version check: `If-None-Match` with the previous read's ETag).
   * 304 -> 'not-modified', 404 -> null, 200 -> a single node.
   */
  async readControlFile(name: string, opts?: { ifNoneMatch?: string }): Promise<ControlFileResult> {
    const account = this.sessionAccount();
    if (!this.isAuthenticated() || !account) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }
    const base = stripUrlUserinfo(account.serverUrl).replace(/\/$/, '');
    const url = `${base}${MOKURO_FOLDER}/${encodeURIComponent(name)}`;
    const previous = this.controlReads.get(name);
    const conditional =
      previous !== undefined &&
      opts?.ifNoneMatch !== undefined &&
      opts.ifNoneMatch === previous.setEtag;

    const request = async (): Promise<{ response: Response; sent: string | null }> => {
      const sent = this.authorizationHeader();
      const headers: Record<string, string> = webdavAuthHeaders(this.sessionAuth());
      if (conditional) headers['If-None-Match'] = previous.serverEtag;
      try {
        // bunko's lease fence answers the marker itself 503 + Retry-After.
        const response = await fetchWithRetryAfter(fetch, url, {
          method: 'GET',
          headers,
          cache: 'no-store'
        });
        return { response, sent };
      } catch (error) {
        throw new ProviderError(
          `Failed to read ${name}: ${error instanceof Error ? error.message : 'Network error'}`,
          'webdav',
          'READ_FAILED',
          false,
          true
        );
      }
    };

    let { response, sent } = await request();
    let reissue: ReissueVerdict | null = null;
    if (response.status === 401 && bearerOf(sent)) {
      reissue = await this.reissueVerdict(sent);
      if (reissue === 'retry') ({ response, sent } = await request()); // once, under the re-issued header
    }

    if (response.status === 304 && conditional) return 'not-modified';
    if (response.status === 404) {
      this.controlReads.delete(name);
      return null;
    }
    if (response.status === 401 && reissue !== 'transient') {
      const refused = this.refusedReadAuth({ status: 401 });
      if (refused) throw refused;
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(
        `WebDAV refused reading ${name} (${response.status})`,
        'webdav',
        'AUTH_FAILED',
        true
      );
    }
    if (!response.ok) {
      throw new ProviderError(
        `Failed to read ${name}: HTTP ${response.status}`,
        'webdav',
        'READ_FAILED',
        false,
        response.status >= 500
      );
    }

    const blob = await response.blob();
    const lastModified = response.headers.get('Last-Modified');
    const serverEtag =
      response.headers.get('ETag') || lastModified || (await bodyFingerprint(blob));
    const etag = controlSetEtag([{ id: url, etag: serverEtag }]);
    this.controlReads.set(name, { setEtag: etag, serverEtag });
    // A server that ignored the conditional still answers 'unchanged' honestly.
    if (opts?.ifNoneMatch !== undefined && opts.ifNoneMatch === etag) return 'not-modified';
    const modifiedMs = lastModified ? Date.parse(lastModified) : NaN;
    return {
      nodes: [
        {
          id: url,
          etag: serverEtag,
          ...(Number.isFinite(modifiedMs) ? { modified: new Date(modifiedMs).toISOString() } : {}),
          blob
        }
      ],
      etag
    };
  }

  /**
   * The quick tier's listing of one subtree (`<mokuro folder>/<folder>`), by
   * the same strategy and entry shape as `listCloudVolumes`: one
   * `Depth: infinity` PROPFIND where the server allows it, else a walk.
   */
  async listFolder(
    folder: string
  ): Promise<import('../../provider-interface').CloudFileMetadata[]> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }
    const client = this.client;
    const base = `${MOKURO_FOLDER}/${folder.replace(/^\/+|\/+$/g, '')}`;
    type Item = {
      type: string;
      filename: string;
      lastmod: string;
      size: number;
      etag?: string | null;
    };
    const out: import('../../provider-interface').CloudFileMetadata[] = [];
    const take = (item: Item) => {
      if (item.type !== 'file') return;
      const relativePath = item.filename.replace(MOKURO_FOLDER + '/', '');
      if (!isSyncableFile(relativePath)) return;
      out.push({
        provider: 'webdav',
        fileId: item.filename,
        path: relativePath,
        modifiedTime: item.lastmod || new Date().toISOString(),
        size: item.size || 0,
        ...etagFields(item.etag)
      });
    };
    const walk = async (path: string): Promise<void> => {
      for (const item of (await client.getDirectoryContents(path)) as Item[]) {
        if (item.type === 'directory') await walk(item.filename);
        else take(item);
      }
    };
    try {
      if (this._supportsDepthInfinity !== false) {
        try {
          const items = (await client.getDirectoryContents(base, { deep: true })) as Item[];
          items.forEach(take);
          return out;
        } catch (error) {
          if ((error as { status?: number })?.status === 404) return [];
          out.length = 0; // fall back to the walk
        }
      }
      await walk(base);
      return out;
    } catch (error) {
      if ((error as { status?: number })?.status === 404) return [];
      const refused = this.refusedReadAuth(error);
      if (refused) throw refused;
      throw error;
    }
  }

  /**
   * `SyncProvider.statFile`: one PROPFIND Depth 0 of the file (`client.stat`)
   * — headers every WebDAV CORS allow-list already admits, never an
   * `If-None-Match`. `getetag` is the revision.
   */
  async statFile(file: CloudFileMetadata): Promise<FileStamp | null> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }
    try {
      const stat = (await this.client.stat(file.fileId)) as {
        type: string;
        lastmod: string;
        size: number;
        etag?: string | null;
      };
      if (stat.type !== 'file') return null;
      return {
        size: stat.size || 0,
        modifiedTime: stat.lastmod,
        ...(stat.etag ? { revision: stat.etag } : {})
      };
    } catch (error) {
      if ((error as { status?: number })?.status === 404) return null;
      const refused = this.refusedReadAuth(error);
      if (refused) throw refused;
      throw error;
    }
  }

  /** The cold probe's read: `<mokuro folder>/<name>` by path, no listing. */
  async readRootFileCopies(name: string): Promise<Blob[]> {
    try {
      const blob = await this.downloadFile({
        provider: 'webdav',
        fileId: `${MOKURO_FOLDER}/${name}`,
        path: name,
        modifiedTime: '',
        size: 0
      });
      return [blob];
    } catch (error) {
      // webdav-core reports the status in its message ("… failed: 404 …").
      if (error instanceof Error && /\b404\b/.test(error.message)) return [];
      throw error;
    }
  }

  async deleteFile(file: import('../../provider-interface').CloudFileMetadata): Promise<void> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    try {
      // For WebDAV, fileId is the full path
      await this.client.deleteFile(file.fileId);
      console.log(`✅ Deleted ${file.path} from WebDAV`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Typed NOT_FOUND at the boundary where the status is unambiguous about
      // THIS operation's target — the shared layer relies on the code (never
      // message text) to treat an already-gone delete target as converged.
      if ((error as { status?: number })?.status === 404) {
        throw new ProviderError(`File not found: ${file.path}`, 'webdav', 'NOT_FOUND');
      }

      // Same best-effort contract as uploadFile: cleanupSeriesFileIfFolderEmptied()
      // and moveSeriesFileAfterRename() DELETE `<Series>/series.json`, which a
      // server that compiles it rejects by design. The callers swallow the throw,
      // so an unguarded demotion here would flip the provider read-only silently.
      if (!isBestEffortMetadataPath(file.path)) {
        const kind = classifyWriteError(errorMessage);
        if (kind === 'permission' && isReservedLayerSidecarPath(file.path)) {
          throw reservedLayerRefusal(file.path);
        }
        const refusal = this.ownershipRefusal(kind, file.path, error);
        if (refusal) throw refusal;
        if (kind !== 'other') {
          this.handleWriteFailure(kind, 'Delete permission denied - server is read-only');
        }
      }

      throw new ProviderError(
        `Failed to delete file: ${errorMessage}`,
        'webdav',
        'DELETE_FAILED',
        false,
        true,
        'unknown'
      );
    }
  }

  async renameFile(file: CloudFileMetadata, newPath: string): Promise<CloudFileMetadata> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    const normalizedNewPath = newPath.replace(/^\/+|\/+$/g, '');
    if (file.path === normalizedNewPath) {
      return file;
    }

    const newPathParts = normalizedNewPath.split('/');
    newPathParts.pop();
    const destinationFolder = newPathParts.join('/');
    const destinationFullPath = `${MOKURO_FOLDER}/${normalizedNewPath}`;

    try {
      if (destinationFolder) {
        await this.ensureSeriesFolder(destinationFolder);
      } else {
        await this.ensureMokuroFolder();
      }

      if (await this.client.exists(destinationFullPath)) {
        // Idempotent retry: if our source is gone AND the occupant matches the
        // source's recorded size, a prior attempt moved it here — treat as
        // success. Drive/MEGA verify this case by file identity (id/nodeId);
        // WebDAV has no stable ids across moves, so size is the closest
        // identity proxy. Anything else — source still present, or an
        // occupant we can't match to the source — is a genuine conflict and
        // throws before any mutation.
        if (!(await this.client.exists(file.fileId))) {
          const destStat = await this.client.stat(destinationFullPath);
          const destSize = (
            'data' in (destStat as object)
              ? (destStat as { data: { size?: number } }).data
              : (destStat as { size?: number })
          )?.size;
          if (typeof file.size === 'number' && destSize === file.size) {
            console.log(`↩️ ${normalizedNewPath} already at destination (idempotent retry)`);
            return this.buildWebDAVFileMetadata(
              file,
              normalizedNewPath,
              file.modifiedTime,
              file.modifiedTimeProvisional
            );
          }
        }
        throw new ProviderError(
          `Target file already exists at '${normalizedNewPath}'`,
          'webdav',
          'TARGET_EXISTS'
        );
      }

      await this.client.moveFile(file.fileId, destinationFullPath, { overwrite: false });
      console.log(`✅ Renamed ${file.path} to ${normalizedNewPath} in WebDAV`);
      return this.buildWebDAVFileMetadata(
        file,
        normalizedNewPath,
        file.modifiedTime,
        file.modifiedTimeProvisional
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      // Typed NOT_FOUND: the destination was verified absent above, so a 404
      // from the MOVE means the source is gone — a genuine failure the shared
      // layer must see as such (never "already moved").
      if ((error as { status?: number })?.status === 404) {
        throw new ProviderError(`File not found: ${file.path}`, 'webdav', 'NOT_FOUND');
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const kind = classifyWriteError(errorMessage);
      if (kind !== 'other') {
        this.handleWriteFailure(
          kind,
          'Rename permission denied - server is read-only',
          CANNOT_RENAME_MESSAGE
        );
      }

      throw new ProviderError(
        `Failed to rename file: ${errorMessage}`,
        'webdav',
        'RENAME_FAILED',
        false,
        true,
        'unknown'
      );
    }
  }

  async renameFolder(oldPath: string, newPath: string): Promise<CloudFileMetadata[]> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    const normalizedOldPath = oldPath.replace(/^\/+|\/+$/g, '');
    const normalizedNewPath = newPath.replace(/^\/+|\/+$/g, '');
    if (normalizedOldPath === normalizedNewPath) {
      const allFiles = await this.listCloudVolumes();
      return allFiles.filter((file) => file.path.startsWith(`${normalizedOldPath}/`));
    }

    const sourceFullPath = `${MOKURO_FOLDER}/${normalizedOldPath}`;
    const destinationFullPath = `${MOKURO_FOLDER}/${normalizedNewPath}`;
    const renamedFiles = (await this.listCloudVolumes())
      .filter((file) => file.path.startsWith(`${normalizedOldPath}/`))
      .map((file) =>
        this.buildWebDAVFileMetadata(
          file,
          `${normalizedNewPath}${file.path.slice(normalizedOldPath.length)}`,
          file.modifiedTime,
          file.modifiedTimeProvisional
        )
      );

    try {
      const newPathParts = normalizedNewPath.split('/');
      newPathParts.pop();
      const destinationParent = newPathParts.join('/');
      if (destinationParent) {
        await this.ensureSeriesFolder(destinationParent);
      } else {
        await this.ensureMokuroFolder();
      }

      if (await this.client.exists(destinationFullPath)) {
        throw new ProviderError(
          `Target series folder already exists at '${normalizedNewPath}'`,
          'webdav',
          'TARGET_EXISTS'
        );
      }

      await this.client.moveFile(sourceFullPath, destinationFullPath, { overwrite: false });
      console.log(
        `✅ Renamed series folder ${normalizedOldPath} to ${normalizedNewPath} in WebDAV`
      );
      return renamedFiles;
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const kind = classifyWriteError(errorMessage);
      if (kind !== 'other') {
        this.handleWriteFailure(
          kind,
          'Rename permission denied - server is read-only',
          CANNOT_RENAME_MESSAGE
        );
      }

      throw new ProviderError(
        `Failed to rename series folder: ${errorMessage}`,
        'webdav',
        'RENAME_FAILED',
        false,
        true,
        'unknown'
      );
    }
  }

  async deleteSeriesFolder(seriesTitle: string): Promise<void> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    const normalizedSeriesTitle = seriesTitle.replace(/^\/+|\/+$/g, '');
    if (!normalizedSeriesTitle) return;

    const folderPath = `${MOKURO_FOLDER}/${normalizedSeriesTitle}`;

    try {
      const exists = await this.client.exists(folderPath);
      if (!exists) {
        console.log(`Series folder '${seriesTitle}' not found in WebDAV`);
        return;
      }

      // Prefer one collection DELETE request when supported by the server.
      await this.client.deleteFile(folderPath);
      console.log(`✅ Deleted series folder '${seriesTitle}' from WebDAV`);
      return;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // 401 goes through the central write-failure policy; 405/409 fall
      // through to the per-file deletion fallback below (unchanged behavior).
      const kind = classifyWriteError(errorMessage);
      if (kind === 'auth') {
        this.handleWriteFailure(kind, 'Delete permission denied - server is read-only');
      }
      // A 403 on the COLLECTION says nothing about the files in it:
      // mokuro-bunko refuses a top-level folder DELETE for ownership-based
      // (uploader) accounts while allowing them to delete each file they own.
      // So no demotion here — the caller deletes file by file (each file's
      // own 403, if any, goes through the policy as usual) and counts the
      // volumes that went (`unifiedCloudManager.deleteSeriesFolder`).
      if (kind === 'permission') {
        throw new ProviderError(
          `Series folder delete refused, delete its files one by one: ${errorMessage}`,
          'webdav',
          'FOLDER_DELETE_REFUSED',
          false,
          false,
          'permission'
        );
      }

      const needsPerFileFallback =
        errorMessage.includes('405') ||
        errorMessage.includes('409') ||
        errorMessage.includes('Method Not Allowed') ||
        errorMessage.includes('Conflict');

      if (!needsPerFileFallback) {
        throw new ProviderError(
          `Failed to delete series folder: ${errorMessage}`,
          'webdav',
          'DELETE_FAILED',
          false,
          true,
          'unknown'
        );
      }
    }

    // Fallback path for servers that reject collection DELETE:
    // delete each archive first, then its sidecars.
    const allFiles = await this.listCloudVolumes();
    const seriesPrefix = `${normalizedSeriesTitle}/`;
    const seriesFiles = allFiles.filter((file) => file.path.startsWith(seriesPrefix));

    const getBasePath = (path: string): string => {
      const lower = path.toLowerCase();
      if (lower.endsWith('.cbz')) return path.slice(0, -4);
      if (lower.endsWith('.mokuro.gz')) return path.slice(0, -10);
      if (lower.endsWith('.mokuro')) return path.slice(0, -7);
      if (lower.endsWith('.jpeg')) return path.slice(0, -5);
      if (lower.endsWith('.webp')) return path.slice(0, -5);
      if (lower.endsWith('.jpg')) return path.slice(0, -4);
      return path;
    };

    const archives: CloudFileMetadata[] = [];
    const nonArchivesByBase = new Map<string, CloudFileMetadata[]>();
    for (const file of seriesFiles) {
      if (file.path.toLowerCase().endsWith('.cbz')) {
        archives.push(file);
        continue;
      }
      const base = getBasePath(file.path);
      const existing = nonArchivesByBase.get(base);
      if (existing) {
        existing.push(file);
      } else {
        nonArchivesByBase.set(base, [file]);
      }
    }

    const orderedSeriesFiles: CloudFileMetadata[] = [];
    for (const archive of archives) {
      orderedSeriesFiles.push(archive);
      const base = getBasePath(archive.path);
      const related = nonArchivesByBase.get(base);
      if (related && related.length > 0) {
        orderedSeriesFiles.push(...related);
        nonArchivesByBase.delete(base);
      }
    }
    for (const leftovers of nonArchivesByBase.values()) {
      orderedSeriesFiles.push(...leftovers);
    }

    for (const file of orderedSeriesFiles) {
      await this.deleteFile(file);
    }

    // Best-effort cleanup of now-empty series directory.
    try {
      await this.client.deleteFile(folderPath);
    } catch {
      // Some servers auto-remove empty collections, others keep them.
    }

    console.log(
      `✅ Deleted series '${seriesTitle}' from WebDAV (${orderedSeriesFiles.length} files via fallback)`
    );
  }

  /**
   * Remove a directory only if the SERVER confirms it is empty — never a blind
   * recursive delete. Used to prune a series folder left empty after a rename.
   */
  async removeDirectoryIfEmpty(relativePath: string): Promise<void> {
    if (!this.isAuthenticated() || !this.client) return;

    const normalized = relativePath.replace(/^\/+|\/+$/g, '');
    if (!normalized) return;

    const folderPath = `${MOKURO_FOLDER}/${normalized}`;
    try {
      // getDirectoryContents returns the folder's CHILDREN; empty = prunable.
      const contents = await this.client.getDirectoryContents(folderPath);
      const children = Array.isArray(contents)
        ? contents
        : ((contents as { data?: unknown[] })?.data ?? []);
      if (children.length === 0) {
        await this.client.deleteFile(folderPath);
      }
    } catch {
      // Folder gone already, listing unsupported, or server refused — harmless.
    }
  }

  /**
   * Get storage quota information from WebDAV server
   * Returns used, total, and available storage in bytes
   * Note: Not all WebDAV servers support quota reporting (RFC 4331)
   */
  async getStorageQuota(): Promise<StorageQuota> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    try {
      // WebDAV library's getQuota() returns DiskQuota | ResponseDataDetailed<DiskQuota | null>
      const response = await this.client.getQuota();

      // Handle ResponseDataDetailed wrapper (when details option is used)
      const quota =
        response && typeof response === 'object' && 'data' in response ? response.data : response;

      if (quota && typeof quota === 'object' && 'used' in quota) {
        const used = (quota as { used?: number; available?: number }).used || 0;
        const available = (quota as { used?: number; available?: number }).available ?? null;
        const total = available !== null ? used + available : null;

        return {
          used,
          total,
          available
        };
      }

      // Server doesn't provide quota info
      return {
        used: 0,
        total: null,
        available: null
      };
    } catch {
      // Many WebDAV servers don't support quota - return unknown
      return {
        used: 0,
        total: null,
        available: null
      };
    }
  }

  /**
   * What a worker (or the main-thread core) authenticates with: the token when
   * one is held — then the password is not handed out at all — else the Basic
   * credentials. The header itself is built by `webdavAuthorization`.
   */
  private workerAuthCredentials(): Record<string, string | null> {
    const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
    const username = localStorage.getItem(STORAGE_KEYS.USERNAME);
    const { token } = this.sessionAuth();
    if (token) return { webdavUrl: serverUrl, webdavUsername: username, webdavToken: token };
    const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);
    return { webdavUrl: serverUrl, webdavUsername: username, webdavPassword: password };
  }

  async getWorkerUploadCredentials(): Promise<Record<string, any>> {
    if (!browser) return {};
    const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
    return {
      ...this.workerAuthCredentials(),
      // Staged, verified PUTs: the upload core then skips its delete-before-PUT.
      webdavPutVerified:
        !!serverUrl && localStorage.getItem(STORAGE_KEYS.PUT_VERIFIED) === serverUrl
    };
  }

  /**
   * Record `X-Mokuro-Put: verified` for a server URL. Keyed by URL, so a
   * different server never inherits it; a value other than `verified` on the
   * same server withdraws it.
   */
  private noteVerifiedPutHeader(value: string | null, serverUrl: string): void {
    if (!browser || !serverUrl) return;
    const url = serverUrl.replace(/\/$/, '');
    if (isVerifiedPutHeader(value)) {
      localStorage.setItem(STORAGE_KEYS.PUT_VERIFIED, url);
    } else if (value !== null && localStorage.getItem(STORAGE_KEYS.PUT_VERIFIED) === url) {
      localStorage.removeItem(STORAGE_KEYS.PUT_VERIFIED);
    }
  }

  /**
   * This server URL has advertised `X-Mokuro-Put: verified` (a header only
   * mokuro-bunko sends): it is bunko, even when its identity probe failed.
   */
  private isKnownBunkoServer(serverUrl: string): boolean {
    if (!browser || !serverUrl) return false;
    return localStorage.getItem(STORAGE_KEYS.PUT_VERIFIED) === serverUrl.replace(/\/$/, '');
  }

  /** A PUT response (here or in a worker) said the connected server stages and verifies. */
  notePutVerified(): void {
    if (!browser) return;
    const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
    if (serverUrl) this.noteVerifiedPutHeader('verified', serverUrl);
  }

  /** One OPTIONS on the mokuro folder, read only for `X-Mokuro-Put`. Never throws. */
  private async probeVerifiedPut(baseUrl: string): Promise<void> {
    try {
      const response = await fetchWithRetryAfter(fetch, `${baseUrl}${MOKURO_FOLDER}/`, {
        method: 'OPTIONS',
        headers: webdavAuthHeaders(this.sessionAuth())
      });
      this.noteVerifiedPutHeader(response.headers.get('X-Mokuro-Put'), baseUrl);
    } catch (error) {
      console.debug('[WebDAV] X-Mokuro-Put probe failed:', error);
    }
  }

  async prepareUploadTarget(seriesTitle: string): Promise<void> {
    await this.ensureMokuroFolder();
    await this.ensureSeriesFolder(seriesTitle);
  }

  async getWorkerDownloadCredentials(_fileId: string): Promise<Record<string, any>> {
    if (!browser) return {};
    return this.workerAuthCredentials();
  }
}

export const webdavProvider = new WebDAVProvider();

// Workers never re-issue a token themselves: a 401 in any of them comes here.
registerWorkerAuthRefresher('webdav', (stale) => webdavProvider.refreshedWorkerCredentials(stale));

/** A listed `getetag`, as entry fields (`etag`, and the stamp's `revision`). */
function etagFields(etag: string | null | undefined): { etag?: string; revision?: string } {
  return typeof etag === 'string' && etag ? { etag, revision: etag } : {};
}

// Self-register cache when module is loaded (same pattern as MEGA provider)
import { cacheManager } from '../../cache-manager';
import { webdavCache } from './webdav-cache';
cacheManager.registerCache('webdav', webdavCache);
