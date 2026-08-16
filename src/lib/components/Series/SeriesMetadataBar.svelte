<!-- src/lib/components/Series/SeriesMetadataBar.svelte -->
<script lang="ts">
  import { Button, Badge, Spinner } from 'flowbite-svelte';
  import { ArrowUpRightFromSquareOutline } from 'flowbite-svelte-icons';
  import { seriesMetadataMap, updateSeriesMetadata, unlinkSeries } from '$lib/metadata/store';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import { getLinkTargets } from '$lib/metadata/link-targets';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import { providerManager } from '$lib/util/sync';
  import { showSnackbar } from '$lib/util';
  import { ProviderError } from '$lib/util/sync/provider-interface';
  import type { VolumeMetadata } from '$lib/types';
  import SeriesLinkModal from './SeriesLinkModal.svelte';

  let { seriesTitle, volumes }: { seriesTitle: string; volumes: VolumeMetadata[] } = $props();

  let meta = $derived($seriesMetadataMap.get(normalizeSeriesKey(seriesTitle)));
  let linked = $derived(!!meta && Object.values(meta.external_ids ?? {}).some((v) => v != null));
  let links = $derived(meta ? getLinkTargets(meta.external_ids) : []);
  let altTitles = $derived.by(() => {
    if (!meta) return [] as string[];
    const seen = new Set<string>([normalizeSeriesKey(seriesTitle)]);
    const out: string[] = [];
    for (const t of [meta.titles.native, meta.titles.romaji, meta.titles.english]) {
      if (t && !seen.has(normalizeSeriesKey(t))) {
        seen.add(normalizeSeriesKey(t));
        out.push(t);
      }
    }
    return out;
  });

  let linkOpen = $state(false);
  // Set after any link/tag/unlink change; cleared by a successful refresh. Drives the
  // "out of date" hint next to the Update button (spec: the offer to refresh).
  let sidecarsStale = $state(false);
  let tagDraft = $state('');
  let tagDirty = $state(false);
  let refreshing = $state(false);

  // Keep the tag field in step with the record unless the user is mid-edit
  $effect(() => {
    if (!tagDirty) tagDraft = meta?.tag ?? '';
  });

  async function saveTag() {
    const next = tagDraft.trim();
    if ((meta?.tag ?? '') === next) {
      tagDirty = false;
      return;
    }
    await updateSeriesMetadata(seriesTitle, { tag: next || undefined });
    tagDirty = false;
    sidecarsStale = true;
  }

  async function onUnlink() {
    await unlinkSeries(seriesTitle);
    showSnackbar('Unlinked from AniList');
    sidecarsStale = true;
  }

  // Reactive "is a cloud provider connected" state. providerManager.getActiveProvider() reads a
  // plain private field with no reactive subscription, so it can't drive a $derived — mirror
  // SeriesView.svelte's pattern instead: subscribe to the same providerManager.status store it
  // uses for `hasAnyProvider`/`isCloudReady`.
  let hasCloud = $state(false);
  $effect(() => {
    return providerManager.status.subscribe((value) => {
      hasCloud = value.hasAnyAuthenticated;
    });
  });

  async function refreshSidecars() {
    refreshing = true;
    try {
      const result = await unifiedCloudManager.refreshSeriesSidecars(
        seriesTitle,
        volumes
          .filter((v) => !v.isPlaceholder)
          .map((v) => ({ volumeUuid: v.volume_uuid, volumeTitle: v.volume_title }))
      );
      const { succeeded, failed, skipped } = result;
      const total = succeeded + failed;
      if (failed === 0) sidecarsStale = false;
      const skippedSuffix = skipped > 0 ? ` (${skipped} skipped — no backed-up .mokuro)` : '';
      if (total === 0) {
        showSnackbar(
          skipped > 0
            ? `No backed-up .mokuro files to update (${skipped} skipped)`
            : 'No backed-up volumes to update'
        );
      } else if (failed === 0) {
        showSnackbar(
          `Updated ${succeeded} cloud sidecar${succeeded === 1 ? '' : 's'}${skippedSuffix}`
        );
      } else {
        showSnackbar(
          `Updated ${succeeded}/${total} cloud sidecars (${failed} failed)${skippedSuffix}`
        );
      }
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'READ_ONLY') {
        showSnackbar('Your cloud provider is read-only — sidecars were not updated');
      } else {
        console.error('Sidecar refresh failed:', error);
        showSnackbar("Couldn't update cloud sidecars. Check your connection and try again.");
      }
    } finally {
      refreshing = false;
    }
  }
</script>

<div class="flex flex-col gap-2 px-2 text-sm">
  {#if altTitles.length > 0}
    <div class="text-gray-500 dark:text-gray-400">{altTitles.join(' · ')}</div>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    {#each links as l (l.provider)}
      <a href={l.url} target="_blank" rel="noopener noreferrer" class="inline-flex">
        <Badge color="blue" class="cursor-pointer">
          <ArrowUpRightFromSquareOutline class="me-1 h-3 w-3" />{l.label}
        </Badge>
      </a>
    {/each}

    {#if linked}
      <Button size="xs" color="light" onclick={() => (linkOpen = true)}>Change</Button>
      <Button size="xs" color="light" onclick={onUnlink}>Unlink</Button>
    {:else}
      <Button size="xs" color="light" onclick={() => (linkOpen = true)}>Link…</Button>
    {/if}

    <label class="ml-auto flex items-center gap-1">
      <span class="text-gray-500 dark:text-gray-400">Tag</span>
      <input
        type="text"
        value={tagDraft}
        oninput={(e) => {
          tagDirty = true;
          tagDraft = (e.currentTarget as HTMLInputElement).value;
        }}
        onblur={saveTag}
        onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
        placeholder="[color]"
        class="w-32 rounded border border-gray-300 bg-gray-50 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700"
      />
    </label>

    {#if hasCloud}
      <Button
        size="xs"
        color="light"
        onclick={refreshSidecars}
        disabled={refreshing}
        title="Rewrite the .mokuro of every backed-up volume with the current link and tag"
      >
        {#if refreshing}<Spinner size="4" class="me-1" />{/if}
        Update cloud sidecars
      </Button>
      {#if sidecarsStale}
        <span class="text-xs text-amber-600 dark:text-amber-400"
          >Cloud .mokuro files are out of date</span
        >
      {/if}
    {/if}
  </div>
</div>

<SeriesLinkModal bind:open={linkOpen} {seriesTitle} onLinked={() => (sidecarsStale = true)} />
