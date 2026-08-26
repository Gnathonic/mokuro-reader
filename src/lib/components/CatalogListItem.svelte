<script lang="ts">
  import type { VolumeMetadata } from '$lib/types';
  import { ListgroupItem, Spinner } from 'flowbite-svelte';
  // The READING RECORD store (page + `completed` per uuid), aliased because this
  // component's own `volumes` prop is the series' catalog rows.
  import { volumes as readStates } from '$lib/settings';
  import { volumes as catalogVolumes } from '$lib/catalog';
  import { DownloadSolid } from 'flowbite-svelte-icons';
  import { downloadQueue } from '$lib/util/download-queue';
  import { nav } from '$lib/util/hash-router';
  import { promptSeriesEditor } from '$lib/util/modals';
  import { shouldOpenSeriesEditor } from '$lib/util/series-editor-shortcut';
  import { anyModalOpen, shouldTriggerDelete } from '$lib/util/delete-shortcut';
  import { promptSeriesRemoval } from '$lib/catalog/series-delete';
  import { needsDownload } from '$lib/catalog/volume-state';
  import { isSeriesFinished, isVolumeFinished } from '$lib/util/volume-helpers';
  import { createCoverClaims } from '$lib/catalog/cover-claims.svelte';
  import { onDestroy } from 'svelte';
  const CATALOG_SCROLL_Y_KEY = 'mokuro:catalog:scroll-y';

  interface Props {
    volumes: VolumeMetadata[]; // Pre-computed by parent - avoids O(N) re-filtering
    providerName?: string; // Shared across all items - avoids repeated lookups
    displayTitle?: string; // Pre-resolved by the catalog store; falls back to series_title
  }

  let { volumes, providerName = 'Cloud', displayTitle }: Props = $props();

  // Volumes are pre-sorted by catalog store (natural sort)
  let sortedVolumes = $derived(volumes);

  let localVolumes = $derived(sortedVolumes.filter((v) => !v.isPlaceholder));

  // The app's one volume-completion rule (see isVolumeFinished): an inline copy here used
  // to call a never-opened one- or two-page volume finished, so a row could claim a series
  // was read that the grid card in the same catalog said was not. Only picks which cover
  // and title this row shows.
  let firstUnreadVolume = $derived(
    localVolumes.find((v) => !isVolumeFinished(v, $readStates?.[v.volume_uuid]))
  );

  let firstVolume = $derived(sortedVolumes[0]);

  let volume = $derived(firstUnreadVolume ?? firstVolume);
  let liveVolume = $derived(volume ? ($catalogVolumes?.[volume.volume_uuid] ?? volume) : undefined);
  // The app's ONE series-completion rule, over the WHOLE series — the same call the grid
  // card and the smart sort make. Requiring a local row here made "finished" false by
  // construction for a cloud-only series: read history is keyed by uuid in localStorage
  // and outlives (or precedes) any row.
  let isComplete = $derived(isSeriesFinished(sortedVolumes, $readStates));
  // Not one page of this series is on the device — cloud-only placeholders, rows whose
  // files were removed, or both (see $lib/catalog/volume-state).
  let seriesNeedsDownload = $derived(
    sortedVolumes.length > 0 && sortedVolumes.every(needsDownload)
  );

  // Is this series downloading or queued? `getSeriesQueueStatus` knows the semantics
  // (queued vs actively downloading) but is a one-shot read, so the store itself is read
  // here as well: without that dependency this never re-ran and the row's spinner never
  // appeared or cleared.
  let isDownloading = $derived.by(() => {
    if (!volume || !seriesNeedsDownload) return false;
    void $downloadQueue;

    const status = downloadQueue.getSeriesQueueStatus(volume.series_title);
    return status.hasQueued || status.hasDownloading;
  });

  // Create blob URL from inline thumbnail
  let thumbnailUrl = $state<string | undefined>(undefined);
  let thumbnailKey = $state<string | undefined>(undefined);

  function getThumbnailKey(volumeUuid: string, thumbnail?: File): string | undefined {
    if (!thumbnail) return undefined;
    return `${volumeUuid}:${thumbnail.name}:${thumbnail.size}:${thumbnail.lastModified}:${thumbnail.type}`;
  }

  $effect(() => {
    const nextKey = liveVolume
      ? getThumbnailKey(liveVolume.volume_uuid, liveVolume.thumbnail)
      : undefined;
    if (nextKey === thumbnailKey) {
      return;
    }

    if (thumbnailUrl) {
      URL.revokeObjectURL(thumbnailUrl);
      thumbnailUrl = undefined;
    }

    thumbnailKey = nextKey;
    if (!liveVolume?.thumbnail) return;
    thumbnailUrl = URL.createObjectURL(liveVolume.thumbnail);
  });

  onDestroy(() => {
    if (thumbnailUrl) {
      URL.revokeObjectURL(thumbnailUrl);
    }
  });

  /**
   * THIS ROW RESOLVES ITS OWN CLOUD COVER.
   *
   * A cloud-only volume's cover used to arrive on the props: `generatePlaceholders`
   * stamped the cached blob onto every placeholder, and the catalog decorated a
   * metadata-only row's copy the same way. That is what made one cover landing re-derive
   * the whole library and re-render every mounted card (a measured 1,784 ms long task on
   * a 1,027-series library), so covers were cut out of the derivation. This row now does
   * what the grid card does: one keyed `cloud_covers` read for the volume it draws.
   *
   * `liveVolume` — the stored row when there is one — always wins if it carries a
   * `thumbnail`; the resolver is the CLOUD path and nothing else.
   *
   * THE PATH FALLS BACK TO THE PROP, and must. `liveVolume` is
   * `$catalogVolumes[uuid] ?? volume`, and `$catalogVolumes` is the RAW `volumes` store
   * — a STORED row, which never carries `cloudPath` (`materializeSeriesVolumes`, the
   * only writer that mints those rows, writes no cloud fields at all; `catalog-store`'s
   * own test pins it). So the moment a series is opened and its rows materialize, this
   * row's `liveVolume` stops carrying a path while the catalog's LISTING-derived prop
   * still does — and that metadata-only row is exactly the case the deleted placeholder
   * decoration used to paint. Reading only `liveVolume.cloudPath` blanked it for good.
   *
   * The claim/release/paint machinery itself lives in `cover-claims.svelte.ts`, shared
   * with every other cover-drawing surface.
   */
  let coverPath = $derived(liveVolume?.cloudPath ?? volume?.cloudPath);

  // No `targets`: this row has never ASKED for a cover, it only paints one already in
  // `cloud_covers`. Left as it was — making the list layout a fetch trigger is a
  // behaviour change, not a refactor.
  const coverClaims = createCoverClaims({
    claims: () => (liveVolume ? [{ ...liveVolume, cloudPath: coverPath }] : [])
  });

  /** Row cover first, resolver cover second. */
  let displayUrl = $derived(thumbnailUrl ?? coverClaims.cover?.url);

  // Use series title for navigation so grouping and routing align with user-visible identity.
  let navId = $derived(volume?.series_title || '');

  function persistCatalogScrollPosition() {
    const y = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    sessionStorage.setItem(CATALOG_SCROLL_Y_KEY, String(y));
  }

  async function handleClick(e: MouseEvent) {
    e.preventDefault();
    persistCatalogScrollPosition();
    nav.toSeries(navId);
  }

  // Hover + "e" opens the series editor for this card (mirrors CatalogItem / VolumeItem).
  let isHovered = $state(false);

  function handleKeydown(e: KeyboardEvent) {
    if (shouldOpenSeriesEditor(e, isHovered, document.activeElement)) {
      e.preventDefault();
      if (volume) promptSeriesEditor(volume.series_title);
      return;
    }
    // Hover + Delete raises the series page's own "Remove manga" dialog (see CatalogItem).
    if (!e.shiftKey && shouldTriggerDelete(e, isHovered, document.activeElement, anyModalOpen())) {
      e.preventDefault();
      void promptSeriesRemoval(sortedVolumes);
    }
  }

  $effect(() => {
    if (!isHovered) return;
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });
</script>

{#if volume}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class:opacity-70={seriesNeedsDownload}
    onmouseenter={() => (isHovered = true)}
    onmouseleave={() => (isHovered = false)}
  >
    <ListgroupItem>
      <a href="#/series/{encodeURIComponent(navId)}" class="h-full w-full" onclick={handleClick}>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <!-- Muted while the series is not here; green still means "finished". -->
            <p
              class:text-green-400={isComplete}
              class:text-gray-400={seriesNeedsDownload && !isComplete}
              class="font-semibold"
            >
              {displayTitle ?? volume.series_title}
            </p>
            {#if seriesNeedsDownload}
              <span class="text-xs text-blue-400">In {providerName}</span>
            {/if}
          </div>
          <!-- Wrapper exists only to anchor the badge; the cover keeps its own box. -->
          <div class="relative flex-shrink-0">
            <!-- The cover comes first whichever kind of series this is: a removed row and
                 an indexed placeholder can both have one, and that is the enriched half.
                 Only with nothing to show does an absent series fall back to the icon. -->
            {#if isDownloading}
              <div class="flex h-[70px] w-[50px] items-center justify-center">
                <Spinner size="12" color="blue" />
              </div>
            {:else if displayUrl}
              <img
                src={displayUrl}
                alt="img"
                class="h-[70px] w-[50px] border border-gray-300 bg-gray-100 object-contain dark:border-gray-900 dark:bg-black"
              />
            {:else if seriesNeedsDownload}
              <div class="flex h-[70px] w-[50px] items-center justify-center">
                <DownloadSolid class="h-[70px] w-[50px] text-blue-400" />
              </div>
            {:else}
              <div
                class="flex h-[70px] w-[50px] items-center justify-center border border-gray-300 bg-gray-200 text-[10px] text-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400"
              >
                Cover
              </div>
            {/if}
            <!-- No corner badge here either (see CatalogItem): an absent series is marked
                 the way cloud series have always been marked in this list — the dimming,
                 the "In <provider>" chip, and the download glyph where no cover exists. -->
          </div>
        </div>
      </a>
    </ListgroupItem>
  </div>
{/if}
