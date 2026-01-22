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
  /** Whether there's an active provider configured (via active_cloud_provider key) */
  hasActiveProvider: boolean;
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
  /** Whether the provider is in read-only mode (e.g., WebDAV without write permissions) */
  isReadOnly: boolean;
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

      // Get the configured provider type from active_cloud_provider key
      // This is the authoritative source - properly clears on logout
      const configuredType = $providerStatus.currentProviderType;
      const hasActiveProvider = configuredType !== null;

      // If no provider configured, return minimal state
      if (!configuredType) {
        return {
          isAuthenticated: false,
          hasActiveProvider: false,
          isCacheLoading: $isCacheLoading,
          isCacheLoaded: hasLoadedOnce,
          isFullyConnected: false,
          needsAttention: false,
          statusMessage: 'No provider connected',
          isReadOnly: false
        };
      }

      // Get status for the configured provider
      const status = $providerStatus.providers[configuredType];

      // If status not yet available, return initializing state
      if (!status) {
        return {
          isAuthenticated: false,
          hasActiveProvider,
          isCacheLoading: $isCacheLoading,
          isCacheLoaded: hasLoadedOnce,
          isFullyConnected: false,
          needsAttention: false,
          statusMessage: 'Initializing...',
          isReadOnly: false
        };
      }

      const isFullyConnected = status.isAuthenticated && hasLoadedOnce && !$isCacheLoading;

      return {
        isAuthenticated: status.isAuthenticated,
        hasActiveProvider,
        isCacheLoading: $isCacheLoading,
        isCacheLoaded: hasLoadedOnce,
        isFullyConnected,
        needsAttention: status.needsAttention,
        statusMessage: status.statusMessage,
        isReadOnly: status.isReadOnly ?? false
      };
    }
  );
}

/**
 * Unified provider state store
 * Automatically updates when active provider or cache state changes
 */
export const unifiedProviderState = createUnifiedProviderState();
