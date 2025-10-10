<script lang="ts">
  import { startCount, volumeStats } from '$lib/settings';
  import { activityTracker } from '$lib/util/activity-tracker';
  import { onMount } from 'svelte';

  interface Props {
    count: number | undefined;
    volumeId: string;
  }

  let { count = $bindable(), volumeId }: Props = $props();

  let active = $derived(Boolean(count));

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
    } else {
      startTimer();
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

    // Start the timer immediately when component mounts
    startTimer();

    return () => {
      stopTimer();
    };
  });
</script>

<button
  class:text-primary-700={!active}
  class="mix-blend-difference z-10 fixed opacity-50 right-20 top-5 p-10 m-[-2.5rem]"
  onclick={onClick}
>
  <p>
    {active ? 'Active' : 'Paused'} | Minutes read: {$volumeStats?.timeReadInMinutes}
  </p>
</button>
