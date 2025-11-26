<script lang="ts">
  import { AccordionItem, Button } from 'flowbite-svelte';
  import { db } from '$lib/catalog/db';
  import { promptConfirmation } from '$lib/util';
  import { clearVolumes } from '$lib/settings';
  import { nav } from '$lib/util/navigation';

  function onConfirm() {
    clearVolumes();
    db.volumes_data.clear();
    db.volumes.clear();
  }

  function onClear() {
    promptConfirmation('Are you sure you want to clear your catalog?', onConfirm);
    nav.toCatalog();
  }
</script>

<AccordionItem>
  {#snippet header()}Catalog settings{/snippet}
  <div class="flex flex-col">
    <Button onclick={onClear} outline color="red">Clear catalog</Button>
  </div>
</AccordionItem>
