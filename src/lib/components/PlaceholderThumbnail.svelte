<script lang="ts">
  import type { VolumeMetadata } from '$lib/types';
  import { Spinner } from 'flowbite-svelte';
  import { DownloadSolid } from 'flowbite-svelte-icons';
  import { fetchCloudThumbnail, getCachedCloudThumbnail } from '$lib/catalog/cloud-thumbnails';
  import { requestCoverOnce } from '$lib/catalog/cover-requests';

  interface Props {
    /** Number of items to show in stack (1 = single, 2-3 = stacked) */
    count?: number;
    /** Whether download is in progress */
    isDownloading?: boolean;
    /** Show download UI (icon + status text) */
    showDownloadUI?: boolean;
    /** Custom message to display (overrides default) */
    message?: string;
    /** Volume metadata for cloud thumbnail fetching */
    volume?: VolumeMetadata;
    /** Whether to show drop shadow on stacked items */
    dropShadow?: boolean;
  }

  let {
    count = 1,
    isDownloading = false,
    showDownloadUI = false,
    message,
    volume,
    dropShadow = true
  }: Props = $props();

  // Limit stack to 3 items max
  let stackCount = $derived(Math.min(Math.max(count, 1), 3));

  // Step sizes for stacking effect
  const stepH = 35;
  let stepV = $derived(stackCount > 1 ? Math.min(40, 35 / (stackCount - 1)) : 0);

  // Cloud thumbnail state
  let cloudThumbnailUrl: string | null = $state(null);

  let hasCloudThumbnailId = $derived(!!volume?.cloudThumbnailFileId);

  /**
   * Covers this placeholder has asked for and landed. Bounded to one uuid in practice —
   * a placeholder draws a single volume — but it follows the same rule as the catalog
   * card and the spine shelf so all three behave alike: the request is only spent when it
   * produced a cover, so a timeout or a saturated provider stays retryable rather than
   * leaving the box blank until the view is reopened.
   *
   * Deliberately NOT reactive.
   */
  const requestedCovers = new Set<string>();

  $effect(() => {
    if (!hasCloudThumbnailId || !volume) return;
    const target = volume;

    const cached = getCachedCloudThumbnail(target.volume_uuid);
    if (cached) {
      const url = URL.createObjectURL(cached.file);
      cloudThumbnailUrl = url;
      // Cleared as well as revoked: this component is reused across volumes (a re-sort,
      // the next page of results), and a state variable still holding a revoked URL keeps
      // the <img> branch rendering — a broken-image icon where the new volume's
      // placeholder belongs. Guarded, so a run that has already been superseded cannot
      // wipe the URL its successor just created.
      return () => {
        URL.revokeObjectURL(url);
        if (cloudThumbnailUrl === url) cloudThumbnailUrl = null;
      };
    }

    let cancelled = false;
    void requestCoverOnce(requestedCovers, target, fetchCloudThumbnail, (result) => {
      // A superseded run releases the uuid instead of claiming it, so the live run can
      // ask again — the object URL it would have created has no owner to revoke it.
      if (cancelled) return false;
      cloudThumbnailUrl = URL.createObjectURL(result.file);
      return true;
    });

    return () => {
      cancelled = true;
      if (cloudThumbnailUrl) {
        URL.revokeObjectURL(cloudThumbnailUrl);
        cloudThumbnailUrl = null;
      }
    };
  });
</script>

{#if cloudThumbnailUrl}
  <!-- Cloud thumbnail loaded: render like VolumeItem's local thumbnail -->
  <div class="flex items-center justify-center sm:h-[350px] sm:w-[250px]">
    <img
      src={cloudThumbnailUrl}
      alt={volume?.volume_title || ''}
      style="max-width: 250px; max-height: 350px; width: auto; height: auto;"
      class="border border-gray-300 bg-gray-100 dark:border-gray-900 dark:bg-black"
    />
    {#if showDownloadUI}
      <div class="absolute right-2 bottom-2 rounded-full bg-black/60 p-1.5">
        {#if isDownloading}
          <Spinner size="4" color="blue" />
        {:else}
          <DownloadSolid class="h-4 w-4 text-blue-400" />
        {/if}
      </div>
    {/if}
  </div>
{:else}
  <!-- Placeholder boxes (thumbnail loading or unavailable) -->
  <div
    class="relative overflow-hidden sm:h-[350px] sm:w-[250px]"
    class:sm:h-[385px]={stackCount > 1}
    class:sm:w-[325px]={stackCount > 1}
  >
    {#each Array(stackCount) as _, i}
      <div
        class="flex items-center justify-center bg-gray-200 sm:h-[350px] sm:w-[250px] dark:bg-gray-800"
        class:border={dropShadow}
        class:border-gray-300={dropShadow}
        class:dark:border-gray-600={dropShadow}
        class:absolute={stackCount > 1}
        style={stackCount > 1
          ? `left: ${i * stepH}px; top: ${i * stepV}px; z-index: ${stackCount - i};${dropShadow ? ' filter: drop-shadow(2px 4px 6px rgba(0, 0, 0, 0.5));' : ''}`
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
{/if}
