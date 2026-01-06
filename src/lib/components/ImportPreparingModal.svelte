<script lang="ts">
  import { Modal, Spinner } from 'flowbite-svelte';
  import { importPreparingModalStore } from '$lib/util/modals';

  // Conditionally render Modal to avoid Flowbite's internal state issues
  let open = $derived($importPreparingModalStore?.open ?? false);

  let phase = $derived($importPreparingModalStore?.phase ?? 'scanning');
  let filesScanned = $derived($importPreparingModalStore?.filesScanned);
  let totalFiles = $derived($importPreparingModalStore?.totalFiles);
  let volumesFound = $derived($importPreparingModalStore?.volumesFound);

  // Phase-specific messages
  let title = $derived(
    phase === 'scanning'
      ? 'Scanning Files'
      : phase === 'analyzing'
        ? 'Analyzing Content'
        : 'Preparing Import'
  );

  let message = $derived(() => {
    switch (phase) {
      case 'scanning':
        if (filesScanned !== undefined) {
          return `Found ${filesScanned.toLocaleString()} file${filesScanned !== 1 ? 's' : ''}...`;
        }
        return 'Scanning dropped files and folders...';
      case 'analyzing':
        if (totalFiles !== undefined) {
          return `Analyzing ${totalFiles.toLocaleString()} file${totalFiles !== 1 ? 's' : ''}...`;
        }
        return 'Analyzing file structure...';
      case 'preparing':
        if (volumesFound !== undefined) {
          return `Found ${volumesFound} volume${volumesFound !== 1 ? 's' : ''} to import`;
        }
        return 'Preparing to import...';
      default:
        return 'Processing...';
    }
  });
</script>

{#if open}
  <Modal open={true} size="sm" dismissable={false}>
    <div class="flex flex-col items-center gap-4 py-4">
      <!-- Spinner -->
      <Spinner size="12" color="blue" />

      <!-- Title -->
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>

      <!-- Status message -->
      <p class="text-center text-sm text-gray-600 dark:text-gray-400">
        {message()}
      </p>

      <!-- Progress details -->
      {#if phase === 'analyzing' && volumesFound !== undefined && volumesFound > 0}
        <p class="text-center text-xs text-gray-500 dark:text-gray-500">
          {volumesFound} volume{volumesFound !== 1 ? 's' : ''} detected so far
        </p>
      {/if}
    </div>
  </Modal>
{/if}
