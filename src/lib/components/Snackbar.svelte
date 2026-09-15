<script lang="ts">
  import { snackbarStore } from '$lib/util/snackbar';
  import { Toast } from 'flowbite-svelte';
</script>

{#if $snackbarStore?.message && $snackbarStore?.visible}
  <!-- `fixed` overrides the `absolute` that `position` applies: a toast must sit in the
       viewport, not on the page, or a click made a screen down never sees it. -->
  <Toast position="bottom-right" class="fixed z-50">{$snackbarStore?.message}</Toast>
{/if}
