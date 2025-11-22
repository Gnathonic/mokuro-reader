<script lang="ts">
  import { toggleFullScreen } from '$lib/panzoom';
  import { isReader } from '$lib/util';

  import { Button } from 'flowbite-svelte';

  interface Props {
    hidden?: boolean;
  }

  let { hidden = $bindable(false) }: Props = $props();

  function onClose() {
    hidden = true;
    // Extract series UUID from current URL and navigate to series page
    const pathname = window.location.pathname || '';
    const seriesUuid = pathname.split('/')[1] || '';
    window.location.href = `/${seriesUuid}`;
  }
</script>

{#if isReader()}
  <div class="flex flex-col gap-2">
    <Button color="alternative" on:click={toggleFullScreen}
      >Toggle fullscreen <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(F)</span
      ></Button
    >
    <Button color="alternative" on:click={onClose}
      >Close reader <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(Esc)</span></Button
    >
  </div>
{/if}
