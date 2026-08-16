<!-- src/lib/components/Settings/AniListAccountSettings.svelte -->
<script lang="ts">
  import { Button, Toggle } from 'flowbite-svelte';
  import {
    anilistUser,
    disconnectAniList,
    getAniListClientId,
    getAniListToken,
    startAniListLogin
  } from '$lib/metadata/anilist-auth';
  import { catalogSettings, updateCatalogSetting } from '$lib/settings/settings';
  import { showSnackbar } from '$lib/util/snackbar';

  // Env-derived and constant for the life of the tab; the script body runs
  // once per component instance, so this needs no reactivity.
  const clientId = getAniListClientId();

  // A token can outlive the Viewer query that names the user (in flight or
  // failed) — either proves a session, same rule as SeriesTrackingPanel.
  let connected = $derived(!!$anilistUser || !!getAniListToken());

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
    <p class="text-xs text-gray-500">
      Tracking is per series: turn it on from a linked series' page. Progress only ever moves
      forward; use "Restart series" to record a re-read.
    </p>
  </div>
{/if}
