<script lang="ts">
  import { catalog } from '$lib/catalog';
  import { goto } from '$app/navigation';
  import VolumeItem from '$lib/components/VolumeItem.svelte';
  import PlaceholderVolumeItem from '$lib/components/PlaceholderVolumeItem.svelte';
  import BackupButton from '$lib/components/BackupButton.svelte';
  import { Button, Listgroup, Spinner } from 'flowbite-svelte';
  import { db } from '$lib/catalog/db';
  import { promptConfirmation, zipManga, showSnackbar, backupVolumeToDrive } from '$lib/util';
  import { promptExtraction } from '$lib/util/modals';
  import { progressTrackerStore } from '$lib/util/progress-tracker';
  import { page } from '$app/stores';
  import type { VolumeMetadata } from '$lib/types';
  import { deleteVolume, mangaStats } from '$lib/settings';
  import { tokenManager, driveFilesCache, driveApiClient } from '$lib/util/google-drive';
  import { CloudArrowUpOutline, DownloadOutline, TrashBinSolid } from 'flowbite-svelte-icons';

  function sortManga(a: VolumeMetadata, b: VolumeMetadata) {
    return a.volume_title.localeCompare(b.volume_title, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  }

  let manga = $derived(
    $catalog?.find((item) => item.series_uuid === $page.params.manga)?.volumes.sort(sortManga)
  );

  let loading = $state(false);

  // Track backup state from progress tracker
  let progressState = $state($progressTrackerStore);
  $effect(() => {
    return progressTrackerStore.subscribe(value => {
      progressState = value;
    });
  });

  let seriesTitle = $derived(manga?.[0]?.series_title || '');
  let backupProcessId = $derived(`backup-series-${seriesTitle}`);
  let downloadProcessId = $derived(`download-series-${seriesTitle}`);


  let backupProcess = $derived.by(() => {
    return progressState.processes.find(p => p.id === backupProcessId);
  });

  let backingUpSeries = $derived(!!backupProcess);
  let backupProgress = $derived(backupProcess?.status?.match(/(\d+\/\d+)/)?.[1] || '');
  let downloadProcess = $derived.by(() => {
    return progressState.processes.find(p => p.id === downloadProcessId);
  });

  let downloadingSeries = $derived(!!downloadProcess);
  let downloadProgress = $derived(downloadProcess?.status?.match(/(\d+\/\d+)/)?.[1] || '');

  let token = $state('');
  $effect(() => {
    return tokenManager.token.subscribe(value => {
      token = value;
    });
  });

  let isAuthenticated = $derived(token !== '');

  // Check if all volumes in series are backed up
  let driveCache = $state(new Map());
  $effect(() => {
    return driveFilesCache.store.subscribe(value => {
      driveCache = value;
    });
  });

  let allBackedUp = $derived.by(() => {
    if (!manga || manga.length === 0) return false;
    return manga.every(vol => driveCache.has(`${vol.series_title}/${vol.volume_title}.cbz`));
  });

  let anyBackedUp = $derived.by(() => {
    if (!manga || manga.length === 0) return false;
    return manga.some(vol => driveCache.has(`${vol.series_title}/${vol.volume_title}.cbz`));
  });
  let anyPlaceholders = $derived.by(() => {
    if (!manga || manga.length === 0) return false;
    return manga.some(vol => vol.isPlaceholder);
  });

  async function confirmDelete(deleteStats = false, deleteDrive = false) {
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

      // Delete from Drive if checkbox checked
      if (deleteDrive && isAuthenticated && manga) {
        await deleteSeriesFromDrive(manga);
      }

      goto('/');
    }
  }

  async function deleteSeriesFromDrive(volumes: VolumeMetadata[]) {
    if (!volumes || volumes.length === 0) return;

    const seriesTitle = volumes[0].series_title;

    // Get any file from the series to find the parent folder
    const sampleFile = driveFilesCache.getDriveFile(volumes[0].series_title, volumes[0].volume_title);
    if (!sampleFile) {
      showSnackbar('Series folder not found in Drive', 'error');
      return;
    }

    try {
      // Get the parent folder ID from the file
      const fileDetails = await driveApiClient.listFiles(
        `'${sampleFile.fileId}' in parents`,
        'files(parents)'
      );

      // Actually we need to get the file's parent, let me use a different approach
      // Search for the series folder by name
      const folders = await driveApiClient.listFiles(
        `name='${seriesTitle}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        'files(id,name)'
      );

      if (folders.length === 0) {
        showSnackbar('Series folder not found in Drive', 'error');
        return;
      }

      const folderId = folders[0].id;

      // Trash the entire folder
      await driveApiClient.trashFile(folderId);

      // Remove all volumes from cache
      for (const vol of volumes) {
        driveFilesCache.removeDriveFile(vol.series_title, vol.volume_title);
      }

      showSnackbar(`Moved series folder to Drive trash`, 'success');
    } catch (error) {
      console.error('Failed to delete series from Drive:', error);
      showSnackbar('Failed to delete from Drive', 'error');
    }
  }

  async function onDeleteFromDrive() {
    if (!manga || manga.length === 0) return;
    if (!isAuthenticated) {
      showSnackbar('Please sign in to Google Drive first', 'error');
      return;
    }

    if (!anyBackedUp) {
      showSnackbar('No backups found in Drive', 'info');
      return;
    }

    promptConfirmation(
      `Delete ${manga[0].series_title} from Google Drive?`,
      async () => {
        await deleteSeriesFromDrive(manga);
      }
    );
  }

  function onDelete() {
    const hasDriveBackups = manga?.some(vol =>
      driveCache.has(`${vol.series_title}/${vol.volume_title}.cbz`)
    );

    promptConfirmation(
      'Are you sure you want to delete this manga?',
      confirmDelete,
      undefined,
      {
        label: "Also delete stats and progress?",
        storageKey: "deleteStatsPreference",
        defaultValue: false
      },
      hasDriveBackups ? {
        label: "Also delete from Google Drive?",
        storageKey: "deleteDrivePreference",
        defaultValue: false
      } : undefined
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
    if (!isAuthenticated) {
      showSnackbar('Please sign in to Google Drive first', 'error');
      return;
    }

    // If already backing up, don't start again
    if (backingUpSeries) {
      return;
    }

    const currentSeriesTitle = manga[0].series_title;
    const currentProcessId = `backup-series-${currentSeriesTitle}`;

    // Filter out already backed up volumes
    const volumesToBackup = manga.filter(vol =>
      !driveCache.has(`${vol.series_title}/${vol.volume_title}.cbz`)
    );

    if (volumesToBackup.length === 0) {
      showSnackbar('All volumes already backed up', 'info');
      return;
    }

    progressTrackerStore.addProcess({
      id: currentProcessId,
      description: `Backing up ${currentSeriesTitle}`,
      progress: 0,
      status: `0/${volumesToBackup.length} volumes`
    });

    let successCount = 0;
    let failCount = 0;

    try {
      for (let i = 0; i < volumesToBackup.length; i++) {
        const volume = volumesToBackup[i];
        const progress = Math.round(((i + 1) / volumesToBackup.length) * 100);

        progressTrackerStore.updateProcess(currentProcessId, {
          progress,
          status: `${i + 1}/${volumesToBackup.length}: ${volume.volume_title}`
        });

        try {
          await backupVolumeToDrive(volume);
          successCount++;
        } catch (error) {
          console.error(`Failed to backup ${volume.volume_title}:`, error);
          failCount++;
        }
      }
    } finally {
      progressTrackerStore.removeProcess(currentProcessId);
    }

    if (failCount === 0) {
      showSnackbar(`Successfully backed up ${successCount} volumes`, 'success');
    } else {
      showSnackbar(`Backed up ${successCount} volumes, ${failCount} failed`, 'error');
    }
  }

  async function downloadSeries() {
    if (!manga || manga.length === 0) return;
    if (!isAuthenticated) {
      showSnackbar('Please sign in to Google Drive first', 'error');
      return;
    }

    // If already downloading, don't start again
    if (downloadingSeries) {
      return;
    }

    const currentSeriesTitle = manga[0].series_title;
    const currentProcessId = `download-series-${currentSeriesTitle}`;

    // Filter for placeholder volumes only
    const volumesToDownload = manga.filter(vol => vol.isPlaceholder);

    if (volumesToDownload.length === 0) {
      showSnackbar('All volumes already downloaded', 'info');
      return;
    }

    progressTrackerStore.addProcess({
      id: currentProcessId,
      description: `Downloading ${currentSeriesTitle}`,
      progress: 0,
      status: `0/${volumesToDownload.length} volumes`
    });

    let successCount = 0;
    let failCount = 0;

    try {
      const { downloadVolumeFromDrive } = await import('$lib/util/download-from-drive');

      for (let i = 0; i < volumesToDownload.length; i++) {
        const volume = volumesToDownload[i];
        const progress = Math.round(((i + 1) / volumesToDownload.length) * 100);

        progressTrackerStore.updateProcess(currentProcessId, {
          progress,
          status: `${i + 1}/${volumesToDownload.length}: ${volume.volume_title}`
        });

        try {
          await downloadVolumeFromDrive(volume);
          successCount++;
        } catch (error) {
          console.error(`Failed to download ${volume.volume_title}:`, error);
          failCount++;
        }
      }
    } finally {
      progressTrackerStore.removeProcess(currentProcessId);
    }

    if (failCount === 0) {
      showSnackbar(`Successfully downloaded ${successCount} volumes`, 'success');
    } else {
      showSnackbar(`Downloaded ${successCount} volumes, ${failCount} failed`, 'error');
    }
  }
</script>

<svelte:head>
  <title>{manga?.[0].series_title || 'Manga'}</title>
</svelte:head>
{#if manga && $mangaStats}
  <div class="p-2 flex flex-col gap-5">
    <div class="flex flex-row justify-between">
      <div class="flex flex-col gap-2">
        <h3 class="font-bold">{manga[0].series_title}</h3>
        <div class="flex flex-col gap-0 sm:flex-row sm:gap-5">
          <p>Volumes: {$mangaStats.completed} / {manga.length}</p>
          <p>Characters read: {$mangaStats.chars}</p>
          <p>Minutes read: {$mangaStats.timeReadInMinutes}</p>
        </div>
      </div>
      <div class="flex flex-row gap-2 items-start">
        {#if anyPlaceholders && isAuthenticated}
          <Button
            color="light"
            on:click={downloadSeries}
            disabled={downloadingSeries || !isAuthenticated}
          >
            {#if downloadingSeries}
              <Spinner size="4" class="me-2" />
              Downloading {downloadProgress}
            {:else}
              <DownloadOutline class="w-4 h-4 me-2" />
              Download series from Drive
            {/if}
          </Button>
        {/if}
        {#if !allBackedUp}
          <Button
            color="light"
            on:click={backupSeries}
            disabled={backingUpSeries || !isAuthenticated}
          >
            {#if backingUpSeries}
              <Spinner size="4" class="me-2" />
              Backing up {backupProgress}
            {:else}
              <CloudArrowUpOutline class="w-4 h-4 me-2" />
              {anyBackedUp ? 'Backup remaining volumes' : 'Backup series to Drive'}
            {/if}
          </Button>
        {/if}
        {#if anyBackedUp && isAuthenticated}
          <Button
            color="red"
            on:click={onDeleteFromDrive}
          >
            <TrashBinSolid class="w-4 h-4 me-2" />
            Delete series from Drive
          </Button>
        {/if}
        <Button color="alternative" on:click={onDelete}>Remove manga</Button>
        <Button color="light" on:click={onExtract} disabled={loading}>
          {loading ? 'Extracting...' : 'Extract manga'}
        </Button>
      </div>
    </div>
    <Listgroup active class="flex-1 h-full w-full">
      {#each manga as volume (volume.volume_uuid)}
        {#if volume.isPlaceholder}
          <PlaceholderVolumeItem {volume} />
        {:else}
          <VolumeItem {volume} />
        {/if}
      {/each}
    </Listgroup>
  </div>
{:else}
  <div class="flex justify-center p-16">Manga not found</div>
{/if}
