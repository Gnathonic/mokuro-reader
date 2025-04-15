// Token management utilities
import type { TokenResponse, RefreshTokenRequest, AuthError } from '$lib/types/auth';

// Constants
const TOKEN_STORAGE_KEY = 'gdrive_token';
const TOKEN_EXPIRY_KEY = 'gdrive_token_expiry';
const REFRESH_TOKEN_STORAGE_KEY = 'gdrive_refresh_token';

/**
 * Saves the access token and its expiration time to localStorage
 */
export function saveToken(accessToken: string, expiresIn: number): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, accessToken);
  
  // Calculate expiry time (current time + expires_in seconds)
  const expiryTime = Date.now() + expiresIn * 1000;
  localStorage.setItem(TOKEN_EXPIRY_KEY, expiryTime.toString());
}

/**
 * Saves the refresh token to localStorage
 * Note: In a production environment, refresh tokens should be stored securely on the server
 * This is a simplified implementation for the client-side only approach
 */
export function saveRefreshToken(refreshToken: string): void {
  localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, refreshToken);
}

/**
 * Gets the stored access token
 */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

/**
 * Gets the stored refresh token
 */
export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);
}

/**
 * Checks if the current token is expired or about to expire
 * Returns true if the token expires in less than 5 minutes
 */
export function isTokenExpired(): boolean {
  const expiryTime = localStorage.getItem(TOKEN_EXPIRY_KEY);
  if (!expiryTime) return true;
  
  // Token is considered expired if it expires in less than 5 minutes
  const bufferTime = 5 * 60 * 1000; // 5 minutes in milliseconds
  return Date.now() + bufferTime > parseInt(expiryTime, 10);
}

/**
 * Clears all token information from storage
 */
export function clearTokens(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
  localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
}

/**
 * Refreshes the access token using the stored refresh token
 * Returns the new access token if successful, null otherwise
 */
export async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  
  if (!refreshToken) {
    console.error('No refresh token available');
    return null;
  }
  
  try {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ refresh_token: refreshToken } as RefreshTokenRequest)
    });
    
    const data = await response.json() as TokenResponse | AuthError;
    
    if ('error' in data || !('access_token' in data)) {
      console.error('Error refreshing token:', 'error' in data ? data.error : 'No access token returned');
      return null;
    }
    
    // Save the new token and its expiry time
    saveToken(data.access_token, data.expires_in);
    
    return data.access_token;
  } catch (error) {
    console.error('Error refreshing access token:', error);
    return null;
  }
}

/**
 * Gets a valid access token, refreshing it if necessary
 * Returns the access token if available and valid, null otherwise
 */
export async function getValidToken(): Promise<string | null> {
  const currentToken = getToken();
  
  // If we have a token and it's not expired, return it
  if (currentToken && !isTokenExpired()) {
    return currentToken;
  }
  
  // Otherwise, try to refresh the token
  return await refreshAccessToken();
}

/**
 * Initializes the auth system by parsing tokens from URL hash if present
 * This is used when returning from the OAuth flow
 */
export function initFromUrlHash(): void {
  if (typeof window === 'undefined') return;
  
  const hash = window.location.hash;
  if (!hash) return;
  
  // Parse access_token and expires_in from URL hash
  const params = new URLSearchParams(hash.substring(1));
  const accessToken = params.get('access_token');
  const expiresIn = params.get('expires_in');
  
  if (accessToken && expiresIn) {
    saveToken(accessToken, parseInt(expiresIn, 10));
    
    // Clean up the URL by removing the hash
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

/**
 * Initiates the OAuth flow to get a new access token and refresh token
 */
export function initiateOAuthFlow(): void {
  const CLIENT_ID = import.meta.env.VITE_GDRIVE_CLIENT_ID;
  const REDIRECT_URI = import.meta.env.VITE_GDRIVE_REDIRECT_URI || window.location.origin + '/api/auth/callback';
  
  // Build the OAuth URL
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.append('client_id', CLIENT_ID);
  authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('scope', 'https://www.googleapis.com/auth/drive.file');
  authUrl.searchParams.append('access_type', 'offline');
  authUrl.searchParams.append('prompt', 'consent'); // Force consent screen to get refresh token
  
  // Redirect to Google's OAuth page
  window.location.href = authUrl.toString();
}