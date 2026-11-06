import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { GOOGLE_DRIVE_CONFIG } from './constants';
import { showSnackbar } from '$lib/util/snackbar';
import { onNextUserGesture } from '$lib/util/user-gesture';
import { CLOUD_TEST_HOOKS, cloudTestToken } from '../../cloud-test-hooks';
import { loadGisScript } from './google-scripts';
import {
  backendAuthConfigured,
  backendAuthEnabled,
  callBackend,
  callWithProof,
  markBackendUnavailable,
  startSignIn,
  takeCallback,
  type BackendOutcome
} from './auth-backend';
import { deleteDeviceKey, loadDeviceKey } from './device-key';

/** What a caller of `getAccessToken` gets by default: a token good for this long. */
export const DEFAULT_MIN_VALIDITY_MS = 5 * 60 * 1000;
/** Transient refresh failures with an expired token before the popup is offered instead. */
const FALLBACK_AFTER_FAILURES = 3;
/**
 * A sign-out that did not reach the backend (offline): the sealed cookie may
 * still be there. Until a /logout gets through, no silent refresh may use it
 * — on a shared machine the next person's Connect would otherwise sign the
 * old account back in without a consent screen. The value is the scope to
 * replay: `'device'` (just clear the cookie — this browser's key is already
 * deleted, so the cookie can no longer refresh anyway) or `'everywhere'`
 * (revoke at Google too; the grant may still be live). Builds before the
 * scope existed stored `'1'`, which always meant a revoke: any value but
 * `'device'` reads as `'everywhere'`. localStorage: it must outlive the tab,
 * like the cookie.
 */
export const LOGOUT_PENDING_KEY = 'gdrive_logout_pending';

/** How far a sign-out reaches: this browser only, or the whole Google grant. */
export type LogoutScope = 'device' | 'everywhere';

function logoutPending(): LogoutScope | null {
  try {
    const value = localStorage.getItem(LOGOUT_PENDING_KEY);
    if (!value) return null;
    return value === 'device' ? 'device' : 'everywhere';
  } catch {
    return null;
  }
}

function setLogoutPending(scope: LogoutScope | null): void {
  try {
    if (!scope) localStorage.removeItem(LOGOUT_PENDING_KEY);
    // Never narrow an unfinished revoke into a mere clear.
    else if (scope === 'device' && logoutPending() === 'everywhere') return;
    else localStorage.setItem(LOGOUT_PENDING_KEY, scope);
  } catch {
    // Storage blocked: nothing to remember it in.
  }
}

/** What a silent refresh through the backend came to. */
export type BackendRefresh = 'ok' | 'reauth' | 'transient' | 'unavailable';

/** What a sign-out came to (see `TokenManager.logout`). */
export interface LogoutAnswer {
  copyMayStillWork: boolean;
  revoked: boolean;
  pendingEverywhere: boolean;
}

/** What renewing a token Drive refused came to. */
export type TokenRenewal =
  | { kind: 'renewed'; token: string }
  | { kind: 'transient' }
  | { kind: 'failed' };

/**
 * The interop rig's stand-in for a GIS token client: a request answers with the
 * token the rig injected (`cloudTestToken('google')`, read when it answers so a
 * re-minted one is what a re-auth gets). Like GIS it answers after the request
 * returns, never inside it, so the manager's `isRefreshing` covers a re-auth in
 * flight: answered inside the call, every 401 of a burst asked again and the
 * later ones read as refusals of the token just granted. Reached only through a
 * `CLOUD_TEST_HOOKS` guard, so a production build drops it.
 *
 * It cannot mint, so a silent re-auth for the token the manager already holds
 * (the API just rejected it) hands that same string back ONCE: enough for a
 * one-off 401. Rejected again before a sync has worked with it, the grant is
 * gone: `access_denied`, as GIS answers, and the string stays refused until the
 * rig sets another. Handing it back every time looped re-auth, sync, 401
 * forever and never left the banner up.
 */
class InjectedTokenClient {
  private regranted: string | null = null;
  private refused: string | null = null;

  constructor(
    private readonly callback: (response: any) => void,
    private readonly held: () => string
  ) {}

  requestAccessToken(options?: { prompt?: string }): void {
    setTimeout(() => this.answer(options), 0);
  }

  private answer(options?: { prompt?: string }): void {
    const token = cloudTestToken('google');
    const value = token?.access_token;
    if (!token || value === this.refused) return this.callback({ error: 'access_denied' });
    if (value === this.held() && options?.prompt !== 'consent') {
      if (this.regranted === value) {
        this.refused = value;
        this.regranted = null;
        return this.callback({ error: 'access_denied' });
      }
      this.regranted = value;
    } else {
      this.regranted = null;
    }
    this.callback({ ...token });
  }

  /** A sync worked with `token`: its next 401 is a one-off again. */
  worked(token: string): void {
    if (this.regranted === token) this.regranted = null;
  }
}

class TokenManager {
  private tokenStore = writable<string>('');
  private tokenClientStore = writable<any>(null);
  private needsAttentionStore = writable<boolean>(false);
  private refreshIntervalId: number | null = null;
  private isRefreshing = false;
  private gestureRetryCancel: (() => void) | null = null;
  private pendingPostReauthSync = false;
  private injectedClient: InjectedTokenClient | null = null;

  // Backend mode (`auth-backend.ts`) only.
  /** The refresh in flight: one per tab, every caller shares it. */
  private backendRefresh: Promise<BackendRefresh> | null = null;
  /** The server said reauth/no_session: no more silent attempts until a sign-in. */
  private backendSessionDead = false;
  /** Transient refresh failures in a row, and when the next attempt may go out. */
  private transientFailures = 0;
  private retryNotBefore = 0;
  /** Of those, the ones that reached (or timed out on) the backend: offline ones never count. */
  private backendFailures = 0;
  /** The backend kept failing with an expired token: Reconnect opens the popup instead. */
  private popupFallbackOffered = false;
  /**
   * A sign-out of this tab is under way (its /logout may be out for up to the
   * client timeout). Nothing renews meanwhile: a renewal would replay the
   * pending sign-out (`settlePendingLogout`) concurrently with its own
   * /logout, and the second revoke of the same grant answers 400, which can
   * turn a sign-out that worked into "Google could not be reached".
   */
  private loggingOut = false;
  /** The sign-out under way (`logout` runs one at a time), with its scope. */
  private logoutFlight: { everywhere: boolean; promise: Promise<LogoutAnswer> } | null = null;

  constructor() {
    if (browser) {
      this.loadPersistedToken();
      this.setupTokenRefreshInterval();
    }
  }

  get token() {
    return this.tokenStore;
  }

  get needsAttention() {
    return this.needsAttentionStore;
  }

  private loadPersistedToken(): void {
    const token = localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN);
    const expiresAt = localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN_EXPIRES);

    if (token && expiresAt) {
      const now = Date.now();
      const expiry = parseInt(expiresAt, 10);

      // Load the token into the store regardless of expiry
      // This preserves authentication state for auto re-auth
      this.tokenStore.set(token);

      // Only set gapi token if gapi is loaded AND token is still valid
      if (typeof gapi !== 'undefined' && gapi.client && expiry > now) {
        gapi.client.setToken({ access_token: token });
      }

      if (expiry > now) {
        console.log(
          'Loaded persisted token, expires in',
          Math.round((expiry - now) / 60000),
          'minutes'
        );
      } else if (this.isBackendMode()) {
        // The session cookie renews it silently at startup (`restoreSession`).
        console.log('Token expired; the auth backend will renew it');
      } else {
        console.log('Token expired, needs re-authentication');
        this.needsAttentionStore.set(true);
        // DON'T clear the token - keep it for auth history
      }
    }
  }

  private setupTokenRefreshInterval(): void {
    // Clear any existing interval
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }

    // Simple token expiry monitor - just checks if token is expired and sets attention flag
    this.refreshIntervalId = window.setInterval(() => {
      const expiresAt = localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN_EXPIRES);
      if (!expiresAt || !this.isAuthenticated()) return;
      // Backend mode renews on use (`getAccessToken`): an hour passing is no
      // reason for attention while the session can still refresh.
      if (this.isBackendMode() && !this.needsUserForSession()) return;

      const now = Date.now();
      const expiry = parseInt(expiresAt, 10);
      const timeUntilExpiry = expiry - now;

      // Token expired - set attention flag
      // Auto re-auth happens in api-client.ts when user actually tries to use Drive
      if (timeUntilExpiry <= 0) {
        console.log('❌ Token expired');
        this.needsAttentionStore.set(true);
        return;
      }

      // Show warning when getting close to expiry
      if (timeUntilExpiry <= GOOGLE_DRIVE_CONFIG.TOKEN_WARNING_BUFFER_MS) {
        const minutesLeft = Math.round(timeUntilExpiry / 60000);
        if (minutesLeft > 0 && minutesLeft <= 10 && minutesLeft % 5 === 0) {
          console.warn(`⚠️ Token expires in ${minutesLeft} minutes`);
        }
      }
    }, GOOGLE_DRIVE_CONFIG.TOKEN_REFRESH_CHECK_INTERVAL_MS);
  }

  /**
   * Popup blockers gate on transient user activation, not a stored permission,
   * so a popup blocked in the background will open fine when requested from
   * inside a real click/tap. Arm a one-shot retry on the next gesture — this
   * makes auto re-auth work WITHOUT the user touching browser settings.
   */
  private armGestureRetry(): void {
    if (this.gestureRetryCancel) return; // already armed
    showSnackbar('Google Drive session expired — click or tap anywhere to reconnect.');
    this.gestureRetryCancel = onNextUserGesture(() => {
      this.gestureRetryCancel = null;
      try {
        // Must stay synchronous: an await here would forfeit the activation
        // window that lets the OAuth popup open.
        this.pendingPostReauthSync = true;
        this.requestNewToken(false);
      } catch (error) {
        console.warn('Gesture-retry re-auth failed:', error);
      }
    });
  }

  private disarmGestureRetry(): void {
    if (this.gestureRetryCancel) {
      this.gestureRetryCancel();
      this.gestureRetryCancel = null;
    }
  }

  setToken(token: string, expiresIn?: number): void {
    this.tokenStore.set(token);
    this.isRefreshing = false;
    this.needsAttentionStore.set(false); // Clear attention flag when token is set
    this.disarmGestureRetry(); // A valid token makes any pending retry moot

    if (browser) {
      localStorage.setItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN, token);
      localStorage.setItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.LAST_AUTH_TIME, Date.now().toString());
      localStorage.setItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED, 'true');

      if (expiresIn) {
        // Debug mode: Override expiry to 30 seconds for testing
        const actualExpiresIn = GOOGLE_DRIVE_CONFIG.DEBUG_SHORT_TOKEN_EXPIRY ? 30 : expiresIn;
        const expiresAt = Date.now() + actualExpiresIn * 1000;
        localStorage.setItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN_EXPIRES, expiresAt.toString());

        if (GOOGLE_DRIVE_CONFIG.DEBUG_SHORT_TOKEN_EXPIRY) {
          console.warn('🔧 DEBUG MODE: Token will expire in 30 seconds');
        } else {
          console.log(
            '✅ Token set successfully, expires in',
            Math.round(expiresIn / 60),
            'minutes'
          );
        }
      }
    }
  }

  clearToken(keepAuthHistory = true): void {
    this.tokenStore.set('');
    this.isRefreshing = false;

    if (browser) {
      localStorage.removeItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN);
      localStorage.removeItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN_EXPIRES);
      localStorage.removeItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.LAST_AUTH_TIME);

      // Only clear auth history on explicit logout
      if (!keepAuthHistory) {
        localStorage.removeItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED);
      }
    }

    // Clear from gapi client
    if (typeof gapi !== 'undefined' && gapi.client) {
      gapi.client.setToken(null);
    }

    // Update provider manager to trigger reactive updates (dynamic import to avoid circular dependency)
    import('../../provider-manager').then(({ providerManager }) => {
      providerManager.updateStatus();
    });
  }

  /** Implicit mode's revoke. True only when Google confirmed it. */
  async revokeToken(token: string): Promise<boolean> {
    try {
      const response = await fetch(`${GOOGLE_DRIVE_CONFIG.OAUTH_ENDPOINT}?token=${token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      return response.ok;
    } catch (error) {
      console.error('Error revoking token:', error);
      return false;
    }
  }

  /**
   * Wait for the Google Identity Services global. The script is injected on
   * demand (`google-scripts.ts`), normally long before a token is needed: at
   * boot for an active Drive, or when the cloud page opened.
   */
  private async waitForGoogleIdentity(): Promise<void> {
    if (typeof google !== 'undefined' && google?.accounts?.oauth2) return;

    console.log('⏳ Waiting for Google Identity Services to load...');
    await loadGisScript();
    const maxWait = 10000; // 10 seconds
    const start = Date.now();

    while (typeof google === 'undefined' || !google?.accounts?.oauth2) {
      if (Date.now() - start > maxWait) {
        throw new Error('Timeout waiting for Google Identity Services to load');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    console.log('✅ Google Identity Services loaded');
  }

  /** A token client's answer: a token, or an OAuth error. */
  private onTokenResponse(response: any): void {
    if (response?.error) {
      console.error('Token client error:', response.error, response.error_description);

      // Handle specific error cases
      if (response.error === 'access_denied') {
        // User denied access OR permissions were revoked server-side by user/Google
        // Clear auth history to force full consent screen on next attempt
        this.clearToken(false);
        this.needsAttentionStore.set(true);
        showSnackbar('Google Drive access was denied. Please sign in again to grant permissions.');
      } else if (response.error === 'popup_closed') {
        // User closed the popup - don't clear anything, they might retry
        // Preserve all state so they can try again immediately
        showSnackbar('Sign-in cancelled. Please try again when ready.');
      } else if (response.error === 'popup_failed_to_open' || response.error === 'popup_blocked') {
        // Popup was blocked (no user activation). Retry inside the next
        // real click/tap, where blockers always allow it.
        console.log('Popup was blocked by browser — arming gesture retry');
        this.armGestureRetry();
      } else {
        // Other errors (network issues, etc.) - keep auth history but clear token
        // Next sign-in will use minimal prompt since permissions weren't explicitly denied
        this.clearToken(true);
        this.needsAttentionStore.set(true);
        showSnackbar('Authentication failed. Please try signing in again.');
      }

      this.isRefreshing = false;
      return;
    }

    const { access_token, expires_in } = response;
    if (access_token) {
      this.setToken(access_token, expires_in);
      gapi.client.setToken({ access_token });

      // Update provider manager to trigger reactive updates (dynamic import to avoid circular dependency)
      import('../../provider-manager').then(({ providerManager }) => {
        providerManager.updateStatus();
      });

      // After a RE-auth (not initial login — CloudView owns that flow),
      // pull cloud state immediately. Without this, nothing syncs until
      // the user turns pages, whose fresher timestamps would then win the
      // newest-wins merge and clobber progress made on another device.
      if (this.pendingPostReauthSync) {
        this.pendingPostReauthSync = false;
        void this.runPostReauthSync(access_token);
      }
    }
  }

  async initTokenClient(): Promise<void> {
    const injected = CLOUD_TEST_HOOKS ? cloudTestToken('google') : null;
    let tokenClient: any;
    if (injected) {
      this.injectedClient = new InjectedTokenClient(
        (response) => this.onTokenResponse(response),
        () => this.getCurrentToken()
      );
      tokenClient = this.injectedClient;
    } else {
      // Wait for google Identity Services to be available. In backend mode it
      // is only the fallback popup: Drive works without it.
      try {
        await this.waitForGoogleIdentity();
      } catch (error) {
        if (!this.isBackendMode()) throw error;
        console.warn('Google Identity Services unavailable; the popup fallback is off');
      }
    }
    if (!tokenClient && typeof google !== 'undefined' && google?.accounts?.oauth2) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_DRIVE_CONFIG.CLIENT_ID,
        scope: GOOGLE_DRIVE_CONFIG.SCOPES,
        callback: (response: any) => this.onTokenResponse(response),
        // GIS reports NON-OAuth failures here, not in `callback` — in particular
        // popup_failed_to_open when the blocker eats a background-triggered
        // popup. Without this handler, blocked auto re-auth failed silently.
        error_callback: (error: { type?: string; message?: string }) => {
          console.warn('Token client non-OAuth error:', error?.type, error?.message);
          if (error?.type === 'popup_failed_to_open') {
            this.armGestureRetry();
          } else if (error?.type === 'popup_closed') {
            showSnackbar('Sign-in cancelled. Please try again when ready.');
          }
          this.isRefreshing = false;
        }
      });
    }

    this.tokenClientStore.set(tokenClient ?? null);

    // If we have a persisted token in the store, set it in gapi.client now that gapi is loaded
    const currentToken = this.getCurrentToken();
    if (currentToken && typeof gapi !== 'undefined' && gapi.client) {
      gapi.client.setToken({ access_token: currentToken });
      console.log('Restored persisted token to gapi.client');
    }
  }

  requestNewToken(forceConsent = false): void {
    // Guards against a manual "Reconnect" click double-firing: a click is
    // simultaneously the pointerdown that satisfies an armed gesture-retry
    // AND the button's own handler, so both can call in on the same tick.
    if (this.isRefreshing) {
      console.log('Token request already in flight — ignoring duplicate call');
      return;
    }

    const tokenClient = this.tokenClientStore;
    let client: any;

    tokenClient.subscribe((value) => {
      client = value;
    })();

    if (client) {
      this.isRefreshing = true;
      // Determine if user has authenticated before
      const hasAuthenticated =
        browser &&
        localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED) === 'true';

      if (forceConsent || !hasAuthenticated) {
        // Force full consent screen (for initial auth or when explicitly requested)
        console.log('→ Using full consent screen (prompt: "consent")');
        client.requestAccessToken({ prompt: 'consent' });
      } else {
        // Re-authentication: minimal UI, just account selection, reuse existing permissions
        console.log('→ Using minimal re-auth (no prompt parameter = default select_account)');
        client.requestAccessToken({});
      }
    } else {
      throw new Error('Token client not initialized');
    }
  }

  /**
   * Sign out. By default **this device only**: nothing is revoked at Google,
   * because Google revokes per Cloud project, not per client — a revoke here
   * would also sign out every other device and any mokuro-bunko server
   * holding a grant from the same project. The held access token is dropped,
   * never revoked (revoking it would end that same whole grant); in backend
   * mode the server clears its cookie and this browser's device key is
   * deleted, so a copy of a bound cookie can never refresh again.
   *
   * `everywhere: true` (an explicit, confirmed action) ends the grant at
   * Google: every device, browser and server signed in through it must
   * connect again. An earlier everywhere sign-out that never got through
   * (offline) makes this one everywhere too — it was the user's ask.
   *
   * Answers `copyMayStillWork` for a device sign-out that could not make
   * copies of the session cookie useless: the server says so
   * (`invalidated: false` — an unbound session, or proofs switched off), or,
   * when it never answered, this browser had no device key to delete (the
   * session cannot have been bound) or could not delete it. Never in
   * implicit mode: there is no server cookie to copy.
   *
   * For an everywhere sign-out, `revoked` says Google confirmed the grant
   * ended (the server's revoke, or one from here); only then may the user be
   * told every device is signed out. Otherwise `pendingEverywhere` says the
   * sign-out is queued to finish the next time this browser connects: the
   * request never got through (offline, a timeout, the backend down), so a
   * replay can. Neither means Google could not be reached and nothing will
   * retry it — also when the backend is missing here (`unavailable`: every
   * replay meets the same 404) or refused the request (`refused`). Both false
   * on a device sign-out.
   */
  logout(options: { everywhere?: boolean } = {}): Promise<LogoutAnswer> {
    // One sign-out at a time: the panel keeps its buttons while /logout is
    // out (up to the client timeout), and a second, concurrent /logout would
    // revoke the same grant twice (Google answers the second 400) and end the
    // first one's renewal guard while it is still out. A click of the same or
    // a narrower scope gets the running sign-out's answer; "everywhere" during
    // a device sign-out runs after it.
    const everywhere =
      options.everywhere === true || (backendAuthConfigured() && logoutPending() === 'everywhere');
    const flight = this.logoutFlight;
    if (flight && (flight.everywhere || !everywhere)) return flight.promise;
    const promise = (flight ? flight.promise : Promise.resolve()).then(() =>
      this.logoutOnce(options)
    );
    const entry = { everywhere, promise };
    this.logoutFlight = entry;
    const clear = () => {
      if (this.logoutFlight === entry) this.logoutFlight = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  private async logoutOnce(options: { everywhere?: boolean }): Promise<LogoutAnswer> {
    this.disarmGestureRetry();
    // Clear the refresh interval
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }

    const currentToken = this.getCurrentToken();
    // An injected token is the simulator's: there is nothing at Google to revoke.
    const injected = CLOUD_TEST_HOOKS ? cloudTestToken('google') : null;
    const backend = backendAuthConfigured();
    const everywhere = options.everywhere === true || (backend && logoutPending() === 'everywhere');

    let copyMayStillWork = false;
    // The simulator's token has no grant behind it: nothing is left to end.
    let revoked = everywhere && !!injected;
    // The request never got through, so the queued sign-out can finish later.
    let queued = false;
    this.loggingOut = true;
    try {
      // Written AHEAD, before anything awaits: a reload or a closed tab
      // while the key is deleted or /logout is out must still find this
      // device signed out and the sign-out queued (`settlePendingLogout`),
      // not a live token over a cookie nobody clears. Undone below once the
      // server answers, or a revoke from here got through.
      if (backend && !injected) setLogoutPending(everywhere ? 'everywhere' : 'device');
      this.clearToken(false);
      // Whether there was a key to bind the session to at all (backend only:
      // implicit mode never touches the key database but to delete it).
      const hadKey = backend ? (await loadDeviceKey()) !== null : false;
      // The key goes first, whatever the network does: from here on no
      // proof for this session can be signed, so its cookie cannot refresh.
      const keyDeleted = await deleteDeviceKey();
      if (backend) {
        // The server clears its cookie (and on `everywhere` revokes the
        // refresh token). Asked even when this tab fell back to the popup: a
        // cookie from an earlier session may still be there.
        const outcome = await callBackend('logout', { everywhere });
        let revokedHere = false;
        if (everywhere) {
          // Unless the server confirms it revoked the grant (it may not have:
          // Google down, a cookie it could not open, no cookie at all),
          // revoke the access token here. Revoking either token of a grant
          // revokes the whole grant, so a cookie left behind holds a dead
          // refresh token. Never on a device sign-out: the server's
          // `revoked: false` there is the point, not a failure.
          const serverRevoked = outcome.kind === 'done' && outcome.revoked;
          if (!serverRevoked && currentToken && !injected) {
            revokedHere = await this.revokeGrant(currentToken);
          }
          revoked ||= serverRevoked || revokedHere;
        }
        if (!everywhere && !injected) {
          if (outcome.kind === 'done') copyMayStillWork = !outcome.invalidated;
          // No answer (offline, refused): with the key gone, a bound cookie is
          // dead either way; only a session that cannot have been bound — or
          // a key that would not delete — may live on. No backend here
          // (`unavailable`) means no cookie of its making.
          else if (outcome.kind !== 'unavailable') copyMayStillWork = !hadKey || !keyDeleted;
        }
        // Otherwise the flag written above stays: the cookie may still be
        // there, and the sign-out must finish before anything renews from it
        // (`settlePendingLogout`). A revoke that got through from here leaves
        // only a dead cookie behind.
        if (outcome.kind === 'done' || revokedHere) setLogoutPending(null);
        queued = outcome.kind === 'transient';
      } else if (everywhere && currentToken && !injected) {
        revoked = await this.revokeToken(currentToken);
      }
    } catch (error) {
      console.warn('Google Drive sign-out request failed:', error);
    } finally {
      // Whatever the server said: this device is signed out.
      this.resetBackendState();
      // Clear token AND auth history on explicit logout
      this.clearToken(false);
      this.loggingOut = false;
    }
    // Read back, not assumed: storage may have refused the flag.
    const pendingEverywhere =
      backend && everywhere && !revoked && queued && logoutPending() === 'everywhere';
    return { copyMayStillWork, revoked: everywhere && revoked, pendingEverywhere };
  }

  /**
   * Revoke at Google with the token in the BODY (never a URL a log could
   * keep). True only when Google confirmed it: an expired token's 400 ends
   * nothing.
   */
  private async revokeGrant(token: string): Promise<boolean> {
    try {
      const response = await fetch(GOOGLE_DRIVE_CONFIG.OAUTH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString()
      });
      return response.ok;
    } catch (error) {
      console.error('Error revoking token:', error);
      return false;
    }
  }

  /**
   * Finish a sign-out that did not get through (`LOGOUT_PENDING_KEY`): null
   * when nothing is pending or the server has now cleared the cookie;
   * otherwise why it still could not, and no silent refresh may go out.
   */
  private async settlePendingLogout(): Promise<BackendOutcome | null> {
    const scope = logoutPending();
    if (!scope) return null;
    const outcome = await callBackend('logout', { everywhere: scope === 'everywhere' });
    if (outcome.kind !== 'done') return outcome;
    setLogoutPending(null);
    return null;
  }

  private getCurrentToken(): string {
    let token = '';
    this.tokenStore.subscribe((value) => {
      token = value;
    })();
    return token;
  }

  isAuthenticated(): boolean {
    // User is authenticated if they have auth history AND a token (even if expired)
    // This allows auto re-auth to work without forcing full logout
    const hasAuthHistory =
      browser &&
      localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED) === 'true';
    const hasToken = this.getCurrentToken() !== '';

    return hasAuthHistory && hasToken;
  }

  /**
   * Time left on the access token, or null for "nothing to show". Backend
   * mode answers null while the session cookie can still renew the token on
   * use: no countdown, no hourly re-auth (the navbar, the reader and the
   * foreground sync all take null as fine). Once only the user can help (the
   * session is gone, or the backend kept failing and the popup is offered)
   * the real time comes back, and with it the Reconnect button.
   */
  getTimeUntilExpiry(): number | null {
    if (this.isBackendMode() && !this.needsUserForSession()) return null;
    const expiresAt = localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN_EXPIRES);
    if (!expiresAt) return null;

    const expiry = parseInt(expiresAt, 10);
    return expiry - Date.now();
  }

  getExpiryMinutes(): number | null {
    const timeLeft = this.getTimeUntilExpiry();
    return timeLeft ? Math.round(timeLeft / 60000) : null;
  }

  // Re-authentication (minimal UI, reuses existing permissions). Flags the
  // next successful token for an immediate cloud pull — see the callback in
  // initTokenClient.
  //
  // Backend mode: silent only. An automatic re-auth (a refused request, an
  // expired token at startup, opening a book) never leaves the page; it
  // renews through the session cookie, or leaves the Reconnect state up.
  reAuthenticate(): void {
    console.log('🔄 reAuthenticate() called');
    if (this.isBackendMode()) {
      void this.refreshFromBackend(true).then((result) => {
        if (result === 'ok') void this.runPostReauthSync(this.getCurrentToken());
      });
      return;
    }
    this.pendingPostReauthSync = true;
    this.requestNewToken(false);
  }

  /**
   * The user asked to reconnect (the Reconnect button, a cloud-page button):
   * the one place a sign-in may start. Implicit mode: `reAuthenticate`,
   * unchanged. Backend mode: the popup when that fallback is on offer (opened
   * synchronously, inside the click), else a silent refresh, and a
   * full-page sign-in when the session is gone.
   */
  reconnect(): void {
    if (!this.isBackendMode()) {
      this.reAuthenticate();
      return;
    }
    if (this.popupFallbackOffered && this.hasTokenClient()) {
      this.pendingPostReauthSync = true;
      this.requestNewToken(false);
      return;
    }
    // Even a session this tab found dead is tried once more first: the
    // server keeps a bound cookie whose proof failed (a passing IndexedDB
    // glitch is not a sign-out), so it may well renew now. Only a second
    // reauth leaves for Google's consent screen.
    this.backendSessionDead = false;
    void this.refreshFromBackend(true).then((result) => {
      if (result === 'ok') void this.runPostReauthSync(this.getCurrentToken());
      else if (result === 'reauth') void this.beginSignIn();
      else if (result === 'unavailable') this.reAuthenticate();
      else showSnackbar('Google Drive could not reconnect right now. Try again in a moment.');
    });
  }

  // -------------------------------------------------------------- backend mode

  /** Drive signs in through the auth backend (`auth-backend.ts`) in this tab. */
  isBackendMode(): boolean {
    return backendAuthEnabled();
  }

  /** Only the user can bring the backend session back (or chose to fall back). */
  private needsUserForSession(): boolean {
    return this.backendSessionDead || this.popupFallbackOffered;
  }

  private hasTokenClient(): boolean {
    let client: unknown = null;
    this.tokenClientStore.subscribe((value) => (client = value))();
    return !!client;
  }

  private resetBackendState(): void {
    this.backendSessionDead = false;
    this.transientFailures = 0;
    this.backendFailures = 0;
    this.retryNotBefore = 0;
    this.popupFallbackOffered = false;
  }

  private storedExpiry(): number | null {
    if (!browser) return null;
    const raw = localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN_EXPIRES);
    const expiry = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(expiry) ? expiry : null;
  }

  /** The held token is good for at least `ms` more. */
  private validFor(ms: number): boolean {
    const expiry = this.storedExpiry();
    return !!this.getCurrentToken() && expiry !== null && expiry - Date.now() >= ms;
  }

  /**
   * Another tab of this browser may have renewed the token since we read it:
   * localStorage is shared, the store is not. Take a stored token that lasts
   * longer than the one held. The cookie is shared too, so whatever that tab
   * did (renewed, or signed in again) holds here as well: this tab's own
   * verdict on the session (gone, failing) is stale and is dropped.
   */
  private adoptStoredToken(): void {
    if (!browser) return;
    const stored = localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN);
    if (!stored || stored === this.getCurrentToken()) return;
    const expiry = this.storedExpiry();
    if (expiry === null || expiry <= Date.now()) return;
    this.tokenStore.set(stored);
    if (typeof gapi !== 'undefined' && gapi.client) gapi.client.setToken({ access_token: stored });
    this.resetBackendState();
    this.setNeedsAttention(false);
  }

  /** Set the attention flag and tell the status store (the navbar reads that). */
  private setNeedsAttention(value: boolean): void {
    let current = false;
    this.needsAttentionStore.subscribe((v) => (current = v))();
    if (current === value) return;
    this.needsAttentionStore.set(value);
    import('../../provider-manager').then(({ providerManager }) => {
      providerManager.updateStatus();
    });
  }

  private applyBackendToken(accessToken: string, expiresIn: number): void {
    this.resetBackendState();
    this.setToken(accessToken, expiresIn);
    if (typeof gapi !== 'undefined' && gapi.client)
      gapi.client.setToken({ access_token: accessToken });
    import('../../provider-manager').then(({ providerManager }) => {
      providerManager.updateStatus();
    });
  }

  /**
   * `offline`: the request never reached the backend. It still backs off, but
   * never counts toward offering the popup: offline, the backend is not the
   * problem, and Google's popup could not open either.
   */
  private noteTransientFailure(offline = false): void {
    this.transientFailures++;
    if (!offline) this.backendFailures++;
    // 30 s, 1, 2, 4 min, then every 5 min.
    const delay = Math.min(30_000 * 2 ** (this.transientFailures - 1), 5 * 60_000);
    this.retryNotBefore = Date.now() + delay;
    if (
      !this.popupFallbackOffered &&
      this.backendFailures >= FALLBACK_AFTER_FAILURES &&
      !this.validFor(0) &&
      this.hasTokenClient()
    ) {
      this.popupFallbackOffered = true;
      this.setNeedsAttention(true);
      showSnackbar('Google Drive sign-in is unavailable right now. Click Reconnect to sign in.');
    }
  }

  /**
   * A fresh access token from the session cookie (`/api/gdrive/refresh`),
   * single-flight per tab. `force` skips the backoff after transient failures.
   */
  refreshFromBackend(force = false): Promise<BackendRefresh> {
    // Mid-sign-out the session is being ended: nothing to renew (and no
    // second /logout racing the first). No verdict is kept; the sign-out
    // resets the backend state when it finishes.
    if (this.loggingOut || this.backendSessionDead) return Promise.resolve('reauth');
    if (!force && Date.now() < this.retryNotBefore) return Promise.resolve('transient');
    if (this.backendRefresh) return this.backendRefresh;
    this.backendRefresh = (async (): Promise<BackendRefresh> => {
      // An unfinished sign-out first: the cookie it left must not renew.
      const outcome = (await this.settlePendingLogout()) ?? (await callWithProof('refresh', {}));
      switch (outcome.kind) {
        case 'ok':
          this.applyBackendToken(outcome.accessToken, outcome.expiresIn);
          return 'ok';
        case 'reauth':
          this.backendSessionDead = true;
          this.setNeedsAttention(true);
          return 'reauth';
        case 'unavailable':
          markBackendUnavailable();
          return 'unavailable';
        default:
          this.noteTransientFailure(outcome.kind === 'transient' && outcome.offline === true);
          return 'transient';
      }
    })().finally(() => {
      this.backendRefresh = null;
    });
    return this.backendRefresh;
  }

  /**
   * An access token good for at least `minValidityMs` (default 5 minutes),
   * renewed through the backend when the held one is not. Never throws: when
   * no renewal is possible right now, the held token (possibly stale) comes
   * back and Drive's 401 takes the auth path. Implicit mode: the held token,
   * exactly as before.
   */
  async getAccessToken(minValidityMs = DEFAULT_MIN_VALIDITY_MS): Promise<string> {
    if (!this.isBackendMode()) return this.getCurrentToken();
    this.adoptStoredToken();
    if (this.validFor(minValidityMs)) return this.getCurrentToken();
    if (!this.isAuthenticated()) return this.getCurrentToken();
    await this.refreshFromBackend();
    return this.getCurrentToken();
  }

  /**
   * Drive refused `rejected` (a 401): a token to retry with, if there is one.
   * One already replaced (another request or tab renewed it) is handed back
   * as it is; otherwise backend mode renews through the cookie. Implicit mode
   * never opens anything from here: a replaced token, or nothing.
   */
  async renewRejectedToken(rejected: string): Promise<TokenRenewal> {
    // Mid-sign-out: no token to retry with, from anywhere.
    if (this.loggingOut) return { kind: 'failed' };
    if (this.isBackendMode()) this.adoptStoredToken();
    const held = this.getCurrentToken();
    if (held && held !== rejected && this.validFor(0)) return { kind: 'renewed', token: held };
    if (!this.isBackendMode()) return { kind: 'failed' };
    // Not forced: while the backend is backing off, a burst of refused calls
    // must not each go and ask it again.
    const result = await this.refreshFromBackend();
    const fresh = this.getCurrentToken();
    if (result === 'ok' && fresh && fresh !== rejected) return { kind: 'renewed', token: fresh };
    return result === 'transient' ? { kind: 'transient' } : { kind: 'failed' };
  }

  /**
   * Startup, backend mode: finish a sign-in the callback page brought back,
   * else renew a token that is expired or about to be. Nothing interactive.
   */
  async restoreSession(): Promise<void> {
    if (!browser || !this.isBackendMode()) return;
    const callback = takeCallback();
    if (callback.kind === 'code') {
      // An unfinished sign-out goes first: run after the sign-in, it would
      // clear the cookie this sign-in is about to set.
      await this.settlePendingLogout();
      await this.completeSignIn(callback.code, callback.verifier);
      return;
    }
    if (callback.kind === 'denied') {
      showSnackbar(
        callback.error === 'access_denied'
          ? 'Google Drive sign-in was cancelled.'
          : 'Google Drive sign-in did not finish. Please try again.'
      );
    } else if (callback.kind === 'refused') {
      console.warn('Google sign-in answer refused:', callback.reason);
      // The user finished Google's screens and came back to nothing: say so.
      // (no_pending: not a sign-in this tab started — nothing to retry.)
      if (callback.reason !== 'no_pending') {
        showSnackbar('Google Drive sign-in did not finish. Click Connect to try again.');
      }
    }
    if (this.isAuthenticated() && !this.validFor(DEFAULT_MIN_VALIDITY_MS)) {
      await this.refreshFromBackend(true);
    }
  }

  private async completeSignIn(code: string, verifier: string): Promise<void> {
    const outcome = await callWithProof('session', { code, code_verifier: verifier });
    if (outcome.kind === 'ok') {
      // The new cookie replaced whatever an unfinished sign-out left behind.
      setLogoutPending(null);
      this.applyBackendToken(outcome.accessToken, outcome.expiresIn);
      const { setActiveProviderKey } = await import('../../provider-detection');
      setActiveProviderKey('google-drive');
      console.log('✅ Google Drive signed in through the auth backend');
      return;
    }
    if (outcome.kind === 'unavailable') {
      markBackendUnavailable();
      showSnackbar('Google Drive sign-in could not finish here. Click Connect to sign in again.');
      return;
    }
    if (outcome.kind === 'refused' && outcome.error === 'consent_incomplete') {
      showSnackbar('Google Drive needs access to its files to sync. Please sign in and allow it.');
      return;
    }
    showSnackbar('Google Drive sign-in failed. Please try again.');
  }

  /**
   * Leave for Google's sign-in page (backend mode, a user's click). The page
   * navigates away; the next load finishes the sign-in (`restoreSession`).
   * The active provider is NOT switched here: a sign-in abandoned on Google's
   * page must leave the app as it was. The callback's answer itself makes the
   * next boot load Drive (`hasPendingCallback`), and only a completed sign-in
   * makes Drive the provider.
   */
  async beginSignIn(): Promise<void> {
    await startSignIn();
  }

  /**
   * Connect from the cloud page, backend mode. A live session cookie (signed
   * in before, local state since lost) reconnects silently; otherwise a
   * full-page sign-in starts — when `interactive`, never from background code.
   * `popup` when the implicit flow should run instead.
   */
  async connectViaBackend(interactive: boolean): Promise<'connected' | 'redirecting' | 'popup'> {
    this.backendSessionDead = false;
    const result = await this.refreshFromBackend(true);
    if (result === 'ok') return 'connected';
    if (result === 'unavailable') return 'popup';
    if (result === 'transient') {
      if (this.backendFailures >= FALLBACK_AFTER_FAILURES && this.hasTokenClient()) return 'popup';
      throw new Error('Google sign-in is unavailable right now. Try again in a moment.');
    }
    if (!interactive) throw new Error('Connect Google Drive from the cloud page to sign in.');
    await this.beginSignIn();
    return 'redirecting';
  }

  /** After a re-auth, pull cloud state at once (see the token callback). */
  private async runPostReauthSync(accessToken: string): Promise<void> {
    try {
      const { unifiedCloudManager } = await import('../../unified-cloud-manager');
      await unifiedCloudManager.fetchAllCloudVolumes();
      const result = await unifiedCloudManager.syncProgress({ silent: true });
      if (result.succeeded > 0) this.injectedClient?.worked(accessToken);
      console.log('✅ Post-reauth sync completed');
    } catch (error) {
      console.warn('Post-reauth sync failed:', error);
    }
  }
}

export const tokenManager = new TokenManager();
