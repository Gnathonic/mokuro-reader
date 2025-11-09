<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { toggleFullScreen, zoomFitToScreen } from '$lib/panzoom';
  import { SpeedDial, SpeedDialButton, Modal, Button } from 'flowbite-svelte';
  import { settings } from '$lib/settings';
  import {
    ArrowLeftOutline,
    ArrowRightOutline,
    CompressOutline,
    ImageOutline,
    ZoomOutOutline,
    EditOutline
  } from 'flowbite-svelte-icons';
  import { imageToWebp, showCropper, updateLastCard } from '$lib/anki-connect';
  import { promptConfirmation } from '$lib/util';

  interface Props {
    left: (_e: any, ingoreTimeOut?: boolean) => void;
    right: (_e: any, ingoreTimeOut?: boolean) => void;
    src1: File | undefined;
    src2: File | undefined;
    currentPage: number;
    showSecondPage: boolean;
  }

  let { left, right, src1, src2, currentPage, showSecondPage }: Props = $props();

  let open = $state(false);
  let showPageSelector = $state(false);

  function handleZoom() {
    zoomFitToScreen();
    open = false;
  }

  function handleLeft(_e: Event) {
    left(_e, true);
    open = false;
  }

  function handleRight(_e: Event) {
    right(_e, true);
    open = false;
  }

  function handleEditPage() {
    open = false;

    if (showSecondPage) {
      // Show modal to select which page to edit
      showPageSelector = true;
    } else {
      // Navigate directly to edit the current page
      navigateToEditPage(currentPage - 1); // Convert to 0-based index
    }
  }

  function navigateToEditPage(pageIndex: number) {
    const manga = $page.params.manga;
    const volume = $page.params.volume;
    goto(`/${manga}/${volume}/edit/${pageIndex}`);
    showPageSelector = false;
  }

  async function onUpdateCard(src: File | undefined) {
    if ($settings.ankiConnectSettings.enabled && src) {
      if ($settings.ankiConnectSettings.cropImage) {
        showCropper(URL.createObjectURL(src));
      } else {
        promptConfirmation('Add image to last created anki card?', async () => {
          const imageData = await imageToWebp(src, $settings);
          updateLastCard(imageData);
        });
      }
    }
    open = false;
  }
</script>

{#if $settings.quickActions}
  <SpeedDial
    tooltip="none"
    trigger="click"
    defaultClass="absolute end-3 bottom-3 z-50"
    color="transparent"
    bind:open
  >
    {#if $settings.ankiConnectSettings.enabled}
      <SpeedDialButton name={src2 ? '1' : undefined} on:click={() => onUpdateCard(src1)}>
        <ImageOutline />
      </SpeedDialButton>
    {/if}
    {#if $settings.ankiConnectSettings.enabled && src2}
      <SpeedDialButton name="2" on:click={() => onUpdateCard(src2)}>
        <ImageOutline />
      </SpeedDialButton>
    {/if}
    <SpeedDialButton on:click={toggleFullScreen}>
      <CompressOutline />
    </SpeedDialButton>
    <SpeedDialButton on:click={handleZoom}>
      <ZoomOutOutline />
    </SpeedDialButton>
    <SpeedDialButton on:click={handleRight}>
      <ArrowRightOutline />
    </SpeedDialButton>
    <SpeedDialButton on:click={handleLeft}>
      <ArrowLeftOutline />
    </SpeedDialButton>
    <SpeedDialButton on:click={handleEditPage}>
      <EditOutline />
    </SpeedDialButton>
  </SpeedDial>
{/if}

<Modal bind:open={showPageSelector} size="xs" autoclose={false}>
  <div class="text-center">
    <h3 class="mb-5 text-lg font-normal text-gray-500 dark:text-gray-400">
      Which page do you want to edit?
    </h3>
    <div class="flex justify-center gap-4">
      <Button color="blue" on:click={() => navigateToEditPage(currentPage - 1)}>
        Left Page ({currentPage})
      </Button>
      <Button color="blue" on:click={() => navigateToEditPage(currentPage)}>
        Right Page ({currentPage + 1})
      </Button>
    </div>
    <div class="mt-4">
      <Button color="alternative" on:click={() => (showPageSelector = false)}>Cancel</Button>
    </div>
  </div>
</Modal>
