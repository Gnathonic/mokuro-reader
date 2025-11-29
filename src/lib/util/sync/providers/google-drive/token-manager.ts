import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { GOOGLE_DRIVE_CONFIG } from './constants';
import { showSnackbar } from '$lib/util/snackbar';

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

  setToken(token: string, expiresIn?: number): void {
    this.tokenStore.set(token);
    this.isRefreshing = false;
    this.needsAttentionStore.set(false); // Clear attention flag when token is set

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

    console.log('⏳ Waiting for Google Identity Services to load...');
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

  async initTokenClient(): Promise<void> {
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
      console.log('Restored persisted token to gapi.client');
    }
  }

  requestNewToken(forceConsent = false): void {
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
    const hasToken = this.getCurrentToken() !== '';

    return hasAuthHistory && hasToken;
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
    console.log('🔄 reAuthenticate() called');
    this.requestNewToken(false);
  }
}

export const tokenManager = new TokenManager();
