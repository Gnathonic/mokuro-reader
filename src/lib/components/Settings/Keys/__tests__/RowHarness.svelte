<script lang="ts">
  // Test harness: one KeyActionRow with its own bindings state, the way
  // KeyboardShortcuts.svelte holds it (minus the profile store).
  import { actionDef, type ActionId } from '$lib/keys/actions';
  import type { KeyBindings } from '$lib/keys/keymap';
  import KeyActionRow from '../KeyActionRow.svelte';

  let {
    id,
    initial = {},
    onSaved
  }: { id: ActionId; initial?: KeyBindings; onSaved?: (b: KeyBindings) => void } = $props();

  // svelte-ignore state_referenced_locally
  let bindings = $state<KeyBindings>(initial);
  let capturing = $state(false);
</script>

<KeyActionRow
  action={actionDef(id)}
  {bindings}
  {capturing}
  labelOf={(c) => c}
  onCaptureChange={(on) => (capturing = on)}
  onSave={(next) => {
    bindings = next;
    onSaved?.(next);
  }}
/>
