/**
 * The connected provider's own `ProviderStatus`, as a store — for UI that
 * decides by what the account may do there (the layer picker's Publish, the
 * editor's fork-on-edit). Null when no provider is configured.
 */
import { derived, type Readable } from 'svelte/store';
import { providerManager } from './provider-manager';
import type { ProviderStatus } from './provider-interface';

export const activeProviderStatus: Readable<ProviderStatus | null> = derived(
  providerManager.status,
  ($status) => {
    const type = $status.currentProviderType;
    return type ? ($status.providers[type] ?? null) : null;
  }
);
