<script module lang="ts">
  // Shared across all VolumeItem instances to ensure only one dropdown is open at a time
  const menuCloseCallbacks = new Set<() => void>();

  function closeAllMenus() {
    menuCloseCallbacks.forEach((cb) => cb());
  }
</script>

<script lang="ts">
  import {
    deleteVolume as deleteVolumeStats,
    progress,
    volumes as readingVolumes,
    settings,
    markVolumeAsComplete,
    markVolumeAsUnread
  } from '$lib/settings';
  import { volumes as catalogVolumes } from '$lib/catalog';
  import { personalizedReadingSpeed } from '$lib/settings/reading-speed';
  import { getEffectiveReadingTime } from '$lib/util/reading-speed';
  import type { VolumeMetadata, Page } from '$lib/types';
  import { promptConfirmation, showSnackbar } from '$lib/util';
  import { promptExtraction } from '$lib/util/modals';
  import { zipManga } from '$lib/util/zip';
  import { getCurrentPage, getProgressDisplay, isVolumeComplete } from '$lib/util/volume-helpers';
  import { ListgroupItem, Dropdown, DropdownItem, Badge, Button, Spinner } from 'flowbite-svelte';
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
    EditOutline,
    DownloadSolid
  } from 'flowbite-svelte-icons';
  import { promptVolumeEditor } from '$lib/util/modals';
  import { db } from '$lib/catalog/db';
  import { removeVolumeFiles, deleteVolumeCompletely } from '$lib/import';
  import { liveQuery } from 'dexie';
  import { nav, routeParams } from '$lib/util/hash-router';
  import BackupButton from './BackupButton.svelte';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import { PROVIDER_SHORT_LABELS } from '$lib/util/sync/provider-display';
  import { providerManager } from '$lib/util/sync';
  import { backupQueue } from '$lib/util/backup-queue';
  import { downloadQueue } from '$lib/util/download-queue';
  import {
    getArchiveSize,
    getCloudFileId,
    getCloudModifiedTime,
    getCloudProvider
  } from '$lib/util/cloud-fields';
  import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';
  import { formatArchiveSize } from '$lib/util/format-size';
  import { progressTrackerStore } from '$lib/util/progress-tracker';
  import type { CloudVolumeWithProvider } from '$lib/util/sync/unified-cloud-manager';
  import { getCharCount } from '$lib/util/count-chars';
  import PlaceholderThumbnail from './PlaceholderThumbnail.svelte';
  import { createCoverClaims } from '$lib/catalog/cover-claims.svelte';
  import DownloadBadge from './DownloadBadge.svelte';
  import { needsDownload } from '$lib/catalog/volume-state';
  import { anyModalOpen, shouldTriggerDelete } from '$lib/util/delete-shortcut';
  import { canDeleteSeriesOnServer } from '$lib/util/sync/metadata-permissions';
  import { isTypingTarget } from '$lib/util/series-editor-shortcut';
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';

  interface Props {
    volume: VolumeMetadata;
    variant?: 'list' | 'grid';
  }

  let { volume, variant = 'list' }: Props = $props();

  let menuOpen = $state(false);
  const closeMenu = () => {
    menuOpen = false;
  };
  menuCloseCallbacks.add(closeMenu);
  onDestroy(() => menuCloseCallbacks.delete(closeMenu));

  const volName = decodeURI(volume.volume_title);

  let volume_uuid = $derived(volume.volume_uuid);
  let volumeData = $derived($readingVolumes?.[volume.volume_uuid]);
  let dbVolume = $state<VolumeMetadata | null>(null);
  let liveVolume = $derived(dbVolume ?? $catalogVolumes?.[volume.volume_uuid] ?? volume);
  // Watch this specific row directly so thumbnail updates repaint immediately.
  $effect(() => {
    const subscription = liveQuery(() => db.volumes.get(volume.volume_uuid)).subscribe({
      next: (value) => {
        // Force a fresh object identity so Svelte reacts even if Dexie
        // reuses object references while blob fields changed.
        dbVolume = value ? { ...value } : null;
      },
      error: (err) => {
        console.error('VolumeItem liveQuery error:', err);
      }
    });

    return () => subscription.unsubscribe();
  });
  let currentPage = $derived(getCurrentPage(volume.volume_uuid, $progress));
  let progressDisplay = $derived(getProgressDisplay(currentPage, volume.page_count));
  // Completion reads the RAW page, not the display default of 1: "page 1 of 1" with no
  // progress record at all is a volume nobody has opened (see isVolumeComplete).
  let isComplete = $derived(
    isVolumeComplete($progress?.[volume.volume_uuid] ?? 0, volume.page_count)
  );

  // Check if this is an image-only volume (no mokuro OCR data)
  let isImageOnly = $derived(volume.mokuro_version === '');

  // The pages are not on this device: everything that reads them (open, view
  // text, extract, back up, edit) is replaced by a download. The row is still
  // real — its progress, stats and cover are shown exactly as usual.
  // Cloud fields are read from the `volume` prop: that is the catalog's copy,
  // the one `volumesWithPlaceholders` decorated with the current listing, while
  // `liveVolume` is the raw stored row.
  let isNotInstalled = $derived(needsDownload(liveVolume));
  // A cloud-only volume drawn as a full row (see `isIndexedPlaceholder`): it has
  // no `volumes` row at all, so anything that deletes one is off. `dbVolume` is
  // the live answer to "is there a row now" — the moment a download or a
  // materialization writes one under this uuid, the card stops being a
  // placeholder even before the catalog re-renders it.
  let isPlaceholderRow = $derived(volume.isPlaceholder === true && !dbVolume);
  let downloadFileId = $derived(getCloudFileId(volume));
  // How big the download is. `getArchiveSize` prefers the connected provider's
  // listing and falls back to the size recorded on the row, so it still answers
  // for a volume whose provider is not connected right now.
  let archiveSizeDisplay = $derived(formatArchiveSize(getArchiveSize(volume) ?? 0));

  // Subscribed to explicitly, not via `$store`: this component renders once per
  // volume in the library, and `$downloadQueue` + an effect subscription would
  // be TWO subscriptions per row to stores that emit throughout every download.
  // Only volumes that can actually be downloaded need to watch them at all.
  let queueState = $state(get(downloadQueue));
  let progressState = $state(get(progressTrackerStore));
  $effect(() => {
    if (!isNotInstalled) return;
    const unsubscribers = [
      downloadQueue.subscribe((value) => (queueState = value)),
      progressTrackerStore.subscribe((value) => (progressState = value))
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  });
  let downloadProcess = $derived(
    downloadFileId
      ? progressState.processes.find((p) => p.id === `download-${downloadFileId}`)
      : undefined
  );
  let isDownloading = $derived(
    queueState.some((item) => item.volumeUuid === volume_uuid) || !!downloadProcess
  );
  let downloadProgress = $derived(downloadProcess?.progress || 0);

  function onDownloadClicked(e?: Event) {
    e?.stopPropagation();
    if (!downloadFileId) {
      showSnackbar(`${volName} is not in the connected cloud storage`);
      return;
    }
    downloadQueue.queueVolume(volume);
  }

  function onOpenClicked() {
    if (isNotInstalled) {
      onDownloadClicked();
      return;
    }
    if ($routeParams.manga) nav.toReader($routeParams.manga, volume_uuid);
  }

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
  let fallbackTotalChars = $state<number | undefined>(undefined);
  let totalCharsRequestId = 0;

  // Prefer metadata totals (fast/sync) and only hit OCR table when absent.
  let metadataTotalChars = $derived.by(() => {
    if (liveVolume.character_count && liveVolume.character_count > 0) {
      return liveVolume.character_count;
    }
    if (liveVolume.page_char_counts?.length) {
      return liveVolume.page_char_counts[liveVolume.page_char_counts.length - 1];
    }
    return undefined;
  });
  let totalChars = $derived(metadataTotalChars ?? fallbackTotalChars);

  // Fallback for legacy/partial metadata. Never for a volume whose pages are
  // not here: there is no OCR row to read (and for a placeholder, no row at
  // all), so it would be one wasted query per card in a cloud-only series.
  $effect(() => {
    fallbackTotalChars = undefined;
    if ((metadataTotalChars && metadataTotalChars > 0) || needsDownload(liveVolume)) {
      return;
    }

    const requestId = ++totalCharsRequestId;
    db.volume_ocr.get(volume.volume_uuid).then((data) => {
      if (requestId !== totalCharsRequestId) return;
      if (!data?.pages) return;

      const { charCount } = getCharCount(data.pages);
      if (charCount > 0) {
        fallbackTotalChars = charCount;
      }
    });
  });

  // Create blob URL from inline thumbnail. Keyed on content identity, not
  // `liveVolume` object identity: a catalog-wide re-derive hands every
  // mounted row a BRAND NEW `liveVolume` object on every emission — even one
  // this row's own thumbnail had no part in — and a fresh IndexedDB read
  // yields a brand new `File` instance per read regardless of whether the
  // stored bytes changed. Without this key, the effect below would tear down
  // and recreate the object URL (forcing a real browser re-decode/re-paint)
  // on every unrelated re-derive, for every row on screen. Mirrors
  // `CatalogListItem.svelte`'s own thumbnail-key pattern.
  let thumbnailUrl = $state<string | undefined>(undefined);
  let thumbnailKey = $state<string | undefined>(undefined);

  function getThumbnailKey(volumeUuid: string, thumbnail?: File): string | undefined {
    if (!thumbnail) return undefined;
    return `${volumeUuid}:${thumbnail.size}:${thumbnail.lastModified}`;
  }

  $effect(() => {
    const nextKey = liveVolume
      ? getThumbnailKey(liveVolume.volume_uuid, liveVolume.thumbnail)
      : undefined;
    if (nextKey === thumbnailKey) {
      return; // Same cover as already rendered — nothing to do.
    }

    if (thumbnailUrl) {
      URL.revokeObjectURL(thumbnailUrl);
      thumbnailUrl = undefined;
    }

    thumbnailKey = nextKey;
    if (!liveVolume?.thumbnail) return;
    thumbnailUrl = URL.createObjectURL(liveVolume.thumbnail);
  });

  onDestroy(() => {
    if (thumbnailUrl) {
      URL.revokeObjectURL(thumbnailUrl);
    }
  });

  /**
   * THE LIST ROW RESOLVES ITS OWN CLOUD COVER.
   *
   * The GRID variant has always drawn its cloud cover through `PlaceholderThumbnail`,
   * which resolves one; the list row painted `liveVolume.thumbnail` and nothing else. It
   * got away with that only while `generatePlaceholders` stamped the cached blob onto
   * every placeholder and the catalog decorated a metadata-only row's copy the same way
   * — the decoration that made one cover landing re-derive the whole library (a measured
   * 1,784 ms long task on a 1,027-series library) and was therefore removed. Without
   * this, every cloud volume on a series page in list layout shows the grey "Cover" box
   * FOREVER: `resolveAndDeliver`'s cache-hit gate means a cover already in
   * `cloud_covers` is never fetched onto the row either, so nothing would ever fill it.
   *
   * The claim path falls back to the PROP, and must: `liveVolume` is the stored row
   * whenever there is one, and a stored row never carries `cloudPath` (no writer of
   * those rows persists a cloud field) — only the catalog's listing-derived copy does,
   * which is what this component is handed.
   *
   * LIST ONLY. The grid variant's empty case already renders `PlaceholderThumbnail`,
   * which claims the very same path; claiming here too would just take a second
   * reference on the same entry for every grid card on screen.
   */
  let coverPath = $derived(liveVolume?.cloudPath ?? volume.cloudPath);

  // Claimed and asked for only in the LIST variant — the grid variant's empty case
  // renders `PlaceholderThumbnail`, which claims the very same path and asks for the very
  // same volume, so doing it here too would take a second reference on one entry for
  // every grid card on screen. Asked for on the same gate the grid one uses: only a
  // volume whose pages are not here.
  const coverClaims = createCoverClaims({
    claims: () =>
      variant === 'list' && liveVolume ? [{ ...liveVolume, cloudPath: coverPath }] : [],
    targets: () => (variant === 'list' && isNotInstalled ? [volume] : [])
  });
  const { gate } = coverClaims;

  /** Row cover first, resolver cover second — a row that HAS a thumbnail always wins. */
  let displayUrl = $derived(thumbnailUrl ?? coverClaims.cover?.url);

  // Some insert/update paths can miss live notifications for blob fields.
  // While thumbnail is missing, poll this row until it appears. Not for a
  // volume that is not installed: nothing is generating one, so it would poll
  // for the lifetime of the page.
  $effect(() => {
    if (needsDownload(liveVolume) || liveVolume.thumbnail) {
      return;
    }

    let canceled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const pollForThumbnail = async () => {
      const refreshed = await db.volumes.get(volume.volume_uuid);
      if (canceled) return;

      if (refreshed?.thumbnail) {
        dbVolume = { ...refreshed };
        return;
      }

      timerId = setTimeout(pollForThumbnail, 1000);
    };

    timerId = setTimeout(pollForThumbnail, 1000);

    return () => {
      canceled = true;
      if (timerId) clearTimeout(timerId);
    };
  });

  onDestroy(() => {
    if (thumbnailUrl) {
      URL.revokeObjectURL(thumbnailUrl);
    }
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
  function onToggleStatusClicked(e?: Event) {
    e?.stopPropagation();
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
  async function onDeleteClicked(e?: Event) {
    e?.stopPropagation();

    // A placeholder has no row: nothing local to remove and no history to
    // forget, so the volume dialog would be asking about something that does
    // not exist. The only copy is the cloud one, which is exactly what the
    // cloud-delete flow (and the minimal placeholder card) already offers.
    if (isPlaceholderRow) {
      await onCloudDeleteOnly();
      return;
    }

    // Check if volume is backed up to cloud
    const hasCloudBackup = hasAuthenticatedProvider && isBackedUp;

    // Get provider display name
    const providerDisplayName =
      cloudFile?.provider === 'google-drive'
        ? 'Drive'
        : cloudFile?.provider === 'mega'
          ? 'MEGA'
          : 'cloud';

    // Nothing left to remove from a volume whose pages are already gone: for it
    // the dialog IS the forget action, with no checkbox to leave unticked.
    const alreadyRemoved = isNotInstalled;

    promptConfirmation(
      alreadyRemoved
        ? `Forget ${volName}? Its stats, progress and cover will be deleted.`
        : `Remove ${volName} from this device? Stats, progress and cover are kept.`,
      async (forget = false, deleteCloud = false) => {
        // Default: strip the pages, keep the volume. The row carries the read
        // history and the cover, and re-downloading fills it back in.
        if (forget || alreadyRemoved) {
          await deleteVolumeCompletely(volume.volume_uuid);
          deleteVolumeStats(volume.volume_uuid);
        } else {
          await removeVolumeFiles(volume.volume_uuid);
        }

        // Delete from cloud if checkbox checked (archive + sidecars)
        if (deleteCloud && hasCloudBackup && cloudFile) {
          try {
            await unifiedCloudManager.deleteManagedVolume(volume.series_title, volume.volume_title);
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
      // A new storage key on purpose: the box used to mean "also delete the
      // stats" on top of a full delete, and now decides whether the row, cover
      // and history survive at all. A saved "yes" must not silently keep
      // answering the new question.
      alreadyRemoved
        ? undefined
        : {
            label: 'Also forget stats, progress and cover?',
            storageKey: 'forgetVolumePreference',
            defaultValue: false
          },
      // Don't show cloud delete option in read-only mode, or when the server's
      // permission rules would refuse this account (uploader on a series it
      // doesn't own — the per-file DELETEs would just 403).
      hasCloudBackup && !isReadOnlyMode && canDeleteSeriesOnServer(volume.series_title).allowed
        ? {
            label: `Also delete from ${providerDisplayName}?`,
            storageKey: 'deleteCloudPreference',
            defaultValue: false
          }
        : undefined
    );
  }

  function onViewTextClicked(e?: Event) {
    e?.stopPropagation();
    const seriesId = $routeParams.manga;
    if (seriesId) nav.toVolumeText(seriesId, volume_uuid);
  }

  function onEditClicked(e?: Event) {
    e?.stopPropagation();
    promptVolumeEditor(volume_uuid);
  }

  function onChangeCover() {
    promptVolumeEditor(volume_uuid, { openCoverPicker: true });
  }

  /**
   * The cloud file to delete, from the listing when it is there and from the
   * volume's own cloud fields when it is not.
   *
   * The listing lookup is by FOLDER name and exact title, which a placeholder
   * built from a `Series:` description does not match: its `series_title` is the
   * display name the description gave it, not the folder the file lives in. That
   * volume still knows exactly which file it came from — provider, id, path —
   * so it is deletable, the same way the minimal placeholder card has always
   * deleted it. `cloudPath` is the path the listing reported, preferred over a
   * path rebuilt from titles for the providers that address files by path.
   */
  let deletableCloudFile = $derived.by((): CloudFileMetadata | undefined => {
    if (cloudFile) return cloudFile;

    const fileId = getCloudFileId(volume);
    const provider = getCloudProvider(volume);
    if (!fileId || !provider) return undefined;

    return {
      provider,
      fileId,
      path: volume.cloudPath || `${volume.series_title}/${volume.volume_title}.cbz`,
      modifiedTime: getCloudModifiedTime(volume) || new Date().toISOString(),
      size: getArchiveSize(volume) ?? 0
    };
  });

  async function onCloudDeleteOnly() {
    const target = deletableCloudFile;
    if (!target || isReadOnlyMode) {
      showSnackbar('Volume is not backed up to cloud');
      return;
    }
    const permitted = canDeleteSeriesOnServer(volume.series_title);
    if (!permitted.allowed) {
      showSnackbar(permitted.reason ?? "This account can't delete this on this server");
      return;
    }
    const providerName =
      target.provider === 'google-drive' ? 'Drive' : target.provider === 'mega' ? 'MEGA' : 'cloud';
    promptConfirmation(`Delete ${volName} from ${providerName}?`, async () => {
      try {
        await unifiedCloudManager.deleteFile(target);
        showSnackbar(`Deleted from ${providerName}`);
      } catch (error) {
        console.error('Failed to delete from cloud:', error);
        showSnackbar(`Failed to delete from ${providerName}`);
      }
    });
  }

  // Keyboard shortcuts when hovering over a volume
  let isHovered = $state(false);

  $effect(() => {
    if (!isHovered) return;

    function handleKeydown(e: KeyboardEvent) {
      if (isTypingTarget(document.activeElement)) return;

      // Delete goes through the shared rule (auto-repeat and already-open modals are what
      // would otherwise stack a second confirmation behind the first). Shift still means
      // "the cloud copy only", exactly as before.
      if (e.key === 'Delete') {
        if (!shouldTriggerDelete(e, isHovered, document.activeElement, anyModalOpen())) return;
        e.preventDefault();
        if (e.shiftKey) {
          onCloudDeleteOnly();
        } else if (isPlaceholderRow) {
          // Nothing on this device to delete. The cloud copy is deletable, but
          // never from the shortcut that means "remove my local copy" — say
          // which key does mean it rather than swallowing the press.
          showSnackbar('Nothing on this device to remove — shift+Delete deletes the cloud copy');
        } else {
          onDeleteClicked();
        }
        return;
      }

      switch (e.key) {
        case 'e':
          e.preventDefault();
          // The editor reads pages and rewrites OCR; there are none here.
          if (!isNotInstalled) onEditClicked();
          break;
        case 'c':
          e.preventDefault();
          // Picking a cover means picking a page. Same reason.
          if (!isNotInstalled) onChangeCover();
          break;
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  async function onBackupClicked(e?: Event) {
    e?.stopPropagation();

    // If already backed up, delete from cloud
    if (isBackedUp && cloudFile) {
      // Capture provider before the await: cloudFile is a $derived that becomes
      // undefined once the delete refreshes the cache.
      const providerType = cloudFile.provider;
      try {
        await unifiedCloudManager.deleteManagedVolume(volume.series_title, volume.volume_title);
        const providerName = PROVIDER_SHORT_LABELS[providerType];
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

  function onExtractClicked(e?: Event) {
    e?.stopPropagation();
    promptExtraction(
      { series_title: volume.series_title, volume_title: volume.volume_title },
      async (
        asCbz,
        _individualVolumes,
        includeSeriesTitle,
        includeSidecars,
        embedSidecarsInArchive
      ) => {
        await zipManga([volume], asCbz, true, includeSeriesTitle, {
          includeSidecars,
          embedSidecarsInArchive
        });
      },
      undefined,
      true
    );
  }
</script>

{#if $routeParams.manga}
  {#if variant === 'list'}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      use:gate
      class="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-600 dark:border-gray-700"
      onmouseenter={() => (isHovered = true)}
      onmouseleave={() => (isHovered = false)}
    >
      <ListgroupItem onclick={onOpenClicked} class="py-4">
        <!-- Wrapper exists only to anchor the badge; the cover keeps its own box. -->
        <div class="relative flex-shrink-0" style="margin-right:10px;">
          {#if displayUrl}
            <img
              src={displayUrl}
              alt="img"
              class="h-[70px] w-[50px] border border-gray-300 bg-gray-100 object-contain dark:border-gray-900 dark:bg-black"
            />
          {:else}
            <div
              class="flex h-[70px] w-[50px] items-center justify-center border border-gray-300 bg-gray-200 text-[10px] text-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400"
            >
              Cover
            </div>
          {/if}
          {#if isNotInstalled}
            <DownloadBadge size="sm" class="right-0.5 bottom-0.5" />
          {/if}
        </div>
        <div
          class:text-green-400={isComplete}
          class="flex w-full flex-row items-center justify-between gap-5"
        >
          <div>
            <div class="mb-1 flex items-center gap-2">
              <p
                class="font-semibold"
                class:text-gray-900={!isComplete}
                class:dark:text-white={!isComplete}
              >
                {volName}
              </p>
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
              {#if isNotInstalled}
                <Badge color="gray" class="text-xs">Not on this device</Badge>
              {/if}
            </div>
            <div class="flex flex-wrap items-center gap-x-3">
              <p>{progressDisplay}</p>
              {#if statsDisplay}
                <p class="text-sm opacity-80">{statsDisplay}</p>
              {/if}
              {#if isNotInstalled && archiveSizeDisplay}
                <p data-testid="archive-size" class="text-sm opacity-80">{archiveSizeDisplay}</p>
              {/if}
            </div>
          </div>
          <div class="flex items-center gap-2">
            {#if isNotInstalled}
              <!-- No pages on this device: the only thing to do with it is get them back. -->
              {#if isDownloading}
                <Button color="light" disabled={true}>
                  <Spinner size="4" class="me-2" />
                  <!-- Keyed: a counter is exactly the kind of text Migaku
                       rewrites and then holds stale (see CLAUDE.md). -->
                  {#key downloadProgress}
                    <span>{Math.round(downloadProgress)}%</span>
                  {/key}
                </Button>
              {:else if downloadFileId}
                <Button color="blue" onclick={onDownloadClicked}>
                  <DownloadSolid class="me-2 h-4 w-4" />
                  Download
                </Button>
              {/if}
            {:else}
              <BackupButton {volume} class="mr-2" />
              <button
                onclick={onViewTextClicked}
                class="flex items-center justify-center"
                title="View text only"
              >
                <FileLinesOutline class="z-10 text-blue-400 hover:text-blue-500" />
              </button>
              <button
                onclick={onExtractClicked}
                class="flex items-center justify-center"
                title="Extract volume"
              >
                <DownloadSolid class="z-10 text-gray-400 hover:text-gray-300" />
              </button>
              <button
                onclick={onEditClicked}
                class="flex items-center justify-center"
                title="Edit volume"
              >
                <EditOutline class="z-10 text-gray-400 hover:text-gray-300" />
              </button>
            {/if}
            <button
              onclick={onDeleteClicked}
              class="flex items-center justify-center"
              title={isPlaceholderRow
                ? 'Delete from cloud'
                : isNotInstalled
                  ? 'Forget this volume'
                  : 'Remove from this device'}
            >
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
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="relative flex flex-col gap-2 rounded-lg border-2 border-transparent p-3 transition-colors hover:bg-gray-100 sm:w-[278px] dark:hover:bg-gray-700"
      class:!border-green-400={isComplete}
      onmouseenter={() => (isHovered = true)}
      onmouseleave={() => (isHovered = false)}
    >
      <!-- Actions menu button -->
      <button
        id="volume-menu-{volume_uuid}"
        class="absolute right-2 bottom-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-gray-800/80 hover:bg-gray-700/80"
        onclick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          closeAllMenus();
        }}
      >
        <DotsVerticalOutline class="h-4 w-4 text-white" />
      </button>
      <Dropdown
        triggeredBy="#volume-menu-{volume_uuid}"
        placement="bottom-end"
        bind:isOpen={menuOpen}
      >
        {#if isNotInstalled}
          {#if downloadFileId}
            <DropdownItem
              onclick={onDownloadClicked}
              class="flex w-full items-center text-gray-700 dark:text-gray-200"
            >
              <DownloadSolid class="me-2 h-5 w-5 flex-shrink-0" />
              <span class="flex-1 text-left">{isDownloading ? 'Downloading…' : 'Download'}</span>
            </DropdownItem>
          {/if}
        {:else}
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
          <DropdownItem
            onclick={onExtractClicked}
            class="flex w-full items-center text-gray-700 dark:text-gray-200"
          >
            <DownloadSolid class="me-2 h-5 w-5 flex-shrink-0" />
            <span class="flex-1 text-left">Extract</span>
          </DropdownItem>
        {/if}
        {#if !isNotInstalled && hasAuthenticatedProvider && !isReadOnlyMode}
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
          <span class="flex-1 text-left">{isPlaceholderRow ? 'Delete from cloud' : 'Delete'}</span>
        </DropdownItem>
      </Dropdown>

      <a
        href="#/reader/{$routeParams.manga}/{volume_uuid}"
        onclick={(e) => {
          e.preventDefault();
          onOpenClicked();
        }}
        class="flex flex-col gap-2"
      >
        <div class="relative flex items-center justify-center sm:h-[350px] sm:w-[250px]">
          {#if thumbnailUrl}
            <img
              src={thumbnailUrl}
              alt={volName}
              class="h-auto w-auto border border-gray-300 bg-gray-100 sm:max-h-[350px] sm:max-w-[250px] dark:border-gray-900 dark:bg-black"
            />
          {:else}
            <!-- Nothing is generating one for a volume whose pages are gone
                 (processThumbnails skips it), so don't promise it — but the
                 cloud may still hold its cover sidecar, which this fetches
                 lazily when the row carries one. -->
            <PlaceholderThumbnail
              volume={isNotInstalled ? volume : undefined}
              message={isNotInstalled ? 'Not on this device' : 'Generating thumbnail...'}
            />
          {/if}
          {#if isNotInstalled}
            <DownloadBadge class="right-1 bottom-1" />
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
          {#if isNotInstalled}
            <Badge color="gray" class="w-fit text-xs">
              {#key downloadProgress}
                <span>
                  {isDownloading
                    ? `Downloading ${Math.round(downloadProgress)}%`
                    : 'Not on this device'}
                </span>
              {/key}
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
          {#if isNotInstalled && archiveSizeDisplay}
            <!-- Beside the download badge on the cover above, not inside it:
                 the badge is a mark, and a mark with a number in it stops
                 reading as one. -->
            <span data-testid="archive-size" class="opacity-70">{archiveSizeDisplay}</span>
          {/if}
        </div>
      </a>
    </div>
  {/if}
{/if}
