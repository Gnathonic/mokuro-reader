<script lang="ts">
  import Catalog from '$lib/components/Catalog.svelte';
  // Rows for series the synced progress references but this device has never
  // seen are minted after every progress sync (`resolveSyncedProgress`), not
  // from this mount — a view is not what decides when metadata converges.
</script>

<svelte:head>
  <title>Mokuro</title>
</svelte:head>

<div class="h-[90svh] p-2">
  <Catalog />
</div>
