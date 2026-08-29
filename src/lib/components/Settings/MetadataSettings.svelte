<script lang="ts">
  import { AccordionItem } from 'flowbite-svelte';
  import AniListAccountSettings from './AniListAccountSettings.svelte';
</script>

<AccordionItem>
  {#snippet header()}AniList{/snippet}
  <div class="flex flex-col gap-4">
    <AniListAccountSettings />
  </div>
</AccordionItem>
