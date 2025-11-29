<script lang="ts">
  import { swUpdateAvailable, applySwUpdate, dismissSwUpdate } from '$lib/util/sw-update';
</script>

{#if $swUpdateAvailable}
  <div
    class="fixed right-4 bottom-4 left-4 z-50 flex items-center justify-between gap-3 rounded-lg bg-blue-600 px-4 py-3 text-white shadow-lg sm:right-4 sm:left-auto sm:max-w-sm"
  >
    <div class="flex-1">
      <p class="text-sm font-medium">Update available</p>
      <p class="text-xs opacity-80">A new version is ready to install</p>
    </div>
    <div class="flex gap-2">
      <button
        onclick={dismissSwUpdate}
        class="rounded px-3 py-1.5 text-sm font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white"
      >
        Later
      </button>
      <button
        onclick={applySwUpdate}
        class="rounded bg-white px-3 py-1.5 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50"
      >
        Update
      </button>
    </div>
  </div>
{/if}
