import { derived, type Readable } from 'svelte/store';
import { providerManager } from '$lib/util/sync';

/**
 * Which account's covers a surface may show, as a PRIMITIVE.
 *
 * `acquireCover` binds the account scope at acquire time and `refreshCoverKeys`
 * resolves the CURRENT one, so a handle taken under the old account is
 * unreachable by refresh after a switch — it would sit on the previous
 * account's blob forever. Every cover-resolving surface therefore joins this
 * into its claim key, so a switch releases and re-acquires instead.
 *
 * ONE subscription for all of them. `providerManager.status` emits a fresh
 * object on every status message, and a catalog can have a thousand cards
 * mounted; deriving down to a string here means they share a single
 * subscription and only re-run when the scope genuinely changes.
 *
 * Deliberately NOT `activeAccountScope()` from `cloud-cache-key.ts`: that one
 * is the imperative read the resolver and the cache writers use, and it is not
 * reactive.
 */
export const activeAccountScopeStore: Readable<string | null> = derived(
  providerManager.status,
  ($status) => {
    const type = $status.currentProviderType;
    if (!type) return null;
    return $status.providers[type]?.accountScope ?? null;
  }
);
