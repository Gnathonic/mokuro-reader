import { describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';
import type { ProviderStatus, ProviderType } from './provider-interface';

const isFetchingState = writable(false);
const status = writable<{
  currentProviderType: ProviderType | null;
  providers: Partial<Record<ProviderType, ProviderStatus | null>>;
}>({ currentProviderType: null, providers: {} });

vi.mock('./cache-manager', () => ({ cacheManager: { isFetchingState } }));
vi.mock('./provider-manager', () => ({ providerManager: { status } }));

/** Everything `UnifiedProviderState` needs, minus the field under test. */
function connected(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    isAuthenticated: true,
    hasStoredCredentials: true,
    needsAttention: false,
    statusMessage: 'Connected',
    ...overrides
  };
}

describe('unifiedProviderState', () => {
  it('passes serverCompilesMetadata through and defaults it to false', async () => {
    const { unifiedProviderState } = await import('./unified-provider-state');

    status.set({
      currentProviderType: 'webdav',
      providers: { webdav: connected({ serverCompilesMetadata: true }) }
    });
    expect(get(unifiedProviderState).serverCompilesMetadata).toBe(true);

    // The flag is optional on ProviderStatus: every provider that never sets it
    // is a plain storage backend, where this client is the producer.
    status.set({ currentProviderType: 'webdav', providers: { webdav: connected() } });
    expect(get(unifiedProviderState).serverCompilesMetadata).toBe(false);

    // Same default while a provider is configured but has not reported yet.
    status.set({ currentProviderType: 'webdav', providers: {} });
    expect(get(unifiedProviderState).serverCompilesMetadata).toBe(false);

    // ...and with no provider at all.
    status.set({ currentProviderType: null, providers: {} });
    expect(get(unifiedProviderState).serverCompilesMetadata).toBe(false);
  });
});
