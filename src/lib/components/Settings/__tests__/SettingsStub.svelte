<script lang="ts">
  // Stands in for Settings.svelte in SettingsDrawerHost.test.ts: the drawer's
  // `open` contract (a bindable boolean, closed from inside) and nothing else.
  let { open = $bindable(false) }: { open?: boolean } = $props();
</script>

<div data-drawer data-open={open ? 'yes' : 'no'}>
  <button type="button" data-close onclick={() => (open = false)}>Close</button>
</div>
