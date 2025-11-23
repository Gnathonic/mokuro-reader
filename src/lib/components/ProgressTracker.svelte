<script lang="ts">
  import { Button, Progressbar } from 'flowbite-svelte';
  import { CaretDownSolid, CaretUpSolid, CloseCircleSolid } from 'flowbite-svelte-icons';
  import { formatBytes } from '$lib/util';
  import { progressTrackerStore } from '$lib/util/progress-tracker';

  let expanded = $state(true);

  function toggleExpanded() {
    expanded = !expanded;
  }

  function removeProcess(id: string) {
    progressTrackerStore.removeProcess(id);
  }
</script>

{#if $progressTrackerStore.processes.length > 0}
  <div
    class="fixed right-4 bottom-4 z-50 w-80 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg transition-all duration-200 dark:border-gray-700 dark:bg-gray-800"
  >
    <div
      class="flex cursor-pointer items-center justify-between bg-primary-100 p-3 dark:bg-primary-900"
      onclick={toggleExpanded}
      onkeydown={(e) => e.key === 'Enter' && toggleExpanded()}
      role="button"
      tabindex="0"
    >
      <div class="font-medium">
        {#if $progressTrackerStore.processes.length === 1}
          {$progressTrackerStore.processes[0].description}
        {:else}
          {$progressTrackerStore.processes.length} Background Tasks
        {/if}
      </div>
      <div>
        {#if expanded}
          <CaretDownSolid class="h-4 w-4" />
        {:else}
          <CaretUpSolid class="h-4 w-4" />
        {/if}
      </div>
    </div>

    {#if expanded}
      <div class="max-h-96 overflow-y-auto p-3">
        {#each $progressTrackerStore.processes as process (process.id)}
          <div class="mb-4 last:mb-0">
            <div class="mb-1 flex items-center justify-between">
              <div class="text-sm font-medium">{process.description}</div>
              <Button
                size="xs"
                color="alternative"
                class="p-1"
                onclick={() => removeProcess(process.id)}
              >
                <CloseCircleSolid class="h-3 w-3" />
              </Button>
            </div>

            {#if process.status}
              <div class="mb-1 text-xs text-gray-600 dark:text-gray-400">{process.status}</div>
            {/if}

            {#if process.progress > 0}
              <div class="mb-1 flex justify-between text-xs">
                <span>{Math.round(process.progress)}%</span>
                {#if process.bytesLoaded !== undefined && process.totalBytes !== undefined}
                  <span>{formatBytes(process.bytesLoaded)} / {formatBytes(process.totalBytes)}</span
                  >
                {/if}
              </div>

              <Progressbar progress={process.progress.toString()} size="h-2" />
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
