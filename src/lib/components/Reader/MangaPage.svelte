<!-- @migration-task Error while migrating Svelte code: Can't migrate code with afterUpdate. Please migrate by hand. -->
<script lang="ts">
  import type { Page } from '$lib/types';
  import { afterUpdate, onMount } from 'svelte';
  import TextBoxes from './TextBoxes.svelte';
  import { zoomDefault } from '$lib/panzoom';

  export let page: Page;
  export let src: File;

  $: url = src ? `url(${URL.createObjectURL(src)})` : '';

  let legacy: HTMLElement | null;

  onMount(() => {
    legacy = document.getElementById('popupAbout');
    zoomDefault();

    return () => {
      setTimeout(() => {
        zoomDefault();
      }, 10);
    };
  });

  $: {
    if (legacy) {
      legacy.style.backgroundImage = url;
    }
  }

  afterUpdate(() => {
    zoomDefault();
  });
</script>

<div
  draggable="false"
  style:width={`${page.img_width}px`}
  style:height={`${page.img_height}px`}
  style:background-image={url}
  class="relative"
>
  <TextBoxes {page} {src} />
</div>
