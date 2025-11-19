import { browser } from '$app/environment';
import type { ProviderType } from './provider-interface';

export const ACTIVE_PROVIDER_KEY = 'active_cloud_provider';

/**
 * Get the currently active provider type
 * Returns null if no provider is configured
 */
export function getConfiguredProviderType(): ProviderType | null {
	if (!browser) return null;
	return localStorage.getItem(ACTIVE_PROVIDER_KEY) as ProviderType | null;
}

/**
 * Set the active provider type
 * Called on successful login
 */
export function setActiveProvider(provider: ProviderType): void {
	if (!browser) return;
	localStorage.setItem(ACTIVE_PROVIDER_KEY, provider);
}

/**
 * Clear the active provider
 * Called on logout
 */
export function clearActiveProvider(): void {
	if (!browser) return;
	localStorage.removeItem(ACTIVE_PROVIDER_KEY);
}
