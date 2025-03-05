<script lang="ts">
  import { volumes } from '$lib/catalog';
  import { ListgroupItem } from 'flowbite-svelte';
  import { progress } from '$lib/settings';

  interface Props {
    series_uuid: string;
  }

  let { series_uuid }: Props = $props();

  let firstUnreadVolume = $derived(
    Object.values($volumes)
      .sort((a, b) => a.volume_title.localeCompare(b.volume_title))
      .find(
        (item) =>
          item.series_uuid === series_uuid &&
          ($progress?.[item.volume_uuid || 0] || 1) < item.page_count - 1
      )
  );

  let firstVolume = $derived(
    Object.values($volumes)
      .sort((a, b) => a.volume_title.localeCompare(b.volume_title))
      .find((item) => item.series_uuid === series_uuid)
  );
  let volume = $derived(firstUnreadVolume ?? firstVolume);
  let isComplete = $derived(!firstUnreadVolume);
</script>

{#if volume}
  <div>
    <ListgroupItem>
      <a href={series_uuid} class="h-full w-full">
        <div class="flex justify-between items-center">
          <p class:text-green-400={isComplete} class="font-semibold">{volume.series_title}</p>
          {#if volume.thumbnail}
            <img
              src={URL.createObjectURL(volume.thumbnail)}
              alt="img"
              class="object-contain w-[50px] h-[70px] bg-black border-gray-900 border"
            />
          {/if}
        </div>
      </a>
    </ListgroupItem>
  </div>
{/if}
