<script lang="ts">
  import { Button, Spinner } from 'flowbite-svelte';
  import { CloudArrowUpOutline, TrashBinSolid } from 'flowbite-svelte-icons';
  import { promptConfirmation, showSnackbar } from '$lib/util';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import { providerManager } from '$lib/util/sync';
  import type { VolumeMetadata } from '$lib/types';
  import type { CloudVolumeWithProvider } from '$lib/util/sync/unified-cloud-manager';
  import { backupQueue, isVolumeInBackupQueue } from '$lib/util/backup-queue';
  import { progressTrackerStore } from '$lib/util/progress-tracker';
  import type { Process } from '$lib/util/progress-tracker';
  import { uploadFailures } from '$lib/util/upload-failures';
  import { canDeleteSeriesOnServer } from '$lib/util/sync/metadata-permissions';

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
      providerStatus = value;
    });
  });
  let hasAuthenticatedProvider = $derived(providerStatus.hasAnyAuthenticated);

  // Check if current provider is WebDAV and in read-only mode
  let isReadOnlyMode = $derived(
    providerStatus.currentProviderType === 'webdav' &&
      providerStatus.providers['webdav']?.isReadOnly === true
  );

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

  // Is this volume backed up? The ONE selector every backup surface asks —
  // the same folded resolution the backup queue uploads into
  // (`resolveCloudFolderTitle`), so a volume the cloud holds under its own
  // spelling of the folder reads as backed up here too instead of being
  // re-uploaded on every click. `cloudFiles` is read for the dependency only:
  // the selector reads the listing cache that store is derived from.
  let cloudFile = $derived.by(() => {
    void cloudFiles;
    return unifiedCloudManager.getCloudFile(volume.series_title, volume.volume_title);
  });
  let isBackedUp = $derived(cloudFile !== null);
  let backupProvider = $derived(cloudFile?.provider);

  // Check if this volume is in the backup queue
  let queueItem = $derived(queueItems.find((item) => item.volumeUuid === volume.volume_uuid));
  let isQueued = $derived(queueItem?.status === 'queued');
  let isBackingUp = $derived(queueItem?.status === 'backing-up');

  // Get progress for this volume's backup
  let backupProcess = $derived(processes.find((p) => p.id === `backup-${volume.volume_uuid}`));
  let backupProgress = $derived(backupProcess?.progress || 0);
  let backupStatus = $derived(backupProcess?.status || '');

  // The last upload of this volume failed for good (persisted until one succeeds).
  let uploadFailure = $derived($uploadFailures[volume.volume_uuid]);

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

    // A refused volume already got the queue's own notice (one snackbar slot).
    const queued = backupQueue.queueVolumeForBackup(volume);
    if (queued === 'added') {
      showSnackbar(`Added ${volume.volume_title} to backup queue`);
    } else if (queued === 'already-queued') {
      showSnackbar('Volume already in backup queue');
    }
  }

  async function handleDelete(e: MouseEvent) {
    e.stopPropagation();

    if (!cloudFile) {
      showSnackbar('Volume not backed up');
      return;
    }
    // The same gate the volume row's own cloud delete runs: on a server whose
    // rules refuse this account (an uploader on a series it does not own),
    // every per-file DELETE would only 403.
    const permitted = canDeleteSeriesOnServer(volume.series_title);
    if (!permitted.allowed) {
      showSnackbar(permitted.reason ?? "This account can't delete this on this server");
      return;
    }

    // The same question the series delete and the volume row's own cloud delete
    // ask: a cloud delete is permanent, so one click never does it. And the
    // same delete — archive AND sidecars (`deleteManagedVolume`); deleting the
    // archive node alone left its .mokuro and cover behind as orphans.
    const providerName = providerDisplayName;
    const { series_title, volume_title, volume_uuid } = volume;
    promptConfirmation(`Delete ${volume_title} from ${providerName}?`, async () => {
      try {
        await unifiedCloudManager.deleteManagedVolume(series_title, volume_title, volume_uuid);
        showSnackbar(`Deleted from ${providerName}`);
      } catch (error) {
        console.error('Delete failed:', error);
        showSnackbar(`Delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    });
  }

  // Get active provider's display name
  let providerDisplayName = $derived.by(() => {
    const provider = unifiedCloudManager.getActiveProvider();
    return provider?.name || 'cloud';
  });
</script>

{#if !hasAuthenticatedProvider || isReadOnlyMode}
  <!-- Don't render anything when not authenticated or in read-only mode -->
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
{:else if uploadFailure}
  <div class="flex items-center gap-2 {className ?? ''}">
    <!-- Keyed: the reason is text an extension may rewrite and hold stale. -->
    <span
      data-testid="upload-failed"
      class="max-w-[16rem] truncate text-xs text-red-500"
      title={`Upload to ${uploadFailure.provider} failed: ${uploadFailure.reason}`}
    >
      {#key uploadFailure.reason}<span>Upload failed: {uploadFailure.reason}</span>{/key}
    </span>
    <Button color="red" outline size="xs" onclick={handleBackup} title="Retry the upload">
      <CloudArrowUpOutline class="me-2 h-4 w-4" />
      Retry
    </Button>
  </div>
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
