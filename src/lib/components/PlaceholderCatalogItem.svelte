<script lang="ts">
  import type { Series } from '$lib/catalog/catalog';
  import { DownloadOutline } from 'flowbite-svelte-icons';
  import { Badge } from 'flowbite-svelte';

  interface Props {
    series: Series;
  }

  let { series }: Props = $props();

  const volumeCount = $derived(series.volumes.length);
  const totalSize = $derived(
    series.volumes.reduce((sum, vol) => sum + (vol.driveSize || 0), 0)
  );
  const totalSizeDisplay = $derived(
    totalSize > 0 ? `${(totalSize / 1024 / 1024).toFixed(1)} MB` : ''
  );
</script>

<a href={series.series_uuid}>
  <div
    class="flex flex-col gap-[5px] text-center items-center bg-slate-900 pb-1 bg-opacity-50 border border-slate-950 opacity-60 relative"
  >
    <!-- Placeholder thumbnail with cloud icon -->
    <div
      class="sm:w-[250px] sm:h-[350px] bg-gray-700 border-gray-600 border flex flex-col items-center justify-center gap-3"
    >
      <DownloadOutline class="w-16 h-16 text-gray-400" />
      <div class="text-gray-400 text-sm px-4">
        <p class="font-semibold">{volumeCount} volume{volumeCount !== 1 ? 's' : ''}</p>
        {#if totalSizeDisplay}
          <p class="text-xs">{totalSizeDisplay}</p>
        {/if}
      </div>
    </div>

    <!-- Series title -->
    <p class="font-semibold sm:w-[250px] line-clamp-1 text-gray-400">
      {series.title}
    </p>

    <!-- Badge indicating it's Drive-only -->
    <Badge color="blue" class="absolute top-2 right-2">In Drive</Badge>
  </div>
</a>
