<script lang="ts">
  import { totalStats } from '$lib/reading-history/total-stats';
  import { AccordionItem } from 'flowbite-svelte';
</script>

<AccordionItem>
  {#snippet header()}Stats{/snippet}
  <div>
    <p class="text-gray-900 dark:text-white">Completed volumes: {$totalStats?.completed || 0}</p>
    <p class="text-gray-900 dark:text-white">Pages read: {$totalStats?.pagesRead || 0}</p>
    <p class="text-gray-900 dark:text-white">Characters read: {$totalStats?.charsRead || 0}</p>
    {#if $totalStats?.charsSkipped}
      <p class="text-gray-900 dark:text-white">Characters skimmed: {$totalStats.charsSkipped}</p>
    {/if}
    <p class="text-gray-900 dark:text-white">Minutes read: {$totalStats?.minutesRead || 0}</p>
  </div>
</AccordionItem>
