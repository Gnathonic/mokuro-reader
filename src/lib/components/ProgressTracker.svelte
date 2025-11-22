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
    class="fixed bottom-4 right-4 z-50 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 w-80 overflow-hidden transition-all duration-200"
  >
    <div
      class="flex justify-between items-center p-3 bg-primary-100 dark:bg-primary-900 cursor-pointer"
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
          <CaretDownSolid class="w-4 h-4" />
        {:else}
          <CaretUpSolid class="w-4 h-4" />
        {/if}
      </div>
    </div>

    {#if expanded}
      <div class="p-3 max-h-96 overflow-y-auto">
        {#each $progressTrackerStore.processes as process (process.id)}
          <div class="mb-4 last:mb-0">
            <div class="flex justify-between items-center mb-1">
              <div class="text-sm font-medium">{process.description}</div>
              <Button size="xs" color="none" class="p-1" on:click={() => removeProcess(process.id)}>
                <CloseCircleSolid class="w-3 h-3" />
              </Button>
            </div>

            {#if process.status}
              <div class="text-xs text-gray-600 dark:text-gray-400 mb-1">{process.status}</div>
            {/if}

            {#if process.progress > 0}
              <div class="flex justify-between text-xs mb-1">
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
