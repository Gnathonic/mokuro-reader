import { derived, writable, type Readable } from 'svelte/store';
import type { ProviderStatus } from './provider-interface';
import { cacheManager } from './cache-manager';
import { providerManager } from './provider-manager';

/**
 * Unified provider state that combines:
 * - Provider authentication status
 * - Cache loading/loaded state
 * - Provider availability
 */
export interface UnifiedProviderState {
  /** Whether a provider is authenticated and connected */
  isAuthenticated: boolean;
  /** Whether credentials are configured (even if not currently connected) */
  hasStoredCredentials: boolean;
  /** Whether the cache is currently loading */
  isCacheLoading: boolean;
  /** Whether the cache has been loaded at least once */
  isCacheLoaded: boolean;
  /** Whether provider is fully connected (authenticated + cache loaded) */
  isFullyConnected: boolean;
  /** Whether provider needs user attention (e.g., re-authentication) */
  needsAttention: boolean;
  /** Status message from provider */
  statusMessage: string;
}

/**
 * Create a reactive store that combines provider status and cache state
 */
function createUnifiedProviderState(): Readable<UnifiedProviderState> {
  // Track cache loading transitions to know when it's actually loaded
  let wasLoading = false;
  let hasLoadedOnce = false;

  return derived(
    [cacheManager.isFetchingState, providerManager.status],
    ([$isCacheLoading, $providerStatus]) => {
      // Track when cache finishes loading (transition from loading -> not loading)
      if (wasLoading && !$isCacheLoading) {
        hasLoadedOnce = true;
      }
      wasLoading = $isCacheLoading;

      // Check if ANY provider has stored credentials (synchronous, immediate on page load)
      // This ensures UI shows yellow "Initializing..." immediately
      const hasStoredCredentials =
        $providerStatus.providers['google-drive']?.hasStoredCredentials ||
        $providerStatus.providers['mega']?.hasStoredCredentials ||
        $providerStatus.providers['webdav']?.hasStoredCredentials ||
        false;

      // Get the configured provider type (if any)
      const configuredType = $providerStatus.currentProviderType;

      // If no provider configured, return minimal state
      if (!configuredType) {
        return {
          isAuthenticated: false,
          hasStoredCredentials,
          isCacheLoading: $isCacheLoading,
          isCacheLoaded: hasLoadedOnce,
          isFullyConnected: false,
          needsAttention: false,
          statusMessage: 'No provider connected'
        };
      }

      // Get status for the configured provider
      const status = $providerStatus.providers[configuredType];

      // If status not yet available, return credentials-only state
      if (!status) {
        return {
          isAuthenticated: false,
          hasStoredCredentials,
          isCacheLoading: $isCacheLoading,
          isCacheLoaded: hasLoadedOnce,
          isFullyConnected: false,
          needsAttention: false,
          statusMessage: 'Initializing...'
        };
      }

      const isFullyConnected = status.isAuthenticated && hasLoadedOnce && !$isCacheLoading;

      return {
        isAuthenticated: status.isAuthenticated,
        hasStoredCredentials: status.hasStoredCredentials,
        isCacheLoading: $isCacheLoading,
        isCacheLoaded: hasLoadedOnce,
        isFullyConnected,
        needsAttention: status.needsAttention,
        statusMessage: status.statusMessage
      };
    }
  );
}

/**
 * Unified provider state store
 * Automatically updates when active provider or cache state changes
 */
export const unifiedProviderState = createUnifiedProviderState();
