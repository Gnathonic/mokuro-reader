<script lang="ts">
  import { snackbarStore } from '$lib/util/snackbar';
  import { Toast } from 'flowbite-svelte';
</script>

{#if $snackbarStore?.message && $snackbarStore?.visible}
  <!-- `fixed` overrides the `absolute` that `position` applies: a toast must sit in the
       viewport, not on the page, or a click made a screen down never sees it.
       z-[60]: above the progress tray (z-50), which shares this corner and would
       otherwise hide every notice raised while something is in progress. -->
  <Toast position="bottom-right" class="fixed z-[60]">{$snackbarStore?.message}</Toast>
{/if}
