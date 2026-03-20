import { writable, type Readable } from 'svelte/store';
import type { SyncProvider, ProviderType, ProviderStatus } from './provider-interface';
import { cacheManager } from './cache-manager';
import { getConfiguredProviderType, clearActiveProviderKey } from './provider-detection';

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
   * Get provider instance by type, loading it dynamically if not registered yet.
   * Use this for login operations when the provider may not be loaded.
   * @param type Provider type
   * @returns The provider instance
   */
  async getOrLoadProvider(type: ProviderType): Promise<SyncProvider> {
    // Return existing provider if already registered
    const existing = this.providerRegistry.get(type);
    if (existing) {
      return existing;
    }

    // Lazy-load the provider module
    console.log(`🔧 Lazy-loading ${type} provider...`);
    const { loadProvider } = await import('./init-providers');
    const provider = await loadProvider(type);
    this.registerProvider(provider);
    console.log(`✅ ${type} provider loaded`);
    return provider;
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
    // Try the current provider first
    if (this.currentProvider) {
      await this.currentProvider.logout();
      this.currentProvider = null;
    } else {
      // currentProvider is null (e.g., connection failed on startup).
      // Call logout on all registered providers to clear any stored credentials.
      for (const provider of this.providerRegistry.values()) {
        try {
          await provider.logout();
        } catch { /* ignore */ }
      }
    }

    // Always clear state — belt and suspenders
    cacheManager.clearAll();
    clearActiveProviderKey();

    // Force-clear all provider credential keys from localStorage
    // in case provider.logout() missed something
    if (typeof localStorage !== 'undefined') {
      // WebDAV
      localStorage.removeItem('webdav_server_url');
      localStorage.removeItem('webdav_username');
      localStorage.removeItem('webdav_password');
      // MEGA
      localStorage.removeItem('mega_email');
      localStorage.removeItem('mega_password');
      localStorage.removeItem('mega_folder_path');
    }

    this.updateStatus();
  }

  /**
   * Update the status store with current provider state
   */
  updateStatus(): void {
    // Use current provider type if set, otherwise check localStorage
    // This ensures UI shows the configured provider even before it finishes loading
    const currentProviderType = this.currentProvider?.type ?? getConfiguredProviderType();

    const status: MultiProviderStatus = {
      providers: {
        'google-drive': null,
        mega: null,
        webdav: null
      },
      hasAnyAuthenticated: false,
      needsAttention: false,
      currentProviderType
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
