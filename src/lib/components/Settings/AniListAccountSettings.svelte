<!-- src/lib/components/Settings/AniListAccountSettings.svelte -->
<script lang="ts">
  import { Button, Toggle } from 'flowbite-svelte';
  import {
    anilistConnected,
    anilistUser,
    disconnectAniList,
    getAniListClientId,
    startAniListLogin
  } from '$lib/metadata/anilist-auth';
  import { syncAllSeriesNow, type SyncAllTally } from '$lib/metadata/progress-tracker';
  import { catalogSettings, updateCatalogSetting } from '$lib/settings/settings';
  import { showSnackbar } from '$lib/util/snackbar';

  // Env-derived and constant for the life of the tab; the script body runs
  // once per component instance, so this needs no reactivity.
  const clientId = getAniListClientId();

  // `anilistConnected` is the reactive session flag (kept in sync by
  // anilist-auth.ts on login/disconnect/expiry); a token can outlive the
  // Viewer query that names the user, so it's the name label, not the
  // connected state, that additionally depends on `$anilistUser`.
  let connected = $derived($anilistConnected);
  let pushAllowed = $derived($catalogSettings?.pushProgressToAniList ?? true);
  let syncingAll = $state(false);

  /** "Synced 12 series — 3 pushed, 8 up to date, 1 queued" (silent about zeroes). */
  function describeTally(tally: SyncAllTally): string {
    if (tally.total === 0) return 'No linked series to sync';
    const parts: string[] = [];
    if (tally.pushed) parts.push(`${tally.pushed} pushed`);
    if (tally.nothing) parts.push(`${tally.nothing} up to date`);
    if (tally.queued) parts.push(`${tally.queued} queued`);
    if (tally.failed) parts.push(`${tally.failed} failed`);
    if (tally.disabled) parts.push(`${tally.disabled} skipped`);
    return `Synced ${tally.total} series — ${parts.join(', ')}`;
  }

  async function syncAll() {
    if (syncingAll) return;
    syncingAll = true;
    try {
      showSnackbar(describeTally(await syncAllSeriesNow()));
    } catch (error) {
      // `syncAllSeriesNow` swallows per-series failures; this is the belt.
      console.error('[anilist-settings] sync all failed:', error);
      showSnackbar("Couldn't reach AniList — try again");
    } finally {
      syncingAll = false;
    }
  }

  function disconnect() {
    disconnectAniList();
    showSnackbar('Disconnected from AniList');
  }
</script>

{#if clientId}
  <div class="flex flex-col gap-3">
    <h4 class="text-sm font-semibold text-gray-900 dark:text-white">AniList account</h4>
    <div class="flex flex-wrap items-center gap-3">
      {#if connected}
        {#key $anilistUser?.name}
          <span class="text-sm text-gray-700 dark:text-gray-300"
            >Connected{$anilistUser ? ` as ${$anilistUser.name}` : ''}</span
          >
        {/key}
        <Button size="xs" color="alternative" onclick={disconnect}>Disconnect</Button>
      {:else}
        <span class="text-sm text-gray-500">Not connected</span>
        <Button size="xs" color="primary" onclick={startAniListLogin}>Connect AniList</Button>
      {/if}
    </div>
    <Toggle
      checked={$catalogSettings?.pushProgressToAniList ?? true}
      onchange={(e) => updateCatalogSetting('pushProgressToAniList', e.currentTarget.checked)}
    >
      Push progress to AniList when a volume is finished
    </Toggle>
    <!-- relative z-10: the settings drawer can sit inside the night-mode filter's
         stacking context, where a scrollable sibling swallows clicks otherwise -->
    <div class="relative z-10 flex flex-wrap items-center gap-3">
      <Button
        size="xs"
        color="alternative"
        onclick={syncAll}
        disabled={syncingAll || !connected || !pushAllowed}
      >
        Sync all linked series now
      </Button>
      {#if syncingAll}
        <span class="text-xs text-gray-500">Syncing…</span>
      {/if}
    </div>
    <p class="text-xs text-gray-500">
      Every series linked to AniList is tracked — there is no per-series switch. Progress only ever
      moves forward; use "Restart series" to record a re-read.
    </p>
  </div>
{:else if import.meta.env.DEV}
  <!-- Dev-only: production builds without a client simply hide AniList. -->
  <p class="text-xs text-gray-500">
    AniList account & progress push are hidden: set <code>VITE_ANILIST_CLIENT_ID</code> in
    <code>.env.local</code> (register a client at anilist.co/settings/developer with redirect
    <code>{location.origin}/</code>) and restart the dev server.
  </p>
{/if}
