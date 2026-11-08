<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, Modal, Label, Input, Select, Spinner } from 'flowbite-svelte';
  import { volumeEditorModalStore, closeVolumeEditor } from '$lib/util/modals';
  import {
    getAllSeriesOptions,
    generateNewSeriesUuid,
    updateVolumeInDb,
    renameVolumeInCloud,
    updateVolumeStats,
    updateVolumeCover,
    resetVolumeCover,
    getVolumeData,
    calculateVolumeCharacterCount,
    getNextVolumeUuidInSeries
  } from '$lib/util/volume-editor';
  import {
    countReadElsewhere,
    markReadSheetOpen,
    prepareSheetVolume,
    removeCredits,
    type SheetVolume
  } from '$lib/reading-history/mark-read-flow';
  import { creditPages, currentPassCredits, formatMinutes } from '$lib/reading-history/credit';
  import { showSnackbar } from '$lib/util';
  import { sanitizeRenameTitle } from '$lib/util/sanitize-title';
  import { ProviderError } from '$lib/util/sync/provider-interface';
  import { renameRefusalMessage } from '$lib/util/sync/account-capabilities';
  import type { VolumeMetadata } from '$lib/types';
  import { get } from 'svelte/store';
  import { volumesWithTrash } from '$lib/settings/volume-data';
  import { figuresFor, readingStats, readingStatsReady } from '$lib/reading-history/stats-store';
  import { isVolumeFinished } from '$lib/util/volume-helpers';
  import VolumeEditorCoverPicker from './VolumeEditorCoverPicker.svelte';
  import {
    RASTER_FORMAT_NAMES,
    displayableCoverBlob,
    sniffRasterBlob
  } from '$lib/util/raster-image';

  let open = $state(false);
  let loading = $state(true);
  let saving = $state(false);
  let volumeUuid = $state('');

  // Original data for comparison
  let originalMetadata: VolumeMetadata | null = $state(null);
  // Editable form state
  let seriesUuid = $state('');
  let seriesTitle = $state('');
  let volumeTitle = $state('');
  let isNewSeries = $state(false);
  let newSeriesName = $state('');

  // Reading stats
  let progress = $state(0);
  let timeReadInMinutes = $state(0);
  /** Time read as the stats showed it when the editor opened: a save records the difference. */
  let loadedMinutes = 0;

  // Time display as hh:mm
  let timeHours = $state(0);
  let timeMinutes = $state(0);

  // Volume stats (read-only, from metadata)
  let characterCount = $state(0);
  let pageCount = $state(0);
  let missingPagePaths = $state<string[]>([]);

  /**
   * Characters read, as the stats count them (history + baseline, credits
   * included). A page edit moves the POSITION only (#224): the old linear
   * estimate here recorded the difference as reading, and after a mark it
   * deducted pages that were never read.
   */
  let charsRead = $state(0);
  /** "Reset All" asks the save to zero the characters as well as the time, and un-read. */
  let resetChars = $state(false);
  /** Each page's characters and the pages not read here (`prepareSheetVolume`). */
  let sheetVolume = $state<SheetVolume | null>(null);
  /** The record says finished (stored flag or page): "up to" defaults to the last page. */
  let finished = $state(false);
  /** What the current pass's credits count (the "Counted when marked read" line). */
  let counted = $state<{ ms: number; chars: number; pages: number } | null>(null);
  /** The last Remove, offered back until the editor closes. */
  let removedUndo = $state<{ text: string; undo: () => Promise<void> } | null>(null);
  let creditBusy = $state(false);

  /** The record's position count: characters of the pages before `progress`, not reading. */
  let positionChars = $derived.by(() => {
    const chars = sheetVolume?.pageChars;
    if (!chars || chars.length === 0) {
      return pageCount > 0 ? Math.round((progress / pageCount) * characterCount) : 0;
    }
    let sum = 0;
    for (let i = 0; i < Math.min(progress, chars.length); i++) sum += chars[i];
    return sum;
  });

  /** "Count pages read elsewhere…" counts pages not read here up to this page. */
  let elsewhereUpTo = $derived(finished ? pageCount : Math.max(0, Math.min(progress, pageCount)));
  let canCountElsewhere = $derived(
    !!sheetVolume &&
      elsewhereUpTo > 0 &&
      creditPages(sheetVolume.notRead, sheetVolume.pageChars, elsewhereUpTo).chars > 0
  );

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
  let hasNextSeriesVolume = $state(false);
  let coverPickerInitialPageIndex = $state<number | null>(null);
  let coverPickerOpenCropperOnLoad = $state(false);
  let lastCropZone = $state<{
    xPercent: number;
    yPercent: number;
    widthPercent: number;
    heightPercent: number;
    aspectRatio: number;
  } | null>(null);

  // Series options for dropdown
  let seriesOptions = $state<{ uuid: string; title: string }[]>([]);

  let pendingOpenCoverPicker = false;

  // Capture Escape so it doesn't propagate to the series page's back-navigation handler
  $effect(() => {
    if (!open) return;

    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // The mark-read sheet on top takes its own Escape.
        if (markReadSheetOpen()) return;
        e.stopPropagation();
        e.preventDefault();
        handleClose();
      }
    }

    window.addEventListener('keydown', handleKeydown, true);
    return () => window.removeEventListener('keydown', handleKeydown, true);
  });

  onMount(() => {
    const unsubscribe = volumeEditorModalStore.subscribe(async (value) => {
      if (value?.open && value.volumeUuid) {
        open = true;
        volumeUuid = value.volumeUuid;
        pendingOpenCoverPicker = value.openCoverPicker ?? false;
        await loadVolumeData();
        if (pendingOpenCoverPicker) {
          pendingOpenCoverPicker = false;
          openCoverPicker();
        }
      }
    });
    return unsubscribe;
  });

  async function loadVolumeData(targetVolumeUuid: string = volumeUuid) {
    loading = true;
    try {
      volumeUuid = targetVolumeUuid;

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
      // Populate form fields
      seriesUuid = data.metadata.series_uuid;
      seriesTitle = data.metadata.series_title;
      volumeTitle = data.metadata.volume_title;
      pageCount = data.metadata.page_count || 0;
      missingPagePaths = data.metadata.missing_page_paths || [];

      // Calculate character count from volume_ocr (matches VolumeItem display)
      characterCount = await calculateVolumeCharacterCount(volumeUuid);

      progress = data.stats.progress || 0;
      finished = isVolumeFinished(data.metadata, data.stats);
      resetChars = false;
      removedUndo = null;
      // A save records the DIFFERENCE from the time shown here, so it must be
      // the counted figure: before the stats' first pass the history half is
      // empty and the baseline alone would make every edit overshoot.
      await readingStatsReady();
      sheetVolume = await prepareSheetVolume(data.metadata);
      loadFigures(true);

      isNewSeries = false;
      newSeriesName = '';

      // Determine next-volume availability for "Use + Next Volume"
      hasNextSeriesVolume =
        (await getNextVolumeUuidInSeries(data.metadata.series_uuid, data.metadata.volume_uuid)) !==
        null;

      // Regenerate thumbnail URL
      if (thumbnailUrl) {
        URL.revokeObjectURL(thumbnailUrl);
      }
      const cover = displayableCoverBlob(data.metadata.thumbnail);
      if (cover) {
        thumbnailUrl = URL.createObjectURL(cover);
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

  /**
   * Re-read the counted figures (after open, Count or Remove). The time field
   * follows them unless the user has typed a time of their own, which is kept;
   * either way the save records the difference from the NEW figure.
   */
  function loadFigures(initial: boolean) {
    const stats = get(readingStats);
    const record = get(volumesWithTrash)[volumeUuid];
    const figures = figuresFor(stats, volumeUuid, record);
    const userTyped = !initial && timeReadInMinutes !== loadedMinutes;
    loadedMinutes = figures.minutes;
    if (!userTyped) {
      timeReadInMinutes = figures.minutes;
      updateTimeFromMinutes(timeReadInMinutes);
    }
    charsRead = figures.chars;
    const credits = currentPassCredits(stats, volumeUuid);
    const ms = credits.reduce((n, c) => n + c.ms, 0);
    const chars = credits.reduce((n, c) => n + c.chars, 0);
    const pages = credits.reduce((n, c) => n + c.pages.length, 0);
    counted = ms > 0 || chars > 0 ? { ms, chars, pages } : null;
  }

  async function refreshAfterCredit() {
    if (originalMetadata) sheetVolume = await prepareSheetVolume(originalMetadata);
    loadFigures(false);
  }

  async function handleCountElsewhere() {
    if (!originalMetadata || creditBusy) return;
    creditBusy = true;
    try {
      if (await countReadElsewhere(originalMetadata, elsewhereUpTo)) {
        removedUndo = null;
        await refreshAfterCredit();
      }
    } finally {
      creditBusy = false;
    }
  }

  async function handleRemoveCredits() {
    if (creditBusy) return;
    creditBusy = true;
    try {
      const result = await removeCredits(volumeUuid);
      if (result) {
        removedUndo = { text: result.removed, undo: result.undo };
        await refreshAfterCredit();
      }
    } finally {
      creditBusy = false;
    }
  }

  async function handleUndoRemove() {
    if (!removedUndo || creditBusy) return;
    creditBusy = true;
    try {
      await removedUndo.undo();
      removedUndo = null;
      await refreshAfterCredit();
    } finally {
      creditBusy = false;
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
        const safeNewSeries = sanitizeRenameTitle(newSeriesName);
        if (safeNewSeries.empty) {
          showSnackbar('Please enter a series name');
          saving = false;
          return;
        }
        if (safeNewSeries.changed) {
          showSnackbar(`Series saved as “${safeNewSeries.value}” to keep the name file-safe.`);
        }
        finalSeriesUuid = generateNewSeriesUuid();
        finalSeriesTitle = safeNewSeries.value;
      }

      // Sanitize the volume title so the stored title is a legal name on every sink
      // (cloud + filesystem + OneDrive + export); title === path going forward. The series
      // title is sanitized only when a NEW series is created (above) or via the series-rename
      // flow — sanitizing an existing series here would split it across two cloud folders.
      const safeVolume = sanitizeRenameTitle(volumeTitle);
      if (safeVolume.empty) {
        showSnackbar("Volume name can't be empty or only unusable characters.");
        return;
      }
      if (safeVolume.changed) {
        showSnackbar(`Volume saved as “${safeVolume.value}” to keep the name file-safe.`);
      }
      volumeTitle = safeVolume.value;

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

      if (
        finalSeriesTitle !== originalMetadata.series_title ||
        volumeTitle !== originalMetadata.volume_title
      ) {
        // The cloud rename GATES the local update: it must succeed first so the
        // remote .mokuro/cbz/cover are renamed (and the sidecar content
        // regenerated) before we change local metadata. If it fails — offline,
        // read-only, etc. — we abort the local rename so the library and cloud
        // stay in sync, and tell the user why nothing changed.
        try {
          await renameVolumeInCloud(originalMetadata, finalSeriesTitle, volumeTitle);
        } catch (renameErr) {
          // Another volume's backup already occupies the new name. Nothing was
          // written yet — offer to overwrite it or keep everything unchanged.
          if (renameErr instanceof ProviderError && renameErr.code === 'TARGET_EXISTS') {
            const overwrite = confirm(
              `A backup named "${finalSeriesTitle} / ${volumeTitle}" already exists in your cloud. ` +
                `Overwrite it with this volume? The existing backup will be deleted.`
            );
            if (!overwrite) {
              showSnackbar('Rename cancelled — nothing was changed.');
              return;
            }
            try {
              await renameVolumeInCloud(originalMetadata, finalSeriesTitle, volumeTitle, {
                overwrite: true
              });
            } catch (overwriteErr) {
              console.error('Cloud rename (overwrite) failed; local rename aborted:', overwriteErr);
              showSnackbar(
                renameRefusalMessage(overwriteErr) ??
                  "Couldn't rename: the change couldn't be saved to your cloud, so it wasn't applied locally either (kept in sync). Check your connection and try again."
              );
              return;
            }
          } else {
            console.error('Cloud rename failed; local rename aborted:', renameErr);
            // A permission refusal says so; only the rest is a connection problem.
            showSnackbar(
              renameRefusalMessage(renameErr) ??
                "Couldn't rename: the change couldn't be saved to your cloud, so it wasn't applied locally either (kept in sync). Check your connection and try again."
            );
            return;
          }
        }
      }

      if (Object.keys(metadataUpdates).length > 0) {
        await updateVolumeInDb(volumeUuid, metadataUpdates);
      }

      // Update localStorage stats
      updateVolumeStats(volumeUuid, {
        progress,
        chars: positionChars,
        timeRead: { from: loadedMinutes, to: timeReadInMinutes },
        // Reset All un-reads too: the card's check follows the stored flag
        // (`isVolumeFinished`), so page 0 alone would leave it showing read.
        ...(resetChars && { charsRead: { from: charsRead, to: 0 }, completed: false }),
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
    // Reset ALL: the characters read go to zero too (an explicit edit, recorded on save).
    resetChars = true;
  }

  async function handleResetCover() {
    try {
      saving = true;
      await resetVolumeCover(volumeUuid);

      // Reload thumbnail
      const data = await getVolumeData(volumeUuid);
      const cover = displayableCoverBlob(data?.metadata.thumbnail);
      if (cover) {
        if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
        thumbnailUrl = URL.createObjectURL(cover);
      }

      showSnackbar('Cover reset to first page');
    } catch (err) {
      console.error('Error resetting cover:', err);
      showSnackbar('Failed to reset cover');
    } finally {
      saving = false;
    }
  }

  /** Raster bytes only, whatever the file's type or name says (SVG is unsupported). */
  async function isValidImageFile(file: File): Promise<boolean> {
    return (await sniffRasterBlob(file).catch(() => null)) !== null;
  }

  function openCoverPicker() {
    coverPickerInitialPageIndex = null;
    coverPickerOpenCropperOnLoad = false;
    showCoverPicker = true;
  }

  function applyCoverPickerContext(context?: {
    pageIndex: number | null;
    cropZone: {
      xPercent: number;
      yPercent: number;
      widthPercent: number;
      heightPercent: number;
      aspectRatio: number;
    } | null;
  }) {
    if (!context) return;
    coverPickerInitialPageIndex = context.pageIndex;
    if (context.cropZone) {
      lastCropZone = context.cropZone;
    }
  }

  async function handleCoverSelected(
    file: File,
    context?: {
      pageIndex: number | null;
      cropZone: {
        xPercent: number;
        yPercent: number;
        widthPercent: number;
        heightPercent: number;
        aspectRatio: number;
      } | null;
    }
  ) {
    showCoverPicker = false;
    applyCoverPickerContext(context);
    await saveCover(file);
  }

  async function handleCoverSelectedAndNext(
    file: File,
    context?: {
      pageIndex: number | null;
      cropZone: {
        xPercent: number;
        yPercent: number;
        widthPercent: number;
        heightPercent: number;
        aspectRatio: number;
      } | null;
    }
  ) {
    showCoverPicker = false;
    applyCoverPickerContext(context);

    const currentVolumeUuid = volumeUuid;
    const currentSeriesUuid = seriesUuid;

    await saveCover(file);

    const nextVolumeUuid = await getNextVolumeUuidInSeries(currentSeriesUuid, currentVolumeUuid);
    if (!nextVolumeUuid) {
      showSnackbar('No next volume in this series');
      return;
    }

    coverPickerOpenCropperOnLoad = true;
    await loadVolumeData(nextVolumeUuid);
    showCoverPicker = true;
  }

  async function saveCover(file: File) {
    if (!(await isValidImageFile(file))) {
      showSnackbar(`Please select a ${RASTER_FORMAT_NAMES} image (SVG is not supported)`);
      return;
    }

    try {
      saving = true;
      await updateVolumeCover(volumeUuid, file);

      // Reload thumbnail
      const data = await getVolumeData(volumeUuid);
      const cover = displayableCoverBlob(data?.metadata.thumbnail);
      if (cover) {
        if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
        thumbnailUrl = URL.createObjectURL(cover);
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
              class="flex h-[175px] w-[125px] items-center justify-center overflow-hidden rounded-lg border border-gray-300 bg-gray-100 dark:border-gray-900 dark:bg-black"
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
              <Button size="xs" color="light" onclick={openCoverPicker}>Change</Button>
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
                <span class="text-sm text-gray-600 dark:text-gray-400" data-testid="editor-chars">
                  {(resetChars ? 0 : charsRead).toLocaleString()} / {(
                    characterCount ?? 0
                  ).toLocaleString()}
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

          <!-- What "mark as read" counted for pages not read here (#224). -->
          <div class="mt-3 space-y-2 text-sm" data-testid="editor-credit">
            {#if counted}
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="text-gray-600 dark:text-gray-400">
                  Counted when marked read: {formatMinutes(counted.ms / 60_000)} · {counted.chars.toLocaleString()}
                  characters ({counted.pages.toLocaleString()} page{counted.pages === 1 ? '' : 's'})
                </span>
                <Button
                  size="xs"
                  color="light"
                  onclick={handleRemoveCredits}
                  disabled={creditBusy}
                  data-testid="editor-credit-remove">Remove</Button
                >
              </div>
            {/if}
            {#if removedUndo}
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="text-gray-600 dark:text-gray-400">{removedUndo.text}.</span>
                <Button size="xs" color="light" onclick={handleUndoRemove} disabled={creditBusy}
                  >Undo</Button
                >
              </div>
            {/if}
            {#if canCountElsewhere}
              <Button
                size="xs"
                color="light"
                onclick={handleCountElsewhere}
                disabled={creditBusy}
                data-testid="editor-count-elsewhere">Count pages read elsewhere…</Button
              >
            {/if}
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

        <!-- Actions. relative z-10: night mode's filter on <dialog> resets stacking (CLAUDE.md). -->
        <div class="relative z-10 flex justify-end gap-2">
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
    initialPageIndex={coverPickerInitialPageIndex}
    openCropperOnLoad={coverPickerOpenCropperOnLoad}
    {lastCropZone}
    hasNextVolume={hasNextSeriesVolume}
    onSelect={handleCoverSelected}
    onSelectAndNext={handleCoverSelectedAndNext}
    onCancel={() => (showCoverPicker = false)}
  />
{/if}
