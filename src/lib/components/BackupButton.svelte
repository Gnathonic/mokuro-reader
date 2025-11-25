<script lang="ts">
  import { Button, Spinner } from 'flowbite-svelte';
  import { CloudArrowUpOutline, TrashBinSolid } from 'flowbite-svelte-icons';
  import { showSnackbar } from '$lib/util';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import { providerManager } from '$lib/util/sync';
  import type { VolumeMetadata } from '$lib/types';
  import type { CloudVolumeWithProvider } from '$lib/util/sync/unified-cloud-manager';
  import { backupQueue, isVolumeInBackupQueue } from '$lib/util/backup-queue';
  import { progressTrackerStore } from '$lib/util/progress-tracker';
  import type { Process } from '$lib/util/progress-tracker';

  interface Props {
    volume: VolumeMetadata;
    class?: string;
  }

  let { volume, class: className }: Props = $props();

  // Subscribe to unified cloud files
  let cloudFiles = $state<Map<string, CloudVolumeWithProvider[]>>(new Map());
  let isFetching = $state(false);

  $effect(() => {
    const unsubscribers = [
      unifiedCloudManager.cloudFiles.subscribe((value) => {
        cloudFiles = value;
      }),
      unifiedCloudManager.isFetching.subscribe((value) => {
        isFetching = value;
      })
    ];
    return () => unsubscribers.forEach((unsub) => unsub());
  });

  // Subscribe to provider manager status for reactive authentication state
  let providerStatus = $state({ hasAnyAuthenticated: false, providers: {}, needsAttention: false });
  $effect(() => {
    return providerManager.status.subscribe((value) => {
      providerStatus = value;
    });
  });
  let hasAuthenticatedProvider = $derived(providerStatus.hasAnyAuthenticated);

  // Subscribe to backup queue
  let queueItems = $state<any[]>([]);
  $effect(() => {
    return backupQueue.subscribe((value) => {
      queueItems = value;
    });
  });

  // Subscribe to progress tracker
  let processes = $state<Process[]>([]);
  $effect(() => {
    return progressTrackerStore.subscribe((value) => {
      processes = value.processes;
    });
  });

  // Check if this volume exists in any cloud provider (reactive to cloudFiles changes)
  let cloudFile = $derived.by(() => {
    const path = `${volume.series_title}/${volume.volume_title}.cbz`;
    const seriesFiles = cloudFiles.get(volume.series_title) || [];
    return seriesFiles.find((f) => f.path === path);
  });
  let isBackedUp = $derived(cloudFile !== undefined);
  let backupProvider = $derived(cloudFile?.provider);

  // Check if this volume is in the backup queue
  let queueItem = $derived(queueItems.find((item) => item.volumeUuid === volume.volume_uuid));
  let isQueued = $derived(queueItem?.status === 'queued');
  let isBackingUp = $derived(queueItem?.status === 'backing-up');

  // Get progress for this volume's backup
  let backupProcess = $derived(processes.find((p) => p.id === `backup-${volume.volume_uuid}`));
  let backupProgress = $derived(backupProcess?.progress || 0);
  let backupStatus = $derived(backupProcess?.status || '');

  // Count total files in the Map for isFetching check
  let totalFiles = $derived.by(() => {
    let count = 0;
    for (const files of cloudFiles.values()) {
      count += files.length;
    }
    return count;
  });

  async function handleBackup(e: MouseEvent) {
    e.stopPropagation();

    const provider = unifiedCloudManager.getDefaultProvider();
    if (!provider) {
      showSnackbar('Please connect to a cloud storage provider first');
      return;
    }

    if (isBackedUp) {
      showSnackbar('Volume already backed up');
      return;
    }

    if (isQueued || isBackingUp) {
      showSnackbar('Volume already in backup queue');
      return;
    }

    // Add to backup queue
    backupQueue.queueVolumeForBackup(volume);
    showSnackbar(`Added ${volume.volume_title} to backup queue`);
  }

  async function handleDelete(e: MouseEvent) {
    e.stopPropagation();

    if (!cloudFile) {
      showSnackbar('Volume not backed up');
      return;
    }

    try {
      await unifiedCloudManager.deleteFile(cloudFile);
      showSnackbar(`Deleted from ${cloudFile.provider}`);
    } catch (error) {
      console.error('Delete failed:', error);
      showSnackbar(`Delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Get active provider's display name
  let providerDisplayName = $derived.by(() => {
    const provider = unifiedCloudManager.getActiveProvider();
    return provider?.name || 'cloud';
  });
</script>

{#if !hasAuthenticatedProvider}
  <!-- Don't render anything when not authenticated -->
{:else if isFetching && totalFiles === 0}
  <Button color="light" size="xs" class={className} disabled={true} title="Loading cloud status...">
    <Spinner size="4" class="me-2" />
    Loading...
  </Button>
{:else if isBackedUp}
  <Button
    color="red"
    size="xs"
    class={className}
    onclick={handleDelete}
    title={`Delete from ${providerDisplayName}`}
  >
    <TrashBinSolid class="me-2 h-4 w-4" />
    Delete from {providerDisplayName}
  </Button>
{:else if isQueued}
  <Button color="light" size="xs" class={className} disabled={true} title="Queued for backup">
    <Spinner size="4" class="me-2" />
    Queued
  </Button>
{:else if isBackingUp}
  <Button color="light" size="xs" class={className} disabled={true} title={backupStatus}>
    <Spinner size="4" class="me-2" />
    {Math.round(backupProgress)}% - {backupStatus}
  </Button>
{:else}
  <Button
    color="light"
    size="xs"
    class={className}
    onclick={handleBackup}
    title={`Backup to ${providerDisplayName}`}
  >
    <CloudArrowUpOutline class="me-2 h-4 w-4" />
    Backup to {providerDisplayName}
  </Button>
{/if}
