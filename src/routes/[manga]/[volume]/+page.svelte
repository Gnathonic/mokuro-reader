<script lang="ts">
  import { page } from '$app/stores';
  import Reader from '$lib/components/Reader/Reader.svelte';
  import Timer from '$lib/components/Reader/Timer.svelte';
  import {
    effectiveVolumeSettings,
    initializeVolume,
    settings,
    volumes
  } from '$lib/settings';
  import { onMount } from 'svelte';
  import { activityTracker } from '$lib/util/activity-tracker';
  import { Spinner } from 'flowbite-svelte';

  let volumeId = $derived($page.params.volume || '');
  let count: undefined | number = $state(undefined);

  // Initialize volume when volumeId changes (reactive to navigation)
  $effect(() => {
    if (volumeId && !$volumes?.[volumeId]) {
      initializeVolume(volumeId);
    }
  });

  // Record activity when volumeId changes to trigger timer via activity tracker
  $effect(() => {
    if (!volumeId) return;

    // Record activity when volume changes - this will trigger the timer
    // via the activity tracker in the Timer component
    activityTracker.recordActivity();
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

{#if $effectiveVolumeSettings[volumeId]}
  {#if $settings.showTimer}
    <Timer bind:count {volumeId} />
  {/if}
  {#key volumeId}
    <Reader volumeSettings={$effectiveVolumeSettings[volumeId]} />
  {/key}
{:else}
  <div class="flex items-center justify-center w-screen h-screen">
    <Spinner size="12" />
  </div>
{/if}
