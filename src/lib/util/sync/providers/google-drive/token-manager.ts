import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { GOOGLE_DRIVE_CONFIG } from './constants';
import { showSnackbar } from '$lib/util/snackbar';
import { isTauri } from '$lib/util/tauri';
import {
	initTauriOAuth,
	startTauriOAuth,
	setTokenCallback,
	setErrorCallback,
	refreshAccessToken
} from './tauri-oauth';

class TokenManager {
  private tokenStore = writable<string>('');
  private tokenClientStore = writable<any>(null);
  private needsAttentionStore = writable<boolean>(false);
  private refreshIntervalId: number | null = null;
  private isRefreshing = false;

  constructor() {
    if (browser) {
      this.loadPersistedToken();
      this.setupTokenRefreshInterval();
      this.setupTauriOAuth();
    }
  }

  private setupTauriOAuth(): void {
    if (!isTauri()) return;

    // Set up callbacks for Tauri OAuth (with refresh token support)
    setTokenCallback((token: string, expiresIn: number, refreshToken?: string) => {
      this.setToken(token, expiresIn, refreshToken);

      // Also set token in gapi.client if available
      if (typeof gapi !== 'undefined' && gapi.client) {
        gapi.client.setToken({ access_token: token });
      }

      // Update provider manager to trigger reactive updates
      import('../../provider-manager').then(({ providerManager }) => {
        providerManager.updateStatus();
      });
    });

    setErrorCallback((error: string) => {
      console.error('Tauri OAuth error:', error);
      this.needsAttentionStore.set(true);

      if (error === 'access_denied') {
        this.clearToken(false);
        showSnackbar('Google Drive access was denied. Please sign in again to grant permissions.');
      } else {
        this.clearToken(true);
        showSnackbar('Authentication failed. Please try signing in again.');
      }
    });

    // Initialize Tauri OAuth listener
    initTauriOAuth().catch((error) => {
      console.error('Failed to initialize Tauri OAuth:', error);
    });
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

      if (expiry <= now) {
        // Token expired - try silent refresh in Tauri
        const refreshToken = localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.REFRESH_TOKEN);
        if (isTauri() && refreshToken) {
          // Defer silent refresh to after initialization
          setTimeout(() => this.silentRefresh(), 100);
        } else {
          this.needsAttentionStore.set(true);
        }
        // DON'T clear the token - keep it for auth history
      }
    }
  }

  private setupTokenRefreshInterval(): void {
    // Clear any existing interval
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }

    // Token expiry monitor with silent refresh for Tauri
    this.refreshIntervalId = window.setInterval(async () => {
      const expiresAt = localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN_EXPIRES);
      if (!expiresAt || !this.isAuthenticated()) return;

      const now = Date.now();
      const expiry = parseInt(expiresAt, 10);
      const timeUntilExpiry = expiry - now;

      // In Tauri with refresh token: silently refresh 5 minutes before expiry
      if (isTauri() && !this.isRefreshing) {
        const refreshToken = localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.REFRESH_TOKEN);

        if (refreshToken && timeUntilExpiry <= 5 * 60 * 1000 && timeUntilExpiry > 0) {
          await this.silentRefresh();
          return;
        }

        // Token expired but we have refresh token - try to refresh
        if (refreshToken && timeUntilExpiry <= 0) {
          const success = await this.silentRefresh();
          if (!success) {
            this.needsAttentionStore.set(true);
          }
          return;
        }
      }

      // Token expired - set attention flag (web app behavior)
      if (timeUntilExpiry <= 0) {
        this.needsAttentionStore.set(true);
        return;
      }
    }, GOOGLE_DRIVE_CONFIG.TOKEN_REFRESH_CHECK_INTERVAL_MS);
  }

  /**
   * Silently refresh the access token using refresh token (Tauri only)
   */
  private async silentRefresh(): Promise<boolean> {
    if (!isTauri() || this.isRefreshing) return false;

    const refreshToken = localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.REFRESH_TOKEN);
    if (!refreshToken) return false;

    this.isRefreshing = true;

    try {
      const result = await refreshAccessToken(refreshToken);

      if (result) {
        this.setToken(result.accessToken, result.expiresIn);

        // Update gapi.client
        if (typeof gapi !== 'undefined' && gapi.client) {
          gapi.client.setToken({ access_token: result.accessToken });
        }

        this.isRefreshing = false;
        return true;
      }
    } catch (error) {
      console.error('Silent refresh failed:', error);
    }

    this.isRefreshing = false;
    return false;
  }

  setToken(token: string, expiresIn?: number, refreshToken?: string): void {
    this.tokenStore.set(token);
    this.isRefreshing = false;
    this.needsAttentionStore.set(false); // Clear attention flag when token is set

    if (browser) {
      localStorage.setItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN, token);
      localStorage.setItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.LAST_AUTH_TIME, Date.now().toString());
      localStorage.setItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED, 'true');

      // Store refresh token if provided (Tauri only)
      if (refreshToken) {
        localStorage.setItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.REFRESH_TOKEN, refreshToken);
      }

      if (expiresIn) {
        // Debug mode: Override expiry to 30 seconds for testing
        const actualExpiresIn = GOOGLE_DRIVE_CONFIG.DEBUG_SHORT_TOKEN_EXPIRY ? 30 : expiresIn;
        const expiresAt = Date.now() + actualExpiresIn * 1000;
        localStorage.setItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN_EXPIRES, expiresAt.toString());
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

      // Only clear auth history and refresh token on explicit logout
      if (!keepAuthHistory) {
        localStorage.removeItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED);
        localStorage.removeItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.REFRESH_TOKEN);
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

  async revokeToken(token: string): Promise<void> {
    try {
      await fetch(`${GOOGLE_DRIVE_CONFIG.OAUTH_ENDPOINT}?token=${token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
    } catch (error) {
      console.error('Error revoking token:', error);
    }
  }

  /**
   * Wait for google Identity Services global to be available (loaded from script tag)
   */
  private async waitForGoogleIdentity(): Promise<void> {
    if (typeof google !== 'undefined' && google?.accounts?.oauth2) return;

    const maxWait = 10000; // 10 seconds
    const start = Date.now();

    while (typeof google === 'undefined' || !google?.accounts?.oauth2) {
      if (Date.now() - start > maxWait) {
        throw new Error('Timeout waiting for Google Identity Services to load');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async initTokenClient(): Promise<void> {
    // In Tauri, we use our own OAuth flow - just set up gapi token if we have one
    if (isTauri()) {
      // If we have a persisted token, set it in gapi.client
      const currentToken = this.getCurrentToken();
      if (currentToken && typeof gapi !== 'undefined' && gapi.client) {
        gapi.client.setToken({ access_token: currentToken });
      }
      return;
    }

    // Wait for google Identity Services to be available
    await this.waitForGoogleIdentity();

    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_DRIVE_CONFIG.CLIENT_ID,
      scope: GOOGLE_DRIVE_CONFIG.SCOPES,
      callback: (response: any) => {
        if (response?.error) {
          console.error('Token client error:', response.error, response.error_description);

          // Handle specific error cases
          if (response.error === 'access_denied') {
            // User denied access OR permissions were revoked server-side by user/Google
            // Clear auth history to force full consent screen on next attempt
            this.clearToken(false);
            this.needsAttentionStore.set(true);
            showSnackbar(
              'Google Drive access was denied. Please sign in again to grant permissions.'
            );
          } else if (response.error === 'popup_closed') {
            // User closed the popup - don't clear anything, they might retry
            // Preserve all state so they can try again immediately
            showSnackbar('Sign-in cancelled. Please try again when ready.');
          } else if (
            response.error === 'popup_failed_to_open' ||
            response.error === 'popup_blocked'
          ) {
            // Popup was blocked by browser
            console.log('Popup was blocked by browser');
            showSnackbar('Popup blocked. Please allow popups for this site and try again.');
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
        }
      }
    });

    this.tokenClientStore.set(tokenClient);

    // If we have a persisted token in the store, set it in gapi.client now that gapi is loaded
    const currentToken = this.getCurrentToken();
    if (currentToken && typeof gapi !== 'undefined' && gapi.client) {
      gapi.client.setToken({ access_token: currentToken });
    }
  }

  requestNewToken(forceConsent = false): void {
    // In Tauri, use the loopback OAuth flow
    if (isTauri()) {
      startTauriOAuth().catch((error) => {
        console.error('Failed to start Tauri OAuth:', error);
        showSnackbar('Failed to open authentication page');
      });
      return;
    }

    const tokenClient = this.tokenClientStore;
    let client: any;

    tokenClient.subscribe((value) => {
      client = value;
    })();

    if (client) {
      // Determine if user has authenticated before
      const hasAuthenticated =
        browser &&
        localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED) === 'true';

      if (forceConsent || !hasAuthenticated) {
        // Force full consent screen (for initial auth or when explicitly requested)
        client.requestAccessToken({ prompt: 'consent' });
      } else {
        // Re-authentication: minimal UI, just account selection, reuse existing permissions
        client.requestAccessToken({});
      }
    } else {
      throw new Error('Token client not initialized');
    }
  }

  async logout(): Promise<void> {
    // Clear the refresh interval
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }

    const currentToken = this.getCurrentToken();

    if (currentToken) {
      await this.revokeToken(currentToken);
    }

    // Clear token AND auth history on explicit logout
    this.clearToken(false);
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
    const currentToken = this.getCurrentToken();
    const hasToken = currentToken !== '';

    return hasAuthHistory && hasToken;
  }

  /**
   * Check if we have a refresh token available (Tauri only)
   */
  hasRefreshToken(): boolean {
    if (!isTauri()) return false;
    return !!localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.REFRESH_TOKEN);
  }

  getTimeUntilExpiry(): number | null {
    const expiresAt = localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN_EXPIRES);
    if (!expiresAt) return null;

    const expiry = parseInt(expiresAt, 10);
    return expiry - Date.now();
  }

  getExpiryMinutes(): number | null {
    const timeLeft = this.getTimeUntilExpiry();
    return timeLeft ? Math.round(timeLeft / 60000) : null;
  }

  // Manual re-authentication (minimal UI, reuses existing permissions)
  reAuthenticate(): void {
    this.requestNewToken(false);
  }
}

export const tokenManager = new TokenManager();
