<script lang="ts">
  import { onMount } from 'svelte';
  import Catalog from '$lib/components/Catalog.svelte';
  import { patchProgressHolesAndEnrich } from '$lib/metadata/hole-patch';

  onMount(() => {
    // Enrich orphaned volumes, pull any series the synced progress references
    // but this device has never seen, then enrich AGAIN so the rows the sweep
    // just minted are reflected in this visit rather than the next one. The
    // second pass is what stops a resolved volume still reading as orphaned
    // for the rest of the session. Session-scoped memory inside the sweep means
    // repeated mounts don't re-pull a series genuinely absent from the cloud.
    void patchProgressHolesAndEnrich();
  });
</script>

<svelte:head>
  <title>Mokuro</title>
</svelte:head>

<div class="h-[90svh] p-2">
  <Catalog />
</div>
