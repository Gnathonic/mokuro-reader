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

      // Use a dedicated static HTML callback page that bypasses SvelteKit's
      // hash-based router. Our app would otherwise try to interpret MSAL's
      // fragment-mode auth response as a route, dropping the auth code before
      // MSAL can read it. The static page is served from /static/ directly.
      const redirectUri = `${window.location.origin}/onedrive-callback.html`;

      // Stash the client ID where the static callback page can find it.
      // Same-origin sessionStorage is shared between opener and popup.
      sessionStorage.setItem('onedrive_client_id', clientId);

      const config: Configuration = {
        auth: {
          clientId,
          authority: ONEDRIVE_CONFIG.AUTHORITY,
          redirectUri
        },
        cache: {
          cacheLocation: 'localStorage',
          // Default is sessionStorage which is per-window and unreachable
          // from the popup callback. We need both opener and popup to share
          // the PKCE verifier and pending-request entries.
          temporaryCacheLocation: 'localStorage'
        }
      };
      this.instance = new this.msal.PublicClientApplication(config);
      await this.instance.initialize();

      // Drain any pending interaction state from a previous (possibly
      // abandoned) popup, and process popup-flow redirects when this code
      // runs inside a popup window.
      try {
        const result = await this.instance.handleRedirectPromise();
        if (result?.account) {
          this.account = result.account;
          this.instance.setActiveAccount(result.account);
          this.tokenStore.set(result.accessToken);
        }
      } catch (error) {
        console.warn('OneDrive handleRedirectPromise failed:', error);
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

  async login(): Promise<void> {
    await this.initialize();
    if (!this.instance || !this.msal) {
      throw new Error('MSAL instance not initialized');
    }

    const request: PopupRequest = { scopes: ONEDRIVE_CONFIG.SCOPES as unknown as string[] };

    let result: AuthenticationResult;
    try {
      result = await this.instance.loginPopup(request);
    } catch (error) {
      // Stale interaction state from a previous popup that didn't complete.
      // Clear it and retry once.
      const code = (error as { errorCode?: string })?.errorCode;
      if (code === 'interaction_in_progress') {
        try {
          await this.instance.handleRedirectPromise();
        } catch {
          /* ignore */
        }
        // MSAL stores the interaction status under a key in localStorage.
        // Clearing it lets the next loginPopup() proceed.
        if (browser) {
          for (const key of Object.keys(localStorage)) {
            if (key.startsWith('msal.interaction.status') || key.endsWith('.interaction.status')) {
              localStorage.removeItem(key);
            }
          }
        }
        result = await this.instance.loginPopup(request);
      } else {
        throw error;
      }
    }

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
   * Popup-based re-authentication. Used by the UI when silent refresh fails
   * and the user clicks a "reconnect" action.
   */
  async reauthenticate(): Promise<void> {
    await this.initialize();
    if (!this.instance) {
      throw new Error('MSAL not initialized');
    }
    const request: PopupRequest = {
      scopes: ONEDRIVE_CONFIG.SCOPES as unknown as string[],
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
