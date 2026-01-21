<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, Card, Alert, Spinner, Radio, Badge } from 'flowbite-svelte';
  import {
    detectSeriesConflicts,
    generateMergeSeriesPreview,
    executeMergeSeries
  } from '$lib/util/series-merge';
  import type { SeriesConflict, MergeSeriesPreview } from '$lib/util/series-merge';

  let conflicts: SeriesConflict[] = $state([]);
  let loading = $state(true);
  let error = $state('');
  let executing = $state(false);
  let lastExecuteResult: MergeSeriesPreview | null = $state(null);

  // Track selected UUIDs for each series
  let selectedUuids: Record<string, string> = $state({});

  // Preview for current selections
  let currentPreview: MergeSeriesPreview | null = $state(null);
  let previewLoading = $state(false);

  onMount(async () => {
    await loadConflicts();
  });

  async function loadConflicts() {
    try {
      loading = true;
      error = '';
      conflicts = await detectSeriesConflicts();

      // Pre-select the newest UUID (last in sorted order) for each conflict
      selectedUuids = {};
      for (const conflict of conflicts) {
        if (conflict.conflictingUuids.length > 0) {
          // Select the last UUID (newest by creation time)
          const newestUuid = conflict.conflictingUuids[conflict.conflictingUuids.length - 1];
          selectedUuids[conflict.seriesTitle] = newestUuid.seriesUuid;
        }
      }

      // Generate initial preview
      await updatePreview();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load conflicts';
      console.error('Error loading conflicts:', err);
    } finally {
      loading = false;
    }
  }

  async function updatePreview() {
    if (conflicts.length === 0) {
      currentPreview = null;
      return;
    }

    try {
      previewLoading = true;

      // Generate preview for all selected merges
      let allIndexedDbChanges: MergeSeriesPreview['indexedDbChanges'] = [];
      let allLocalStorageChanges: MergeSeriesPreview['localStorageChanges'] = [];

      for (const conflict of conflicts) {
        const selectedUuid = selectedUuids[conflict.seriesTitle];
        if (!selectedUuid) continue;

        // For each non-selected UUID, preview merging it to the selected UUID
        for (const conflictingUuid of conflict.conflictingUuids) {
          if (conflictingUuid.seriesUuid !== selectedUuid) {
            const preview = await generateMergeSeriesPreview(
              conflict.seriesTitle,
              conflictingUuid.seriesUuid,
              selectedUuid
            );

            allIndexedDbChanges.push(...preview.indexedDbChanges);
            allLocalStorageChanges.push(...preview.localStorageChanges);
          }
        }
      }

      currentPreview = {
        indexedDbChanges: allIndexedDbChanges,
        localStorageChanges: allLocalStorageChanges
      };
    } catch (err) {
      console.error('Error updating preview:', err);
    } finally {
      previewLoading = false;
    }
  }

  async function handleUuidSelectionChange() {
    await updatePreview();
  }

  async function executeMerge() {
    if (!currentPreview || conflicts.length === 0) return;

    try {
      executing = true;
      error = '';

      // Execute all merges
      let totalIndexedDbChanges = 0;
      let totalLocalStorageChanges = 0;

      for (const conflict of conflicts) {
        const selectedUuid = selectedUuids[conflict.seriesTitle];
        if (!selectedUuid) continue;

        // For each non-selected UUID, merge it to the selected UUID
        for (const conflictingUuid of conflict.conflictingUuids) {
          if (conflictingUuid.seriesUuid !== selectedUuid) {
            const result = await executeMergeSeries(
              conflict.seriesTitle,
              conflictingUuid.seriesUuid,
              selectedUuid
            );

            totalIndexedDbChanges += result.indexedDbChanges.length;
            totalLocalStorageChanges += result.localStorageChanges.length;
          }
        }
      }

      lastExecuteResult = {
        indexedDbChanges: Array(totalIndexedDbChanges).fill(null),
        localStorageChanges: Array(totalLocalStorageChanges).fill(null)
      };

      // Reload conflicts to show updated state
      await loadConflicts();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to execute merge';
      console.error('Error executing merge:', err);
    } finally {
      executing = false;
    }
  }

  function getConflictSummary(conflict: SeriesConflict): string {
    const totalVolumes = conflict.conflictingUuids.reduce((sum, uuid) => sum + uuid.volumeCount, 0);
    return `${conflict.conflictingUuids.length} UUIDs, ${totalVolumes} volumes total`;
  }
</script>

<div class="container mx-auto px-4 py-8">
  <h1 class="mb-6 text-3xl font-bold">Series Merge Tool</h1>

  <div class="mb-6">
    <div
      class="mb-6 flex w-full max-w-none flex-col rounded-lg border border-gray-200 bg-white p-6 shadow-md dark:border-gray-700 dark:bg-gray-800"
    >
      <p class="mb-1 text-sm text-gray-400">
        This tool helps you consolidate volumes from the same series that have different series
        UUIDs. This can happen when importing volumes at different times. The preview below shows
        exactly what changes will be made when you execute the merge.
      </p>
    </div>

    {#if loading}
      <div class="flex items-center justify-center py-8">
        <Spinner size="8" class="mr-3" />
        <span>Loading series conflicts...</span>
      </div>
    {:else if error}
      <Alert color="red">
        <strong>Error:</strong>
        {error}
        <Button onclick={() => (error = '')} color="red" size="xs" class="ml-2">Retry</Button>
      </Alert>
    {:else if conflicts.length === 0}
      <Alert color="green">
        <strong>Great news!</strong> No series conflicts were found. All your series have consistent
        UUIDs.
      </Alert>
    {:else}
      <!-- Conflicts List -->
      <div class=" space-y-6">
        {#each conflicts as conflict}
          <Card class="max-w-none p-6">
            <div class="mb-4">
              <h3 class="mb-2 text-xl font-semibold">{conflict.seriesTitle}</h3>
              <p class="mb-4 text-sm text-gray-400">
                {getConflictSummary(conflict)}
              </p>
            </div>

            <div class="space-y-3">
              <p class="text-sm font-medium text-gray-400">Choose which UUID to keep:</p>

              {#each conflict.conflictingUuids as uuidData, index}
                <div
                  class="flex items-start gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
                >
                  <Radio
                    name="uuid-{conflict.seriesTitle}"
                    value={uuidData.seriesUuid}
                    bind:group={selectedUuids[conflict.seriesTitle]}
                    onchange={handleUuidSelectionChange}
                  />

                  <div class="min-w-0 flex-1">
                    <div class="mb-1 flex items-center gap-2">
                      <code class="rounded px-2 py-1 font-mono text-sm">
                        {uuidData.seriesUuid}
                      </code>

                      <Badge color="gray" size="small">
                        {uuidData.volumeCount} volume{uuidData.volumeCount !== 1 ? 's' : ''}
                      </Badge>

                      {#if index === 0}
                        <Badge color="blue" size="small">Oldest</Badge>
                      {:else if index === conflict.conflictingUuids.length - 1}
                        <Badge color="green" size="small">Newest</Badge>
                      {/if}
                    </div>

                    <div class="text-sm text-gray-400">
                      Volumes: {uuidData.volumes
                        .map((v) => v.volume_title || 'Untitled')
                        .join(', ')}
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          </Card>
        {/each}
      </div>

      <!-- Preview Section -->
      {#if currentPreview && (currentPreview.indexedDbChanges.length > 0 || currentPreview.localStorageChanges.length > 0)}
        <Card class="mt-6 mb-6 max-w-none p-6">
          <h3 class="mb-4 text-lg font-semibold">Preview of Changes</h3>

          {#if previewLoading}
            <div class="flex items-center justify-center py-4">
              <Spinner size="6" class="mr-3" />
              <span>Generating preview...</span>
            </div>
          {:else}
            <div class="space-y-4">
              {#if currentPreview.indexedDbChanges.length > 0}
                <div>
                  <h4 class="mb-2 font-medium">
                    Database Changes ({currentPreview.indexedDbChanges.length})
                  </h4>
                  <div class="max-h-40 overflow-y-auto rounded p-3 font-mono text-sm">
                    {#each currentPreview.indexedDbChanges.slice(0, 10) as change}
                      <div class="mb-1">
                        {change.volumeUuid}: {change.oldValue} → {change.newValue}
                      </div>
                    {/each}
                    {#if currentPreview.indexedDbChanges.length > 10}
                      <div class="text-gray-600">
                        ... and {currentPreview.indexedDbChanges.length - 10} more
                      </div>
                    {/if}
                  </div>
                </div>
              {/if}

              {#if currentPreview.localStorageChanges.length > 0}
                <div>
                  <h4 class="mb-2 font-medium">
                    LocalStorage Changes ({currentPreview.localStorageChanges.length})
                  </h4>
                  <div class="max-h-40 overflow-y-auto rounded p-3 font-mono text-sm">
                    {#each currentPreview.localStorageChanges.slice(0, 10) as change}
                      <div class="mb-1">
                        {change.volumeUuid}: {change.oldValue} → {change.newValue}
                      </div>
                    {/each}
                    {#if currentPreview.localStorageChanges.length > 10}
                      <div class="text-gray-600">
                        ... and {currentPreview.localStorageChanges.length - 10} more
                      </div>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </Card>
      {/if}

      <!-- Controls -->
      <div class="mb-6 flex items-center justify-end">
        <Button
          onclick={executeMerge}
          disabled={executing || !currentPreview || currentPreview.indexedDbChanges.length === 0}
          color="primary"
        >
          {#if executing}
            <Spinner size="4" class="mr-2" />
          {/if}
          Execute Merge
        </Button>
      </div>

      <!-- Results of last execution -->
      {#if lastExecuteResult}
        <Alert color="green" class="mb-6">
          <strong>Success:</strong>
          {lastExecuteResult.indexedDbChanges.length} database changes,
          {lastExecuteResult.localStorageChanges.length} localStorage changes completed
        </Alert>
      {/if}
    {/if}
  </div>
</div>
