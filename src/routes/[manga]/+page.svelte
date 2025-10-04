<script lang="ts">
  import { catalog } from '$lib/catalog';
  import { goto } from '$app/navigation';
  import VolumeItem from '$lib/components/VolumeItem.svelte';
  import { Button, Listgroup } from 'flowbite-svelte';
  import { db } from '$lib/catalog/db';
  import { promptConfirmation, zipManga } from '$lib/util';
  import { promptExtraction } from '$lib/util/modals';
  import { page } from '$app/stores';
  import type { VolumeMetadata } from '$lib/types';
  import { deleteVolume, mangaStats } from '$lib/settings';

  function sortManga(a: VolumeMetadata, b: VolumeMetadata) {
    return a.volume_title.localeCompare(b.volume_title, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  }

  let manga = $derived(
    $catalog?.find((item) => item.series_uuid === $page.params.manga)?.volumes.sort(sortManga)
  );

  let loading = $state(false);

  async function confirmDelete(deleteStats = false) {
    const seriesUuid = manga?.[0].series_uuid;
    if (seriesUuid) {
      manga?.forEach((vol) => {
        const volId = vol.volume_uuid;
        db.volumes_data.where('volume_uuid').equals(vol.volume_uuid).delete();
        db.volumes.where('volume_uuid').equals(vol.volume_uuid).delete();
        
        // Only delete stats and progress if the checkbox is checked
        if (deleteStats) {
          deleteVolume(volId);
        }
      });
      goto('/');
    }
  }

  function onDelete() {
    promptConfirmation(
      'Are you sure you want to delete this manga?', 
      confirmDelete, 
      undefined, 
      {
        label: "Also delete stats and progress?",
        storageKey: "deleteStatsPreference",
        defaultValue: false
      }
    );
  }

  async function onExtract() {
    if (manga && manga.length > 0) {
      const firstVolume = {
        series_title: manga[0].series_title,
        volume_title: manga[0].volume_title
      };

      promptExtraction(firstVolume, async (asCbz, individualVolumes, includeSeriesTitle) => {
        loading = true;
        loading = await zipManga(manga, asCbz, individualVolumes, includeSeriesTitle);
      });
    }
  }
</script>

<svelte:head>
  <title>{manga?.[0].series_title || 'Manga'}</title>
</svelte:head>
{#if manga && $mangaStats}
  <div class="p-2 flex flex-col gap-5">
    <div class="flex flex-row justify-between">
      <div class="flex flex-col gap-2">
        <h3 class="font-bold">{manga[0].series_title}</h3>
        <div class="flex flex-col gap-0 sm:flex-row sm:gap-5">
          <p>Volumes: {$mangaStats.completed} / {manga.length}</p>
          <p>Characters read: {$mangaStats.chars}</p>
          <p>Minutes read: {$mangaStats.timeReadInMinutes}</p>
        </div>
      </div>
      <div class="sm:block flex-col flex gap-2">
        <Button color="alternative" on:click={onDelete}>Remove manga</Button>
        <Button color="light" on:click={onExtract} disabled={loading}>
          {loading ? 'Extracting...' : 'Extract manga'}
        </Button>
      </div>
    </div>
    <Listgroup active class="flex-1 h-full w-full">
      {#each manga as volume (volume.volume_uuid)}
        <VolumeItem {volume} />
      {/each}
    </Listgroup>
  </div>
{:else}
  <div class="flex justify-center p-16">Manga not found</div>
{/if}
