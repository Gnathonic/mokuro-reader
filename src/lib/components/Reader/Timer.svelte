<script lang="ts">
  import { startCount, volumes, settings } from '$lib/settings';
  import { personalizedReadingSpeed } from '$lib/settings/reading-speed';
  import { currentVolume, currentVolumeCharacterCount } from '$lib/catalog';
  import { calculateVolumeTimeToFinish, getEffectiveReadingTime } from '$lib/util/reading-speed';
  import { activityTracker } from '$lib/util/activity-tracker';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { derived } from 'svelte/store';

  interface Props {
    count: number | undefined;
    volumeId: string;
    visible?: boolean;
  }

  let { count = $bindable(), volumeId, visible = true }: Props = $props();

  // Local volumeStats to avoid circular dependency with currentVolume
  const volumeStats = derived(
    [currentVolume, volumes, settings],
    ([$currentVolume, $volumes, $settings]) => {
      if ($currentVolume && $volumes && $volumes[$currentVolume.volume_uuid]) {
        const volumeData = $volumes[$currentVolume.volume_uuid];
        const idleTimeoutMs = $settings.inactivityTimeoutMinutes * 60 * 1000;

        return {
          chars: volumeData.chars,
          completed: volumeData.completed,
          timeReadInMinutes: getEffectiveReadingTime(volumeData, idleTimeoutMs),
          progress: volumeData.progress,
          lastProgressUpdate: volumeData.lastProgressUpdate
        };
      }
      return {
        chars: 0,
        completed: 0,
        timeReadInMinutes: 0,
        progress: 0,
        lastProgressUpdate: new Date(0).toISOString()
      };
    }
  );

  let active = $derived(Boolean(count));

  // Calculate time-to-finish
  let timeEstimate = $derived.by(() => {
    const volumeProgress = $volumes[volumeId];
    const charsRead = volumeProgress?.chars || 0;
    return calculateVolumeTimeToFinish(
      $currentVolumeCharacterCount,
      charsRead,
      $personalizedReadingSpeed
    );
  });

  function startTimer() {
    if (!count) {
      count = startCount(volumeId);
    }
  }

  function stopTimer() {
    if (count) {
      clearInterval(count);
      count = undefined;
    }
  }

  function onClick() {
    if (count) {
      stopTimer();
      // Reset activity tracker so next activity can restart timer
      activityTracker.stop();
    } else {
      startTimer();
      // Record activity to start the inactivity timeout
      activityTracker.recordActivity();
    }
  }

  onMount(() => {
    // Initialize activity tracker callbacks
    activityTracker.initialize({
      onActive: () => {
        startTimer();
      },
      onInactive: () => {
        stopTimer();
      }
    });

    // If user is already active when Timer mounts (e.g., from volume navigation),
    // start the timer immediately to avoid the race condition where recordActivity()
    // was called before callbacks were initialized
    if (get(activityTracker.active)) {
      startTimer();
    }

    return () => {
      stopTimer();
    };
  });
</script>

{#if visible}
  <button
    class:text-primary-700={!active}
    class="fixed top-5 right-14 z-10 opacity-50 mix-blend-difference"
    onclick={onClick}
  >
    {#key `${active}-${$volumeStats?.timeReadInMinutes}`}
      <div class="text-right">
        <p>
          {active ? 'Active' : 'Paused'} | Minutes read: {$volumeStats?.timeReadInMinutes}
        </p>
        {#if timeEstimate}
          <p class="text-sm">
            {timeEstimate.displayText}
          </p>
        {/if}
      </div>
    {/key}
  </button>
{/if}
