<script lang="ts">
  import type { VolumeMetadata } from '$lib/types';
  import { Spinner } from 'flowbite-svelte';
  import { DownloadSolid } from 'flowbite-svelte-icons';
  import { isCoverFetchTarget, requestCover } from '$lib/catalog/cover-service';

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

  // Cloud thumbnail state — an object URL over `volume.thumbnail`, kept in sync with it.
  // Delivery of a fetched cover is the DB write itself (`cover-service.ts`): once a cover
  // lands, the catalog re-derives and this component's OWN `volume` prop arrives with
  // `thumbnail` already on it, from the parent. This effect only manages the object URL's
  // lifecycle (create/revoke), never the fetch.
  let cloudThumbnailUrl: string | null = $state(null);

  // A CATALOG-WIDE re-derive (any row anywhere committing) hands every mounted card a
  // BRAND NEW `volume` object, even for a row whose own cover has not changed — Dexie
  // gives back a fresh `File` instance per read regardless. Without this key, the effect
  // below would treat every re-derive as "a new cover", tearing down and recreating the
  // object URL (and forcing the browser to re-decode/re-paint the `<img>`) for every
  // already-painted card on screen, every time. `size`+`lastModified` is cheap to compare
  // and, unlike object identity, survives a structured-clone round trip through IndexedDB
  // unchanged — a GENUINELY new cover (a fresh fetch, a self-heal overwrite) always gets a
  // new `lastModified` (see `cloud-thumbnails.ts`), so this never masks a real update.
  let renderedCoverKey: string | null = null;
  let activeThumbnailUrl: string | null = null; // mirrors `cloudThumbnailUrl`; read/written outside reactivity so comparing it never itself triggers a re-run.

  function releaseActiveThumbnailUrl(): void {
    if (activeThumbnailUrl) {
      URL.revokeObjectURL(activeThumbnailUrl);
      activeThumbnailUrl = null;
    }
  }

  $effect(() => {
    const file = volume?.thumbnail;
    const uuid = volume?.volume_uuid;
    const key = file && uuid ? `${uuid}:${file.size}:${file.lastModified}` : null;
    if (key === renderedCoverKey) return; // Same cover as already rendered — nothing to do.
    renderedCoverKey = key;

    releaseActiveThumbnailUrl();
    if (!file) {
      cloudThumbnailUrl = null;
      return;
    }
    const url = URL.createObjectURL(file);
    activeThumbnailUrl = url;
    cloudThumbnailUrl = url;
  });

  // Revoke whatever is active when this component is torn down. Deliberately a SEPARATE
  // effect with no reactive reads of its own (so it runs its body once, on mount, and its
  // cleanup only on unmount) — folding this into the effect above would tie revocation to
  // Svelte's automatic "run the previous cleanup before every re-run" behavior, which fires
  // on EVERY re-run regardless of the early return above and would revoke a URL this
  // component is still actively showing.
  $effect(() => {
    return () => releaseActiveThumbnailUrl();
  });

  // Ask for the cover once, whatever this box currently shows. `requestCover` is
  // idempotent and fire-and-forget — the service's own dedupe makes a redundant call on
  // every re-run of this effect free.
  $effect(() => {
    if (volume && isCoverFetchTarget(volume)) requestCover(volume);
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
