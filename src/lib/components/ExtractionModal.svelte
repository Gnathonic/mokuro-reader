<script lang="ts">
  import { run } from 'svelte/legacy';

  import { Button, Modal, Toggle } from 'flowbite-svelte';
  import { extractionModalStore } from '$lib/util/modals';
  import { onMount } from 'svelte';
  import { extractionSettings, updateExtractionSetting } from '$lib/settings';

  let open = $state(false);
  let asCbz = $state($extractionSettings.asCbz);
  let individualVolumes = $state($extractionSettings.individualVolumes);
  let includeSeriesTitle = $state($extractionSettings.includeSeriesTitle);
  let firstVolumePreview = $state('');
  let currentVolume = $state<{ series_title: string; volume_title: string } | null>(null);

  onMount(() => {
    extractionModalStore.subscribe((value) => {
      if (value) {
        open = value.open;
        if (value.firstVolume) {
          currentVolume = value.firstVolume;
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

  function updateAsCbz(value: boolean) {
    asCbz = value;
    updateExtractionSetting('asCbz', value);
    if (currentVolume) updateFilenamePreview(currentVolume);
  }

  function updateIndividualVolumes(value: boolean) {
    individualVolumes = value;
    updateExtractionSetting('individualVolumes', value);
    if (currentVolume) updateFilenamePreview(currentVolume);
  }

  function updateIncludeSeriesTitle(value: boolean) {
    includeSeriesTitle = value;
    updateExtractionSetting('includeSeriesTitle', value);
    if (currentVolume) updateFilenamePreview(currentVolume);
  }

  run(() => {
    if ($extractionModalStore?.firstVolume) {
      updateFilenamePreview($extractionModalStore.firstVolume);
    }
  });
</script>

<Modal bind:open size="md" autoclose outsideclose>
  <div class="text-center">
    <h3 class="mb-5 text-lg font-normal text-gray-700 dark:text-gray-300">Extract Options</h3>
    <div class="mb-5 flex flex-col gap-4">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-gray-700 dark:text-gray-300"
          >Extract as CBZ (recommended)</span
        >
        <Toggle
          checked={asCbz}
          onchange={(e) => updateAsCbz((e.target as HTMLInputElement)?.checked ?? false)}
        />
      </div>
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-gray-700 dark:text-gray-300"
          >Extract individual volumes (recommended)</span
        >
        <Toggle
          checked={individualVolumes}
          onchange={(e) =>
            updateIndividualVolumes((e.target as HTMLInputElement)?.checked ?? false)}
        />
      </div>

      {#if individualVolumes}
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-gray-700 dark:text-gray-300"
            >Include series title in filename</span
          >
          <Toggle
            checked={includeSeriesTitle}
            onchange={(e) =>
              updateIncludeSeriesTitle((e.target as HTMLInputElement)?.checked ?? false)}
          />
        </div>
      {/if}

      <div class="mt-2 rounded-md bg-gray-100 p-3 dark:bg-gray-800">
        <div class="mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">
          Filename preview:
        </div>
        <div class="font-mono text-xs break-all text-gray-600 dark:text-gray-400">
          {firstVolumePreview}
        </div>
      </div>
    </div>
    <div class="flex justify-center gap-2">
      <Button color="blue" onclick={handleExtract}>Extract</Button>
      <Button color="alternative" onclick={handleCancel}>Cancel</Button>
    </div>
  </div>
</Modal>
