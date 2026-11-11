<script lang="ts">
  /**
   * One of the two mounts of the settings drawer, bound to the app's single
   * open flag (`settings-open.ts`). `context` says where this mount belongs;
   * it shows only there, so the two mounts are never open together.
   */
  import { get } from 'svelte/store';
  import { settingsOpen } from '$lib/settings/settings-open';
  import { isOnReader } from '$lib/util/hash-router';
  import Settings from './Settings.svelte';

  let { context }: { context: 'reader' | 'app' } = $props();

  // Read from the store at call time, not a `$derived`: the drawer's close
  // paths can still run while this mount is being torn down (leaving the
  // reader with the drawer open), when a derived of it is already inert.
  const mine = (onReader: boolean) => (context === 'reader') === onReader;
</script>

<Settings
  bind:open={
    () => $settingsOpen && mine($isOnReader),
    (open) => {
      // Only the mount that is showing may speak for the flag.
      if (mine(get(isOnReader))) settingsOpen.set(open);
    }
  }
/>
