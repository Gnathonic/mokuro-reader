/**
 * Multi-Provider Sync Module
 *
 * Exports all sync providers and the provider manager for unified sync operations.
 */

export * from './provider-interface';
export * from './provider-manager';
export * from './cloud-cache-interface';
export { cacheManager } from './cache-manager';
export type { GenericCloudFile } from './cache-manager';
export { unifiedProviderState } from './unified-provider-state';
export type { UnifiedProviderState } from './unified-provider-state';

// Export lazy-loading function for provider modules
export { loadProvider } from './init-providers';

// Export key management helpers from provider detection
export {
  setActiveProviderKey,
  clearActiveProviderKey,
  getActiveProviderKey,
  getConfiguredProviderType,
  ACTIVE_PROVIDER_KEY
} from './provider-detection';

// Note: Provider instances are NOT exported directly to enable lazy-loading.
// Use providerManager.getOrLoadProvider(type) to get a provider instance.
