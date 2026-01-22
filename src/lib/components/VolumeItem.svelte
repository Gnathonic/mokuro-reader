<script lang="ts">
  import {
    deleteVolume,
    progress,
    volumes,
    settings,
    markVolumeAsComplete,
    markVolumeAsUnread
  } from '$lib/settings';
  import { personalizedReadingSpeed } from '$lib/settings/reading-speed';
  import { getEffectiveReadingTime } from '$lib/util/reading-speed';
  import type { VolumeMetadata, Page } from '$lib/types';
  import { promptConfirmation, showSnackbar } from '$lib/util';
  import { getCurrentPage, getProgressDisplay, isVolumeComplete } from '$lib/util/volume-helpers';
  import { ListgroupItem, Dropdown, DropdownItem, Badge } from 'flowbite-svelte';
  import {
    CheckCircleSolid,
    CloseCircleOutline,
    CheckCircleOutline,
    TrashBinSolid,
    FileLinesOutline,
    DotsVerticalOutline,
    CloudArrowUpOutline,
    ImageOutline,
    ExclamationCircleOutline,
    EditOutline
  } from 'flowbite-svelte-icons';
  import { promptVolumeEditor } from '$lib/util/modals';
  import { db } from '$lib/catalog/db';
  import { nav, routeParams } from '$lib/util/hash-router';
  import BackupButton from './BackupButton.svelte';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import { providerManager } from '$lib/util/sync';
  import { backupQueue } from '$lib/util/backup-queue';
  import type { CloudVolumeWithProvider } from '$lib/util/sync/unified-cloud-manager';
  import { getCharCount } from '$lib/util/count-chars';
  import PlaceholderThumbnail from './PlaceholderThumbnail.svelte';

  interface Props {
    volume: VolumeMetadata;
    variant?: 'list' | 'grid';
  }

  let { volume, variant = 'list' }: Props = $props();

  const volName = decodeURI(volume.volume_title);

  let volume_uuid = $derived(volume.volume_uuid);
  let volumeData = $derived($volumes?.[volume.volume_uuid]);
  let currentPage = $derived(getCurrentPage(volume.volume_uuid, $progress));
  let progressDisplay = $derived(getProgressDisplay(currentPage, volume.page_count));
  let isComplete = $derived(isVolumeComplete(currentPage, volume.page_count));

  // Check if this is an image-only volume (no mokuro OCR data)
  let isImageOnly = $derived(volume.mokuro_version === '');

  // Check if this volume has missing pages (imported with placeholders)
  let missingPages = $derived(volume.missing_pages);

  // Cloud backup state (for grid view menu)
  let cloudFiles = $state<Map<string, CloudVolumeWithProvider[]>>(new Map());
  let hasAuthenticatedProvider = $state(false);
  let isFetchingCloud = $state(false);
  let isReadOnlyMode = $state(false);

  // Subscribe to cloud state for grid view
  $effect(() => {
    const unsubscribers = [
      unifiedCloudManager.cloudFiles.subscribe((value) => {
        cloudFiles = value;
      }),
      unifiedCloudManager.isFetching.subscribe((value) => {
        isFetchingCloud = value;
      }),
      providerManager.status.subscribe((value) => {
        hasAuthenticatedProvider = value.hasAnyAuthenticated;
        // Check if current provider is WebDAV and in read-only mode
        isReadOnlyMode =
          value.currentProviderType === 'webdav' && value.providers['webdav']?.isReadOnly === true;
      })
    ];
    return () => unsubscribers.forEach((unsub) => unsub());
  });

  // Count total files in the Map for loading check
  let totalCloudFiles = $derived.by(() => {
    let count = 0;
    for (const files of cloudFiles.values()) {
      count += files.length;
    }
    return count;
  });

  // Check if cloud cache is still loading (fetching with no files yet)
  let isCloudLoading = $derived(isFetchingCloud && totalCloudFiles === 0);

  // Check if this volume is backed up to cloud
  let cloudFile = $derived.by(() => {
    const path = `${volume.series_title}/${volume.volume_title}.cbz`;
    const seriesFiles = cloudFiles.get(volume.series_title) || [];
    return seriesFiles.find((f) => f.path === path);
  });
  let isBackedUp = $derived(cloudFile !== undefined);

  // Time statistics
  let timeReadMinutes = $derived.by(() => {
    if (!volumeData) return 0;
    const idleTimeoutMs = $settings.inactivityTimeoutMinutes * 60 * 1000;
    return getEffectiveReadingTime(volumeData, idleTimeoutMs);
  });
  let charsRead = $derived(volumeData?.chars || 0);
  let totalChars = $state<number | undefined>(undefined);

  // Calculate Japanese character count from pages data (matches reading tracker)
  $effect(() => {
    db.volume_ocr.get(volume.volume_uuid).then((data) => {
      if (data?.pages) {
        const { charCount } = getCharCount(data.pages);
        if (charCount > 0) {
          totalChars = charCount;
        }
      }
    });
  });

  // Create blob URL from inline thumbnail
  let thumbnailUrl = $state<string | undefined>(undefined);
  $effect(() => {
    if (!volume.thumbnail) {
      thumbnailUrl = undefined;
      return;
    }
    const url = URL.createObjectURL(volume.thumbnail);
    thumbnailUrl = url;
    return () => URL.revokeObjectURL(url);
  });

  // Calculate estimated time remaining for incomplete volumes
  let estimatedMinutesLeft = $derived.by(() => {
    // Don't show estimate for completed volumes
    if (isComplete) return null;

    // Need totalChars to calculate estimate
    if (!totalChars || totalChars <= 0) {
      return null;
    }

    const charsRemaining = totalChars - charsRead;
    if (charsRemaining <= 0) return null;

    // Try to get reading speed from multiple sources, in order of preference:
    let charsPerMinute = 0;

    // 1. Use personalized reading speed if available
    const readingSpeed = $personalizedReadingSpeed;
    if (readingSpeed.isPersonalized && readingSpeed.charsPerMinute > 0) {
      charsPerMinute = readingSpeed.charsPerMinute;
    }
    // 2. Fall back to this volume's speed if we have data
    else if (volumeData && timeReadMinutes > 0 && charsRead > 0) {
      charsPerMinute = charsRead / timeReadMinutes;
    }
    // 3. Fall back to default manga reading speed
    else {
      charsPerMinute = 100; // Default for manga
    }

    // Sanity check - must be positive and reasonable
    if (charsPerMinute <= 0 || charsPerMinute > 1000) {
      return null;
    }

    return Math.ceil(charsRemaining / charsPerMinute);
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

  // Format character count with K suffix
  function formatCharCount(chars: number): string {
    if (chars >= 1000) {
      return `${(chars / 1000).toFixed(1)}K`;
    }
    return chars.toString();
  }

  let statsDisplay = $derived.by(() => {
    const parts: string[] = [];

    // Character count (show for all volumes with data)
    if (totalChars && totalChars > 0) {
      parts.push(`${formatCharCount(totalChars)} chars`);
    }

    // For completed volumes: show actual time
    if (isComplete && timeReadMinutes > 0) {
      parts.push(formatTime(timeReadMinutes));
    }
    // For incomplete volumes: show time estimate remaining
    else if (estimatedMinutesLeft !== null && estimatedMinutesLeft > 0) {
      parts.push(`~${formatTime(estimatedMinutesLeft)} left`);
    }

    return parts.length > 0 ? parts.join(' ') : null;
  });
  function onToggleStatusClicked(e: Event) {
    e.stopPropagation();
    if (isComplete) {
      markVolumeAsUnread(volume_uuid);
      showSnackbar(`Marked ${volName} as unread`);
    } else {
      if (volume.page_count) {
        markVolumeAsComplete(volume_uuid, volume.page_count, totalChars);
        showSnackbar(`Marked ${volName} as read`);
      } else {
        showSnackbar('Error: Missing page count data');
      }
    }
  }
  async function onDeleteClicked(e: Event) {
    e.stopPropagation();

    // Check if volume is backed up to cloud
    const hasCloudBackup = hasAuthenticatedProvider && isBackedUp;

    // Get provider display name
    const providerDisplayName =
      cloudFile?.provider === 'google-drive'
        ? 'Drive'
        : cloudFile?.provider === 'mega'
          ? 'MEGA'
          : 'cloud';

    promptConfirmation(
      `Delete ${volName}?`,
      async (deleteStats = false, deleteCloud = false) => {
        // Delete from all 3 tables
        await Promise.all([
          db.volumes.where('volume_uuid').equals(volume.volume_uuid).delete(),
          db.volume_ocr.delete(volume.volume_uuid),
          db.volume_files.delete(volume.volume_uuid)
        ]);

        // Only delete stats and progress if the checkbox is checked
        if (deleteStats) {
          deleteVolume(volume.volume_uuid);
        }

        // Delete from cloud if checkbox checked
        if (deleteCloud && hasCloudBackup && cloudFile) {
          try {
            await unifiedCloudManager.deleteFile(cloudFile);
            showSnackbar(`Deleted from ${providerDisplayName}`);
          } catch (error) {
            console.error('Failed to delete from cloud:', error);
            showSnackbar(`Failed to delete from ${providerDisplayName}`);
          }
        }

        // Check if this was the last volume for this title
        const remainingVolumes = await db.volumes
          .where('series_uuid')
          .equals(volume.series_uuid)
          .count();

        if (remainingVolumes > 0 && $routeParams.manga) {
          nav.toSeries($routeParams.manga);
        } else {
          nav.toCatalog();
        }
      },
      undefined,
      {
        label: 'Also delete stats and progress?',
        storageKey: 'deleteStatsPreference',
        defaultValue: false
      },
      // Don't show cloud delete option in read-only mode
      hasCloudBackup && !isReadOnlyMode
        ? {
            label: `Also delete from ${providerDisplayName}?`,
            storageKey: 'deleteCloudPreference',
            defaultValue: false
          }
        : undefined
    );
  }

  function onViewTextClicked(e: Event) {
    e.stopPropagation();
    const seriesId = $routeParams.manga;
    if (seriesId) nav.toVolumeText(seriesId, volume_uuid);
  }

  function onEditClicked(e: Event) {
    e.stopPropagation();
    promptVolumeEditor(volume_uuid);
  }

  async function onBackupClicked(e: Event) {
    e.stopPropagation();

    // If already backed up, delete from cloud
    if (isBackedUp && cloudFile) {
      try {
        await unifiedCloudManager.deleteFile(cloudFile);
        const providerName = cloudFile.provider === 'google-drive' ? 'Drive' : cloudFile.provider;
        showSnackbar(`Deleted from ${providerName}`);
      } catch (error) {
        console.error('Delete failed:', error);
        showSnackbar(`Delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      return;
    }

    // Otherwise, backup to cloud
    const provider = unifiedCloudManager.getDefaultProvider();
    if (!provider) {
      showSnackbar('Please connect to a cloud storage provider first');
      return;
    }

    // Add to backup queue
    backupQueue.queueVolumeForBackup(volume);
    showSnackbar(`Added ${volume.volume_title} to backup queue`);
  }
</script>

{#if $routeParams.manga}
  {#if variant === 'list'}
    <div
      class="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-600 dark:border-gray-700"
    >
      <ListgroupItem
        onclick={() => $routeParams.manga && nav.toReader($routeParams.manga, volume_uuid)}
        class="py-4"
      >
        {#if thumbnailUrl}
          <img
            src={thumbnailUrl}
            alt="img"
            style="margin-right:10px;"
            class="h-[70px] w-[50px] border border-gray-900 bg-black object-contain"
          />
        {/if}
        <div
          class:text-green-400={isComplete}
          class="flex w-full flex-row items-center justify-between gap-5"
        >
          <div>
            <div class="mb-1 flex items-center gap-2">
              <p class="font-semibold" class:text-white={!isComplete}>{volName}</p>
              {#if isImageOnly}
                <Badge color="blue" class="text-xs">
                  <ImageOutline class="me-1 inline h-3 w-3" />
                  Image Only
                </Badge>
              {/if}
              {#if missingPages}
                <Badge color="yellow" class="text-xs">
                  <ExclamationCircleOutline class="me-1 inline h-3 w-3" />
                  Missing {missingPages} page{missingPages > 1 ? 's' : ''}
                </Badge>
              {/if}
            </div>
            <div class="flex flex-wrap items-center gap-x-3">
              <p>{progressDisplay}</p>
              {#if statsDisplay}
                <p class="text-sm opacity-80">{statsDisplay}</p>
              {/if}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <BackupButton {volume} class="mr-2" />
            <button
              onclick={onViewTextClicked}
              class="flex items-center justify-center"
              title="View text only"
            >
              <FileLinesOutline class="z-10 text-blue-400 hover:text-blue-500" />
            </button>
            <button
              onclick={onEditClicked}
              class="flex items-center justify-center"
              title="Edit volume"
            >
              <EditOutline class="z-10 text-gray-400 hover:text-gray-300" />
            </button>
            <button onclick={onDeleteClicked} class="flex items-center justify-center">
              <TrashBinSolid class="poin z-10 text-red-400 hover:text-red-500" />
            </button>
            <button
              onclick={onToggleStatusClicked}
              class="flex items-center justify-center transition-colors"
              title={isComplete ? 'Mark as unread' : 'Mark as read'}
            >
              {#if isComplete}
                <CheckCircleSolid
                  class="z-10 text-green-400 hover:text-green-600 dark:hover:text-green-300"
                />
              {:else}
                <CheckCircleOutline class="z-10 text-gray-400 hover:text-green-500" />
              {/if}
            </button>
          </div>
        </div>
      </ListgroupItem>
    </div>
  {:else}
    <!-- Grid view -->
    <div
      class="relative flex flex-col gap-2 rounded-lg border-2 border-transparent p-3 transition-colors hover:bg-gray-100 sm:w-[278px] dark:hover:bg-gray-700"
      class:!border-green-400={isComplete}
    >
      <!-- Actions menu button -->
      <button
        id="volume-menu-{volume_uuid}"
        class="absolute right-2 bottom-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-gray-800/80 hover:bg-gray-700/80"
        onclick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <DotsVerticalOutline class="h-4 w-4 text-white" />
      </button>
      <Dropdown triggeredBy="#volume-menu-{volume_uuid}" placement="bottom-end">
        <DropdownItem
          onclick={onEditClicked}
          class="flex w-full items-center text-gray-700 dark:text-gray-200"
        >
          <EditOutline class="me-2 h-5 w-5 flex-shrink-0" />
          <span class="flex-1 text-left">Edit</span>
        </DropdownItem>
        <DropdownItem
          onclick={onViewTextClicked}
          class="flex w-full items-center text-gray-700 dark:text-gray-200"
        >
          <FileLinesOutline class="me-2 h-5 w-5 flex-shrink-0" />
          <span class="flex-1 text-left">View text</span>
        </DropdownItem>
        {#if hasAuthenticatedProvider && !isReadOnlyMode}
          {#if isCloudLoading}
            <DropdownItem class="flex w-full items-center opacity-50" disabled>
              <span class="me-2 h-5 w-5 flex-shrink-0 animate-spin">⏳</span>
              <span class="flex-1 text-left text-gray-500">Loading cloud status...</span>
            </DropdownItem>
          {:else if isBackedUp}
            <DropdownItem onclick={onBackupClicked} class="flex w-full items-center">
              <TrashBinSolid class="me-2 h-5 w-5 flex-shrink-0 text-red-500" />
              <span class="flex-1 text-left text-red-500">Delete from cloud</span>
            </DropdownItem>
          {:else}
            <DropdownItem onclick={onBackupClicked} class="flex w-full items-center">
              <CloudArrowUpOutline
                class="me-2 h-5 w-5 flex-shrink-0 text-gray-700 dark:text-gray-200"
              />
              <span class="flex-1 text-left text-gray-700 dark:text-gray-200">Backup to cloud</span>
            </DropdownItem>
          {/if}
        {/if}
        {#if !isComplete}
          <DropdownItem
            onclick={onToggleStatusClicked}
            class="flex w-full items-center text-green-600 hover:!text-green-700 dark:text-green-500 dark:hover:!text-green-400"
          >
            <CheckCircleOutline class="me-2 h-5 w-5 flex-shrink-0" />
            <span class="flex-1 text-left">Mark as read</span>
          </DropdownItem>
        {:else}
          <DropdownItem
            onclick={onToggleStatusClicked}
            class="flex w-full items-center text-gray-500 hover:!text-gray-900 dark:text-gray-400 dark:hover:!text-white"
          >
            <CloseCircleOutline class="me-2 h-5 w-5 flex-shrink-0" />
            <span class="flex-1 text-left">Mark as unread</span>
          </DropdownItem>
        {/if}
        <DropdownItem
          onclick={onDeleteClicked}
          class="flex w-full items-center text-red-500 hover:!text-red-500 dark:hover:!text-red-500"
        >
          <TrashBinSolid class="me-2 h-5 w-5 flex-shrink-0" />
          <span class="flex-1 text-left">Delete</span>
        </DropdownItem>
      </Dropdown>

      <a
        href="#/reader/{$routeParams.manga}/{volume_uuid}"
        onclick={(e) => {
          e.preventDefault();
          if ($routeParams.manga) nav.toReader($routeParams.manga, volume_uuid);
        }}
        class="flex flex-col gap-2"
      >
        <div class="flex items-center justify-center sm:h-[350px] sm:w-[250px]">
          {#if thumbnailUrl}
            <img
              src={thumbnailUrl}
              alt={volName}
              class="h-auto w-auto border border-gray-900 bg-black sm:max-h-[350px] sm:max-w-[250px]"
            />
          {:else}
            <PlaceholderThumbnail />
          {/if}
        </div>
        <div class="flex flex-col gap-1 sm:w-[250px]">
          <div class="flex items-center gap-1">
            <div class="flex-1 truncate text-sm font-medium" class:text-green-400={isComplete}>
              {volName}
            </div>
            {#if isComplete}
              <CheckCircleSolid class="h-5 w-5 flex-shrink-0 text-green-400" />
            {/if}
          </div>
          {#if isImageOnly}
            <Badge color="blue" class="w-fit text-xs">
              <ImageOutline class="me-1 inline h-3 w-3" />
              Image Only
            </Badge>
          {/if}
          {#if missingPages}
            <Badge color="yellow" class="w-fit text-xs">
              <ExclamationCircleOutline class="me-1 inline h-3 w-3" />
              Missing {missingPages} page{missingPages > 1 ? 's' : ''}
            </Badge>
          {/if}
        </div>
        <div
          class="flex flex-wrap items-center gap-x-2 text-xs sm:w-[250px]"
          class:text-green-400={isComplete}
          class:text-gray-500={!isComplete}
          class:dark:text-gray-400={!isComplete}
        >
          <span>{progressDisplay}</span>
          {#if statsDisplay}
            <span class="opacity-70">{statsDisplay}</span>
          {/if}
        </div>
      </a>
    </div>
  {/if}
{/if}
