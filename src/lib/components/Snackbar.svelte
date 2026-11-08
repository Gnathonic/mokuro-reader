<script lang="ts">
  import { snackbarStore } from '$lib/util/snackbar';
  import { Toast } from 'flowbite-svelte';
</script>

{#if $snackbarStore?.message && $snackbarStore?.visible}
  <!-- `fixed` overrides the `absolute` that `position` applies: a toast must sit in the
       viewport, not on the page, or a click made a screen down never sees it.
       z-[60]: above the progress tray (z-50), which shares this corner and would
       otherwise hide every notice raised while something is in progress. -->
  <Toast position="bottom-right" class="fixed z-[60]">
    <div class="flex items-center gap-3" data-testid="snackbar">
      <span class="flex-1">{$snackbarStore.message}</span>
      {#if $snackbarStore.action}
        <button
          type="button"
          class="-my-2 min-h-11 shrink-0 rounded-lg px-3 text-sm font-semibold text-primary-600 hover:bg-gray-100 dark:text-primary-400 dark:hover:bg-gray-700"
          onclick={$snackbarStore.action.onClick}
        >
          {$snackbarStore.action.label}
        </button>
      {/if}
    </div>
  </Toast>
{/if}
