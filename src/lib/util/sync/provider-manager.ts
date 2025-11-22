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
		// Note: We don't set initial status here anymore
		// The status is set synchronously when providers register themselves
		// This ensures the status always reflects the actual registered provider state
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
		console.log('🔍 initializeCurrentProvider: currentProvider =', this.currentProvider?.type);
		if (this.currentProvider) return; // Already set

		// Check each registered provider to see if it's already authenticated
		console.log('🔍 Checking registered providers for authentication...');
		for (const provider of this.providerRegistry.values()) {
			const isAuth = provider.isAuthenticated();
			console.log(`🔍 Provider ${provider.type}: isAuthenticated = ${isAuth}`);
			if (isAuth) {
				this.setCurrentProvider(provider);
				console.log(`✅ Detected existing auth: ${provider.type}`);
				return;
			}
		}
		console.log('🔍 No authenticated providers found');
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

		// Persist to localStorage so it survives page refresh
		const { setActiveProvider } = await import('./provider-detection');
		setActiveProvider(provider.type);

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
		// If current provider is no longer authenticated, clear it
		if (this.currentProvider && !this.currentProvider.isAuthenticated()) {
			this.currentProvider = null;
		}

		// Re-sync currentProviderType from localStorage in case a provider set itself during initialization
		// This handles the case where MEGA/WebDAV restore credentials and call setActiveProvider() before
		// initializeCurrentProvider() is called
		const configuredProvider = getConfiguredProviderType();

		const status: MultiProviderStatus = {
			providers: {
				'google-drive': null,
				mega: null,
				webdav: null
			},
			hasAnyAuthenticated: false,
			needsAttention: false,
			currentProviderType: configuredProvider ?? this.currentProvider?.type ?? null
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
