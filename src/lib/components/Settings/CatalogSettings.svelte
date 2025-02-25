<script lang="ts">
  import { AccordionItem, Button } from 'flowbite-svelte';
  import { db } from '$lib/catalog/db';
  import { promptConfirmation } from '$lib/util';
  import { goto } from '$app/navigation';
  import { clearVolumes } from '$lib/settings';
  import { currentVolume } from '$lib/catalog';
  import { generateThumbnail } from '$lib/catalog/thumbnails';

  function onConfirm() {
    clearVolumes();
    db.volumes_data.clear();
    db.volumes.clear();
  }

  function onClear() {
    promptConfirmation('Are you sure you want to clear your catalog?', onConfirm);
    goto('/');
  }

  export let currentPage: File | undefined;

  async function onSetThumbnail() {
    if (currentPage && $currentVolume) {
      promptConfirmation('Set this page as volume thumbnail?', async () => {
        try {
          const thumbnail = await generateThumbnail(currentPage);
          await db.volumes.where('volume_uuid').equals($currentVolume.volume_uuid).modify({ thumbnail });
        } catch (error) {
          console.error('Failed to update thumbnail for volume:', $currentVolume.volume_uuid, error);
        }
      });
    }
  }
</script>

<AccordionItem>
  <span slot="header">Catalog settings</span>
  <div class="flex flex-col gap-2">
    <Button on:click={onSetThumbnail} outline color="blue" disabled={!currentPage || !$currentVolume}>
      Set current page as volume thumbnail
    </Button>
    <Button on:click={onClear} outline color="red">Clear catalog</Button>
  </div>
</AccordionItem>
