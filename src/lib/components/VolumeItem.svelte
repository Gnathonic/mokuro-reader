<script lang="ts">
  import { page } from '$app/stores';
  import { deleteVolume, progress } from '$lib/settings';
  import type { Volume } from '$lib/types';
  import { promptConfirmation } from '$lib/util';
  import { ListgroupItem, Frame } from 'flowbite-svelte';
  import { CheckCircleSolid, TrashBinSolid } from 'flowbite-svelte-icons';
  import { goto } from '$app/navigation';
  import { db } from '$lib/catalog/db';

  export let volume: Volume;

  const { volumeName, mokuroData } = volume as Volume;
  const { title_uuid, volume_uuid } = mokuroData;
  const volName = decodeURI(volumeName);

  $: currentPage = $progress?.[volume_uuid || 0] || 1;
  $: progressDisplay = `${
    currentPage === volume.mokuroData.pages.length - 1 ? currentPage + 1 : currentPage
  } / ${volume.mokuroData.pages.length}`;
  $: isComplete =
    currentPage === volume.mokuroData.pages.length ||
    currentPage === volume.mokuroData.pages.length - 1;

  async function onDeleteClicked(e: Event) {
    e.stopPropagation();

    promptConfirmation(`Delete ${volName}?`, async () => {
      const existingCatalog = await db.catalog.get(title_uuid);
      const updated = existingCatalog?.manga.filter(({ mokuroData }) => {
        return mokuroData.volume_uuid !== volume_uuid;
      });

      deleteVolume(volume_uuid);
      if (updated && updated.length > 0) {
        await db.catalog.update(title_uuid, { manga: updated });
        goto(`/${$page.params.manga}`);
      } else {
        db.catalog.delete(title_uuid);
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
      <div
        class:text-green-400={isComplete}
        class="flex flex-row gap-5 items-center justify-between w-full"
      >
        <div>
          <p
            class="font-semibold"
            class:text-black={!isComplete}
            class:dark:text-white={!isComplete}
          >
            {volName}
          </p>
          <p>{progressDisplay}</p>
        </div>
        <div class="flex gap-2">
          <TrashBinSolid
            class="text-red-400 hover:text-red-500 z-10 poin"
            on:click={onDeleteClicked}
          />
          {#if isComplete}
            <CheckCircleSolid />
          {/if}
        </div>
      </div>
    </ListgroupItem>
  </Frame>
{/if}
