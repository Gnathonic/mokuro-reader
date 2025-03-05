<script lang="ts">
  import { volumes } from '$lib/catalog';
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
  <a href={series_uuid}>
    <div
      class:text-green-400={isComplete}
      class="flex flex-col gap-[5px] text-center items-center bg-slate-900 pb-1 bg-opacity-50 border border-slate-950"
    >
      {#if volume.thumbnail}
        <img
          src={URL.createObjectURL(volume.thumbnail)}
          alt="img"
          class="object-contain sm:w-[250px] sm:h-[350px] bg-black border-gray-900 border"
        />
      {/if}
      <p class="font-semibold sm:w-[250px] line-clamp-1">
        {volume.series_title}
      </p>
    </div>
  </a>
{/if}
