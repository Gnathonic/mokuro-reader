<script lang="ts">
  import Reader from '$lib/components/Reader/Reader.svelte';
  import Timer from '$lib/components/Reader/Timer.svelte';
  import { effectiveVolumeSettings, initializeVolume, settings, volumes } from '$lib/settings';
  import { miscSettings } from '$lib/settings/misc';
  import { onMount } from 'svelte';
  import { activityTracker } from '$lib/util/activity-tracker';
  import { Spinner } from 'flowbite-svelte';
  import { routeParams } from '$lib/util/hash-router';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import { tokenManager } from '$lib/util/sync/providers/google-drive/token-manager';
  import { foregroundSync } from '$lib/util/sync/foreground-sync';
  import { checkPositionsOnOpen } from '$lib/positions/positions-sync';
  import { noteReaderClosed } from '$lib/positions/reader-open';
  import { endVisit, startVisit } from '$lib/positions/visit';

  let volumeId = $derived($routeParams.volume || '');

  // Opening a book with an expired Google session: request reconnection NOW,
  // before page turns stamp fresh local timestamps that would win the
  // newest-wins merge and clobber progress made on another device. The
  // navigation click's activation usually lets the account chooser open
  // immediately; if not, the blocked-popup path arms a next-click retry.
  // Closing Google's dialog IS the "read anyway" choice — no extra dialog.
  let gdriveReauthRequested = false;
  $effect(() => {
    if (!volumeId) return;
    if (!$miscSettings.gdriveAutoReAuth) return;
    const active = unifiedCloudManager.getActiveProvider();
    if (active?.type !== 'google-drive') return;
    const msLeft = tokenManager.getTimeUntilExpiry();
    if (msLeft === null || msLeft > 0) {
      gdriveReauthRequested = false;
      return;
    }
    if (gdriveReauthRequested) return;
    gdriveReauthRequested = true;
    tokenManager.reAuthenticate();
  });

  // Cache volume settings to prevent flash when unrelated volumes are added.
  // The effectiveVolumeSettings store emits a new object whenever ANY volume changes,
  // which would cause this component to re-render. By caching the specific volume's
  // settings and only updating when those values actually change, we prevent
  // unnecessary unmount/remount cycles that cause visual flashing.
  let cachedVolumeSettings = $state<
    | {
        rightToLeft: boolean;
        hasCover: boolean;
      }
    | undefined
  >(undefined);

  // Track last volumeId to reset cache on navigation
  let lastVolumeId = '';

  // Overlay visibility state (shared with Reader via bind)
  let overlaysVisible = $state(true);

  // Update cached settings only when the specific volume's settings actually change
  $effect(() => {
    // Reset cache when navigating to a different volume
    if (volumeId !== lastVolumeId) {
      lastVolumeId = volumeId;
      cachedVolumeSettings = undefined;
    }

    const newSettings = $effectiveVolumeSettings[volumeId];
    if (newSettings) {
      if (
        !cachedVolumeSettings ||
        cachedVolumeSettings.rightToLeft !== newSettings.rightToLeft ||
        cachedVolumeSettings.hasCover !== newSettings.hasCover
      ) {
        cachedVolumeSettings = newSettings;
      }
    }
  });

  // Initialize volume when volumeId changes (reactive to navigation)
  $effect(() => {
    if (volumeId && !$volumes?.[volumeId]) {
      initializeVolume(volumeId);
    }
  });

  // The device swap: before the reader picks its page, ask positions.json
  // (fixed address, no listing) whether another device read on. At most
  // READER_OPEN_WAIT_MS, then the local page; a later answer still moves the
  // page while none has been turned here. Re-run for every volume opened.
  // The visit (look-ups claim nothing) starts from the page the check settled.
  let positionsChecked = $state(false);
  // The volume the reader has open, for the unmount below (`volumeId` may
  // already name the next route by then).
  let openVolumeId = '';
  $effect(() => {
    const id = volumeId;
    if (!id) return;
    openVolumeId = id;
    positionsChecked = false;
    let live = true;
    void checkPositionsOnOpen(id).finally(() => {
      if (!live) return;
      startVisit(id);
      positionsChecked = true;
    });
    return () => {
      live = false;
      if (openVolumeId === id) openVolumeId = '';
      noteReaderClosed(id);
      endVisit(id);
    };
  });

  onMount(() => {
    // Pull other devices' progress before the first page turn here can make
    // this device's (possibly stale) page the newest.
    foregroundSync.request();

    return () => {
      // The reading session ends BEFORE the flush, whichever teardown Svelte
      // runs first: the flush's sync must see no session, so it uploads the
      // volume-data.json a sync deferred while reading (`reading-session.ts`).
      if (openVolumeId) noteReaderClosed(openVolumeId);
      // Send a pending progress change now rather than when the batching
      // interval allows.
      activityTracker.flush();
    };
  });
</script>

{#if cachedVolumeSettings && positionsChecked}
  {#key volumeId}
    <Timer {volumeId} visible={$settings.showTimer && overlaysVisible} />
    <Reader volumeSettings={cachedVolumeSettings} bind:overlaysVisible />
  {/key}
{:else}
  <div class="flex h-screen w-screen items-center justify-center">
    <Spinner size="12" />
  </div>
{/if}
