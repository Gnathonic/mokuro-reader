<script lang="ts">
  import { Spinner } from 'flowbite-svelte';
  import { DownloadSolid } from 'flowbite-svelte-icons';

  interface Props {
    /** Number of items to show in stack (1 = single, 2-3 = stacked) */
    count?: number;
    /** Whether download is in progress */
    isDownloading?: boolean;
    /** Show download UI (icon + status text) */
    showDownloadUI?: boolean;
    /** Custom message to display (overrides default) */
    message?: string;
  }

  let { count = 1, isDownloading = false, showDownloadUI = false, message }: Props = $props();

  // Limit stack to 3 items max
  let stackCount = $derived(Math.min(Math.max(count, 1), 3));

  // Step sizes for stacking effect
  const stepH = 35;
  let stepV = $derived(stackCount > 1 ? Math.min(40, 35 / (stackCount - 1)) : 0);
</script>

<div
  class="relative overflow-hidden sm:h-[350px] sm:w-[250px]"
  class:sm:h-[385px]={stackCount > 1}
  class:sm:w-[325px]={stackCount > 1}
>
  {#each Array(stackCount) as _, i}
    <div
      class="flex items-center justify-center border border-gray-300 bg-gray-200 sm:h-[350px] sm:w-[250px] dark:border-gray-600 dark:bg-gray-800"
      class:absolute={stackCount > 1}
      style={stackCount > 1
        ? `left: ${i * stepH}px; top: ${i * stepV}px; z-index: ${stackCount - i}; filter: drop-shadow(2px 4px 6px rgba(0, 0, 0, 0.5));`
        : ''}
    >
      {#if i === 0}
        {#if showDownloadUI}
          <div class="flex flex-col items-center gap-3">
            {#if isDownloading}
              <Spinner size="16" color="blue" />
              <span class="text-sm text-gray-300">Downloading...</span>
            {:else}
              <DownloadSolid class="h-16 w-16 text-blue-400" />
              <span class="text-sm text-gray-300">{message || 'Click to download'}</span>
            {/if}
          </div>
        {:else}
          <span class="text-gray-300">{message || 'No thumbnail'}</span>
        {/if}
      {/if}
    </div>
  {/each}
</div>
