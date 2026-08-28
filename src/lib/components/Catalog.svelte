<script module lang="ts">
  /**
   * How long "Loading catalog..." may sit before it explains itself. The
   * first catalog read normally lands within one coalesce window (~150ms);
   * five seconds of silence means IndexedDB is not answering at all.
   *
   * Diagnosed live (2026-08-27, 819-volume library): Chrome's storage
   * backend (the browser-wide StorageService) wedged with readwrite
   * transactions on `volumes`/`cloud_covers` grinding for HOURS — one took
   * ~2.5h to commit 2 rows — right after a bulk download pushed the origin
   * to 110GB of its 120GB quota. Once wedged, every boot's own queued
   * writes pile on behind it, so reloading the page does NOT clear it (the
   * aborts themselves crawl); restarting the whole browser does (fresh
   * StorageService). No page can observe or fix that state from the inside —
   * a queued read simply never returns — so past this deadline the loader
   * says what is known and what actually helps, including live quota
   * pressure when `navigator.storage.estimate()` can report it.
   */
  export const CATALOG_LOAD_STALL_MS = 5000;
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { catalog } from '$lib/catalog';
  import { Button, Listgroup, Search } from 'flowbite-svelte';
  import CatalogItem from './CatalogItem.svelte';
  import Loader from './Loader.svelte';
  import {
    GridOutline,
    ListOutline,
    SortOutline,
    DownloadSolid,
    UploadSolid
  } from 'flowbite-svelte-icons';
  import { miscSettings, updateMiscSetting, volumes } from '$lib/settings';
  import { partitionCatalogSeries } from '$lib/catalog/catalog';
  import CatalogListItem from './CatalogListItem.svelte';
  import { isUpgrading } from '$lib/catalog/db';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import { queueSeriesVolumes } from '$lib/util/download-queue';
  import { getCloudFileId, getCloudProvider } from '$lib/util/cloud-fields';
  import { needsDownload } from '$lib/catalog/volume-state';
  import { isSeriesFinished } from '$lib/util/volume-helpers';
  import { showSnackbar } from '$lib/util';
  import type { ProviderType } from '$lib/util/sync/provider-interface';

  const CATALOG_SCROLL_Y_KEY = 'mokuro:catalog:scroll-y';

  let search = $state('');
  /** True once the loading spinner has outlived {@link CATALOG_LOAD_STALL_MS}. */
  let loadStalled = $state(false);
  /** "110 of 120 GB" when the origin is under storage-quota pressure, else null. */
  let quotaPressure = $state<string | null>(null);
  let pendingRestoreY = $state<number | null>(null);
  let restoringScroll = $state(false);
  let restoreAttempts = $state(0);
  let restoreRaf: number | null = null;

  function getScrollingElement(): HTMLElement {
    return (document.scrollingElement as HTMLElement) || document.documentElement || document.body;
  }

  function getScrollY(): number {
    const scroller = getScrollingElement();
    return (
      window.scrollY ||
      scroller.scrollTop ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0
    );
  }

  function getMaxScrollY(): number {
    const scroller = getScrollingElement();
    const scrollerMax = scroller.scrollHeight - scroller.clientHeight;
    const docMax = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    const bodyMax = document.body.scrollHeight - document.body.clientHeight;
    return Math.max(0, scrollerMax, docMax, bodyMax);
  }

  function setScrollY(y: number) {
    window.scrollTo(0, y);
    const scroller = getScrollingElement();
    if (scroller.scrollTop !== y) {
      scroller.scrollTop = y;
    }
  }

  function persistCatalogScrollPosition() {
    try {
      sessionStorage.setItem(CATALOG_SCROLL_Y_KEY, String(getScrollY()));
    } catch (error) {
      console.debug('Failed to persist catalog scroll position:', error);
    }
  }

  function loadPendingCatalogScrollPosition() {
    try {
      const saved = sessionStorage.getItem(CATALOG_SCROLL_Y_KEY);
      if (!saved) return;

      const y = Number(saved);
      if (!Number.isFinite(y) || y < 0) return;
      pendingRestoreY = y;
    } catch (error) {
      console.debug('Failed to restore catalog scroll position:', error);
    }
  }

  function stopRestoreLoop() {
    restoringScroll = false;
    restoreAttempts = 0;
    if (restoreRaf !== null) {
      cancelAnimationFrame(restoreRaf);
      restoreRaf = null;
    }
  }

  function restoreCatalogScrollStep() {
    if (pendingRestoreY === null) {
      stopRestoreLoop();
      return;
    }

    const maxY = getMaxScrollY();
    const targetY = Math.min(pendingRestoreY, maxY);
    setScrollY(targetY);

    const reachedTarget = Math.abs(getScrollY() - targetY) <= 2;
    const enoughHeight = maxY >= pendingRestoreY - 2;

    restoreAttempts += 1;
    if ((reachedTarget && enoughHeight) || restoreAttempts >= 240) {
      pendingRestoreY = null;
      stopRestoreLoop();
      return;
    }

    restoreRaf = requestAnimationFrame(restoreCatalogScrollStep);
  }

  function startRestoreLoop() {
    if (pendingRestoreY === null || restoringScroll) return;
    restoringScroll = true;
    restoreAttempts = 0;
    restoreRaf = requestAnimationFrame(restoreCatalogScrollStep);
  }

  onMount(() => {
    loadPendingCatalogScrollPosition();
    startRestoreLoop();

    const onScroll = () => {
      persistCatalogScrollPosition();
    };

    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      stopRestoreLoop();
      window.removeEventListener('scroll', onScroll);
    };
  });

  // Check if any cloud provider is authenticated
  let hasAuthenticatedProvider = $derived(unifiedCloudManager.getDefaultProvider() !== null);

  // Get active provider's display name
  let providerDisplayName = $derived.by(() => {
    const provider = unifiedCloudManager.getActiveProvider();
    return provider?.name || 'cloud storage';
  });

  function onLayout() {
    if ($miscSettings.galleryLayout === 'list') {
      updateMiscSetting('galleryLayout', 'grid');
    } else {
      updateMiscSetting('galleryLayout', 'list');
    }
  }

  function onOrder() {
    if ($miscSettings.gallerySorting === 'SMART') {
      updateMiscSetting('gallerySorting', 'ASC');
    } else if ($miscSettings.gallerySorting === 'ASC') {
      updateMiscSetting('gallerySorting', 'DESC');
    } else {
      updateMiscSetting('gallerySorting', 'SMART');
    }
  }
  let sortedCatalog = $derived.by(() => {
    if ($catalog === null) return [];

    // Snapshot volumes state before sorting to prevent race conditions.
    // Reading $volumes inside the sort comparator can cause deadlocks if the
    // store updates mid-sort, violating the comparator's transitivity requirement.
    const volumesSnapshot = $volumes;

    return [...$catalog]
      .sort((a, b) => {
        if ($miscSettings.gallerySorting === 'ASC') {
          return a.displayTitle.localeCompare(b.displayTitle, undefined, {
            numeric: true,
            sensitivity: 'base'
          });
        } else if ($miscSettings.gallerySorting === 'DESC') {
          return b.displayTitle.localeCompare(a.displayTitle, undefined, {
            numeric: true,
            sensitivity: 'base'
          });
        } else {
          // SMART sorting
          // Check if series are completed — through the app's ONE series-completion rule,
          // the same call the cards colour themselves by (`$lib/util/volume-helpers`).
          // This used to read the stored `completed` flag alone, which the card did not,
          // so a finished series could sort to the bottom and never turn green.
          const aVolumes = a.volumes.map((vol) => vol.volume_uuid);
          const bVolumes = b.volumes.map((vol) => vol.volume_uuid);

          const aCompleted = isSeriesFinished(a.volumes, volumesSnapshot);
          const bCompleted = isSeriesFinished(b.volumes, volumesSnapshot);

          // If completion status differs, completed series go to the end
          if (aCompleted !== bCompleted) {
            return aCompleted ? 1 : -1;
          }

          // If both have the same completion status, sort by last updated date
          // Only consider volumes with actual progress (page > 1)
          const aLastUpdated = Math.max(
            ...aVolumes
              .filter((volId) => (volumesSnapshot[volId]?.progress || 0) > 1)
              .map((volId) => new Date(volumesSnapshot[volId]?.lastProgressUpdate || 0).getTime()),
            0 // Default to 0 if no volumes have progress
          );
          const bLastUpdated = Math.max(
            ...bVolumes
              .filter((volId) => (volumesSnapshot[volId]?.progress || 0) > 1)
              .map((volId) => new Date(volumesSnapshot[volId]?.lastProgressUpdate || 0).getTime()),
            0 // Default to 0 if no volumes have progress
          );

          if (aLastUpdated !== bLastUpdated) {
            // Most recently read first
            return bLastUpdated - aLastUpdated;
          }

          // If all else is equal, use natural sorting on display title
          return a.displayTitle.localeCompare(b.displayTitle, undefined, {
            numeric: true,
            sensitivity: 'base'
          });
        }
      })
      .filter((item) => {
        const query = search.trim().toLowerCase();
        if (!query) return true;
        // Matches folder title, AniList titles, synonyms, tag and the display title
        return item.searchTerms.some((term) => term.includes(query));
      });
  });

  // The three regions, decided in ONE pass over the sorted catalog (never per card).
  // Series with nothing readable here always render in their own cloud section.
  let sections = $derived(partitionCatalogSeries(sortedCatalog));
  let localSeries = $derived(sections.localSeries);
  let placeholderSeries = $derived(sections.cloudSeries);

  // Everything "Download all" fetches: every volume in the LIBRARY that is not on this
  // device and has a cloud file to pull from — cloud-only placeholders and metadata-only
  // rows alike, wherever their series card is currently filed. The button has always meant
  // "get all the ones I don't have"; scoping it to the cloud section's own series dropped
  // both the removed rows and the cloud volumes of a partly-downloaded series.
  // Same rule as the series page's "Download all" (needsDownload + a cloud file id).
  let downloadableVolumes = $derived(
    sortedCatalog.flatMap((series) =>
      series.volumes.filter((vol) => needsDownload(vol) && !!getCloudFileId(vol))
    )
  );

  // Provider breakdown OF THAT SET, so the line above the button counts what the button
  // will actually queue.
  let placeholdersByProvider = $derived.by(() => {
    const counts: Record<string, number> = {};
    for (const vol of downloadableVolumes) {
      const provider = getCloudProvider(vol) || 'unknown';
      counts[provider] = (counts[provider] || 0) + 1;
    }
    return counts;
  });

  // Format provider breakdown for display (e.g., "3 Drive • 2 MEGA")
  let providerBreakdown = $derived.by(() => {
    const providerNames: Record<string, string> = {
      'google-drive': 'Drive',
      mega: 'MEGA',
      webdav: 'WebDAV',
      filesystem: 'Local Folder',
      onedrive: 'OneDrive'
    };
    return Object.entries(placeholdersByProvider)
      .map(([provider, count]) => `${count} ${providerNames[provider] || provider}`)
      .join(' • ');
  });

  $effect(() => {
    // Re-attempt restoration as catalog data/layout changes while loading.
    sortedCatalog.length;
    $miscSettings.galleryLayout;
    $miscSettings.gallerySorting;
    startRestoreLoop();
  });

  $effect(() => {
    // Stall watch for the loading spinner: armed while the catalog is still
    // null, cleared the moment data lands (including data that arrives AFTER
    // the stall message showed — the queued read completes as soon as the
    // blocked database frees up, and the message must not outlive the
    // condition it describes).
    if ($catalog !== null) {
      loadStalled = false;
      // The quota line must reset with the stall it described: a later,
      // unrelated stall in this same tab must re-measure, not replay the
      // reading from a previous incident (quota may have been freed since).
      quotaPressure = null;
      return;
    }
    const stallTimer = setTimeout(() => {
      loadStalled = true;
      // Best-effort context for the stall message: quota pressure is the one
      // condition this failure was actually observed under. The estimate call
      // does not touch IndexedDB, so it answers even while the database hangs.
      void navigator.storage
        ?.estimate?.()
        .then(({ usage, quota }) => {
          if (!usage || !quota) return;
          if (usage / quota >= 0.85) {
            quotaPressure = `${Math.round(usage / 1e9)} of ${Math.round(quota / 1e9)} GB`;
          }
        })
        .catch(() => {});
    }, CATALOG_LOAD_STALL_MS);
    return () => clearTimeout(stallTimer);
  });

  async function downloadAllPlaceholders() {
    if (downloadableVolumes.length === 0) return;
    if (!hasAuthenticatedProvider) {
      showSnackbar('Please connect to a cloud storage provider first');
      return;
    }

    try {
      queueSeriesVolumes(downloadableVolumes);
    } catch (error) {
      console.error('Failed to queue placeholders for download:', error);
    }
  }
</script>

{#if $catalog === null}
  <Loader>
    {#if loadStalled}
      <div class="max-w-md text-center" data-testid="catalog-load-stalled">
        <p>Still loading the catalog...</p>
        <p class="mt-2 text-sm text-gray-500">
          The browser's storage system is not responding, so the catalog's first read is stuck in
          its queue. Fully restarting the browser (all windows) is the reliable fix — reloading just
          this page usually is not enough.
        </p>
        {#if quotaPressure}
          <p class="mt-2 text-sm text-gray-500" data-testid="catalog-quota-pressure">
            This site's browser storage is nearly full ({quotaPressure} used). Storage stalls tend to
            happen under that pressure — removing some downloaded volumes makes them less likely.
          </p>
        {/if}
      </div>
    {:else}
      Loading catalog...
    {/if}
  </Loader>
{:else if $catalog.length > 0}
  <div class="flex flex-col gap-5">
    <div class="flex w-full gap-1 py-2">
      <div class="flex-grow">
        <Search bind:value={search} class="w-full [&>div>input]:h-10" size="md" />
      </div>
      <Button
        size="sm"
        color="alternative"
        onclick={onLayout}
        class="flex h-10 min-w-10 items-center justify-center"
      >
        {#if $miscSettings.galleryLayout === 'list'}
          <GridOutline class="h-5 w-5" />
        {:else}
          <ListOutline class="h-5 w-5" />
        {/if}
      </Button>
      <Button
        size="sm"
        color="alternative"
        onclick={onOrder}
        class="flex h-10 min-w-10 items-center justify-center"
      >
        <SortOutline class="h-5 w-5" />
        <span class="ml-1 text-xs">
          {#if $miscSettings.gallerySorting === 'ASC'}
            A-Z
          {:else if $miscSettings.gallerySorting === 'DESC'}
            Z-A
          {:else}
            Smart
          {/if}
        </span>
      </Button>
    </div>
    {#if search && sortedCatalog.length === 0}
      <div class="p-20 text-center">
        <p>No results found.</p>
      </div>
    {:else}
      <!-- Local series -->
      <div
        data-testid="catalog-library"
        class="flex flex-col flex-wrap justify-center gap-[3px] sm:flex-row sm:justify-start"
      >
        {#if $miscSettings.galleryLayout === 'grid'}
          {#each localSeries as { title, displayTitle, volumes } (title)}
            <CatalogItem {volumes} {displayTitle} providerName={providerDisplayName} />
          {/each}
        {:else}
          <Listgroup active class="w-full">
            {#each localSeries as { title, displayTitle, volumes } (title)}
              <CatalogListItem {volumes} {displayTitle} providerName={providerDisplayName} />
            {/each}
          </Listgroup>
        {/if}
      </div>

      <!-- Placeholder series (Cloud providers) -->
      {#if placeholderSeries && placeholderSeries.length > 0}
        <div class="mt-8" data-testid="catalog-cloud">
          <div class="mb-4 flex items-center justify-between px-4">
            <div>
              <!-- Keyed: counts are exactly the text Migaku rewrites and then holds
                   stale, and these two change under the display setting (see CLAUDE.md). -->
              <h4 class="text-lg font-semibold text-gray-400">
                Available in {providerDisplayName}
                {#key placeholderSeries.length}<span>({placeholderSeries.length} series)</span
                  >{/key}
              </h4>
              {#if providerBreakdown}
                {#key providerBreakdown}
                  <p class="mt-1 text-sm text-gray-500">{providerBreakdown}</p>
                {/key}
              {/if}
            </div>
            {#if hasAuthenticatedProvider && downloadableVolumes.length > 0}
              <Button size="sm" color="blue" onclick={downloadAllPlaceholders}>
                <DownloadSolid class="me-1 h-3 w-3" />
                Download all
              </Button>
            {/if}
          </div>
          <div
            class="flex flex-col flex-wrap justify-center gap-[3px] sm:flex-row sm:justify-start"
          >
            {#if $miscSettings.galleryLayout === 'grid'}
              {#each placeholderSeries as { title, displayTitle, volumes } (title)}
                <CatalogItem {volumes} {displayTitle} providerName={providerDisplayName} />
              {/each}
            {:else}
              <Listgroup active class="w-full">
                {#each placeholderSeries as { title, displayTitle, volumes } (title)}
                  <CatalogListItem {volumes} {displayTitle} providerName={providerDisplayName} />
                {/each}
              </Listgroup>
            {/if}
          </div>
        </div>
      {/if}
    {/if}
  </div>
{:else}
  <div class="p-20 text-center">
    {#if $isUpgrading}
      <p>Upgrading and optimizing manga catalog... Please wait.</p>
    {:else}
      <p>Your catalog is currently empty.</p>
      <p class="text-sm text-gray-500">
        To add manga, click the <UploadSolid class="inline h-4 w-4" /> button in the top right.
      </p>
    {/if}
  </div>
{/if}
