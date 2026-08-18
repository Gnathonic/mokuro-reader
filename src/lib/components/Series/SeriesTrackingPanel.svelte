<!-- src/lib/components/Series/SeriesTrackingPanel.svelte -->
<script lang="ts">
  import { Button, Select, Toggle } from 'flowbite-svelte';
  import type { VolumeMetadata } from '$lib/types';
  import type { SeriesTracking, TrackingUnit } from '$lib/metadata/types';
  import {
    seriesMetadataMap,
    updateSeriesMetadata,
    type SeriesMetadataPatchInput
  } from '$lib/metadata/store';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import { resolveDisplayTitle } from '$lib/metadata/display-title';
  import {
    computeLocalPassState,
    syncSeriesNow,
    type PushOutcome
  } from '$lib/metadata/progress-tracker';
  import { restartSeries } from '$lib/metadata/reread';
  import { anilistConnected, getAniListClientId } from '$lib/metadata/anilist-auth';
  import { volumes as volumesStore } from '$lib/settings/volume-data';
  import { catalogSettings, preferredTitleLanguage } from '$lib/settings/settings';
  import { promptConfirmation } from '$lib/util/modals';
  import { showSnackbar } from '$lib/util/snackbar';

  let { seriesTitle, volumes }: { seriesTitle: string; volumes: VolumeMetadata[] } = $props();

  const unitOptions = [
    { value: 'volumes', name: 'Volumes' },
    { value: 'chapters', name: 'Chapters' }
  ];

  const DEFAULT_TRACKING: SeriesTracking = { enabled: false, unit: 'volumes' };

  /** Every outcome `syncSeriesNow` can report — `failed` is an error, not a queue. */
  const SYNC_MESSAGES: Record<PushOutcome, string> = {
    pushed: 'Pushed to AniList',
    nothing: 'Already up to date',
    queued: 'Queued — will push when AniList is reachable',
    disabled: 'Tracking is off for this series',
    failed: 'AniList rejected the update'
  };

  // Env-derived and constant for the life of the tab; the script body runs once
  // per component instance, so this needs no reactivity.
  const clientId = getAniListClientId();

  let seriesKey = $derived(normalizeSeriesKey(seriesTitle));
  let meta = $derived($seriesMetadataMap.get(seriesKey));
  // Every human-facing label uses the display title (language preference + tag);
  // the folder title stays the identity we read and write records by.
  let displayTitle = $derived(resolveDisplayTitle(seriesTitle, meta, $preferredTitleLanguage));
  // Cloud-only placeholders were never downloaded, so they can be neither read
  // nor reset. The tracker computes its pass state from the LOCAL volumes only
  // (`restartSeries` does the same) — filtering here keeps "Read N times" and
  // the Restart button in step with what actually gets pushed.
  let localVolumes = $derived(volumes.filter((v) => !v.isPlaceholder));
  // One computation for the whole page — never per volume card.
  let passState = $derived(computeLocalPassState(localVolumes, $volumesStore, meta));
  let readCount = $derived(meta?.read_count ?? 0);
  let linked = $derived(!!meta?.external_ids?.anilist);
  let tracking = $derived<SeriesTracking>(meta?.tracking ?? DEFAULT_TRACKING);
  let lastPushed = $derived(tracking.last_pushed);
  // Reactive session flag (kept in sync by anilist-auth.ts on
  // login/disconnect/expiry) — a token can outlive the Viewer query that
  // names the user, so this doesn't wait on `$anilistUser`.
  let connected = $derived($anilistConnected);
  let pushAllowed = $derived($catalogSettings?.pushProgressToAniList !== false);
  let syncing = $state(false);

  /**
   * Every write goes through `updateSeriesMetadata`, which resolves a functional
   * patch inside its own `rw` transaction. That is what keeps concurrent writers
   * honest: `seriesMetadataMap` is a Dexie liveQuery and lags a write by a
   * round-trip (two fast `+` clicks would otherwise read the same count), and
   * the progress tracker writes `tracking.last_pushed` from another module
   * entirely.
   */
  async function write(patch: SeriesMetadataPatchInput, failureMessage: string): Promise<void> {
    try {
      await updateSeriesMetadata(seriesTitle, patch);
    } catch (error) {
      console.error('[series-tracking] could not save the series record:', error);
      showSnackbar(failureMessage);
    }
  }

  function setReadCount(delta: number) {
    // The − button is disabled at 0; this keeps a stray click from spending a
    // write (and an `updated_at` bump the cloud would then sync) on a no-op.
    if (delta < 0 && readCount === 0) return Promise.resolve();
    return write(
      (current) => ({ read_count: Math.max(0, (current.read_count ?? 0) + delta) }),
      "Couldn't save the read count"
    );
  }

  function setTracking(patch: Partial<SeriesTracking>) {
    // Spread the stored record so unit/number_overrides/last_pushed survive an
    // edit to any one of them.
    return write(
      (current) => ({ tracking: { ...(current.tracking ?? DEFAULT_TRACKING), ...patch } }),
      "Couldn't save the tracking settings"
    );
  }

  /** The reader's "Don't ask for this series" is permanent — this is its undo. */
  function askAgainAboutRereads() {
    return write({ reread_prompt_suppressed: undefined }, "Couldn't reset the re-read prompt");
  }

  async function syncNow() {
    if (syncing) return;
    syncing = true;
    try {
      const outcome = await syncSeriesNow(seriesKey);
      showSnackbar(SYNC_MESSAGES[outcome] ?? 'Sync finished');
    } catch (error) {
      // `syncSeriesNow` is documented never to reject; belt and braces.
      console.error('[series-tracking] sync failed:', error);
      showSnackbar("Couldn't reach AniList — try again");
    } finally {
      syncing = false;
    }
  }

  function confirmRestart() {
    promptConfirmation(
      `Restart ${displayTitle}? Every volume goes back to the start; your reading stats are kept.`,
      async () => {
        try {
          await restartSeries(seriesTitle, volumes);
          showSnackbar('Series restarted — your previous read is kept in your stats');
        } catch (error) {
          console.error('[series-tracking] restart failed:', error);
          showSnackbar('Could not restart the series');
        }
      }
    );
  }

  function formatPushedAt(at: string) {
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? at : date.toLocaleDateString();
  }
</script>

<div class="flex flex-col gap-2">
  <!-- relative z-10: inside a modal the night-mode filter on <dialog> creates a stacking
       context, and a scrollable sibling can otherwise swallow clicks meant for these buttons -->
  <div class="relative z-10 flex flex-wrap items-center gap-2">
    <!-- Migaku/Yomitan rewrite text in place; a fresh node per value keeps the count honest -->
    {#key passState.timesRead}
      <span class="text-gray-700 dark:text-gray-300">
        Read {passState.timesRead}
        {passState.timesRead === 1 ? 'time' : 'times'}
      </span>
    {/key}
    <Button
      size="xs"
      color="light"
      aria-label="Decrease read count"
      disabled={readCount === 0}
      onclick={() => setReadCount(-1)}>−</Button
    >
    <Button size="xs" color="light" aria-label="Increase read count" onclick={() => setReadCount(1)}
      >+</Button
    >
    <Button
      size="xs"
      color="light"
      onclick={confirmRestart}
      disabled={localVolumes.length === 0}
      title="Archive this pass and send every volume back to the start">Restart series…</Button
    >
    {#if meta?.reread_prompt_suppressed}
      <Button
        size="xs"
        color="light"
        onclick={askAgainAboutRereads}
        title="Offer a restart again when you reopen the first volume"
        >Ask again about re-reads</Button
      >
    {/if}
  </div>

  <!-- Without a client id nothing can ever be pushed, so the whole row is noise. -->
  {#if clientId}
    {#if linked}
      <div class="relative z-10 flex flex-wrap items-center gap-3">
        <Toggle
          checked={tracking.enabled}
          onchange={(e) => setTracking({ enabled: e.currentTarget.checked })}
        >
          Push progress to AniList
        </Toggle>
        <Select
          size="sm"
          class="w-32"
          items={unitOptions}
          value={tracking.unit}
          aria-label="Tracking unit"
          onchange={(e) => setTracking({ unit: e.currentTarget.value as TrackingUnit })}
        />
        <Button size="xs" color="light" onclick={syncNow} disabled={syncing}>Sync now</Button>
        {#if !connected}
          <span class="text-xs text-gray-500 dark:text-gray-400">Connect AniList in Settings</span>
        {:else if !pushAllowed}
          <span class="text-xs text-amber-600 dark:text-amber-400"
            >Progress pushing is off in Settings</span
          >
        {/if}
        <!-- Standing element (spec): what AniList last received, shown alongside any hint. -->
        {#if lastPushed}
          {#key lastPushed.at}
            <span class="text-xs text-gray-500 dark:text-gray-400">
              Last pushed {tracking.unit === 'chapters' ? 'ch.' : 'vol.'}
              {lastPushed.n} · {formatPushedAt(lastPushed.at)}
            </span>
          {/key}
        {/if}
      </div>
    {:else}
      <span class="text-xs text-gray-500 dark:text-gray-400">Link to AniList to track progress</span
      >
    {/if}
  {:else if import.meta.env.DEV}
    <span class="text-xs text-gray-500 dark:text-gray-400"
      >AniList progress push is hidden: no <code>VITE_ANILIST_CLIENT_ID</code> (see Settings → AniList)</span
    >
  {/if}
</div>
