<script lang="ts">
  import { run } from 'svelte/legacy';

  import { Button, Modal, Toggle } from 'flowbite-svelte';
  import { extractionModalStore } from '$lib/util/modals';
  import { onMount } from 'svelte';

  let open = $state(false);
  let asCbz = $state(true);
  let individualVolumes = $state(false);
  let includeSeriesTitle = $state(true);
  let firstVolumePreview = $state('');

  onMount(() => {
    extractionModalStore.subscribe((value) => {
      if (value) {
        open = value.open;
        if (value.firstVolume) {
          updateFilenamePreview(value.firstVolume);
        }
      }
    });
  });

  function updateFilenamePreview(firstVolume: { series_title: string; volume_title: string }) {
    if (firstVolume) {
      const extension = asCbz ? 'cbz' : 'zip';
      if (includeSeriesTitle && individualVolumes) {
        firstVolumePreview = `${firstVolume.series_title} - ${firstVolume.volume_title}.${extension}`;
      } else if (individualVolumes) {
        firstVolumePreview = `${firstVolume.volume_title}.${extension}`;
      } else {
        firstVolumePreview = `${firstVolume.series_title}.${extension}`;
      }
    }
  }

  function handleExtract() {
    if ($extractionModalStore?.onConfirm) {
      $extractionModalStore.onConfirm(asCbz, individualVolumes, includeSeriesTitle);
    }
    open = false;
  }

  function handleCancel() {
    if ($extractionModalStore?.onCancel) {
      $extractionModalStore.onCancel();
    }
    open = false;
  }

  run(() => {
    if ($extractionModalStore?.firstVolume) {
      updateFilenamePreview($extractionModalStore.firstVolume);
    }
  });

  run(() => {
    if (
      asCbz !== undefined ||
      includeSeriesTitle !== undefined ||
      individualVolumes !== undefined
    ) {
      if ($extractionModalStore?.firstVolume) {
        updateFilenamePreview($extractionModalStore.firstVolume);
      }
    }
  });
</script>

<Modal bind:open size="md" autoclose outsideclose>
  <div class="text-center">
    <h3 class="mb-5 text-lg font-normal text-gray-700 dark:text-gray-300">Extract Options</h3>
    <div class="flex flex-col gap-4 mb-5">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-gray-700 dark:text-gray-300">Extract as CBZ</span>
        <Toggle bind:checked={asCbz} />
      </div>
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-gray-700 dark:text-gray-300"
          >Extract individual volumes</span
        >
        <Toggle bind:checked={individualVolumes} />
      </div>

      {#if individualVolumes}
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-gray-700 dark:text-gray-300"
            >Include series title in filename</span
          >
          <Toggle bind:checked={includeSeriesTitle} />
        </div>
      {/if}

      <div class="mt-2 p-3 bg-gray-100 dark:bg-gray-800 rounded-md">
        <div class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Filename preview:
        </div>
        <div class="text-xs font-mono break-all text-gray-600 dark:text-gray-400">
          {firstVolumePreview}
        </div>
      </div>
    </div>
    <div class="flex justify-center gap-2">
      <Button color="blue" on:click={handleExtract}>Extract</Button>
      <Button color="alternative" on:click={handleCancel}>Cancel</Button>
    </div>
  </div>
</Modal>
