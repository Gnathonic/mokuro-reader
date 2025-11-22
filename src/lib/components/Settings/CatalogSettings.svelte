<script lang="ts">
  import { AccordionItem, Button } from 'flowbite-svelte';
  import { db } from '$lib/catalog/db';
  import { promptConfirmation } from '$lib/util';
  import { goto } from '$app/navigation';
  import { clearVolumes } from '$lib/settings';

  function onConfirm() {
    clearVolumes();
    db.volumes_data.clear();
    db.volumes.clear();
  }

  function onClear() {
    promptConfirmation('Are you sure you want to clear your catalog?', onConfirm);
    goto('/');
  }
</script>

<AccordionItem>
  <span slot="header">Catalog settings</span>
  <div class="flex flex-col">
    <Button on:click={onClear} outline color="red">Clear catalog</Button>
  </div>
</AccordionItem>
