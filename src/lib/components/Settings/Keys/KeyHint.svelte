<script lang="ts">
  import type { ActionId } from '$lib/keys/actions';
  import { keyHints } from '$lib/keys/live';

  // The live binding's label — never a hard-coded key (#55). An unbound
  // action shows no hint at all.
  let { id }: { id: ActionId } = $props();

  let hint = $derived($keyHints(id));
</script>

{#if hint}
  <span class="ml-2 text-xs text-gray-500 dark:text-gray-400" data-key-hint={id}>({hint})</span>
{/if}
