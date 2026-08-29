<script lang="ts">
  import { catalog, currentSeries } from '$lib/catalog';
  import VolumeItem from '$lib/components/VolumeItem.svelte';
  import PlaceholderVolumeItem from '$lib/components/PlaceholderVolumeItem.svelte';
  import SeriesMetadataBar from '$lib/components/Series/SeriesMetadataBar.svelte';
  import { Button, Listgroup, Spinner, Badge, Dropdown, DropdownItem } from 'flowbite-svelte';
  import { promptConfirmation, zipManga, showSnackbar } from '$lib/util';
  import { promptExtraction, promptSeriesEditor } from '$lib/util/modals';
  import { progressTrackerStore } from '$lib/util/progress-tracker';
  import { volumes, progress, settings } from '$lib/settings';
  import { getEffectiveReadingTime } from '$lib/util/reading-speed';
  import { nav, routeParams, navigateBack } from '$lib/util/hash-router';
  import { personalizedReadingSpeed } from '$lib/settings/reading-speed';
  import {
    CloudArrowUpOutline,
    TrashBinSolid,
    DownloadSolid,
    FileLinesOutline,
    SortOutline,
    GridOutline,
    ListOutline,
    DotsVerticalOutline,
    EditOutline
  } from 'flowbite-svelte-icons';
  import { backupQueue } from '$lib/util/backup-queue';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import { providerManager } from '$lib/util/sync';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { browser } from '$app/environment';
  import { preferredTitleLanguage } from '$lib/settings/settings';
  import { partitionSeriesVolumes } from '$lib/catalog/catalog';
  import { seriesMetadataMap } from '$lib/metadata/store';
  import { reconcileMissingMetadataFiles } from '$lib/metadata/series-file-sync';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import { openSeries } from '$lib/metadata/series-open';
  import { resolveDisplayTitle } from '$lib/metadata/display-title';
  import { isVolumeInstalled, needsDownload } from '$lib/catalog/volume-state';
  import { sortVolumes } from '$lib/catalog/sort-volumes';
  import { isVolumeComplete } from '$lib/util/volume-helpers';
  import { isIndexedPlaceholder } from '$lib/catalog/placeholders';
  import { deleteSeriesFromCloudByTitle, promptSeriesRemoval } from '$lib/catalog/series-delete';
  import { getCloudFileId } from '$lib/util/cloud-fields';
  import { downloadQueue } from '$lib/util/download-queue';

  // Calculate manga stats locally to avoid circular dependency
  let mangaStats = $derived.by(() => {
    if (!manga || manga.length === 0 || !$volumes) return null;

    const idleTimeoutMs = $settings.inactivityTimeoutMinutes * 60 * 1000;

    return manga
      .map((vol) => vol.volume_uuid)
      .reduce(
        (stats, volumeId) => {
          const volumeData = $volumes[volumeId];
          const timeReadInMinutes = volumeData
            ? getEffectiveReadingTime(volumeData, idleTimeoutMs)
            : 0;
          const chars = volumeData?.chars || 0;
          const completed = volumeData?.completed ? 1 : 0;

          stats.timeReadInMinutes = stats.timeReadInMinutes + timeReadInMinutes;
          stats.chars = stats.chars + chars;
          stats.completed = stats.completed + completed;

          return stats;
        },
        { timeReadInMinutes: 0, chars: 0, completed: 0 }
      );
  });

  // Calculate total Japanese characters in series (from metadata - no async needed)
  let totalSeriesChars = $derived.by(() => {
    if (!manga || manga.length === 0) return 0;
    return manga.reduce((total, vol) => {
      // Use character_count from metadata, or last element of page_char_counts
      const volTotal =
        vol.character_count ||
        (vol.page_char_counts?.length > 0
          ? vol.page_char_counts[vol.page_char_counts.length - 1]
          : 0);
      return total + volTotal;
    }, 0);
  });

  // Calculate chars read in series (from metadata + progress)
  let charsReadInSeries = $derived.by(() => {
    if (!manga || manga.length === 0) return 0;
    return manga.reduce((total, vol) => {
      const volumeData = $volumes?.[vol.volume_uuid];
      const currentPage = volumeData?.progress || 0;
      if (currentPage <= 0) return total;

      // If volume is completed, use full character count
      // (completion can trigger on second-to-last page, so progress may be short)
      if (volumeData?.completed) {
        return (
          total +
          (vol.page_char_counts?.length
            ? vol.page_char_counts[vol.page_char_counts.length - 1] || 0
            : vol.character_count || volumeData.chars || 0)
        );
      }

      // Not installed (placeholder from the series index): no per-page counts,
      // but the progress record keeps the cumulative chars read of that volume.
      if (!vol.page_char_counts?.length) return total + (volumeData?.chars || 0);

      // page_char_counts is cumulative: [50, 120, 200] means page 3 has 200 total chars through it
      // currentPage is 1-indexed, so page 1 = index 0, page N = index N-1
      const charIndex = Math.min(currentPage, vol.page_char_counts.length) - 1;
      const charsRead = vol.page_char_counts[charIndex] || 0;
      return total + charsRead;
    }, 0);
  });

  let estimatedMinutesLeft = $derived.by(() => {
    if (!totalSeriesChars) return null;

    const charsRemaining = totalSeriesChars - charsReadInSeries;
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

  // Compact character formatter with 3 significant digits
  const charFormatter = new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumSignificantDigits: 3
  });
  const formatCharCount = (chars: number) => charFormatter.format(chars || 0);

  // View mode state (persisted to localStorage)
  type ViewMode = 'list' | 'grid';
  let viewMode = $state<ViewMode>(
    (browser && (localStorage.getItem('series-view-mode') as ViewMode)) || 'grid'
  );

  // Sort mode state (persisted to localStorage)
  type SortMode = 'unread-first' | 'reverse-alphabetical' | 'alphabetical';
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

  // Series open is a load step: refresh this series' series.json, materialize
  // its volumes, install covers. Keyed on the route param so navigating between
  // series re-runs it; `openSeries` itself dedupes, never rejects, and settles
  // once the rows exist rather than waiting on the cover downloads behind them.
  let seriesOpenPending = $state(false);
  // Only the newest run may clear the flag. Series A settling after a
  // navigation to B would otherwise drop B's spinner and flash "Series not
  // found" over a series still being materialized.
  let seriesOpenRun = 0;

  $effect(() => {
    const title = $routeParams.manga;
    if (!browser || !title) return;
    const run = ++seriesOpenRun;
    seriesOpenPending = true;
    openSeries(title).finally(() => {
      if (run === seriesOpenRun) seriesOpenPending = false;
    });
  });

  function toggleViewMode() {
    viewMode = viewMode === 'list' ? 'grid' : 'list';
  }

  function toggleSortMode() {
    sortMode =
      sortMode === 'unread-first'
        ? 'alphabetical'
        : sortMode === 'alphabetical'
          ? 'reverse-alphabetical'
          : 'unread-first';
  }

  /** Read through? The app's one completion rule, over this list's raw progress. */
  function isReadThrough(vol: { volume_uuid: string; page_count: number }): boolean {
    return isVolumeComplete($progress?.[vol.volume_uuid] || 0, vol.page_count);
  }

  // Reactive sorted volumes - uses currentSeries which handles title/UUID matching
  // Returns null while loading, undefined if series not found, array if found
  let allVolumes = $derived.by(() => {
    const seriesVolumes = $currentSeries;
    // Propagate loading state (null = loading, [] = not found)
    if (seriesVolumes === null) return null;
    if (seriesVolumes.length === 0) return undefined;

    // Create a copy to sort
    const volumesToSort = [...seriesVolumes];

    volumesToSort.sort((a, b) => {
      if (sortMode === 'unread-first') {
        const aComplete = isReadThrough(a);
        const bComplete = isReadThrough(b);

        // Sort unread first, then by title
        if (aComplete !== bComplete) {
          return aComplete ? 1 : -1; // Unread (false) comes before complete (true)
        }
      } else if (sortMode === 'reverse-alphabetical') {
        return -sortVolumes(a, b);
      }

      // Within same completion status (or alphabetical mode), the catalog's own natural
      // volume order — one collator for every list of volumes in the app.
      return sortVolumes(a, b);
    });

    return volumesToSort;
  });

  // Separate real volumes from placeholders
  let manga = $derived(allVolumes?.filter((v) => !v.isPlaceholder) || []);
  let placeholders = $derived(allVolumes?.filter((v) => v.isPlaceholder) || []);
  // Rows kept for their history whose pages are gone. They stay in `manga` —
  // they are real volumes with real stats — but they are downloadable, not
  // readable, and nothing may try to read their files. Only the ones the
  // catalog could match to a cloud file are counted as "available": a volume
  // whose backup is gone too has nowhere to download from, and counting it
  // would promise a "Download all" that silently does nothing.
  let notInstalled = $derived(manga.filter((vol) => needsDownload(vol) && !!getCloudFileId(vol)));

  // Where the rows whose pages are gone are DRAWN (display only — they keep their data,
  // their progress and every action they had).
  let volumeSections = $derived(partitionSeriesVolumes(manga));
  let listedVolumes = $derived(volumeSections.listed);
  let sectionVolumes = $derived(volumeSections.absent);
  // The header counts what the section is offering: the absent rows it holds
  // plus the cloud-only placeholders.
  let cloudSectionCount = $derived(placeholders.length + sectionVolumes.length);
  // Raw folder title (identity) and its human-facing overlay. The overlay is
  // presentation only: rename/cloud/delete flows below keep using seriesTitle.
  let seriesTitle = $derived(manga[0]?.series_title || placeholders[0]?.series_title || '');
  let seriesDisplayTitle = $derived(
    seriesTitle
      ? resolveDisplayTitle(
          seriesTitle,
          $seriesMetadataMap.get(normalizeSeriesKey(seriesTitle)),
          $preferredTitleLanguage
        )
      : ''
  );
  let volumeListRenderKey = $derived.by(() =>
    manga
      .map((vol) => {
        const thumbSig = vol.thumbnail
          ? `${vol.thumbnail.name}:${vol.thumbnail.size}:${vol.thumbnail.lastModified}:${vol.thumbnail.type}`
          : 'none';
        return `${vol.volume_uuid}:${thumbSig}:${vol.thumbnail_width ?? 0}:${vol.thumbnail_height ?? 0}`;
      })
      .join('|')
  );

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
  let providerStatus = $state<{
    hasAnyAuthenticated: boolean;
    currentProviderType: string | null;
    providers: Record<string, { isAuthenticated?: boolean; isReadOnly?: boolean } | null>;
    needsAttention: boolean;
  }>({
    hasAnyAuthenticated: false,
    currentProviderType: null,
    providers: {},
    needsAttention: false
  });
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

  // Every absent row that reaches this view is one the active listing can deliver: the
  // catalog store already dropped removed volumes with no current cloud file behind them
  // (`isCatalogVisible`), so the section never seats an offer nothing can honor. The rows
  // still up in the list (mixed mode) only justify a section when there is a provider to
  // fetch them from — otherwise an offer of "available in <cloud>" would head an empty
  // section built from a cached cloud id nothing can act on.
  // Declared here because it reads `hasAnyProvider`, which the provider block above sets up.
  let showCloudSection = $derived(sectionVolumes.length > 0 || placeholders.length > 0);
  let isCloudReady = $derived(hasAnyProvider && cacheHasLoaded);

  // Check if current provider is WebDAV and in read-only mode
  let isReadOnlyMode = $derived(
    providerStatus.currentProviderType === 'webdav' &&
      providerStatus.providers['webdav']?.isReadOnly === true
  );

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

    // Build a path set from all cloud files to avoid lookup inconsistencies
    // between different cache adapters and grouping keys.
    const cloudPathSet = new Set<string>();
    for (const files of cloudFiles.values()) {
      for (const file of files) {
        cloudPathSet.add(file.path);
      }
    }

    allBackedUp = manga.every((vol) => {
      const path = `${vol.series_title}/${vol.volume_title}.cbz`;
      return cloudPathSet.has(path);
    });

    anyBackedUp = manga.some((vol) => {
      const path = `${vol.series_title}/${vol.volume_title}.cbz`;
      return cloudPathSet.has(path);
    });

    console.log(
      '[Series Page] Backup status computed - allBackedUp:',
      allBackedUp,
      'anyBackedUp:',
      anyBackedUp,
      'cloudPaths:',
      cloudPathSet.size
    );
  });

  async function onDeleteFromCloud() {
    if (!hasAnyProvider) {
      showSnackbar('Please connect to a cloud storage provider first');
      return;
    }

    const seriesTitle = manga?.[0]?.series_title || placeholders?.[0]?.series_title;
    if (!seriesTitle) return;

    const hasBackups = (cloudFiles.get(seriesTitle) || []).length > 0;
    if (!hasBackups) {
      showSnackbar(`No backups found in ${providerDisplayName}`);
      return;
    }

    promptConfirmation(`Delete ${seriesTitle} from ${providerDisplayName}?`, async () => {
      await deleteSeriesFromCloudByTitle(seriesTitle);
    });
  }

  // The dialog itself lives in $lib/catalog/series-delete so the catalog's hover +
  // Delete shortcut raises exactly this one, checkboxes and all.
  function onDelete() {
    void promptSeriesRemoval(manga, { onRemoved: () => nav.toCatalog() });
  }

  async function onExtract() {
    if (manga && manga.length > 0) {
      const firstVolume = {
        series_title: manga[0].series_title,
        volume_title: manga[0].volume_title
      };

      promptExtraction(
        firstVolume,
        async (
          asCbz,
          individualVolumes,
          includeSeriesTitle,
          includeSidecars,
          embedSidecarsInArchive
        ) => {
          loading = true;
          loading = await zipManga(manga, asCbz, individualVolumes, includeSeriesTitle, {
            includeSidecars,
            embedSidecarsInArchive
          });
        }
      );
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

    // Filter out already backed up volumes using the same cloud path set
    // used by the current view status calculations.
    const cloudPathSet = new Set<string>();
    for (const files of cloudFiles.values()) {
      for (const file of files) {
        cloudPathSet.add(file.path);
      }
    }

    const volumesToBackup = manga.filter(
      // Metadata-only rows have no pages to upload.
      (vol) =>
        isVolumeInstalled(vol) && !cloudPathSet.has(`${vol.series_title}/${vol.volume_title}.cbz`)
    );

    if (volumesToBackup.length === 0) {
      // Same hole as the cloud screen's "backup all": nothing to upload means
      // the backup run never starts, so the `series.json` this folder may never
      // have had would stay missing. Back it off the current listing instead.
      void reconcileMissingMetadataFiles();
      showSnackbar('All volumes already backed up');
      return;
    }

    // Add volumes to backup queue
    backupQueue.queueSeriesVolumesForBackup(volumesToBackup, provider);

    showSnackbar(`Added ${volumesToBackup.length} volume(s) to backup queue`);
  }

  async function downloadAllPlaceholders() {
    // Both flavours of not-installed volume: cloud-only placeholders and rows
    // whose files were removed from this device.
    const toDownload = [...notInstalled, ...placeholders];
    if (toDownload.length === 0) return;

    // Check if any cloud provider is authenticated
    if (!hasAnyProvider) {
      showSnackbar('Please sign in to a cloud storage provider first');
      return;
    }

    try {
      const { queueSeriesVolumes } = await import('$lib/util/download-queue');
      const before = get(downloadQueue).length;
      queueSeriesVolumes(toDownload);
      if (get(downloadQueue).length === before) {
        showSnackbar('Nothing to download — these volumes are already queued or unavailable');
      }
    } catch (error) {
      console.error('Failed to download volumes:', error);
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
    const seriesId = $routeParams.manga;
    if (seriesId) nav.toSeriesText(seriesId);
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
        navigateBack();
      }
    }

    window.addEventListener('keydown', handleKeydown);

    return () => {
      window.removeEventListener('keydown', handleKeydown);
    };
  });
</script>

<svelte:head>
  <title>{seriesDisplayTitle || 'Manga'}</title>
</svelte:head>
{#if $catalog === null || allVolumes === null}
  <!-- Still loading from IndexedDB -->
  <div class="flex items-center justify-center p-16">
    <Spinner size="12" />
  </div>
{:else if manga && manga.length > 0 && mangaStats}
  <div class="flex flex-col gap-5 p-2">
    <!-- Header Row: Title on left, Stats on right -->
    <div class="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
      <div class="flex min-w-0 items-center gap-1">
        {#key seriesDisplayTitle}
          <h3 class="min-w-0 flex-shrink-2 px-2 text-2xl font-bold">{seriesDisplayTitle}</h3>
        {/key}
        <button
          onclick={() => promptSeriesEditor(seriesTitle)}
          class="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          title="Edit series"
        >
          <EditOutline class="h-4 w-4" />
        </button>
      </div>
      <div class="flex flex-row gap-2 px-2 text-base">
        <Badge color="gray" class="!min-w-0 bg-gray-100 break-words dark:bg-gray-700"
          >Volumes: {mangaStats.completed} / {manga.length}</Badge
        >
        <Badge color="gray" class="!min-w-0 bg-gray-100 break-words dark:bg-gray-700">
          Characters: {formatCharCount(charsReadInSeries)}
          {#if totalSeriesChars > 0}
            / {formatCharCount(totalSeriesChars)}
          {/if}
        </Badge>
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

    <SeriesMetadataBar seriesTitle={manga[0].series_title} volumes={manga} />

    <!-- Actions Row: All buttons -->
    <div class="flex flex-row items-stretch justify-end gap-2">
      <!-- Cloud buttons - hidden in read-only mode -->
      {#if isCloudReady && !allBackedUp && !isReadOnlyMode}
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
        <span class="break-words">
          {#if sortMode === 'unread-first'}
            Unread first
          {:else if sortMode === 'reverse-alphabetical'}
            Reverse default
          {:else}
            Default
          {/if}</span
        >
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
        {#if isCloudReady && anyBackedUp && !isReadOnlyMode}
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
        {#if hasDuplicates && hasAnyProvider && !isReadOnlyMode}
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

        {#key volumeListRenderKey}
          {#each listedVolumes as volume (volume.volume_uuid)}
            <VolumeItem {volume} variant="list" />
          {/each}
        {/key}

        {#if showCloudSection}
          <div class="mt-4 mb-2 flex items-center justify-between px-4">
            <!-- Keyed: a live-flipping count is exactly the text Migaku rewrites and then
                 holds stale (see CLAUDE.md). -->
            <h4 class="text-sm font-semibold text-gray-400">
              Available in {providerDisplayName}
              {#key cloudSectionCount}<span>({cloudSectionCount})</span>{/key}
            </h4>
            {#if hasAnyProvider}
              <Button size="xs" color="blue" onclick={downloadAllPlaceholders}>
                <DownloadSolid class="me-1 h-3 w-3" />
                Download all
              </Button>
            {/if}
          </div>
          <!-- Real rows, drawn here rather than up in the list: still VolumeItem, so the
               download fills the row and hover + Delete still removes it. -->
          {#key volumeListRenderKey}
            {#each sectionVolumes as volume (volume.volume_uuid)}
              <VolumeItem {volume} variant="list" />
            {/each}
          {/key}
          <!-- A placeholder that adopted a `series.json` entry has a real uuid and real
               counts, so it gets the SAME row a metadata-only volume gets: progress,
               estimate, cover, badge, size. Only bare shares (derived uuid, zero
               counts) keep the minimal card, which is all they can fill. -->
          {#each placeholders as placeholder (placeholder.volume_uuid)}
            {#if isIndexedPlaceholder(placeholder)}
              <VolumeItem volume={placeholder} variant="list" />
            {:else}
              <PlaceholderVolumeItem volume={placeholder} variant="list" />
            {/if}
          {/each}
        {/if}
      </Listgroup>
    {:else}
      <!-- Grid view -->
      <div class="flex flex-col gap-4">
        <div class="flex flex-col flex-wrap justify-center gap-5 sm:flex-row sm:justify-start">
          {#key volumeListRenderKey}
            {#each listedVolumes as volume (volume.volume_uuid)}
              <VolumeItem {volume} variant="grid" />
            {/each}
          {/key}
        </div>

        {#if showCloudSection}
          <div class="flex items-center justify-between px-2 pt-4">
            <!-- Keyed for the same reason as the list view's heading above. -->
            <h4 class="text-sm font-semibold text-gray-400">
              Available in {providerDisplayName}
              {#key cloudSectionCount}<span>({cloudSectionCount})</span>{/key}
            </h4>
            {#if hasAnyProvider}
              <Button size="xs" color="blue" onclick={downloadAllPlaceholders}>
                <DownloadSolid class="me-1 h-3 w-3" />
                Download all
              </Button>
            {/if}
          </div>
          <div class="flex flex-col flex-wrap justify-center gap-5 sm:flex-row sm:justify-start">
            <!-- Real rows (see the list view above): same component, same actions. -->
            {#key volumeListRenderKey}
              {#each sectionVolumes as volume (volume.volume_uuid)}
                <VolumeItem {volume} variant="grid" />
              {/each}
            {/key}
            {#each placeholders as placeholder (placeholder.volume_uuid)}
              {#if isIndexedPlaceholder(placeholder)}
                <VolumeItem volume={placeholder} variant="grid" />
              {:else}
                <PlaceholderVolumeItem volume={placeholder} variant="grid" />
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{:else if placeholders && placeholders.length > 0}
  <!-- Placeholder-only series page -->
  <div class="flex flex-col gap-5 p-2">
    <!-- Header Row: Title and cloud info -->
    <div class="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
      <div class="flex min-w-0 items-center gap-1">
        {#key seriesDisplayTitle}
          <h3 class="min-w-0 flex-shrink-2 px-2 text-2xl font-bold text-gray-400">
            {seriesDisplayTitle || 'Cloud Series'}
          </h3>
        {/key}
        <button
          onclick={() => promptSeriesEditor(placeholders[0].series_title)}
          class="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          title="Edit series"
        >
          <EditOutline class="h-4 w-4" />
        </button>
      </div>
      <div class="flex flex-row gap-2 px-2 text-base">
        <Badge color="blue" class="!min-w-0 bg-blue-100 dark:bg-blue-900/30">
          {placeholders.length} volume{placeholders.length !== 1 ? 's' : ''} in {providerDisplayName}
        </Badge>
      </div>
    </div>

    <SeriesMetadataBar seriesTitle={placeholders[0].series_title} volumes={placeholders} />

    <!-- Actions Row -->
    <div class="flex flex-row items-stretch justify-end gap-2">
      {#if hasAnyProvider}
        <Button color="primary" onclick={downloadAllPlaceholders} class="!min-w-0 self-stretch">
          <DownloadSolid class="me-2 h-4 w-4 shrink-0" />
          <span class="break-words">Download All</span>
        </Button>
      {:else}
        <Button color="light" disabled class="!min-w-0 self-stretch">
          <DownloadSolid class="me-2 h-4 w-4 shrink-0" />
          <span class="break-words">Sign in to download</span>
        </Button>
      {/if}

      <Button color="light" onclick={toggleViewMode} class="!min-w-0 self-stretch">
        {#if viewMode === 'list'}
          <GridOutline class="me-2 h-5 w-5 shrink-0" />
          <span class="break-words">Grid</span>
        {:else}
          <ListOutline class="me-2 h-5 w-5 shrink-0" />
          <span class="break-words">List</span>
        {/if}
      </Button>

      <Button id="placeholder-series-menu" color="light" class="!min-w-0 !p-2.5">
        <DotsVerticalOutline class="h-5 w-5" />
      </Button>
      <Dropdown triggeredBy="#placeholder-series-menu" placement="bottom-end">
        {#if hasAnyProvider && !isReadOnlyMode}
          <DropdownItem
            onclick={onDeleteFromCloud}
            class="flex w-full items-center text-red-500 hover:!text-red-500 dark:hover:!text-red-500"
          >
            <TrashBinSolid class="me-2 h-5 w-5 flex-shrink-0" />
            <span class="flex-1 text-left">Delete from {providerDisplayName}</span>
          </DropdownItem>
        {/if}
      </Dropdown>
    </div>

    <!-- Volume List/Grid -->
    {#if viewMode === 'list'}
      <Listgroup active class="h-full w-full flex-1">
        {#each placeholders as placeholder (placeholder.volume_uuid)}
          {#if isIndexedPlaceholder(placeholder)}
            <VolumeItem volume={placeholder} variant="list" />
          {:else}
            <PlaceholderVolumeItem volume={placeholder} variant="list" />
          {/if}
        {/each}
      </Listgroup>
    {:else}
      <div class="flex flex-col flex-wrap justify-center gap-5 sm:flex-row sm:justify-start">
        {#each placeholders as placeholder (placeholder.volume_uuid)}
          {#if isIndexedPlaceholder(placeholder)}
            <VolumeItem volume={placeholder} variant="grid" />
          {:else}
            <PlaceholderVolumeItem volume={placeholder} variant="grid" />
          {/if}
        {/each}
      </div>
    {/if}
  </div>
{:else if seriesOpenPending}
  <div class="flex items-center justify-center p-16">
    <Spinner size="12" />
  </div>
{:else}
  <div class="flex flex-col items-center justify-center gap-4 p-16">
    <p class="text-lg text-gray-400">Series not found</p>
    <Button color="primary" onclick={() => nav.toCatalog()}>Go to Catalog</Button>
  </div>
{/if}
