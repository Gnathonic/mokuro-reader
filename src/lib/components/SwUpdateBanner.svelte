<script lang="ts">
  import { swUpdateAvailable, applySwUpdate, dismissSwUpdate } from '$lib/util/sw-update';
  import { latestRelease, fetchLatestRelease } from '$lib/util/release-notes';
  import { READER_VERSION } from '$lib/consts';
  import { onMount } from 'svelte';

  let showReleaseNotes = $state(false);

  onMount(() => {
    // Fetch release notes when update banner appears
    if ($swUpdateAvailable) {
      fetchLatestRelease();
    }
  });

  // Also fetch when update becomes available
  $effect(() => {
    if ($swUpdateAvailable && !$latestRelease) {
      fetchLatestRelease();
    }
  });
</script>

{#if $swUpdateAvailable}
  <div
    class="fixed right-4 bottom-4 left-4 z-50 flex flex-col gap-2 rounded-lg bg-blue-600 px-4 py-3 text-white shadow-lg sm:right-4 sm:left-auto sm:max-w-sm"
  >
    <div class="flex items-center justify-between gap-3">
      <div class="flex-1">
        <p class="text-sm font-medium">Update available</p>
        <p class="text-xs opacity-80">
          {#if $latestRelease}
            v{READER_VERSION} → v{$latestRelease.version}
          {:else}
            A new version is ready to install
          {/if}
        </p>
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

    {#if $latestRelease}
      <div class="border-t border-white/20 pt-2">
        <button
          onclick={() => (showReleaseNotes = !showReleaseNotes)}
          class="text-xs text-white/80 underline hover:text-white"
        >
          {showReleaseNotes ? 'Hide' : 'Show'} what's new
        </button>

        {#if showReleaseNotes}
          <div class="mt-2 max-h-48 overflow-y-auto rounded bg-white/10 p-2 text-xs">
            <p class="mb-1 font-medium">{$latestRelease.name}</p>
            <div class="whitespace-pre-wrap">
              {$latestRelease.body}
            </div>
          </div>
        {/if}

        <a
          href={$latestRelease.html_url}
          target="_blank"
          rel="noopener noreferrer"
          class="mt-1 block text-xs text-white/60 hover:text-white"
        >
          View full release notes →
        </a>
      </div>
    {/if}
  </div>
{/if}
