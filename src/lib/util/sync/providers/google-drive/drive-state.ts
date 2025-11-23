import { derived, type Readable } from 'svelte/store';
import { tokenManager } from './token-manager';

export interface DriveState {
  isAuthenticated: boolean;
  needsAttention: boolean;
}

/**
 * Simplified Drive state derived from token manager
 *
 * NOTE: Cache loading states removed as we now query the Drive API directly on-demand.
 * The old dual-cache architecture (driveFilesCache) has been eliminated.
 */
export const driveState: Readable<DriveState> = derived(
  [tokenManager.token, tokenManager.needsAttention],
  ([$token, $needsAttention]) => {
    const isAuthenticated = $token !== '';
    return {
      isAuthenticated,
      needsAttention: $needsAttention
    };
  }
);
