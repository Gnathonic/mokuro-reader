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

  /**
   * Returns true when the app booted from a OneDrive redirect callback that
   * the user is currently waiting on. Init-providers uses this to skip
   * unrelated bootstrap work and let the UI surface "connected" instead.
   */
  hasPendingRedirect(): boolean {
    if (!browser) return false;
    if (localStorage.getItem(PENDING_LOGIN_KEY) !== 'true') return false;
    const url = new URL(window.location.href);
    return url.searchParams.has('code') || url.searchParams.has('error');
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
    await this.instance.loginRedirect(request);
  }

  async logout(): Promise<void> {
    if (this.instance && this.account) {
      await this.instance.logoutRedirect({
        account: this.account,
        postLogoutRedirectUri: window.location.origin
      });
    }
    this.account = null;
    this.tokenStore.set('');
    this.needsAttentionStore.set(false);
    if (browser) {
      localStorage.removeItem(ONEDRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED);
      localStorage.removeItem(PENDING_LOGIN_KEY);
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
    await this.instance.acquireTokenRedirect(request);
  }
}

export const onedriveTokenManager = new OneDriveTokenManager();
