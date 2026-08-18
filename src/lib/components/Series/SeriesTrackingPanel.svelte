<!-- src/lib/components/Series/SeriesTrackingPanel.svelte -->
<script lang="ts">
  import { Button, Select } from 'flowbite-svelte';
  import type { VolumeMetadata } from '$lib/types';
  import {
    seriesMetadataMap,
    updateSeriesMetadata,
    type SeriesMetadataPatchInput
  } from '$lib/metadata/store';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import { resolveDisplayTitle } from '$lib/metadata/display-title';
  import { computeLocalPassState } from '$lib/metadata/progress-tracker';
  import { resolveTrackingUnit } from '$lib/metadata/tracking-unit';
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
  let lastPushed = $derived(meta?.tracking?.last_pushed);
  // Volumes or chapters is a fact about the archives, not a preference: detected
  // from every title in the folder (placeholders included — they have titles)
  // unless somebody has corrected it on the record.
  let unitState = $derived(resolveTrackingUnit(meta, volumes));
  let resolvedUnit = $derived(unitState.unit);
  // What detection says on its own, so the "Auto" option can name it even while
  // an override is in force.
  let detectedUnit = $derived(
    unitState.source === 'detected'
      ? unitState.unit
      : resolveTrackingUnit(meta ? { ...meta, unit: undefined } : undefined, volumes).unit
  );
  let unitOptions = $derived([
    { value: '', name: `Auto (${detectedUnit})` },
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

  /**
   * `unit` is a shared fact, so this is a fact edit: it moves `facts_updated_at`
   * and the store's listener publishes the new `series.json`. An empty value is
   * "no correction" — back to auto-detection.
   */
  function setUnit(value: string) {
    return write(
      { unit: value === 'volumes' || value === 'chapters' ? value : undefined },
      "Couldn't save the tracking unit"
    );
  }

  /** The reader's "Don't ask for this series" is permanent — this is its undo. */
  function askAgainAboutRereads() {
    return write({ reread_prompt_suppressed: undefined }, "Couldn't reset the re-read prompt");
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
          onchange={(e) => setUnit(e.currentTarget.value)}
        />
        <!-- Standing element (spec): what AniList last received, shown alongside any hint. -->
        {#if lastPushed}
          {#key lastPushed.at}
            <span class="text-xs text-gray-500 dark:text-gray-400">
              Last pushed {resolvedUnit === 'chapters' ? 'ch.' : 'vol.'}
              {lastPushed.n} · {formatPushedAt(lastPushed.at)}
            </span>
          {/key}
        {/if}
      </div>
      <span class="text-xs text-gray-500 dark:text-gray-400">
        Detected from the archive names; override if wrong. Saved with the series.
      </span>
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
