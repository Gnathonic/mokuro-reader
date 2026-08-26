<script lang="ts">
  import { onMount } from 'svelte';
  import Catalog from '$lib/components/Catalog.svelte';
  import { patchProgressHolesWhenListingReady } from '$lib/metadata/hole-patch';

  onMount(() => {
    // Enrich orphaned volumes, pull any series the synced progress references
    // but this device has never seen, then enrich AGAIN so the rows the sweep
    // just minted are reflected in this visit rather than the next one. The
    // second pass is what stops a resolved volume still reading as orphaned
    // for the rest of the session. Session-scoped memory inside the sweep means
    // repeated mounts don't re-pull a series genuinely absent from the cloud.
    //
    // `patchProgressHolesWhenListingReady` (see hole-patch.ts) also re-runs the
    // whole sweep once more if THIS mount fired before the cloud listing had
    // loaded — otherwise a mount that lost that race gets zero sweep work for
    // the whole visit, cloud listing or not.
    return patchProgressHolesWhenListingReady();
  });
</script>

<svelte:head>
  <title>Mokuro</title>
</svelte:head>

<div class="h-[90svh] p-2">
  <Catalog />
</div>
