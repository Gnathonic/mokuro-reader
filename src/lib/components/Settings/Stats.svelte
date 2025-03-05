<script lang="ts">
  import { totalStats } from '$lib/settings';
  import { AccordionItem } from 'flowbite-svelte';
</script>

<AccordionItem>
  {#snippet header()}
    <span>Stats</span>
  {/snippet}
  <div>
    <p>Completed volumes: {$totalStats?.completed || 0}</p>
    <p>Pages read: {$totalStats?.pagesRead || 0}</p>
    <p>Characters read: {$totalStats?.charsRead || 0}</p>
    <p>Minutes read: {$totalStats?.minutesRead || 0}</p>
  </div>
</AccordionItem>
