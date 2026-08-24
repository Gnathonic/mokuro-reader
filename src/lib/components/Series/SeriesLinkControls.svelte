<!-- src/lib/components/Series/SeriesLinkControls.svelte -->
<script lang="ts">
  /**
   * The AniList block: alt titles, provider chips, Link…/Change/Unlink and the tag field.
   * Lifted out of SeriesMetadataBar so the series editor modal and the series page render
   * the same controls.
   *
   * There is no "publish to the cloud" action: edits here move the series' facts clock, and
   * `series-file-sync.ts` writes `<Series>/series.json` on its own a couple of seconds later
   * (when a writable provider is connected and the series has a backup).
   */
  import { Button, Badge } from 'flowbite-svelte';
  import { ArrowUpRightFromSquareOutline } from 'flowbite-svelte-icons';
  import { seriesMetadataMap, updateSeriesMetadata, unlinkSeries } from '$lib/metadata/store';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import { resolveDisplayBase } from '$lib/metadata/display-title';
  import { preferredTitleLanguage } from '$lib/settings/settings';
  import { getLinkTargets } from '$lib/metadata/link-targets';
  import {
    activeMetadataPermissions,
    canEditSeriesMetadata
  } from '$lib/util/sync/metadata-permissions';
  import { showSnackbar } from '$lib/util';
  import SeriesLinkModal from './SeriesLinkModal.svelte';

  let {
    seriesTitle,
    // Bindable so a host modal can suppress its own Escape guard while this nested
    // modal is on top (Escape must close only the top-most modal).
    linkOpen = $bindable(false)
  }: { seriesTitle: string; linkOpen?: boolean } = $props();

  // See SeriesTitlesEditor.svelte for why: captured once so the tag field's blur-save can
  // refuse to write once the host modal has cleared `seriesTitle` out from under it (e.g.
  // Escape closing the editor while the tag input still has focus).
  const ownerSeriesTitle = seriesTitle;

  // Server-reported edit scope for THIS series (mokuro-bunko's identity endpoint). Disabled,
  // not hidden, with the reason shown below — see $lib/util/sync/metadata-permissions.ts.
  // Touches $activeMetadataPermissions so this recomputes if the scope changes after mount
  // (a slow identity check, a reconnect) — canEditSeriesMetadata reads the live value itself.
  let editGate = $derived.by(() => {
    void $activeMetadataPermissions;
    return canEditSeriesMetadata(seriesTitle);
  });

  let meta = $derived($seriesMetadataMap.get(normalizeSeriesKey(seriesTitle)));
  let linked = $derived(!!meta && Object.values(meta.external_ids ?? {}).some((v) => v != null));
  let links = $derived(meta ? getLinkTargets(meta.external_ids) : []);
  // The title shown in the header above these controls (without its tag), so the subtitle
  // can list the OTHER names instead of repeating the one already on screen.
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

  let tagDraft = $state('');
  let tagDirty = $state(false);

  // Keep the tag field in step with the record unless the user is mid-edit
  $effect(() => {
    if (!tagDirty) tagDraft = meta?.tag ?? '';
  });

  async function saveTag() {
    if (!seriesTitle.trim() || seriesTitle !== ownerSeriesTitle || !editGate.allowed) return;
    const next = tagDraft.trim();
    if ((meta?.tag ?? '') === next) {
      tagDirty = false;
      return;
    }
    try {
      await updateSeriesMetadata(seriesTitle, { tag: next || undefined });
      tagDirty = false;
    } catch (error) {
      console.error('Error saving series tag:', error);
      showSnackbar("Couldn't save the tag. Check your connection and try again.");
    }
  }

  async function onUnlink() {
    if (!editGate.allowed) return;
    try {
      await unlinkSeries(seriesTitle);
      showSnackbar('Unlinked from AniList');
    } catch (error) {
      console.error('Error unlinking series:', error);
      showSnackbar("Couldn't unlink from AniList. Check your connection and try again.");
    }
  }
</script>

{#if altTitles.length > 0}
  <div class="text-gray-500 dark:text-gray-400">{altTitles.join(' · ')}</div>
{/if}

<!-- relative z-10: inside a modal the night-mode filter on <dialog> creates a stacking
     context, and a scrollable sibling can otherwise swallow clicks meant for these buttons -->
<div class="relative z-10 flex flex-wrap items-center gap-2">
  {#each links as l (l.provider)}
    <a href={l.url} target="_blank" rel="noopener noreferrer" class="inline-flex">
      <Badge color="blue" class="cursor-pointer">
        <ArrowUpRightFromSquareOutline class="me-1 h-3 w-3" />{l.label}
      </Badge>
    </a>
  {/each}

  {#if linked}
    <Button size="xs" color="light" disabled={!editGate.allowed} onclick={() => (linkOpen = true)}
      >Change</Button
    >
    <Button size="xs" color="light" disabled={!editGate.allowed} onclick={onUnlink}>Unlink</Button>
  {:else}
    <Button size="xs" color="light" disabled={!editGate.allowed} onclick={() => (linkOpen = true)}
      >Link…</Button
    >
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
      disabled={!editGate.allowed}
      placeholder="color"
      title={editGate.allowed
        ? 'Shown as (tag) after alt titles; folder names already include it'
        : editGate.reason}
      class="w-32 rounded border border-gray-300 bg-gray-50 px-2 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-700"
    />
  </label>
</div>

{#if !editGate.allowed}
  <p class="text-xs text-amber-600 dark:text-amber-400">{editGate.reason}</p>
{/if}

<SeriesLinkModal bind:open={linkOpen} {seriesTitle} />
