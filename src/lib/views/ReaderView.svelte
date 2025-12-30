<script lang="ts">
  import Reader from '$lib/components/Reader/Reader.svelte';
  import Timer from '$lib/components/Reader/Timer.svelte';
  import { effectiveVolumeSettings, initializeVolume, settings, volumes } from '$lib/settings';
  import { onMount } from 'svelte';
  import { activityTracker } from '$lib/util/activity-tracker';
  import { Spinner } from 'flowbite-svelte';
  import type { PageViewMode } from '$lib/settings/settings';
  import { routeParams } from '$lib/util/hash-router';

  let volumeId = $derived($routeParams.volume || '');

  // Cache volume settings to prevent flash when unrelated volumes are added.
  // The effectiveVolumeSettings store emits a new object whenever ANY volume changes,
  // which would cause this component to re-render. By caching the specific volume's
  // settings and only updating when those values actually change, we prevent
  // unnecessary unmount/remount cycles that cause visual flashing.
  let cachedVolumeSettings = $state<
    | {
        rightToLeft: boolean;
        singlePageView: PageViewMode;
        hasCover: boolean;
      }
    | undefined
  >(undefined);

  // Track last volumeId to reset cache on navigation
  let lastVolumeId = '';

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
        cachedVolumeSettings.singlePageView !== newSettings.singlePageView ||
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

  onMount(() => {
    // Set up activity tracker timeout
    activityTracker.setTimeoutDuration($settings.inactivityTimeoutMinutes);

    return () => {
      // Stop activity tracker when component unmounts
      activityTracker.stop();
    };
  });
</script>

{#if cachedVolumeSettings}
  {#key volumeId}
    <Timer {volumeId} visible={$settings.showTimer} />
    <Reader volumeSettings={cachedVolumeSettings} />
  {/key}
{:else}
  <div class="flex h-screen w-screen items-center justify-center">
    <Spinner size="12" />
  </div>
{/if}
