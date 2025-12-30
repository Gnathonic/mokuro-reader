import { browser } from '$app/environment';

declare global {
	interface Window {
		__TAURI__?: unknown;
		__TAURI_INTERNALS__?: unknown;
	}
}

/**
 * Detect if running inside Tauri
 * Tauri v2 uses __TAURI_INTERNALS__, v1 used __TAURI__
 */
export function isTauri(): boolean {
	if (!browser) return false;
	// Tauri v2 uses __TAURI_INTERNALS__
	if (typeof window.__TAURI_INTERNALS__ !== 'undefined') return true;
	// Tauri v1 fallback
	if (typeof window.__TAURI__ !== 'undefined') return true;
	return false;
}

/**
 * Detect if running as a web app (not in Tauri)
 */
export function isWeb(): boolean {
	return browser && !isTauri();
}
