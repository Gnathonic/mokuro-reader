<script lang="ts">
  import { catalog } from '$lib/catalog';

  export let id: string;

  import { onMount } from 'svelte';
  import { writable } from 'svelte/store';
  import type { Volume } from '$lib/types';

  const manga = writable<Volume | null>(null);
  let mounted = false;

  onMount(() => {
    mounted = true;
    return () => {
      mounted = false;
    };
  });

  // Only load metadata when component is mounted and visible
  $: if (mounted && id && $catalog) {
    const item = $catalog.find((item) => item.id === id);
    if (item) {
      // Use requestIdleCallback to load metadata during idle time
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(() => {
          if (mounted) manga.set(item.manga[0]);
        });
      } else {
        // Fallback for browsers that don't support requestIdleCallback
        setTimeout(() => {
          if (mounted) manga.set(item.manga[0]);
        }, 0);
      }
    }
  }
</script>

{#if $manga}
  <a href={id}>
    <div
      class="flex flex-col gap-[5px] text-center items-center bg-slate-900 pb-1 bg-opacity-50 border border-slate-950"
    >
      {#if manga.files}
        <img
          src={URL.createObjectURL(Object.values(manga.files)[0])}
          alt="img"
          class="object-contain sm:w-[250px] sm:h-[350px] bg-black border-gray-900 border"
        />
      {/if}
      <p class="font-semibold sm:w-[250px] line-clamp-1">
        {manga.mokuroData.title}
      </p>
    </div>
  </a>
{/if}
