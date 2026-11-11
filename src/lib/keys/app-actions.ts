/**
 * The `app` commands every listener site answers the same way (#55, spec
 * 17.4): Reader.svelte in the reader, `+layout.svelte` everywhere else. Back
 * (`app.back`) is not here — where it goes is each site's own business.
 *
 * Each handler is its button's handler behind its button's own test, so a key
 * can never do what the button would not: Sync is the NavBar's sync behind
 * the test that shows and disables that button, Open settings sets the one
 * settings-open flag, Open upload opens the NavBar's dialog.
 */
import { get } from 'svelte/store';
import { openSettings, uploadModalOpen } from '$lib/settings/settings-open';
import { nav } from '$lib/util/hash-router';
import { showSnackbar } from '$lib/util/snackbar';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import {
  unifiedProviderState,
  type UnifiedProviderState
} from '$lib/util/sync/unified-provider-state';
import type { AppCommandId } from './actions';
import { announce } from './announce';
import type { KeyHandler } from './dispatch';

type SyncState = Pick<UnifiedProviderState, 'hasActiveProvider' | 'isReadOnly'>;

/** Is there anything to sync progress with? The NavBar shows its sync button on this. */
export function canSyncProgress(state: SyncState): boolean {
  return state.hasActiveProvider && !state.isReadOnly;
}

/** May a manual sync start now, and if not, why. */
export function manualSyncGate(
  state: SyncState,
  syncing: boolean
): { run: true } | { run: false; reason: string } {
  if (!state.hasActiveProvider) {
    return { run: false, reason: 'Connect cloud storage to sync progress' };
  }
  if (state.isReadOnly) {
    return { run: false, reason: 'This cloud connection is read-only: progress is not synced' };
  }
  if (syncing) return { run: false, reason: 'Already syncing' };
  return { run: true };
}

/** A manual progress sync: the NavBar button and the `app.sync` key. */
export async function syncProgressNow(): Promise<void> {
  // One at a time; the sync state itself is the sync service's.
  if (get(unifiedCloudManager.isSyncing)) return;
  try {
    await unifiedCloudManager.syncProgress();
  } catch (error) {
    console.error('Manual sync failed:', error);
    showSnackbar('Sync failed');
  }
}

export const appKeyHandlers = {
  'app.settings': () => openSettings(),
  'app.sync': () => {
    const gate = manualSyncGate(get(unifiedProviderState), get(unifiedCloudManager.isSyncing));
    if (!gate.run) {
      announce(gate.reason, 'app-sync');
      return;
    }
    announce('Syncing progress…', 'app-sync');
    void syncProgressNow();
  },
  'app.open-catalog': () => void nav.toCatalog(),
  'app.open-reading-speed': () => void nav.toReadingSpeed(),
  'app.open-progress-tracker': () => void nav.toProgressTracker(),
  'app.open-cloud': () => void nav.toCloud(),
  'app.open-upload': () => uploadModalOpen.set(true)
} satisfies Record<AppCommandId, KeyHandler>;
