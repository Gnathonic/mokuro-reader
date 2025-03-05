<script lang="ts">
  import { page } from '$app/stores';
  import Reader from '$lib/components/Reader/Reader.svelte';
  import Timer from '$lib/components/Reader/Timer.svelte';
  import { initializeVolume, settings, startCount, volumes, volumeSettings } from '$lib/settings';
  import { onMount } from 'svelte';

  let volumeId = $derived($page.params.volume);
  let count: undefined | number = $state(undefined);

  onMount(() => {
    if (!$volumes?.[volumeId]) {
      initializeVolume(volumeId);
    }

    count = startCount(volumeId);

    return () => {
      clearInterval(count);
      count = undefined;
    };
  });
</script>

{#if $volumeSettings[volumeId]}
  {#if $settings.showTimer}
    <Timer bind:count {volumeId} />
  {/if}
  {#key volumeId}
    <Reader volumeSettings={$volumeSettings[volumeId]} />
  {/key}
{/if}
