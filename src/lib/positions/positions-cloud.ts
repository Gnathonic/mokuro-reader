/**
 * What the cloud `positions.json` held when this device last read or wrote
 * it: each volume's entry stamp `t`, per provider account. Held in memory only.
 *
 * The volume-data sync uses it to decide whether a page turn is already on its
 * way to other devices (`util/sync/volume-data-deferral.ts`). It runs before
 * the positions step of the same sync, so it cannot use that step's outcome.
 * Only an account the provider can name is kept, so a stamp read from one
 * account never vouches for another. An account scope is not always unique
 * (Local Folder's is the folder's basename), so the memo is also cleared on
 * every connect, provider switch, logout and cache clear (`cacheManager`).
 *
 * LEAF MODULE: no stores, no IO.
 */

import type { PositionsMap } from './positions-file';

interface ProviderLike {
  type: string;
  getStatus(): { accountScope?: string };
}

let known: { account: string; stamps: Map<string, number> } | null = null;

function accountOf(provider: ProviderLike): string | null {
  let scope: string | undefined;
  try {
    scope = provider.getStatus().accountScope;
  } catch {
    scope = undefined;
  }
  return scope ? `${provider.type}\u0000${scope}` : null;
}

/** The cloud file holds `positions` (a read of every copy, or this device's write). */
export function noteCloudPositions(provider: ProviderLike, positions: PositionsMap): void {
  const account = accountOf(provider);
  if (!account) {
    known = null;
    return;
  }
  known = {
    account,
    stamps: new Map(Object.entries(positions).map(([volume, entry]) => [volume, entry.t]))
  };
}

/** The volume's entry stamp in the cloud file as last seen, or undefined. */
export function cloudPositionStamp(provider: ProviderLike, volume: string): number | undefined {
  const account = accountOf(provider);
  if (!account || known?.account !== account) return undefined;
  return known.stamps.get(volume);
}

/** Forget what the cloud file held (connect, provider switch, logout, cache clear). */
export function clearCloudPositions(): void {
  known = null;
}

export const _resetCloudPositionsForTests = clearCloudPositions;
