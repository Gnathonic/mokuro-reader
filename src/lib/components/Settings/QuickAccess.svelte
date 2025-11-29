<script lang="ts">
  import { toggleFullScreen } from '$lib/panzoom';
  import { isReader } from '$lib/util';
  import { navigateBack } from '$lib/util/hash-router';

  import { Button } from 'flowbite-svelte';

  interface Props {
    open?: boolean;
  }

  let { open = $bindable(false) }: Props = $props();

  function onClose() {
    open = false;
    navigateBack();
  }
</script>

{#if isReader()}
  <div class="flex flex-col gap-2">
    <Button color="alternative" onclick={toggleFullScreen}
      >Toggle fullscreen <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(F)</span
      ></Button
    >
    <Button color="alternative" onclick={onClose}
      >Close reader <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(Esc)</span></Button
    >
  </div>
{/if}
