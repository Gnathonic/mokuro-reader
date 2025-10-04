<script lang="ts">
  import { Button, Spinner } from 'flowbite-svelte';
  import { CloudArrowUpOutline, CheckCircleSolid, TrashBinSolid } from 'flowbite-svelte-icons';
  import { backupVolumeToDrive } from '$lib/util';
  import { showSnackbar } from '$lib/util';
  import { accessTokenStore, driveFilesCache, driveApiClient } from '$lib/util/google-drive';
  import type { VolumeMetadata } from '$lib/types';
  import type { DriveFileMetadata } from '$lib/util/google-drive';

  interface Props {
    volume: VolumeMetadata;
    class?: string;
  }

  let { volume, class: className }: Props = $props();

  let isBackingUp = $state(false);
  let currentStep = $state('');

  let isAuthenticated = $derived($accessTokenStore !== '');

  // Get the store reference once
  const driveCache = driveFilesCache.store;

  // Check if this volume exists in Drive (by parent/filename path)
  let expectedPath = $derived(`${volume.series_title}/${volume.volume_title}.cbz`);
  let isBackedUp = $derived.by(() => {
    const exists = $driveCache.has(expectedPath);
    console.log(`Checking backup status for: ${expectedPath}, exists: ${exists}`);
    console.log('Cache keys:', Array.from($driveCache.keys()));
    return exists;
  });

  async function handleBackup(e: MouseEvent) {
    e.stopPropagation();

    if (!isAuthenticated) {
      showSnackbar('Please sign in to Google Drive first', 'error');
      return;
    }

    if (isBackedUp) {
      showSnackbar('Volume already backed up', 'info');
      return;
    }

    isBackingUp = true;
    try {
      await backupVolumeToDrive(volume, (step) => {
        currentStep = step;
      });
      showSnackbar('Backup completed successfully', 'success');
    } catch (error) {
      console.error('Backup failed:', error);
      showSnackbar(`Backup failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      isBackingUp = false;
      currentStep = '';
    }
  }

  async function handleDelete(e: MouseEvent) {
    e.stopPropagation();

    if (!isAuthenticated) {
      showSnackbar('Please sign in to Google Drive first', 'error');
      return;
    }

    if (!isBackedUp) {
      showSnackbar('Volume not backed up', 'info');
      return;
    }

    const driveFile = driveFilesCache.getDriveFile(volume.series_title, volume.volume_title);
    if (!driveFile) {
      showSnackbar('File not found in Drive', 'error');
      return;
    }

    try {
      await driveApiClient.trashFile(driveFile.fileId);
      driveFilesCache.removeDriveFile(volume.series_title, volume.volume_title);
      showSnackbar('Moved to Drive trash', 'success');
    } catch (error) {
      console.error('Delete failed:', error);
      showSnackbar(`Delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    }
  }
</script>

{#if isBackedUp}
  <Button
    color="red"
    size="xs"
    class={className}
    on:click={handleDelete}
    disabled={!isAuthenticated}
    title="Delete from Drive (move to trash)"
  >
    <TrashBinSolid class="w-4 h-4 me-2" />
    Delete from Drive
  </Button>
{:else}
  <Button
    color="light"
    size="xs"
    class={className}
    disabled={isBackingUp || !isAuthenticated}
    on:click={handleBackup}
    title="Backup to Google Drive"
  >
    {#if isBackingUp}
      <Spinner size="4" class="me-2" />
      {currentStep || 'Backing up...'}
    {:else}
      <CloudArrowUpOutline class="w-4 h-4 me-2" />
      Backup to Drive
    {/if}
  </Button>
{/if}
