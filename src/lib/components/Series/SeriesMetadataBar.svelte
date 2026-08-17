<!-- src/lib/components/Series/SeriesMetadataBar.svelte -->
<script lang="ts">
  /**
   * Read-only summary of series-level metadata for the series page: alt titles, link-out
   * chips, read count, and a one-line tracking status. Every EDITING control (rename,
   * AniList link/tag/sidecar refresh, tracking toggles, restart) lives only in
   * SeriesEditorModal.svelte, opened by the pencil next to the series title.
   */
  import { Badge } from 'flowbite-svelte';
  import { ArrowUpRightFromSquareOutline } from 'flowbite-svelte-icons';
  import { seriesMetadataMap } from '$lib/metadata/store';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import { resolveDisplayBase } from '$lib/metadata/display-title';
  import { getLinkTargets } from '$lib/metadata/link-targets';
  import { computeLocalPassState } from '$lib/metadata/progress-tracker';
  import { preferredTitleLanguage } from '$lib/settings/settings';
  import { volumes as volumesData } from '$lib/settings/volume-data';
  import type { VolumeMetadata } from '$lib/types';

  let { seriesTitle, volumes }: { seriesTitle: string; volumes: VolumeMetadata[] } = $props();

  let meta = $derived($seriesMetadataMap.get(normalizeSeriesKey(seriesTitle)));
  let links = $derived(meta ? getLinkTargets(meta.external_ids) : []);

  // The title shown in the header above this bar (without its tag), so the subtitle can
  // list the OTHER names instead of repeating the one already on screen.
  let displayBase = $derived(resolveDisplayBase(seriesTitle, meta, $preferredTitleLanguage));
  // Spec: the subtitle is the non-displayed languages. Whichever language the header is
  // showing is filtered out; the folder name is added back when it is not what's displayed,
  // so the real on-disk/cloud name stays visible somewhere on the page.
  let altTitles = $derived.by(() => {
    if (!meta) return [] as string[];
    const folderKey = normalizeSeriesKey(seriesTitle);
    const displayKey = normalizeSeriesKey(displayBase);
    const seen = new Set<string>([folderKey, displayKey]);
    const out: string[] = [];
    if (displayKey !== folderKey) out.push(seriesTitle);
    for (const t of [meta.titles.native, meta.titles.romaji, meta.titles.english]) {
      if (t && !seen.has(normalizeSeriesKey(t))) {
        seen.add(normalizeSeriesKey(t));
        out.push(t);
      }
    }
    return out;
  });

  // "Read N times": local passes only — placeholders were never downloaded, so they can
  // be neither read nor tracked (matches SeriesTrackingPanel's own computation).
  let localVolumes = $derived(volumes.filter((v) => !v.isPlaceholder));
  let passState = $derived(computeLocalPassState(localVolumes, $volumesData, meta));

  // Tracking only ever runs through AniList, so the status line keys off that link
  // specifically — a bare MAL link has no tracking to report.
  let trackingLinked = $derived(!!meta?.external_ids?.anilist);
  let tracking = $derived(meta?.tracking);
  let lastPushed = $derived(tracking?.last_pushed);
  let trackingStatus = $derived.by(() => {
    if (!trackingLinked) return '';
    if (!tracking?.enabled) return 'Tracking off';
    if (!lastPushed) return 'Tracking on';
    const unitLabel = tracking.unit === 'chapters' ? 'ch.' : 'vol.';
    const date = new Date(lastPushed.at);
    const dateLabel = Number.isNaN(date.getTime()) ? lastPushed.at : date.toLocaleDateString();
    return `Tracking on · last pushed ${unitLabel} ${lastPushed.n} · ${dateLabel}`;
  });
</script>

<div class="flex flex-col gap-2 px-2 text-sm">
  {#if altTitles.length > 0}
    <div class="text-gray-500 dark:text-gray-400">{altTitles.join(' · ')}</div>
  {/if}

  {#if links.length > 0}
    <div class="flex flex-wrap items-center gap-2">
      {#each links as l (l.provider)}
        <a href={l.url} target="_blank" rel="noopener noreferrer" class="inline-flex">
          <Badge color="blue" class="cursor-pointer">
            <ArrowUpRightFromSquareOutline class="me-1 h-3 w-3" />{l.label}
          </Badge>
        </a>
      {/each}
    </div>
  {/if}

  <div class="flex flex-wrap items-center gap-3 text-gray-700 dark:text-gray-300">
    <!-- Migaku/Yomitan rewrite text in place; a fresh node per value keeps the count honest -->
    {#key passState.timesRead}
      <span>Read {passState.timesRead} {passState.timesRead === 1 ? 'time' : 'times'}</span>
    {/key}
    {#if trackingStatus}
      {#key trackingStatus}
        <span class="text-xs text-gray-500 dark:text-gray-400">{trackingStatus}</span>
      {/key}
    {/if}
  </div>
</div>
