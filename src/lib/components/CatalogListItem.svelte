<script lang="ts">
  import { catalog } from '$lib/catalog';
  import { ListgroupItem } from 'flowbite-svelte';

  export let id: string;

  $: manga = $catalog?.find((item) => item.id === id)?.manga[0];
</script>

{#if manga}
  <div>
    <ListgroupItem>
      <a href={id} class="h-full w-full">
        <div class="flex justify-between items-center">
          <p class="font-semibold text-black dark:text-white">{manga.mokuroData.title}</p>
          <img
            src={URL.createObjectURL(Object.values(manga.files)[0])}
            alt="img"
            class="object-contain w-[50px] h-[70px] bg-black border-gray-900 border"
          />
        </div>
      </a>
    </ListgroupItem>
  </div>
{/if}
