<script lang="ts">
  import { toggleFullScreen } from '$lib/util/fullscreen';
  import { isReader } from '$lib/util';
  import { navigateBack } from '$lib/util/hash-router';
  import KeyHint from './Keys/KeyHint.svelte';

  import { Button } from 'flowbite-svelte';

  interface Props {
    open?: boolean;
  }

  let { open = $bindable(false) }: Props = $props();

  function onFullscreen() {
    open = false;
    toggleFullScreen();
  }

  function onClose() {
    open = false;
    navigateBack();
  }
</script>

{#if isReader()}
  <div class="flex flex-col gap-2">
    <Button color="alternative" onclick={onFullscreen}
      >Toggle fullscreen <KeyHint id="reader.fullscreen" /></Button
    >
    <Button color="alternative" onclick={onClose}>Close reader <KeyHint id="app.back" /></Button>
  </div>
{/if}
