<script lang="ts">
  import { page } from '$app/stores';
  import { deleteVolume, progress } from '$lib/settings';
  import type { VolumeMetadata } from '$lib/types';
  import { promptConfirmation } from '$lib/util';
  import { Frame, ListgroupItem } from 'flowbite-svelte';
  import { CheckCircleSolid, TrashBinSolid } from 'flowbite-svelte-icons';
  import { goto } from '$app/navigation';
  import { db } from '$lib/catalog/db';

  interface Props {
    volume: VolumeMetadata;
  }

  let { volume }: Props = $props();

  const volName = decodeURI(volume.volume_title);

  let volume_uuid = $derived(volume.volume_uuid);
  let currentPage = $derived($progress?.[volume.volume_uuid || 0] || 1);
  let progressDisplay = $derived(
    `${
      currentPage === volume.page_count - 1 ? currentPage + 1 : currentPage
    } / ${volume.page_count}`
  );
  let isComplete = $derived(
    currentPage === volume.page_count || currentPage === volume.page_count - 1
  );

  async function onDeleteClicked(e: Event) {
    e.stopPropagation();

    promptConfirmation(`Delete ${volName}?`, async () => {
      await db.volumes.where('volume_uuid').equals(volume.volume_uuid).delete();
      await db.volumes_data.where('volume_uuid').equals(volume.volume_uuid).delete();
      deleteVolume(volume.volume_uuid);

      // Check if this was the last volume for this title
      const remainingVolumes = await db.volumes
        .where('series_uuid')
        .equals(volume.series_uuid)
        .count();

      if (remainingVolumes > 0) {
        goto(`/${$page.params.manga}`);
      } else {
        goto('/');
      }
    });
  }
</script>

{#if $page.params.manga}
  <Frame rounded border class="divide-y divide-gray-200 dark:divide-gray-600">
    <ListgroupItem
      on:click={() => goto(`/${$page.params.manga}/${volume_uuid}`)}
      normalClass="py-4"
    >
      {#if volume.thumbnail}
        <img
          src={URL.createObjectURL(volume.thumbnail)}
          alt="img"
          style="margin-right:10px;"
          class="object-contain w-[50px] h-[70px] bg-black border-gray-900 border"
        />
      {/if}
      <div
        class:text-green-400={isComplete}
        class="flex flex-row gap-5 items-center justify-between w-full"
      >
        <div>
          <p class="font-semibold" class:text-white={!isComplete}>{volName}</p>
          <p>{progressDisplay}</p>
        </div>
        <div class="flex gap-2">
          <button onclick={onDeleteClicked} class="flex items-center justify-center">
            <TrashBinSolid class="text-red-400 hover:text-red-500 z-10 poin" />
          </button>
          {#if isComplete}
            <CheckCircleSolid />
          {/if}
        </div>
      </div>
    </ListgroupItem>
  </Frame>
{/if}
