<script lang="ts">
  // Test harness: many KeyActionRows at once, as the section mounts them.
  import type { ActionId, KeyActionDef } from '#lib/keys/actions.js';
  import { allActions } from '#lib/keys/registry.js';
  import KeyActionRow from '../KeyActionRow.svelte';

  let { rows }: { rows: KeyActionDef[] } = $props();

  const actions = new Map(allActions().map((a) => [a.id as ActionId, a]));
</script>

{#each rows as action (action.id)}
  <KeyActionRow
    {action}
    {actions}
    bindings={{}}
    capturing={false}
    labelOf={(c) => c}
    onCaptureChange={() => {}}
    onSave={() => {}}
    menu={false}
  />
{/each}
