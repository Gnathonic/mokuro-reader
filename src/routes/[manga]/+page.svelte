<script lang="ts">
  import { catalog } from '$lib/catalog';
  import { goto } from '$app/navigation';
  import VolumeItem from '$lib/components/VolumeItem.svelte';
  import PlaceholderVolumeItem from '$lib/components/PlaceholderVolumeItem.svelte';
  import BackupButton from '$lib/components/BackupButton.svelte';
  import { Button, Listgroup, Spinner, Badge, Dropdown, DropdownItem } from 'flowbite-svelte';
  import { db } from '$lib/catalog/db';
  import { promptConfirmation, zipManga, showSnackbar } from '$lib/util';
  import { promptExtraction } from '$lib/util/modals';
  import { progressTrackerStore } from '$lib/util/progress-tracker';
  import { page } from '$app/stores';
  import type { VolumeMetadata } from '$lib/types';
  import { deleteVolume, volumes, progress } from '$lib/settings';
  import { personalizedReadingSpeed } from '$lib/settings/reading-speed';
  import {
    CloudArrowUpOutline,
    TrashBinSolid,
    DownloadSolid,
    FileLinesOutline,
    SortOutline,
    GridOutline,
    ListOutline,
    DotsVerticalOutline
  } from 'flowbite-svelte-icons';
  import { backupQueue } from '$lib/util/backup-queue';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import { providerManager } from '$lib/util/sync';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { browser } from '$app/environment';
  import { getCharCount } from '$lib/util/count-chars';

  // Calculate manga stats locally to avoid circular dependency
  let mangaStats = $derived.by(() => {
    if (!manga || manga.length === 0 || !$volumes) return null;

    return manga
      .map((vol) => vol.volume_uuid)
      .reduce(
        (stats, volumeId) => {
          const timeReadInMinutes = $volumes[volumeId]?.timeReadInMinutes || 0;
          const chars = $volumes[volumeId]?.chars || 0;
          const completed = $volumes[volumeId]?.completed ? 1 : 0;

          stats.timeReadInMinutes = stats.timeReadInMinutes + timeReadInMinutes;
          stats.chars = stats.chars + chars;
          stats.completed = stats.completed + completed;

          return stats;
        },
        { timeReadInMinutes: 0, chars: 0, completed: 0 }
      );
  });

  // Track Japanese character counts per volume (calculated from pages)
  let volumeJapaneseChars = $state<Map<string, number>>(new Map());

  // Calculate Japanese character counts from pages data when manga list changes
  $effect(() => {
    if (!manga || manga.length === 0) return;

    const fetchCharCounts = async () => {
      const charCounts = new Map<string, number>();

      for (const vol of manga) {
        const volumeData = await db.volumes_data.get(vol.volume_uuid);
        if (volumeData?.pages) {
          const { charCount } = getCharCount(volumeData.pages);
          charCounts.set(vol.volume_uuid, charCount);
        }
      }

      volumeJapaneseChars = charCounts;
    };

    fetchCharCounts();
  });

  // Calculate total Japanese characters in series
  let totalSeriesChars = $derived.by(() => {
    if (!manga || manga.length === 0) return 0;
    return manga.reduce((total, vol) => {
      return total + (volumeJapaneseChars.get(vol.volume_uuid) || 0);
    }, 0);
  });

  let estimatedMinutesLeft = $derived.by(() => {
    if (!mangaStats || !totalSeriesChars) return null;

    const charsRemaining = totalSeriesChars - mangaStats.chars;
    if (charsRemaining <= 0) return null;

    // Get personalized reading speed
    const readingSpeed = $personalizedReadingSpeed;
    if (!readingSpeed.isPersonalized || readingSpeed.charsPerMinute <= 0) {
      return null;
    }

    return Math.ceil(charsRemaining / readingSpeed.charsPerMinute);
  });

  // Format time display
  function formatTime(minutes: number): string {
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }

  // View mode state (persisted to localStorage)
  type ViewMode = 'list' | 'grid';
  let viewMode = $state<ViewMode>(
    (browser && (localStorage.getItem('series-view-mode') as ViewMode)) || 'grid'
  );

  // Sort mode state (persisted to localStorage)
  type SortMode = 'unread-first' | 'alphabetical';
  let sortMode = $state<SortMode>(
    (browser && (localStorage.getItem('series-sort-mode') as SortMode)) || 'unread-first'
  );

  // Update localStorage when modes change
  $effect(() => {
    if (browser) {
      localStorage.setItem('series-view-mode', viewMode);
      localStorage.setItem('series-sort-mode', sortMode);
    }
  });

  function toggleViewMode() {
    viewMode = viewMode === 'list' ? 'grid' : 'list';
  }

  function toggleSortMode() {
    sortMode = sortMode === 'unread-first' ? 'alphabetical' : 'unread-first';
  }

  // Reactive sorted volumes - avoids circular dependency by making sorting fully reactive
  let allVolumes = $derived.by(() => {
    const seriesVolumes = $catalog?.find(
      (item) => item.series_uuid === $page.params.manga
    )?.volumes;
    if (!seriesVolumes) return undefined;

    // Create a copy to sort
    const volumesToSort = [...seriesVolumes];

    volumesToSort.sort((a, b) => {
      if (sortMode === 'unread-first') {
        // Get completion status from current page position only (source of truth)
        const aCurrentPage = $progress?.[a.volume_uuid] || 0;
        const bCurrentPage = $progress?.[b.volume_uuid] || 0;

        const aComplete = aCurrentPage === a.page_count || aCurrentPage === a.page_count - 1;
        const bComplete = bCurrentPage === b.page_count || bCurrentPage === b.page_count - 1;

        // Sort unread first, then by title
        if (aComplete !== bComplete) {
          return aComplete ? 1 : -1; // Unread (false) comes before complete (true)
        }
      }

      // Within same completion status (or alphabetical mode), sort alphabetically
      return a.volume_title.localeCompare(b.volume_title, undefined, {
        numeric: true,
        sensitivity: 'base'
      });
    });

    return volumesToSort;
  });

  // Separate real volumes from placeholders
  let manga = $derived(allVolumes?.filter((v) => !v.isPlaceholder) || []);
  let placeholders = $derived(allVolumes?.filter((v) => v.isPlaceholder) || []);

  let loading = $state(false);

  // Subscribe to unified cloud cache updates
  let cloudFiles = $state<Map<string, any[]>>(new Map());
  let cacheHasLoaded = $state(false);
  let wasFetching = $state(false);

  $effect(() => {
    return unifiedCloudManager.cloudFiles.subscribe((value) => {
      console.log('[Series Page] Cloud files updated:', value.size, 'series');
      cloudFiles = value;
      // If we get files and weren't fetching, cache must already be loaded
      if (value.size > 0 && !wasFetching) {
        cacheHasLoaded = true;
        console.log('[Series Page] Cache already loaded (has files)');
      }
    });
  });

  // Track when fetching completes to know when cache is loaded
  $effect(() => {
    return unifiedCloudManager.isFetching.subscribe((isFetching) => {
      console.log('[Series Page] isFetching:', isFetching, 'wasFetching:', wasFetching);
      // Mark cache as loaded when fetching transitions from true to false
      if (wasFetching && !isFetching) {
        cacheHasLoaded = true;
        console.log('[Series Page] Cache has loaded (fetch complete)');
      }
      wasFetching = isFetching;
      // Also mark as loaded if not fetching and we have files
      if (!isFetching && cloudFiles.size > 0) {
        cacheHasLoaded = true;
        console.log('[Series Page] Cache already loaded (not fetching + has files)');
      }
    });
  });

  // Subscribe to provider manager status for reactive authentication state
  let providerStatus = $state({ hasAnyAuthenticated: false, providers: {}, needsAttention: false });
  $effect(() => {
    return providerManager.status.subscribe((value) => {
      console.log('[Series Page] Provider status updated:', value.hasAnyAuthenticated, value);
      providerStatus = value;
      // Reset cache loaded state when provider changes
      if (!value.hasAnyAuthenticated) {
        cacheHasLoaded = false;
        wasFetching = false;
      }
    });
  });
  let hasAnyProvider = $derived(providerStatus.hasAnyAuthenticated);
  let isCloudReady = $derived(hasAnyProvider && cacheHasLoaded);

  // Get active provider's display name
  let providerDisplayName = $derived.by(() => {
    const provider = unifiedCloudManager.getActiveProvider();
    return provider?.name || 'cloud';
  });

  // Debug logging for reactive values
  $effect(() => {
    console.log(
      '[Series Page] Reactive values - hasAnyProvider:',
      hasAnyProvider,
      'allBackedUp:',
      allBackedUp,
      'anyBackedUp:',
      anyBackedUp
    );
  });

  // Use $effect to manually compute these values when cloudFiles changes
  let allBackedUp = $state(false);
  let anyBackedUp = $state(false);

  $effect(() => {
    // This effect runs whenever cloudFiles changes
    if (!manga || manga.length === 0) {
      allBackedUp = false;
      anyBackedUp = false;
      return;
    }

    // Efficient O(1) lookup: Get series files from Map by series title
    const seriesTitle = manga[0].series_title;
    const seriesFiles = cloudFiles.get(seriesTitle) || [];

    allBackedUp = manga.every((vol) => {
      const path = `${vol.series_title}/${vol.volume_title}.cbz`;
      return seriesFiles.some((f) => f.path === path);
    });

    anyBackedUp = manga.some((vol) => {
      const path = `${vol.series_title}/${vol.volume_title}.cbz`;
      return seriesFiles.some((f) => f.path === path);
    });

    console.log(
      '[Series Page] Backup status computed - allBackedUp:',
      allBackedUp,
      'anyBackedUp:',
      anyBackedUp,
      'seriesFiles:',
      seriesFiles.length
    );
  });

  async function confirmDelete(deleteStats = false, deleteCloud = false) {
    const seriesUuid = manga?.[0].series_uuid;
    if (seriesUuid) {
      manga?.forEach((vol) => {
        const volId = vol.volume_uuid;
        db.volumes_data.where('volume_uuid').equals(vol.volume_uuid).delete();
        db.volumes.where('volume_uuid').equals(vol.volume_uuid).delete();

        // Only delete stats and progress if the checkbox is checked
        if (deleteStats) {
          deleteVolume(volId);
        }
      });

      // Delete from cloud if checkbox checked
      if (deleteCloud && hasAnyProvider && manga) {
        await deleteSeriesFromCloud(manga);
      }

      goto('/');
    }
  }

  async function deleteSeriesFromCloud(volumes: VolumeMetadata[]) {
    if (!volumes || volumes.length === 0) return;

    const seriesTitle = volumes[0].series_title;

    // Check if any volumes are backed up (efficient O(1) Map lookup)
    const backedUpVolumes = cloudFiles.get(seriesTitle) || [];

    if (backedUpVolumes.length === 0) {
      showSnackbar(`No volumes found in ${providerDisplayName}`);
      return;
    }

    try {
      // Use the new deleteSeriesFolder method which deletes the entire folder
      // The unified manager automatically updates its cache, so no need to fetch again
      const result = await unifiedCloudManager.deleteSeriesFolder(seriesTitle);

      if (result.failed === 0) {
        showSnackbar(`Deleted ${result.succeeded} volume(s) from ${providerDisplayName}`);
      } else {
        showSnackbar(`Deleted ${result.succeeded} volume(s), ${result.failed} failed`);
      }
    } catch (error) {
      console.error(`Failed to delete series from ${providerDisplayName}:`, error);
      showSnackbar(`Failed to delete from ${providerDisplayName}`);
      // Refresh cache to restore correct state on error
      await unifiedCloudManager.fetchAllCloudVolumes();
    }
  }

  async function onDeleteFromCloud() {
    if (!manga || manga.length === 0) return;

    // Check if any provider is authenticated
    if (!hasAnyProvider) {
      showSnackbar('Please connect to a cloud storage provider first');
      return;
    }

    if (!anyBackedUp) {
      showSnackbar(`No backups found in ${providerDisplayName}`);
      return;
    }

    promptConfirmation(`Delete ${manga[0].series_title} from ${providerDisplayName}?`, async () => {
      await deleteSeriesFromCloud(manga);
    });
  }

  function onDelete() {
    const hasCloudBackups = manga?.some((vol) =>
      unifiedCloudManager.existsInCloud(vol.series_title, vol.volume_title)
    );

    promptConfirmation(
      'Are you sure you want to delete this manga?',
      confirmDelete,
      undefined,
      {
        label: 'Also delete stats and progress?',
        storageKey: 'deleteStatsPreference',
        defaultValue: false
      },
      hasCloudBackups
        ? {
            label: `Also delete from ${providerDisplayName}?`,
            storageKey: 'deleteCloudPreference',
            defaultValue: false
          }
        : undefined
    );
  }

  async function onExtract() {
    if (manga && manga.length > 0) {
      const firstVolume = {
        series_title: manga[0].series_title,
        volume_title: manga[0].volume_title
      };

      promptExtraction(firstVolume, async (asCbz, individualVolumes, includeSeriesTitle) => {
        loading = true;
        loading = await zipManga(manga, asCbz, individualVolumes, includeSeriesTitle);
      });
    }
  }

  async function backupSeries() {
    if (!manga || manga.length === 0) return;

    // Check if any provider is authenticated
    const provider = unifiedCloudManager.getDefaultProvider();
    if (!provider) {
      showSnackbar('Please connect to a cloud storage provider first');
      return;
    }

    // Filter out already backed up volumes using unified cloud manager
    const volumesToBackup = manga.filter(
      (vol) => !unifiedCloudManager.existsInCloud(vol.series_title, vol.volume_title)
    );

    if (volumesToBackup.length === 0) {
      showSnackbar('All volumes already backed up');
      return;
    }

    // Add volumes to backup queue
    backupQueue.queueSeriesVolumesForBackup(volumesToBackup, provider);

    showSnackbar(`Added ${volumesToBackup.length} volume(s) to backup queue`);
  }

  async function downloadAllPlaceholders() {
    if (!placeholders || placeholders.length === 0) return;

    // Check if any cloud provider is authenticated
    if (!hasAnyProvider) {
      showSnackbar('Please sign in to a cloud storage provider first');
      return;
    }

    try {
      // Use the download queue to handle placeholders
      const { queueSeriesVolumes } = await import('$lib/util/download-queue');
      queueSeriesVolumes(placeholders);
    } catch (error) {
      console.error('Failed to download placeholders:', error);
    }
  }

  // Detect duplicate cloud files - multiple files with same path
  // Uses unified cloud manager, works with any provider
  let duplicateCloudFiles = $derived.by(() => {
    if (!manga || manga.length === 0) return [];

    // Get all cloud files for this series from unified cache
    const seriesTitle = manga[0].series_title;
    const cloudFilesForSeries = unifiedCloudManager.getCloudVolumesBySeries(seriesTitle);

    // Group cloud files by path
    const pathGroups = new Map<string, typeof cloudFilesForSeries>();
    for (const cloudFile of cloudFilesForSeries) {
      const existing = pathGroups.get(cloudFile.path);
      if (existing) {
        existing.push(cloudFile);
      } else {
        pathGroups.set(cloudFile.path, [cloudFile]);
      }
    }

    // Collect all duplicate files (keep most recent, mark others for deletion)
    const duplicates: typeof cloudFilesForSeries = [];
    for (const files of pathGroups.values()) {
      if (files.length > 1) {
        // Sort by modified time, keep most recent
        files.sort((a, b) => {
          const timeA = new Date(a.modifiedTime).getTime();
          const timeB = new Date(b.modifiedTime).getTime();
          return timeB - timeA; // Most recent first
        });

        // Add all but the first (most recent) to duplicates list
        for (let i = 1; i < files.length; i++) {
          duplicates.push(files[i]);
        }
      }
    }

    return duplicates;
  });

  let hasDuplicates = $derived(duplicateCloudFiles.length > 0);

  async function cleanCloudDuplicates() {
    if (!hasAnyProvider) {
      showSnackbar('Please connect to a cloud storage provider first');
      return;
    }

    if (duplicateCloudFiles.length === 0) {
      showSnackbar(`No duplicate ${providerDisplayName} files found`);
      return;
    }

    promptConfirmation(
      `Remove ${duplicateCloudFiles.length} duplicates from ${providerDisplayName}?\n\nWe'll keep one copy of each volume and remove the duplicates.`,
      async () => {
        let successCount = 0;
        let failCount = 0;

        for (const duplicate of duplicateCloudFiles) {
          try {
            await unifiedCloudManager.deleteFile(duplicate);
            successCount++;
          } catch (error) {
            console.error(`Failed to delete ${duplicate.path}:`, error);
            failCount++;
          }
        }

        if (failCount === 0) {
          showSnackbar(`Cleaned up ${successCount} duplicate(s)`);
        } else {
          showSnackbar(`Cleaned up ${successCount}, ${failCount} failed`);
        }
      }
    );
  }

  function goToSeriesText() {
    goto(`/${$page.params.manga}/text`);
  }

  onMount(() => {
    // Check if cache is already loaded on mount (for navigation scenarios)
    const currentCloudFiles = unifiedCloudManager.getAllCloudVolumes();
    const currentlyFetching = get(unifiedCloudManager.isFetching);

    // If we have files and not fetching, cache is already loaded
    if (currentCloudFiles.length > 0 && !currentlyFetching) {
      cacheHasLoaded = true;
      console.log(
        '[Series Page] Cache already loaded on mount:',
        currentCloudFiles.length,
        'files'
      );
    }

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        goto('/');
      }
    }

    window.addEventListener('keydown', handleKeydown);

    return () => {
      window.removeEventListener('keydown', handleKeydown);
    };
  });
</script>

<svelte:head>
  <title>{manga?.[0]?.series_title || 'Manga'}</title>
</svelte:head>
{#if !$catalog || $catalog.length === 0}
  <div class="flex items-center justify-center p-16">
    <Spinner size="12" />
  </div>
{:else if manga && manga.length > 0 && mangaStats}
  <div class="flex flex-col gap-5 p-2">
    <!-- Header Row: Title on left, Stats on right -->
    <div class="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
      <h3 class="min-w-0 flex-shrink-2 px-2 text-2xl font-bold">{manga[0].series_title}</h3>
      <div class="flex flex-row gap-2 px-2 text-base">
        <Badge color="gray" class="!min-w-0 bg-gray-100 break-words dark:bg-gray-700"
          >Volumes: {mangaStats.completed} / {manga.length}</Badge
        >
        <Badge color="gray" class="!min-w-0 bg-gray-100 break-words dark:bg-gray-700"
          >Characters: {mangaStats.chars}</Badge
        >
        <Badge color="gray" class="!min-w-0 bg-gray-100 break-words dark:bg-gray-700"
          >Time Read: {formatTime(mangaStats.timeReadInMinutes)}</Badge
        >
        {#if estimatedMinutesLeft !== null}
          <Badge color="gray" class="!min-w-0 bg-gray-100 break-words dark:bg-gray-700"
            >Time Left: ~{formatTime(estimatedMinutesLeft)}</Badge
          >
        {/if}
      </div>
    </div>

    <!-- Actions Row: All buttons -->
    <div class="flex flex-row items-stretch justify-end gap-2">
      <!-- Cloud buttons -->
      {#if isCloudReady && !allBackedUp}
        <Button color="light" onclick={backupSeries} class="!min-w-0 self-stretch">
          <CloudArrowUpOutline class="me-2 h-4 w-4 shrink-0" />
          <span class="break-words"
            >{anyBackedUp ? 'Backup remaining' : `Backup to ${providerDisplayName}`}</span
          >
        </Button>
      {/if}

      <Button color="light" onclick={onDelete} class="!min-w-0 self-stretch">
        <TrashBinSolid class="me-2 h-4 w-4 shrink-0" />
        <span class="break-words">Remove manga</span>
      </Button>

      <Button color="light" onclick={toggleSortMode} class="!min-w-0 self-stretch">
        <SortOutline class="me-2 h-5 w-5 shrink-0" />
        <span class="break-words">{sortMode === 'unread-first' ? 'Unread first' : 'Default'}</span>
      </Button>

      <Button color="light" onclick={toggleViewMode} class="!min-w-0 self-stretch">
        {#if viewMode === 'list'}
          <GridOutline class="me-2 h-5 w-5 shrink-0" />
          <span class="break-words">Grid</span>
        {:else}
          <ListOutline class="me-2 h-5 w-5 shrink-0" />
          <span class="break-words">List</span>
        {/if}
      </Button>

      <!-- More options menu -->
      <Button id="series-menu" color="light" class="!min-w-0 !p-2.5">
        <DotsVerticalOutline class="h-5 w-5" />
      </Button>
      <Dropdown triggeredBy="#series-menu" placement="bottom-end">
        {#if isCloudReady && anyBackedUp}
          <DropdownItem
            onclick={onDeleteFromCloud}
            class="flex w-full items-center text-red-500 hover:!text-red-500 dark:hover:!text-red-500"
          >
            <TrashBinSolid class="me-2 h-5 w-5 flex-shrink-0" />
            <span class="flex-1 text-left">Delete from {providerDisplayName}</span>
          </DropdownItem>
        {/if}
        <DropdownItem
          onclick={onExtract}
          disabled={loading}
          class="flex w-full items-center text-gray-700 dark:text-gray-200"
        >
          <DownloadSolid class="me-2 h-5 w-5 flex-shrink-0" />
          <span class="flex-1 text-left">{loading ? 'Extracting...' : 'Extract'}</span>
        </DropdownItem>
        <DropdownItem
          onclick={goToSeriesText}
          class="flex w-full items-center text-gray-700 dark:text-gray-200"
        >
          <FileLinesOutline class="me-2 h-5 w-5 flex-shrink-0" />
          <span class="flex-1 text-left">View Series Text</span>
        </DropdownItem>
      </Dropdown>
    </div>

    {#if viewMode === 'list'}
      <Listgroup active class="h-full w-full flex-1">
        {#if hasDuplicates && hasAnyProvider}
          <div
            class="mb-4 flex items-center justify-between rounded bg-red-50 px-4 py-2 dark:bg-red-900/20"
          >
            <h4 class="text-sm font-semibold text-red-600 dark:text-red-400">
              Duplicates found in {providerDisplayName} ({duplicateCloudFiles.length})
            </h4>
            <Button size="xs" color="red" onclick={cleanCloudDuplicates}>
              <TrashBinSolid class="me-1 h-3 w-3" />
              Clean Duplicates
            </Button>
          </div>
        {/if}

        {#each manga as volume (volume.volume_uuid)}
          <VolumeItem {volume} variant="list" />
        {/each}

        {#if placeholders && placeholders.length > 0}
          <div class="mt-4 mb-2 flex items-center justify-between px-4">
            <h4 class="text-sm font-semibold text-gray-400">
              Available in {providerDisplayName} ({placeholders.length})
            </h4>
            {#if hasAnyProvider}
              <Button size="xs" color="blue" onclick={downloadAllPlaceholders}>
                <DownloadSolid class="me-1 h-3 w-3" />
                Download all
              </Button>
            {/if}
          </div>
          {#each placeholders as placeholder (placeholder.volume_uuid)}
            <PlaceholderVolumeItem volume={placeholder} variant="list" />
          {/each}
        {/if}
      </Listgroup>
    {:else}
      <!-- Grid view -->
      <div class="flex flex-col gap-4">
        <div class="flex flex-col flex-wrap justify-center gap-5 sm:flex-row sm:justify-start">
          {#each manga as volume (volume.volume_uuid)}
            <VolumeItem {volume} variant="grid" />
          {/each}
        </div>

        {#if placeholders && placeholders.length > 0 && hasAnyProvider}
          <div class="flex items-center justify-between px-2 pt-4">
            <h4 class="text-sm font-semibold text-gray-400">
              Available in {providerDisplayName} ({placeholders.length})
            </h4>
            <Button size="xs" color="blue" onclick={downloadAllPlaceholders}>
              <DownloadSolid class="me-1 h-3 w-3" />
              Download all
            </Button>
          </div>
          <div class="flex flex-col flex-wrap justify-center gap-5 sm:flex-row sm:justify-start">
            {#each placeholders as placeholder (placeholder.volume_uuid)}
              <PlaceholderVolumeItem volume={placeholder} variant="grid" />
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{:else}
  <div class="flex justify-center p-16">Manga not found</div>
{/if}
