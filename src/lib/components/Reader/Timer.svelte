<script lang="ts">
  import { startCount, volumeStats } from '$lib/settings';

  interface Props {
    count: number | undefined;
    volumeId: string;
  }

  let { count = $bindable(), volumeId }: Props = $props();

  let active = $derived(Boolean(count));

  function onClick() {
    if (count) {
      clearInterval(count);
      count = undefined;
    } else {
      count = startCount(volumeId);
    }
  }
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
