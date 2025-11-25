import { writable, type Readable } from 'svelte/store';
import type { SyncProvider, ProviderType, ProviderStatus } from './provider-interface';
import { cacheManager } from './cache-manager';
import { getConfiguredProviderType } from './provider-detection';

export interface MultiProviderStatus {
  providers: Record<ProviderType, ProviderStatus | null>;
  hasAnyAuthenticated: boolean;
  needsAttention: boolean;
  currentProviderType: ProviderType | null;
}

/**
 * Provider Manager - Single Provider Design
 *
 * Manages ONE active cloud storage provider at a time.
 * Only one provider can be authenticated simultaneously.
 * Switching providers automatically logs out the previous one.
 */
class ProviderManager {
  // THE provider - only one can be active
  private currentProvider: SyncProvider | null = null;

  // Registry for looking up provider instances by type (they exist as singletons)
  private providerRegistry: Map<ProviderType, SyncProvider> = new Map();

  private statusStore = writable<MultiProviderStatus>({
    providers: {
      'google-drive': null,
      mega: null,
      webdav: null
    },
    hasAnyAuthenticated: false,
    needsAttention: false,
    currentProviderType: null
  });

  constructor() {
    // Check localStorage synchronously to set initial "configured" state
    // This prevents UI from showing "not connected" while waiting for async init
    const configuredProvider = getConfiguredProviderType();
    if (configuredProvider) {
      // Set initial status to show provider is configured but still initializing
      const initialStatus = this.statusStore;
      initialStatus.update((status) => ({
        ...status,
        providers: {
          ...status.providers,
          [configuredProvider]: {
            isAuthenticated: false, // Not yet connected
            hasStoredCredentials: true, // But we know it's configured
            needsAttention: false,
            statusMessage: 'Initializing...'
          }
        },
        hasAnyAuthenticated: false, // Not authenticated yet
        currentProviderType: configuredProvider
      }));
    }
  }

  /** Observable store for provider status */
  get status(): Readable<MultiProviderStatus> {
    return this.statusStore;
  }

  /**
   * Register a provider instance in the registry
   * This doesn't make it active - just makes it available for lookup
   * @param provider The provider instance to register
   */
  registerProvider(provider: SyncProvider): void {
    this.providerRegistry.set(provider.type, provider);
    this.updateStatus();
  }

  /**
   * Initialize by detecting any already-authenticated provider
   * Called once on app startup
   */
  initializeCurrentProvider(): void {
    if (this.currentProvider) return; // Already set

    // Check each registered provider to see if it's already authenticated
    for (const provider of this.providerRegistry.values()) {
      if (provider.isAuthenticated()) {
        this.setCurrentProvider(provider);
        console.log(`✅ Detected existing auth: ${provider.type}`);
        return;
      }
    }
  }

  /**
   * Set the current provider (THE provider)
   * Logs out the previous provider if switching
   * @param provider The provider instance to make current
   */
  async setCurrentProvider(provider: SyncProvider): Promise<void> {
    // Logout previous provider if switching
    if (this.currentProvider && this.currentProvider.type !== provider.type) {
      console.log(`🔄 Switching from ${this.currentProvider.type} to ${provider.type}`);
      try {
        await this.currentProvider.logout();
      } catch (error) {
        console.error(`Failed to logout ${this.currentProvider.type}:`, error);
      }
    }

    // Set THE provider
    this.currentProvider = provider;

    // Update cache to use this provider's cache
    cacheManager.setActiveProvider(provider.type);

    this.updateStatus();
  }

  /**
   * Get THE current provider
   * @returns The active provider or null
   */
  getActiveProvider(): SyncProvider | null {
    // Only return if still authenticated
    return this.currentProvider?.isAuthenticated() ? this.currentProvider : null;
  }

  /**
   * Get provider instance by type (for login operations)
   * @param type Provider type
   */
  getProviderInstance(type: ProviderType): SyncProvider | undefined {
    return this.providerRegistry.get(type);
  }

  /**
   * Check if any provider is authenticated
   */
  hasAnyAuthenticated(): boolean {
    return this.getActiveProvider() !== null;
  }

  /**
   * Logout the current provider
   */
  async logout(): Promise<void> {
    if (this.currentProvider) {
      await this.currentProvider.logout();
      this.currentProvider = null;
      cacheManager.clearAll();
      this.updateStatus();
    }
  }

  /**
   * Update the status store with current provider state
   */
  updateStatus(): void {
    const status: MultiProviderStatus = {
      providers: {
        'google-drive': null,
        mega: null,
        webdav: null
      },
      hasAnyAuthenticated: false,
      needsAttention: false,
      currentProviderType: this.currentProvider?.type ?? null
    };

    // Update status for all registered providers (shows their individual states)
    for (const provider of this.providerRegistry.values()) {
      status.providers[provider.type] = provider.getStatus();
    }

    status.hasAnyAuthenticated = this.hasAnyAuthenticated();
    status.needsAttention = this.currentProvider?.getStatus().needsAttention ?? false;

    this.statusStore.set(status);
  }
}

export const providerManager = new ProviderManager();
