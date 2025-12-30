<script lang="ts">
  import { Card } from 'flowbite-svelte';
  import { BookSolid } from 'flowbite-svelte-icons';
  import { volumes, VolumeData, progress } from '$lib/settings/volume-data';
  import { volumes as catalogVolumes } from '$lib/catalog';

  // Check if volumes is empty
  let hasVolumes = $derived($volumes && Object.keys($volumes).length > 0);

  // Create typed entries for iteration
  let volumeEntries = $derived(Object.entries($volumes) as [string, VolumeData][]);

  // Store blob URLs for thumbnails
  let thumbnailUrls = $state<Map<string, string>>(new Map());

  // Create blob URLs for thumbnails
  $effect(() => {
    const newUrls = new Map<string, string>();
    const urlsToRevoke: string[] = [];

    volumeEntries.forEach(([volumeId]) => {
      const catalogVolume = $catalogVolumes[volumeId];
      if (catalogVolume?.thumbnail) {
        const url = URL.createObjectURL(catalogVolume.thumbnail);
        urlsToRevoke.push(url);
        newUrls.set(volumeId, url);
      }
    });

    thumbnailUrls = newUrls;

    // Cleanup: revoke all blob URLs when effect is destroyed
    return () => {
      urlsToRevoke.forEach((url) => URL.revokeObjectURL(url));
    };
  });
</script>

<svelte:head>
  <title>Progress Tracker</title>
</svelte:head>

<div class="min-h-[90svh] w-full p-4">
  <h1 class="mb-6 text-3xl font-bold">Progress Tracker</h1>

  {#if !hasVolumes}
    <Card class="mb-6 py-8 text-center">
      <BookSolid size="lg" class="mx-auto mb-3 text-gray-500" />
      <h2 class="mb-2 text-lg font-semibold text-gray-300">No Reading History Yet</h2>
      <p class="text-sm text-gray-400">Start reading to track your reading speed!</p>
    </Card>
  {:else}
    {#each volumeEntries as [volumeId, volumeData]}
      <div class="mb-4 rounded-lg border border-gray-700 bg-gray-800 p-4">
        <h3 class="mb-2 font-semibold">{volumeData.volume_title}</h3>
        {#if thumbnailUrls.get(volumeId)}
          <img
            src={thumbnailUrls.get(volumeId)}
            alt={volumeData.volume_title || 'Volume cover'}
            class="mb-3 rounded"
            style="max-width: 125px; max-height: 180px; height: auto;"
          />
        {/if}
        <p>
          {$catalogVolumes[volumeId]?.page_count
            ? ((($progress[volumeId] ?? 0) / $catalogVolumes[volumeId].page_count) * 100).toFixed(0)
            : 0}% ({($catalogVolumes[volumeId]?.page_count ?? 0) - ($progress[volumeId] ?? 0)}p)
        </p>
      </div>
    {/each}
  {/if}
</div>
