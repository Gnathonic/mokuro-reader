<script lang="ts">
  import { catalog } from '$lib/catalog';
  import { Button, Search, Listgroup } from 'flowbite-svelte';
  import CatalogItem from './CatalogItem.svelte';
  import Loader from './Loader.svelte';
  import { GridOutline, SortOutline, ListOutline } from 'flowbite-svelte-icons';
  import { miscSettings, updateMiscSetting, volumes } from '$lib/settings';
  import CatalogListItem from './CatalogListItem.svelte';
  import { isUpgrading } from '$lib/catalog/db';


  let search = $state('');

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
  let sortedCatalog = $derived($catalog.sort((a, b) => {
      if ($miscSettings.gallerySorting === 'ASC') {
        return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
      } else if ($miscSettings.gallerySorting === 'DESC') {
        return b.title.localeCompare(a.title, undefined, { numeric: true, sensitivity: 'base' });
      } else {
        // SMART sorting
        // Check if series are completed
        const aVolumes = a.volumes.map(vol => vol.volume_uuid);
        const bVolumes = b.volumes.map(vol => vol.volume_uuid);
        
        const aCompleted = aVolumes.every(volId => $volumes[volId]?.completed);
        const bCompleted = bVolumes.every(volId => $volumes[volId]?.completed);
        
        // If completion status differs, completed series go to the end
        if (aCompleted !== bCompleted) {
          return aCompleted ? 1 : -1;
        }
        
        // If both have the same completion status, sort by last updated date
        const aLastUpdated = Math.max(...aVolumes.map(volId => 
          new Date($volumes[volId]?.lastProgressUpdate || 0).getTime()
        ));
        const bLastUpdated = Math.max(...bVolumes.map(volId => 
          new Date($volumes[volId]?.lastProgressUpdate || 0).getTime()
        ));
        
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
    }));
</script>

{#if $catalog}
  {#if $catalog.length > 0}
    <div class="flex flex-col gap-5">
      <div class="flex gap-1 py-2 w-full">
        <div class="flex-grow">
          <Search bind:value={search} class="w-full" />
        </div>
        <Button size="sm" color="alternative" on:click={onLayout} class="min-w-10 h-10 flex items-center justify-center">
          {#if $miscSettings.galleryLayout === 'list'}
            <GridOutline class="w-5 h-5" />
          {:else}
            <ListOutline class="w-5 h-5" />
          {/if}
        </Button>
        <Button size="sm" color="alternative" on:click={onOrder} class="min-w-10 h-10 flex items-center justify-center">
          <SortOutline class="w-5 h-5" />
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
        <div class="text-center p-20">
          <p>No results found.</p>
        </div>
      {:else}
        <div class="flex sm:flex-row flex-col gap-5 flex-wrap justify-center sm:justify-start">
          {#if $miscSettings.galleryLayout === 'grid'}
            {#each sortedCatalog as { series_uuid } (series_uuid)}
              <CatalogItem {series_uuid} />
            {/each}
          {:else}
            <Listgroup active class="w-full">
              {#each sortedCatalog as { series_uuid } (series_uuid)}
                <CatalogListItem {series_uuid} />
              {/each}
            </Listgroup>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <div class="text-center p-20">
      {#if $isUpgrading}
        <p>Upgrading and optimizing manga catalog... Please wait.</p>
      {:else}
        <p>Your catalog is currently empty.</p>
      {/if}
    </div>
  {/if}
{:else}
  <Loader>Fetching catalog...</Loader>
{/if}
