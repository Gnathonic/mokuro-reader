<script lang="ts">
  import { catalog } from '$lib/catalog';
  import { Button, Search, Listgroup } from 'flowbite-svelte';
  import CatalogItem from './CatalogItem.svelte';
  import Loader from './Loader.svelte';
  import { GridOutline, SortOutline, ListOutline } from 'flowbite-svelte-icons';
  import { miscSettings, updateMiscSetting } from '$lib/settings';
  import CatalogListItem from './CatalogListItem.svelte';

  const PAGE_SIZE = 20;
  let currentPage = 0;

  $: totalPages = $catalog ? Math.ceil($catalog.length / PAGE_SIZE) : 0;

  $: sortedCatalog = $catalog
    ?.sort((a, b) => {
      if ($miscSettings.gallerySorting === 'ASC') {
        return a.manga[0].mokuroData.title.localeCompare(b.manga[0].mokuroData.title);
      } else {
        return b.manga[0].mokuroData.title.localeCompare(a.manga[0].mokuroData.title);
      }
    })
    .filter((item) => {
      return item.manga[0].mokuroData.title.toLowerCase().indexOf(search.toLowerCase()) !== -1;
    });

  $: paginatedCatalog = sortedCatalog
    ? sortedCatalog.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
    : [];

  function nextPage() {
    if (currentPage < totalPages - 1) {
      currentPage++;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function prevPage() {
    if (currentPage > 0) {
      currentPage--;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  let search = '';

  function onLayout() {
    if ($miscSettings.galleryLayout === 'list') {
      updateMiscSetting('galleryLayout', 'grid');
    } else {
      updateMiscSetting('galleryLayout', 'list');
    }
  }

  function onOrder() {
    if ($miscSettings.gallerySorting === 'ASC') {
      updateMiscSetting('gallerySorting', 'DESC');
    } else {
      updateMiscSetting('gallerySorting', 'ASC');
    }
  }
</script>

{#if $catalog}
  {#if $catalog.length > 0}
    <div class="flex flex-col gap-5">
      <div class="flex gap-1 py-2">
        <Search bind:value={search} />
        <Button size="sm" color="alternative" on:click={onLayout}>
          {#if $miscSettings.galleryLayout === 'list'}
            <GridOutline />
          {:else}
            <ListOutline />
          {/if}
        </Button>
        <Button size="sm" color="alternative" on:click={onOrder}>
          <SortOutline />
        </Button>
      </div>
      {#if search && sortedCatalog.length === 0}
        <div class="text-center p-20">
          <p>No results found.</p>
        </div>
      {:else}
        <div class="flex sm:flex-row flex-col gap-5 flex-wrap justify-center sm:justify-start">
          {#if $miscSettings.galleryLayout === 'grid'}
            {#each paginatedCatalog as { id } (id)}
              <CatalogItem {id} />
            {/each}
          {:else}
            <Listgroup active class="w-full">
              {#each paginatedCatalog as { id } (id)}
                <CatalogListItem {id} />
              {/each}
            </Listgroup>
          {/if}
          {#if totalPages > 1}
            <div class="flex justify-center gap-2 mt-4 w-full">
              <Button size="sm" disabled={currentPage === 0} on:click={prevPage}>
                Previous
              </Button>
              <span class="py-2">Page {currentPage + 1} of {totalPages}</span>
              <Button size="sm" disabled={currentPage >= totalPages - 1} on:click={nextPage}>
                Next
              </Button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <div class="text-center p-20">
      <p>Your catalog is currently empty.</p>
    </div>
  {/if}
{:else}
  <Loader>Fetching catalog...</Loader>
{/if}
