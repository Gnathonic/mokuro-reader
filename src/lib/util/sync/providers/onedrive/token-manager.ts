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
          cacheLocation: 'localStorage'
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

    const request: PopupRequest = { scopes: ONEDRIVE_CONFIG.SCOPES as unknown as string[] };
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
