<script lang="ts">
  import { page } from '$app/stores';
  import Reader from '$lib/components/Reader/Reader.svelte';
  import Timer from '$lib/components/Reader/Timer.svelte';
  import { initializeVolume, settings, startCount, volumeSettings, volumes } from '$lib/settings';
  import { onMount } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { currentSeries, currentVolume, currentVolumeData } from '$lib/catalog';

  const volumeId = $page.params.volume;
  let count: undefined | number = undefined;

  // Reset all relevant stores on navigation
  beforeNavigate(() => {
    if (count) {
      clearInterval(count);
      count = undefined;
    }
    // Clear current volume data
    currentVolume.set(null);
    currentVolumeData.set(null);
  });

  onMount(() => {
    // Always reinitialize volume on mount
    initializeVolume(volumeId);
    count = startCount(volumeId);

    return () => {
      if (count) {
        clearInterval(count);
        count = undefined;
      }
    };
  });
</script>

{#if $volumeSettings[volumeId]}
  {#if $settings.showTimer}
    <Timer bind:count {volumeId} />
  {/if}
  <Reader volumeSettings={$volumeSettings[volumeId]} />
{/if}
