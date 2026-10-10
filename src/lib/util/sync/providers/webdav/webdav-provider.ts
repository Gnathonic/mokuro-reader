import { browser } from '$app/environment';
import type {
  SyncProvider,
  ProviderCredentials,
  ProviderStatus,
  StorageQuota,
  CloudFileMetadata,
  UploadFileResult
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
import { isVerifiedPutHeader } from './webdav-upload';
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
import { CANNOT_RENAME_MESSAGE } from '../../account-capabilities';
import { isBestEffortMetadataPath, isSyncableFile } from '../../syncable-file';
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

/** `webdav` client methods that hit the server: a 401 under a token is retried once. */
const CLIENT_REQUEST_METHODS = new Set([
  'copyFile',
  'createDirectory',
  'customRequest',
  'deleteFile',
  'exists',
  'getDAVCompliance',
  'getDirectoryContents',
  'getFileContents',
  'getQuota',
  'moveFile',
  'putFileContents',
  'stat'
]);

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
  /** Server-reported permissions (mokuro-bunko identity endpoint); null = unknown/generic server */
  private _capabilities: ServerPermissions | null = null;
  /** The server answered the mokuro-bunko identity endpoint: it compiles the metadata files. */
  private _serverCompilesMetadata = false;
  /** The bunko version `/login/api/me` reported (bunko >= 0.7.1); undefined otherwise. */
  private _serverVersion: string | undefined;
  /** Set when stored credentials were rejected and the user must re-login */
  private _needsAttention = false;
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
   * sent re-issues the token (single-flight) and is retried once.
   */
  private wrapClient(raw: WebDAVClient): WebDAVClient {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const provider = this;
    return new Proxy(raw, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop !== 'string' || !CLIENT_REQUEST_METHODS.has(prop)) return value;
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const sent = target.getHeaders().Authorization;
          try {
            return await value.apply(target, args);
          } catch (error) {
            if (!isUnauthorized(error) || !bearerOf(sent)) throw error;
            const verdict = await provider.reissueVerdict(sent);
            if (verdict === 'transient') throw new TransientAuthRefreshError();
            if (verdict !== 'retry') throw error;
            // Retry under the session's header as it is NOW: the token may have
            // been replaced by another tab (localStorage is shared, this
            // client's headers are not), or the session fell back to Basic.
            target.setHeaders(webdavAuthHeaders(provider.sessionAuth()));
            return await value.apply(target, args);
          }
        };
      }
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
    password: string | undefined
  ): Promise<IdentityResult> {
    const token = this.sessionAuth().token;
    if (!token) return fetchServerIdentity(serverUrl, username, password);
    const identity = await fetchServerIdentity(serverUrl, username, password, undefined, token);
    if (identity.kind === 'invalid-credentials') {
      const outcome =
        this.sessionAuth().token !== token ? 'replaced' : await this.reissueSingleFlight();
      if (outcome === 'refused') return identity;
      if (outcome === 'rate-limited') return { kind: 'rate-limited' };
      if (outcome === 'unavailable' || outcome === 'unreachable') this.dropToken();
      // The client follows whatever the session holds now (a new token, one
      // another tab stored, or Basic after the drop above).
      this.applyClientAuth();
      const fresh = this.sessionAuth().token;
      return fetchServerIdentity(serverUrl, username, password, undefined, fresh);
    }
    if (identity.kind === 'unsupported') {
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
   * wrongly gates edits on series the account now owns. Called after the
   * backup queue drains; fails quietly — the connect-time snapshot stays.
   */
  async refreshIdentity(): Promise<void> {
    if (!browser || !this.client) return;
    const account = this.sessionAccount();
    if (!account) return;
    try {
      const identity = await this.identify(
        account.serverUrl,
        account.username || undefined,
        account.password || undefined
      );
      if (identity.kind === 'authenticated') {
        this._capabilities = identity.permissions;
        this._isReadOnly = !(
          identity.permissions.canWriteProgress || identity.permissions.canAddFiles
        );
        this.notifyStatusChanged();
      }
    } catch (error) {
      console.warn('[WebDAV] identity refresh failed (keeping last known):', error);
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

    return {
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
      // mokuro-bunko keeps reading history per user only from 0.7.1; before
      // that `history/` lands in the shared library. Plain WebDAV: no limit.
      historySync: this._serverCompilesMetadata
        ? bunkoSupportsHistory(this._serverVersion)
        : undefined,
      metadataPermissions: this._capabilities?.metadata,
      canModifyDelete: this._capabilities?.canModifyDelete,
      canAddFiles: this._capabilities?.canAddFiles,
      // username is optional (some servers support password-only or no auth),
      // so it's an extra discriminator on top of the required serverUrl, not
      // a requirement in its own right.
      accountScope: serverUrl
        ? `webdav:${stripUrlUserinfo(serverUrl)}${username ? `|${username}` : ''}`
        : undefined
    };
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
          break;

        case 'unsupported':
        default:
          // Generic WebDAV server (or older mokuro-bunko): keep the existing
          // heuristics byte-for-byte (copyparty/nextcloud/nginx compatibility)
          this._capabilities = null;

          // Ensure mokuro folder exists
          await this.ensureMokuroFolder();

          // Check write permissions via OPTIONS request
          this._isReadOnly = !(await this.checkWritePermissions(normalizedUrl));
          if (this._isReadOnly) {
            console.log('📖 WebDAV server is read-only (no PUT/DELETE/MKCOL permissions)');
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
    this.client = null;
    this.rawClient = null;
    this._supportsDepthInfinity = null; // Reset for next connection (may be different server)
    this._capabilities = null;
    this._serverCompilesMetadata = false;
    this._serverVersion = undefined;
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

  private async ensureMokuroFolder(): Promise<void> {
    if (!this.client) return;

    try {
      const exists = await this.client.exists(MOKURO_FOLDER);

      if (!exists) {
        await this.client.createDirectory(MOKURO_FOLDER);
        console.log('Created mokuro-reader folder in WebDAV');
      }
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
   * 2. Fall back to OPTIONS request to check Allow header
   * 3. If both are inconclusive → assume write access
   * 4. Actual write operations will mark as read-only if they fail with permission errors
   */
  private async checkWritePermissions(baseUrl: string): Promise<boolean> {
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

      const response = await fetch(url, {
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
          const hasWritePrivilege =
            text.includes('<D:write') ||
            text.includes('<write') ||
            text.includes(':write/>') ||
            text.includes('<D:all') ||
            text.includes('<all') ||
            text.includes(':all/>');

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

      const response = await fetch(url, {
        method: 'OPTIONS',
        headers: headers['Authorization'] ? { Authorization: headers['Authorization'] } : {}
      });

      console.log('[WebDAV] OPTIONS response status:', response.status);
      this.noteVerifiedPutHeader(response.headers.get('X-Mokuro-Put'), baseUrl);

      if (!response.ok) {
        // If OPTIONS fails, assume full access (fail open for usability)
        console.warn('[WebDAV] OPTIONS request failed, assuming full write access');
        return true;
      }

      const allowHeader = response.headers.get('Allow');
      console.log('[WebDAV] Allow header:', allowHeader);

      // If Allow header is missing or empty, assume full access
      // Not all servers return an Allow header on OPTIONS
      if (!allowHeader || allowHeader.trim() === '') {
        console.log('[WebDAV] No Allow header present, assuming full write access');
        return true;
      }

      const allowedMethods = allowHeader
        .split(',')
        .map((m) => m.trim().toUpperCase())
        .filter((m) => m.length > 0);

      // If the header exists but has no valid methods, assume full access
      if (allowedMethods.length === 0) {
        console.log('[WebDAV] Allow header empty, assuming full write access');
        return true;
      }

      // Need PUT for uploads, DELETE for deletions, MKCOL for creating folders
      const hasPut = allowedMethods.includes('PUT');
      const hasDelete = allowedMethods.includes('DELETE');
      const hasMkcol = allowedMethods.includes('MKCOL');

      const hasWrite = hasPut && hasDelete && hasMkcol;

      console.log(
        `[WebDAV] Permissions: PUT=${hasPut}, DELETE=${hasDelete}, MKCOL=${hasMkcol}, hasWrite=${hasWrite}`
      );

      return hasWrite;
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
      // Ensure mokuro folder exists first
      await this.ensureMokuroFolder();

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
                size: item.size || 0
              });
            }
          }
        }
      };

      await processFolder(MOKURO_FOLDER);

      console.log(`✅ Listed ${allFiles.length} files from WebDAV (recursive)`);
      return allFiles;
    } catch (error) {
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
            size: item.size || 0
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
      return uploaded;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Compiled metadata files are best-effort: a server that compiles them
      // itself (mokuro-bunko) rejects the write by design, and that says
      // nothing about progress sync or archive uploads. Demoting the provider
      // here would hide backup and upload for a perfectly writable account.
      if (!isBestEffortMetadataPath(path)) {
        const kind = classifyWriteError(errorMessage);
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

  /**
   * Central policy for failed write operations:
   * - 401 with a password-backed session: credentials were rejected -> clear
   *   the stored password and prompt re-login (NOT a read-only server)
   * - 403 when the server told us we CAN write progress: an isolated
   *   permission error (e.g. library upload as a registered user) -> clear
   *   message, but do NOT demote to read-only (that would hide progress sync)
   * - everything else (405, 403 on unknown/low capabilities, 401 on a
   *   credential-less session): legacy behavior - mark read-only
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
    onProgress?: (loaded: number, total: number) => void
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
        refreshAuth: (stale) => this.refreshedWorkerCredentials(stale)
      });
      const blob = new Blob([arrayBuffer], { type: 'application/zip' });
      console.log(`✅ Downloaded ${file.path} from WebDAV`);
      return blob;
    } catch (error) {
      throw new ProviderError(
        `Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'webdav',
        'DOWNLOAD_FAILED',
        false,
        true
      );
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
      const response = await fetch(`${baseUrl}${MOKURO_FOLDER}/`, {
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

// Self-register cache when module is loaded (same pattern as MEGA provider)
import { cacheManager } from '../../cache-manager';
import { webdavCache } from './webdav-cache';
cacheManager.registerCache('webdav', webdavCache);
