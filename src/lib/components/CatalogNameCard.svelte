<script lang="ts">
  import { nav } from '$lib/util/hash-router';
  import { ListgroupItem } from 'flowbite-svelte';
  import { CloudArrowUpOutline } from 'flowbite-svelte-icons';

  interface Props {
    /** Raw folder title — the route key. */
    title: string;
    /** Pre-resolved by the catalog store; never computed per card. */
    displayTitle: string;
    variant?: 'grid' | 'list';
  }

  let { title, displayTitle, variant = 'grid' }: Props = $props();
</script>

{#if variant === 'list'}
  <!--
    ListgroupItem so the row carries the same dividers/hover as CatalogListItem.
    `active` is pinned rather than inherited from the Listgroup context: without
    it the item renders a bare <li> that DROPS onclick (it spreads restProps only
    on the button/anchor branches), leaving the row silently unclickable.
  -->
  <ListgroupItem active onclick={() => nav.toSeries(title)}>
    <div class="flex w-full items-center gap-3 text-left">
      <CloudArrowUpOutline class="h-5 w-5 flex-shrink-0 text-gray-400" />
      {#key displayTitle}
        <span class="truncate font-semibold">{displayTitle}</span>
      {/key}
    </div>
  </ListgroupItem>
{:else}
  <button
    type="button"
    class="flex h-[297px] w-[210px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 p-3 text-center hover:border-gray-400 hover:bg-gray-50 dark:border-gray-600 dark:hover:border-gray-500 dark:hover:bg-gray-800"
    onclick={() => nav.toSeries(title)}
  >
    <CloudArrowUpOutline class="h-8 w-8 text-gray-400" />
    {#key displayTitle}
      <span class="line-clamp-4 text-sm font-medium">{displayTitle}</span>
    {/key}
    <span class="text-xs text-gray-500">Open to load volumes</span>
  </button>
{/if}
