<script lang="ts">
  import { onMount } from 'svelte';
  import Catalog from '$lib/components/Catalog.svelte';
  import { enrichAllOrphanedVolumes } from '$lib/settings/volume-data';
  import { patchProgressHoles } from '$lib/metadata/hole-patch';

  onMount(() => {
    // Enrich orphaned volumes when catalog loads
    // This happens after users upload volumes
    enrichAllOrphanedVolumes();
    // …and pull any series the synced progress references but this device has
    // never seen, so the stats views never dangle. Session-scoped memory inside
    // patchProgressHoles means repeated mounts don't re-pull a series that's
    // genuinely absent from the cloud.
    void patchProgressHoles();
  });
</script>

<svelte:head>
  <title>Mokuro</title>
</svelte:head>

<div class="h-[90svh] p-2">
  <Catalog />
</div>
