<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, Modal, Label, Input, Select, Spinner, Fileupload } from 'flowbite-svelte';
  import { volumeEditorModalStore, closeVolumeEditor } from '$lib/util/modals';
  import {
    getAllSeriesOptions,
    generateNewSeriesUuid,
    updateVolumeInDb,
    updateVolumeStats,
    resetVolumeProgress,
    updateVolumeCover,
    resetVolumeCover,
    getVolumeData,
    getVolumeFiles,
    calculateVolumeCharacterCount
  } from '$lib/util/volume-editor';
  import { showSnackbar } from '$lib/util';
  import type { VolumeMetadata } from '$lib/types';
  import { VolumeData } from '$lib/settings/volume-data';
  import VolumeEditorCoverPicker from './VolumeEditorCoverPicker.svelte';
  import { IMAGE_MIME_TYPES } from '$lib/import/types';

  let open = $state(false);
  let loading = $state(true);
  let saving = $state(false);
  let volumeUuid = $state('');

  // Original data for comparison
  let originalMetadata: VolumeMetadata | null = $state(null);
  let originalStats: VolumeData | null = $state(null);

  // Editable form state
  let seriesUuid = $state('');
  let seriesTitle = $state('');
  let volumeTitle = $state('');
  let isNewSeries = $state(false);
  let newSeriesName = $state('');

  // Reading stats
  let progress = $state(0);
  let timeReadInMinutes = $state(0);

  // Time display as hh:mm
  let timeHours = $state(0);
  let timeMinutes = $state(0);

  // Volume stats (read-only, from metadata)
  let characterCount = $state(0);
  let pageCount = $state(0);
  let missingPagePaths = $state<string[]>([]);

  // Derived characters read based on progress
  let chars = $derived(pageCount > 0 ? Math.round((progress / pageCount) * characterCount) : 0);

  // Sync time fields to/from timeReadInMinutes
  function updateTimeFromMinutes(totalMinutes: number) {
    timeHours = Math.floor(totalMinutes / 60);
    timeMinutes = totalMinutes % 60;
  }

  function updateMinutesFromTime() {
    // Ensure non-negative values
    timeHours = Math.max(0, Math.floor(timeHours) || 0);
    timeMinutes = Math.max(0, Math.min(59, Math.floor(timeMinutes) || 0));
    timeReadInMinutes = timeHours * 60 + timeMinutes;
  }

  // Cover
  let thumbnailUrl = $state<string | null>(null);
  let showCoverPicker = $state(false);

  // Series options for dropdown
  let seriesOptions = $state<{ uuid: string; title: string }[]>([]);

  onMount(() => {
    const unsubscribe = volumeEditorModalStore.subscribe(async (value) => {
      if (value?.open && value.volumeUuid) {
        open = true;
        volumeUuid = value.volumeUuid;
        await loadVolumeData();
      }
    });
    return unsubscribe;
  });

  async function loadVolumeData() {
    loading = true;
    try {
      // Load series options
      seriesOptions = await getAllSeriesOptions();

      // Load volume data
      const data = await getVolumeData(volumeUuid);
      if (!data) {
        showSnackbar('Volume not found');
        handleCancel();
        return;
      }

      originalMetadata = data.metadata;
      originalStats = data.stats;

      // Populate form fields
      seriesUuid = data.metadata.series_uuid;
      seriesTitle = data.metadata.series_title;
      volumeTitle = data.metadata.volume_title;
      pageCount = data.metadata.page_count || 0;
      missingPagePaths = data.metadata.missing_page_paths || [];

      // Calculate character count from volume_ocr (matches VolumeItem display)
      characterCount = await calculateVolumeCharacterCount(volumeUuid);

      progress = data.stats.progress || 0;
      timeReadInMinutes = data.stats.timeReadInMinutes || 0;
      updateTimeFromMinutes(timeReadInMinutes);

      isNewSeries = false;
      newSeriesName = '';

      // Generate thumbnail URL
      if (data.metadata.thumbnail) {
        thumbnailUrl = URL.createObjectURL(data.metadata.thumbnail);
      } else {
        thumbnailUrl = null;
      }
    } catch (err) {
      console.error('Error loading volume data:', err);
      showSnackbar('Failed to load volume data');
    } finally {
      loading = false;
    }
  }

  function handleSeriesChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    const value = target.value;

    if (value === '__new__') {
      isNewSeries = true;
      newSeriesName = '';
    } else {
      isNewSeries = false;
      seriesUuid = value;
      // Find the title for this UUID
      const series = seriesOptions.find((s) => s.uuid === value);
      if (series) {
        seriesTitle = series.title;
      }
    }
  }

  async function handleSave() {
    if (!originalMetadata) return;

    saving = true;
    try {
      // Determine final series UUID and title
      let finalSeriesUuid = seriesUuid;
      let finalSeriesTitle = seriesTitle;

      if (isNewSeries) {
        if (!newSeriesName.trim()) {
          showSnackbar('Please enter a series name');
          saving = false;
          return;
        }
        finalSeriesUuid = generateNewSeriesUuid();
        finalSeriesTitle = newSeriesName.trim();
      }

      // Update IndexedDB metadata
      const metadataUpdates: Partial<VolumeMetadata> = {};

      if (finalSeriesUuid !== originalMetadata.series_uuid) {
        metadataUpdates.series_uuid = finalSeriesUuid;
      }
      if (finalSeriesTitle !== originalMetadata.series_title) {
        metadataUpdates.series_title = finalSeriesTitle;
      }
      if (volumeTitle !== originalMetadata.volume_title) {
        metadataUpdates.volume_title = volumeTitle;
      }

      if (Object.keys(metadataUpdates).length > 0) {
        await updateVolumeInDb(volumeUuid, metadataUpdates);
      }

      // Update localStorage stats
      updateVolumeStats(volumeUuid, {
        progress,
        chars,
        timeReadInMinutes,
        series_uuid: finalSeriesUuid,
        series_title: finalSeriesTitle,
        volume_title: volumeTitle
      });

      showSnackbar('Volume updated');

      // Call onSave callback if provided
      if ($volumeEditorModalStore?.onSave) {
        $volumeEditorModalStore.onSave();
      }

      handleClose();
    } catch (err) {
      console.error('Error saving volume:', err);
      showSnackbar('Failed to save changes');
    } finally {
      saving = false;
    }
  }

  function handleResetProgress() {
    progress = 0;
    timeReadInMinutes = 0;
    timeHours = 0;
    timeMinutes = 0;
  }

  async function handleResetCover() {
    try {
      saving = true;
      await resetVolumeCover(volumeUuid);

      // Reload thumbnail
      const data = await getVolumeData(volumeUuid);
      if (data?.metadata.thumbnail) {
        if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
        thumbnailUrl = URL.createObjectURL(data.metadata.thumbnail);
      }

      showSnackbar('Cover reset to first page');
    } catch (err) {
      console.error('Error resetting cover:', err);
      showSnackbar('Failed to reset cover');
    } finally {
      saving = false;
    }
  }

  const validImageMimeTypes = new Set(Object.values(IMAGE_MIME_TYPES));

  function isValidImageFile(file: File): boolean {
    return validImageMimeTypes.has(file.type) || file.type.startsWith('image/');
  }

  function handleCoverSelected(file: File) {
    showCoverPicker = false;
    saveCover(file);
  }

  async function saveCover(file: File) {
    if (!isValidImageFile(file)) {
      showSnackbar('Please select a valid image file');
      return;
    }

    try {
      saving = true;
      await updateVolumeCover(volumeUuid, file);

      // Reload thumbnail
      const data = await getVolumeData(volumeUuid);
      if (data?.metadata.thumbnail) {
        if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
        thumbnailUrl = URL.createObjectURL(data.metadata.thumbnail);
      }

      showSnackbar('Cover updated');
    } catch (err) {
      console.error('Error updating cover:', err);
      showSnackbar('Failed to update cover');
    } finally {
      saving = false;
    }
  }

  function handleCancel() {
    if ($volumeEditorModalStore?.onCancel) {
      $volumeEditorModalStore.onCancel();
    }
    handleClose();
  }

  function handleClose() {
    open = false;
    loading = true; // Reset for next open
    if (thumbnailUrl) {
      URL.revokeObjectURL(thumbnailUrl);
      thumbnailUrl = null;
    }
    closeVolumeEditor();
  }
</script>

<Modal bind:open size="lg" onclose={handleClose}>
  <div class="p-2">
    <h3 class="mb-4 text-xl font-semibold text-gray-900 dark:text-white">Edit Volume</h3>

    {#if loading}
      <div class="flex items-center justify-center py-12">
        <Spinner size="8" />
      </div>
    {:else}
      <div class="flex flex-col gap-6">
        <!-- Top section: Cover + Metadata -->
        <div class="flex gap-6">
          <!-- Cover Image -->
          <div class="flex flex-col items-center gap-2">
            <div
              class="flex h-[175px] w-[125px] items-center justify-center overflow-hidden rounded-lg border border-gray-900 bg-black"
            >
              {#if thumbnailUrl}
                <img
                  src={thumbnailUrl}
                  alt="Cover"
                  class="max-h-[175px] max-w-[125px] object-contain"
                />
              {:else}
                <span class="text-sm text-gray-400">No cover</span>
              {/if}
            </div>
            <div class="flex gap-1">
              <Button size="xs" color="light" onclick={() => (showCoverPicker = true)}>
                Change
              </Button>
              <Button size="xs" color="light" onclick={handleResetCover} disabled={saving}>
                Reset
              </Button>
            </div>
          </div>

          <!-- Metadata Fields -->
          <div class="flex flex-1 flex-col gap-3">
            <!-- Series -->
            <div>
              <Label for="series" class="mb-1">Series</Label>
              <div class="flex gap-2">
                {#if isNewSeries}
                  <Input
                    id="new-series"
                    bind:value={newSeriesName}
                    placeholder="Enter new series name"
                    class="flex-1"
                  />
                  <Button size="sm" color="light" onclick={() => (isNewSeries = false)}>
                    Cancel
                  </Button>
                {:else}
                  <Select id="series" class="flex-1" onchange={handleSeriesChange}>
                    {#each seriesOptions as series}
                      <option value={series.uuid} selected={series.uuid === seriesUuid}>
                        {series.title}
                      </option>
                    {/each}
                    <option value="__new__">+ Create new series...</option>
                  </Select>
                {/if}
              </div>
            </div>

            <!-- Volume Name -->
            <div>
              <Label for="volume-title" class="mb-1">Volume Name</Label>
              <Input id="volume-title" bind:value={volumeTitle} />
            </div>

            <!-- Volume UUID (read-only) -->
            <div>
              <Label class="mb-1 text-gray-500">Volume UUID</Label>
              <code
                class="block rounded bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              >
                {volumeUuid}
              </code>
            </div>
          </div>
        </div>

        <!-- Reading Progress Section -->
        <div class="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <div class="mb-3 flex items-center justify-between">
            <h4 class="font-medium text-gray-900 dark:text-white">Reading Progress</h4>
            <Button size="xs" color="red" outline onclick={handleResetProgress}>Reset All</Button>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <Label for="progress" class="mb-1">Current Page</Label>
              <div class="flex items-center gap-2">
                <Input
                  id="progress"
                  type="number"
                  bind:value={progress}
                  min={0}
                  max={pageCount}
                  class="w-24"
                />
                <span class="text-sm text-gray-500">/ {pageCount}</span>
              </div>
            </div>

            <div>
              <Label class="mb-1 text-gray-500">Characters Read</Label>
              <div class="flex items-center gap-2 py-2">
                <span class="text-sm text-gray-600 dark:text-gray-400">
                  {(chars ?? 0).toLocaleString()} / {(characterCount ?? 0).toLocaleString()}
                </span>
              </div>
            </div>

            <div>
              <Label for="time-hours" class="mb-1">Time Read</Label>
              <div class="flex items-center gap-1">
                <Input
                  id="time-hours"
                  type="number"
                  bind:value={timeHours}
                  oninput={updateMinutesFromTime}
                  min={0}
                  class="w-16"
                />
                <span class="text-sm text-gray-500">h</span>
                <Input
                  id="time-minutes"
                  type="number"
                  bind:value={timeMinutes}
                  oninput={updateMinutesFromTime}
                  min={0}
                  max={59}
                  class="w-16"
                />
                <span class="text-sm text-gray-500">m</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Missing Pages Section (only shown if there are missing pages) -->
        {#if missingPagePaths.length > 0}
          <div
            class="rounded-lg border border-yellow-300 bg-yellow-50 p-4 dark:border-yellow-600 dark:bg-yellow-900/20"
          >
            <h4 class="mb-2 font-medium text-yellow-800 dark:text-yellow-200">
              Missing Pages ({missingPagePaths.length})
            </h4>
            <p class="mb-2 text-sm text-yellow-700 dark:text-yellow-300">
              The following pages were not found in the archive and have been replaced with
              placeholders:
            </p>
            <ul class="max-h-32 overflow-y-auto text-sm text-yellow-600 dark:text-yellow-400">
              {#each missingPagePaths as path}
                <li class="font-mono">{path}</li>
              {/each}
            </ul>
          </div>
        {/if}

        <!-- Actions -->
        <div class="flex justify-end gap-2">
          <Button color="alternative" onclick={handleCancel} disabled={saving}>Cancel</Button>
          <Button color="primary" onclick={handleSave} disabled={saving}>
            {#if saving}
              <Spinner size="4" class="mr-2" />
            {/if}
            Save
          </Button>
        </div>
      </div>
    {/if}
  </div>
</Modal>

<!-- Cover Picker Sub-Modal -->
{#if showCoverPicker}
  <VolumeEditorCoverPicker
    {volumeUuid}
    onSelect={handleCoverSelected}
    onCancel={() => (showCoverPicker = false)}
  />
{/if}
