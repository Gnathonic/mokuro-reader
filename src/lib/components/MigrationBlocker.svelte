<script lang="ts">
  import { onMount } from 'svelte';
  import {
    runMigration,
    rollbackMigration,
    type MigrationProgress,
    type MigrationPhase
  } from '$lib/catalog/migration';
  import { Progressbar, Button, Alert, Spinner } from 'flowbite-svelte';

  interface Props {
    sourceVersion: 1 | 2;
    onComplete: () => void;
  }

  let { sourceVersion, onComplete }: Props = $props();

  let progressData: MigrationProgress | null = $state(null);
  let errorMessage: string | null = $state(null);
  let isRunning = $state(false);
  let isRollingBack = $state(false);

  let progress = $derived.by(() => {
    if (!progressData || progressData.volumesTotal === 0) return 0;
    return (progressData.volumesCurrent / progressData.volumesTotal) * 100;
  });

  const phaseLabels: Record<MigrationPhase, string> = {
    counting: 'Counting volumes...',
    loading_series: 'Loading series...',
    writing_volume: 'Migrating...',
    deleting_source: 'Migrating...',
    complete: 'Complete!'
  };

  onMount(() => {
    startMigration();
  });

  async function startMigration() {
    if (isRunning) return;
    isRunning = true;
    errorMessage = null;

    try {
      await runMigration(sourceVersion, (p) => {
        progressData = p;
      });

      // Success - notify parent
      onComplete();
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
      isRunning = false;
    }
  }

  async function handleRetry() {
    errorMessage = null;
    await startMigration();
  }

  async function handleRollback() {
    isRollingBack = true;
    try {
      await rollbackMigration();
      // Reload the page to start fresh
      window.location.reload();
    } catch (e) {
      errorMessage = `Rollback failed: ${e instanceof Error ? e.message : String(e)}`;
      isRollingBack = false;
    }
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-gray-900">
  <div class="w-full max-w-md rounded-lg bg-gray-800 p-8 shadow-xl">
    <h2 class="mb-6 text-center text-2xl font-bold text-white">Upgrading Database</h2>

    {#if errorMessage}
      <Alert color="red" class="mb-6">
        <span class="font-medium">Migration Failed:</span>
        {errorMessage}
      </Alert>

      <div class="flex gap-4">
        <Button color="primary" class="flex-1" onclick={handleRetry} disabled={isRunning}>
          {#if isRunning}
            <Spinner size="4" class="mr-2" />
          {/if}
          Retry
        </Button>
        <Button
          color="alternative"
          class="flex-1"
          onclick={handleRollback}
          disabled={isRollingBack}
        >
          {#if isRollingBack}
            <Spinner size="4" class="mr-2" />
          {/if}
          Rollback
        </Button>
      </div>
    {:else}
      <p class="mb-6 text-center text-gray-300">
        Please do not close this tab. Your manga library is being upgraded to a new format.
      </p>

      <div class="mb-4">
        <Progressbar {progress} size="h-4" labelInside />
      </div>

      <div class="mb-4 h-32 text-center text-gray-400">
        {#if progressData}
          <!-- Phase indicator -->
          <p class="mb-2 flex items-center justify-center gap-2 text-sm text-blue-400">
            <Spinner size="4" />
            {phaseLabels[progressData.phase]}
          </p>

          <!-- Volume progress -->
          <p class="text-lg font-semibold">
            {progressData.volumesCurrent} / {progressData.volumesTotal} volumes
          </p>

          <!-- Series progress (v1 only) - always reserve space -->
          <p class="mt-1 h-5 text-sm text-gray-500">
            {#if progressData.seriesTotal && progressData.seriesCurrent}
              Series {progressData.seriesCurrent} / {progressData.seriesTotal}
            {/if}
          </p>

          <!-- Current series name - always reserve space -->
          <p class="mt-2 h-5 truncate text-sm text-gray-400">
            {progressData.seriesTitle || '\u00A0'}
          </p>

          <!-- Current volume name - always reserve space -->
          <p class="h-4 truncate text-xs text-gray-500">
            {progressData.volumeTitle || '\u00A0'}
          </p>
        {:else}
          <p class="flex items-center justify-center gap-2">
            <Spinner size="4" />
            Preparing migration...
          </p>
        {/if}
      </div>
    {/if}
  </div>
</div>
