<script lang="ts">
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
  import CatalogListItem from './CatalogListItem.svelte';
  import { isUpgrading } from '$lib/catalog/db';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import { queueSeriesVolumes } from '$lib/util/download-queue';
  import { getCloudProvider } from '$lib/util/cloud-fields';
  import { showSnackbar } from '$lib/util';
  import type { ProviderType } from '$lib/util/sync/provider-interface';

  let search = $state('');

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
          return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
        } else if ($miscSettings.gallerySorting === 'DESC') {
          return b.title.localeCompare(a.title, undefined, { numeric: true, sensitivity: 'base' });
        } else {
          // SMART sorting
          // Check if series are completed
          const aVolumes = a.volumes.map((vol) => vol.volume_uuid);
          const bVolumes = b.volumes.map((vol) => vol.volume_uuid);

          const aCompleted = aVolumes.every((volId) => volumesSnapshot[volId]?.completed);
          const bCompleted = bVolumes.every((volId) => volumesSnapshot[volId]?.completed);

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

          // If all else is equal, use natural sorting on title
          return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
        }
      })
      .filter((item) => {
        return item.title.toLowerCase().indexOf(search.toLowerCase()) !== -1;
      });
  });

  // Separate local series from placeholder-only series
  let localSeries = $derived(
    sortedCatalog.filter((series) => series.volumes.some((vol) => !vol.isPlaceholder))
  );

  let placeholderSeries = $derived(
    sortedCatalog.filter((series) => series.volumes.every((vol) => vol.isPlaceholder))
  );

  // Collect all placeholder volumes from the entire catalog
  let allPlaceholderVolumes = $derived(
    sortedCatalog.flatMap((series) => series.volumes.filter((vol) => vol.isPlaceholder))
  );

  // Count placeholders by provider for UI display
  let placeholdersByProvider = $derived.by(() => {
    const counts: Record<string, number> = {};
    for (const vol of allPlaceholderVolumes) {
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
      webdav: 'WebDAV'
    };
    return Object.entries(placeholdersByProvider)
      .map(([provider, count]) => `${count} ${providerNames[provider] || provider}`)
      .join(' • ');
  });

  async function downloadAllPlaceholders() {
    if (!allPlaceholderVolumes || allPlaceholderVolumes.length === 0) return;
    if (!hasAuthenticatedProvider) {
      showSnackbar('Please connect to a cloud storage provider first');
      return;
    }

    try {
      queueSeriesVolumes(allPlaceholderVolumes);
    } catch (error) {
      console.error('Failed to queue placeholders for download:', error);
    }
  }
</script>

{#if $catalog === null}
  <Loader>Loading catalog...</Loader>
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
      <div class="flex flex-col flex-wrap justify-center gap-[3px] sm:flex-row sm:justify-start">
        {#if $miscSettings.galleryLayout === 'grid'}
          {#each localSeries as { series_uuid } (series_uuid)}
            <CatalogItem {series_uuid} />
          {/each}
        {:else}
          <Listgroup active class="w-full">
            {#each localSeries as { series_uuid } (series_uuid)}
              <CatalogListItem {series_uuid} />
            {/each}
          </Listgroup>
        {/if}
      </div>

      <!-- Placeholder series (Cloud providers) -->
      {#if placeholderSeries && placeholderSeries.length > 0}
        <div class="mt-8">
          <div class="mb-4 flex items-center justify-between px-4">
            <div>
              <h4 class="text-lg font-semibold text-gray-400">
                Available in {providerDisplayName} ({placeholderSeries.length} series)
              </h4>
              {#if providerBreakdown}
                <p class="mt-1 text-sm text-gray-500">{providerBreakdown}</p>
              {/if}
            </div>
            {#if hasAuthenticatedProvider && allPlaceholderVolumes.length > 0}
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
              {#each placeholderSeries as { series_uuid } (series_uuid)}
                <CatalogItem {series_uuid} />
              {/each}
            {:else}
              <Listgroup active class="w-full">
                {#each placeholderSeries as { series_uuid } (series_uuid)}
                  <CatalogListItem {series_uuid} />
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
