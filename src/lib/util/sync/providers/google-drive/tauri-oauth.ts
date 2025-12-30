/**
 * Tauri-specific OAuth implementation using authorization code flow with PKCE
 * This allows us to get refresh tokens for silent token refresh
 */
import { isTauri } from '$lib/util/tauri';
import { GOOGLE_DRIVE_CONFIG } from './constants';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_PORT = 17548; // Fixed port for OAuth callback

// Callback function to be set by token manager
let onTokenReceived: ((accessToken: string, expiresIn: number, refreshToken?: string) => void) | null = null;
let onAuthError: ((error: string) => void) | null = null;

// Cleanup function for event listener
let unlistenToken: (() => void) | null = null;
let unlistenError: (() => void) | null = null;

/**
 * Generate a cryptographically random string for PKCE code verifier
 */
function generateCodeVerifier(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return base64UrlEncode(array);
}

/**
 * Generate code challenge from verifier using SHA-256
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Base64 URL encode (RFC 4648)
 */
function base64UrlEncode(buffer: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < buffer.length; i++) {
		binary += String.fromCharCode(buffer[i]);
	}
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/**
 * Initialize Tauri OAuth - set up event listeners for OAuth responses
 */
export async function initTauriOAuth(): Promise<void> {
	console.log('[TauriOAuth] initTauriOAuth called, isTauri:', isTauri());
	if (!isTauri()) return;

	try {
		const { listen } = await import('@tauri-apps/api/event');

		// Listen for successful token (now includes refresh_token)
		unlistenToken = await listen<{ access_token: string; expires_in: number; refresh_token?: string }>(
			'oauth-token',
			(event) => {
				console.log('[TauriOAuth] Received oauth-token event');
				const { access_token, expires_in, refresh_token } = event.payload;
				if (onTokenReceived) {
					onTokenReceived(access_token, expires_in, refresh_token);
				}
			}
		);

		// Listen for errors
		unlistenError = await listen<string>('oauth-error', (event) => {
			console.error('[TauriOAuth] Received oauth-error event:', event.payload);
			if (onAuthError) {
				onAuthError(event.payload);
			}
		});

		console.log('[TauriOAuth] Event listeners initialized');
	} catch (error) {
		console.error('[TauriOAuth] Failed to initialize:', error);
	}
}

/**
 * Start OAuth flow using authorization code with PKCE
 * Opens system browser and starts local server to receive callback
 */
export async function startTauriOAuth(): Promise<void> {
	console.log('[TauriOAuth] startTauriOAuth called');
	if (!isTauri()) {
		throw new Error('startTauriOAuth called outside of Tauri context');
	}

	// Generate PKCE code verifier and challenge
	const codeVerifier = generateCodeVerifier();
	const codeChallenge = await generateCodeChallenge(codeVerifier);

	// Generate state for CSRF protection
	const state = crypto.randomUUID();
	const redirectUri = `http://127.0.0.1:${OAUTH_PORT}/callback`;

	console.log('[TauriOAuth] Starting OAuth with PKCE, redirect:', redirectUri);

	try {
		// Start the Rust OAuth server with code verifier for token exchange
		const { invoke } = await import('@tauri-apps/api/core');
		await invoke('start_oauth_server', {
			state,
			port: OAUTH_PORT,
			codeVerifier,
			clientId: GOOGLE_DRIVE_CONFIG.CLIENT_ID,
			clientSecret: GOOGLE_DRIVE_CONFIG.CLIENT_SECRET || '',
			redirectUri
		});
		console.log('[TauriOAuth] OAuth server started');

		// Build the OAuth URL for authorization code flow with PKCE
		const params = new URLSearchParams({
			client_id: GOOGLE_DRIVE_CONFIG.CLIENT_ID,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: GOOGLE_DRIVE_CONFIG.SCOPES,
			state: state,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
			access_type: 'offline', // Request refresh token
			prompt: 'consent' // Force consent to get refresh token
		});

		const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

		// Open in system browser
		console.log('[TauriOAuth] Opening browser...');
		const { open } = await import('@tauri-apps/plugin-shell');
		await open(authUrl);
		console.log('[TauriOAuth] Browser opened');
	} catch (error) {
		console.error('[TauriOAuth] Failed to start OAuth:', error);
		if (onAuthError) {
			onAuthError('Failed to start authentication');
		}
	}
}

/**
 * Refresh access token using refresh token (Tauri only)
 * Returns new access token and expiry, or null if refresh failed
 */
export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number } | null> {
	if (!isTauri()) {
		return null;
	}

	try {
		const { invoke } = await import('@tauri-apps/api/core');
		const result = await invoke<{ access_token: string; expires_in: number }>('refresh_oauth_token', {
			refreshToken,
			clientId: GOOGLE_DRIVE_CONFIG.CLIENT_ID,
			clientSecret: GOOGLE_DRIVE_CONFIG.CLIENT_SECRET || ''
		});

		console.log('[TauriOAuth] Token refreshed successfully');
		return {
			accessToken: result.access_token,
			expiresIn: result.expires_in
		};
	} catch (error) {
		console.error('[TauriOAuth] Failed to refresh token:', error);
		return null;
	}
}

/**
 * Set callback for when token is received
 */
export function setTokenCallback(callback: (accessToken: string, expiresIn: number, refreshToken?: string) => void): void {
	onTokenReceived = callback;
}

/**
 * Set callback for auth errors
 */
export function setErrorCallback(callback: (error: string) => void): void {
	onAuthError = callback;
}

/**
 * Check if Tauri OAuth is available
 */
export function isTauriOAuthAvailable(): boolean {
	return isTauri() && !!GOOGLE_DRIVE_CONFIG.CLIENT_ID;
}
