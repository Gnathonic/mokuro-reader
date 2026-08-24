<!-- src/lib/components/Series/SeriesTrackingPanel.svelte -->
<script lang="ts">
  import { Button, Select } from 'flowbite-svelte';
  import type { VolumeMetadata } from '$lib/types';
  import {
    seriesMetadataMap,
    updateSeriesMetadata,
    type SeriesMetadataPatchInput
  } from '$lib/metadata/store';
  import {
    readingStateFor,
    seriesReadingState,
    updateSeriesReadingState
  } from '$lib/settings/series-data';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import { resolveDisplayTitle } from '$lib/metadata/display-title';
  import { computeLocalPassState, onReadCountChanged } from '$lib/metadata/progress-tracker';
  import { resolveTrackingUnit } from '$lib/metadata/tracking-unit';
  import {
    activeMetadataPermissions,
    canEditSeriesMetadata
  } from '$lib/util/sync/metadata-permissions';
  import { restartSeries } from '$lib/metadata/reread';
  import { anilistConnected, anilistUser, getAniListClientId } from '$lib/metadata/anilist-auth';
  import { volumes as volumesStore } from '$lib/settings/volume-data';
  import { catalogSettings, preferredTitleLanguage } from '$lib/settings/settings';
  import { promptConfirmation } from '$lib/util/modals';
  import { showSnackbar } from '$lib/util/snackbar';

  let { seriesTitle, volumes }: { seriesTitle: string; volumes: VolumeMetadata[] } = $props();

  // Env-derived and constant for the life of the tab; the script body runs once
  // per component instance, so this needs no reactivity.
  const clientId = getAniListClientId();

  let seriesKey = $derived(normalizeSeriesKey(seriesTitle));
  let meta = $derived($seriesMetadataMap.get(seriesKey));
  // Server-reported edit scope for THIS series (mokuro-bunko's identity endpoint). Only the
  // tracking-unit correction below is shared series metadata — read count and Restart are
  // per-user progress, never gated. See $lib/util/sync/metadata-permissions.ts.
  // Touches $activeMetadataPermissions so this recomputes if the scope changes after mount.
  let editGate = $derived.by(() => {
    void $activeMetadataPermissions;
    return canEditSeriesMetadata(seriesTitle);
  });
  // Every human-facing label uses the display title (language preference + tag);
  // the folder title stays the identity we read and write records by.
  let displayTitle = $derived(resolveDisplayTitle(seriesTitle, meta, $preferredTitleLanguage));
  // Cloud-only placeholders were never downloaded, so they can be neither read
  // nor reset. The tracker computes its pass state from the LOCAL volumes only
  // (`restartSeries` does the same) — filtering here keeps "Read N times" and
  // the Restart button in step with what actually gets pushed.
  let localVolumes = $derived(volumes.filter((v) => !v.isPlaceholder));
  // The reading state is a plain store over localStorage: a write is visible on
  // the very next read, so unlike the (liveQuery-backed) record there is nothing
  // to hold optimistically — two fast clicks each see the previous one's value.
  let state = $derived(readingStateFor($seriesReadingState, seriesKey));
  let readCount = $derived(state.read_count);
  let linked = $derived(!!meta?.external_ids?.anilist);
  let lastPushed = $derived(state.tracking?.last_pushed);
  // Volumes or chapters is a fact about the archives, not a preference: detected
  // from every title in the folder (placeholders included — they have titles)
  // unless somebody has corrected it on the record.
  let unitState = $derived(resolveTrackingUnit(meta, volumes));
  let resolvedUnit = $derived(unitState.unit);
  // One computation for the whole page — never per volume card. The unit is
  // handed over rather than re-detected: it was resolved above from the FULL
  // volume list, which is what the tracker pushes by.
  let passState = $derived(computeLocalPassState(localVolumes, $volumesStore, state, resolvedUnit));
  // What detection says on its own, so the "Auto" option can name it even while
  // an override is in force.
  let detection = $derived(
    unitState.source === 'detected'
      ? unitState
      : resolveTrackingUnit(meta ? { ...meta, unit: undefined } : undefined, volumes)
  );
  // Only a title that names its unit outright earns the parenthetical. Anything
  // else rests on AniList's totals, which this page never has and the push
  // fetches for itself — promising "Auto (volumes)" over a push that writes
  // chapters is worse than naming nothing.
  let autoLabel = $derived(detection.confident ? `Auto (${detection.unit})` : 'Auto');
  // Explains whatever is actually in force: a stated fact needs no explaining,
  // and neither does a marker-decided guess. It is the bare-number path — where
  // only the totals the push fetches can settle it — that owes the user a word.
  let unitHint = $derived(
    unitState.confident ? undefined : 'Determined at push time from AniList totals'
  );
  // Same rule for the figure AniList last received: the number is what was sent,
  // but labelling it `vol.`/`ch.` on an unconfident unit is a coin flip.
  let pushedUnitLabel = $derived(
    unitState.confident ? (resolvedUnit === 'chapters' ? 'ch. ' : 'vol. ') : ''
  );
  let unitOptions = $derived([
    { value: '', name: autoLabel },
    { value: 'volumes', name: 'Volumes' },
    { value: 'chapters', name: 'Chapters' }
  ]);
  // Reactive session flag (kept in sync by anilist-auth.ts on
  // login/disconnect/expiry) — a token can outlive the Viewer query that
  // names the user, so this doesn't wait on `$anilistUser`.
  let connected = $derived($anilistConnected);
  let pushAllowed = $derived($catalogSettings?.pushProgressToAniList !== false);
  // One line, because there is nothing to decide here any more: pushing is the
  // global switch in Settings and the series is either linked or it is not.
  let pushStatus = $derived(
    !connected
      ? 'Connect AniList in Settings'
      : !pushAllowed
        ? 'Progress push is off in Settings'
        : `Progress push on${$anilistUser ? ` · Connected as ${$anilistUser.name}` : ''}`
  );

  /**
   * Record writes (the unit correction — the one fact this panel edits) go
   * through `updateSeriesMetadata`, which resolves a functional patch inside its
   * own `rw` transaction: `seriesMetadataMap` is a Dexie liveQuery and lags a
   * write by a round-trip. The reading state has its own store and its own
   * writes below.
   */
  async function write(patch: SeriesMetadataPatchInput, failureMessage: string): Promise<boolean> {
    try {
      await updateSeriesMetadata(seriesTitle, patch);
      return true;
    } catch (error) {
      console.error('[series-tracking] could not save the series record:', error);
      showSnackbar(failureMessage);
      return false;
    }
  }

  function setReadCount(delta: number) {
    const before = readCount;
    const next = Math.max(0, before + delta);
    // The − button is disabled at 0, and a second fast click lands here too:
    // either way a no-op must not spend a write (and the sync it would cause).
    if (next === before) return;
    try {
      // Functional patch: `restartSeries` bumps the same counter from another
      // module, so the delta applies to the state as stored.
      updateSeriesReadingState(seriesKey, (existing) => ({
        read_count: Math.max(0, existing.read_count + delta)
      }));
    } catch (error) {
      console.error('[series-tracking] could not save the read count:', error);
      showSnackbar("Couldn't save the read count");
      return;
    }
    // "Read N times" is AniList's repeat count. Nothing else pushes it — a
    // correction here is deliberate, so it travels in both directions.
    onReadCountChanged(seriesKey)
      .then((outcome) => {
        if (outcome === 'failed') showSnackbar('AniList rejected the read count');
      })
      .catch((error) => console.warn('[series-tracking] read count push failed:', error));
  }

  /**
   * `unit` is a shared fact, so this is a fact edit: it moves `facts_updated_at`
   * and the store's listener publishes the new `series.json`. An empty value is
   * "no correction" — back to auto-detection.
   */
  function setUnit(value: string) {
    if (!editGate.allowed) return Promise.resolve(false);
    return write(
      { unit: value === 'volumes' || value === 'chapters' ? value : undefined },
      "Couldn't save the tracking unit"
    );
  }

  /** The reader's "Don't ask for this series" is permanent — this is its undo. */
  function askAgainAboutRereads() {
    try {
      updateSeriesReadingState(seriesKey, { reread_prompt_suppressed: undefined });
    } catch (error) {
      console.error('[series-tracking] could not reset the re-read prompt:', error);
      showSnackbar("Couldn't reset the re-read prompt");
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
    {#if state.reread_prompt_suppressed}
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
        <!-- Migaku/Yomitan rewrite text in place; a fresh node per value keeps this honest -->
        {#key pushStatus}
          <span
            class="text-xs {connected && !pushAllowed
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-gray-500 dark:text-gray-400'}">{pushStatus}</span
          >
        {/key}
        <Select
          size="sm"
          class="w-40"
          items={unitOptions}
          placeholder=""
          value={unitState.source === 'set' ? resolvedUnit : ''}
          aria-label="Tracking unit"
          disabled={!editGate.allowed}
          title={editGate.allowed ? unitHint : editGate.reason}
          onchange={(e) => setUnit(e.currentTarget.value)}
        />
        <!-- Standing element (spec): what AniList last received, shown alongside any hint. -->
        {#if lastPushed}
          <!-- The label is part of the key: a correction rewrites this line, and
               Migaku would otherwise keep showing the old one in place. -->
          {#key `${lastPushed.at}|${lastPushed.n}|${pushedUnitLabel}`}
            <span class="text-xs text-gray-500 dark:text-gray-400" title={unitHint}>
              Last pushed {pushedUnitLabel}{lastPushed.n} · {formatPushedAt(lastPushed.at)}
            </span>
          {/key}
        {/if}
      </div>
      {#if !editGate.allowed}
        <span class="text-xs text-amber-600 dark:text-amber-400">{editGate.reason}</span>
      {:else}
        <span class="text-xs text-gray-500 dark:text-gray-400">
          Detected from the archive names; override if wrong. Saved with the series.
        </span>
      {/if}
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
