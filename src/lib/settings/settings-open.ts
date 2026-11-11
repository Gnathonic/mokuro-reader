/**
 * Whether the settings drawer is open — ONE flag for the whole app (#55,
 * spec 17.8). The drawer is mounted twice (by `NavBar`, always mounted, and
 * by the reader's `SettingsButton`), because `Settings.svelte` reads
 * `isReader()` once to choose reader or library content. Both mounts bind to
 * this store through `SettingsDrawerHost.svelte` and each shows only in its
 * own context, so there is never a second flag and never two drawers.
 *
 * Everything that opens settings sets it: the NavBar button, the reader's
 * settings button, the `app.settings` key and the quick menu.
 *
 * `uploadModalOpen` sits beside it for the "Open upload" action.
 */
import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import { currentView } from '$lib/util/hash-router';

export const settingsOpen = writable(false);
export const uploadModalOpen = writable(false);

export function openSettings() {
  settingsOpen.set(true);
}

// A drawer never follows the user to another view. With one flag for two
// mounts this must not depend on which mount notices first: leaving the
// reader with the drawer open would otherwise re-open it in the library.
if (browser) {
  let viewType: string | undefined;
  currentView.subscribe((view) => {
    if (viewType !== undefined && view.type !== viewType) settingsOpen.set(false);
    viewType = view.type;
  });
}
