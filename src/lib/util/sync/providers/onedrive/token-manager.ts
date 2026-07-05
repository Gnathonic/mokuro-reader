import { browser } from '$app/environment';
import { writable, type Readable } from 'svelte/store';
import type {
  PublicClientApplication,
  AccountInfo,
  Configuration,
  RedirectRequest,
  SilentRequest
} from '@azure/msal-browser';
import { ONEDRIVE_CONFIG } from './constants';

type Msal = typeof import('@azure/msal-browser');

const PENDING_LOGIN_KEY = 'onedrive_login_pending';

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
   * Uses redirect-based auth (not popup): cleaner cross-window state, no
   * popup blockers, and avoids the need for a separate callback page.
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
          cacheLocation: 'localStorage'
        }
      };
      this.instance = new this.msal.PublicClientApplication(config);
      await this.instance.initialize();

      // If we just returned from a redirect-flow login, this completes it.
      try {
        const result = await this.instance.handleRedirectPromise();
        if (result?.account) {
          this.account = result.account;
          this.instance.setActiveAccount(result.account);
          this.tokenStore.set(result.accessToken);
          localStorage.setItem(ONEDRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED, 'true');
          localStorage.removeItem(PENDING_LOGIN_KEY);
        } else if (localStorage.getItem(PENDING_LOGIN_KEY) === 'true') {
          // We were waiting for a redirect that never produced a result —
          // either the user navigated away or auth failed silently. Clear
          // the flag so the user can retry.
          localStorage.removeItem(PENDING_LOGIN_KEY);
        }
      } catch (error) {
        console.warn('OneDrive handleRedirectPromise failed:', error);
        localStorage.removeItem(PENDING_LOGIN_KEY);
      }

      // Restore account from MSAL cache (if a previous session exists)
      if (!this.account) {
        const accounts = this.instance.getAllAccounts();
        if (accounts.length > 0) {
          this.account = accounts[0];
          this.instance.setActiveAccount(this.account);
        }
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

  /**
   * Start the redirect-based login flow. The whole window navigates to
   * Microsoft's login page; after auth the user lands back on the app's
   * origin and `initialize()` calls `handleRedirectPromise()` to complete
   * the sign-in. Because this navigates the window, this method does not
   * resolve in the normal sense — the caller's await never returns from
   * the user's perspective; the next page load is the post-auth state.
   */
  async login(): Promise<void> {
    await this.initialize();
    if (!this.instance || !this.msal) {
      throw new Error('MSAL instance not initialized');
    }
    // Mark the redirect as in-flight so init-providers can detect the
    // callback path on the next page load.
    localStorage.setItem(PENDING_LOGIN_KEY, 'true');

    const request: RedirectRequest = {
      scopes: ONEDRIVE_CONFIG.SCOPES as unknown as string[]
    };
    try {
      await this.instance.loginRedirect(request);
    } catch (error) {
      localStorage.removeItem(PENDING_LOGIN_KEY);
      throw this.translateInteractionError(error);
    }
  }

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

  /**
   * Acquire an access token silently. Throws if MSAL signals interaction
   * required (the caller should prompt the user via reauthenticate()).
   */
  async getAccessToken(): Promise<string> {
    await this.initialize();
    if (!this.instance || !this.account || !this.msal) {
      throw new Error('Not authenticated with OneDrive');
    }
    const request: SilentRequest = {
      scopes: ONEDRIVE_CONFIG.SCOPES as unknown as string[],
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

  /** Flag the session as needing user re-authentication (e.g. Graph 401). */
  markNeedsAttention(): void {
    this.needsAttentionStore.set(true);
  }

  /**
   * Redirect-based re-authentication. Used by the UI when silent refresh
   * fails and the user clicks a "reconnect" action.
   */
  async reauthenticate(): Promise<void> {
    await this.initialize();
    if (!this.instance) {
      throw new Error('MSAL not initialized');
    }
    localStorage.setItem(PENDING_LOGIN_KEY, 'true');
    const request: RedirectRequest = {
      scopes: ONEDRIVE_CONFIG.SCOPES as unknown as string[],
      account: this.account ?? undefined
    };
    try {
      await this.instance.acquireTokenRedirect(request);
    } catch (error) {
      localStorage.removeItem(PENDING_LOGIN_KEY);
      throw this.translateInteractionError(error);
    }
  }
}

export const onedriveTokenManager = new OneDriveTokenManager();
