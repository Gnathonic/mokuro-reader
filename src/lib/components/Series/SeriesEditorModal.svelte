<!-- src/lib/components/Series/SeriesEditorModal.svelte -->
<script lang="ts">
  /**
   * One place for every series-level control: folder rename, AniList link/tag/sidecars and
   * tracking. Mounted once globally (src/routes/+layout.svelte) and driven by
   * `seriesEditorModalStore`, exactly like VolumeEditorModal.
   */
  import { Button, Modal } from 'flowbite-svelte';
  import {
    seriesEditorModalStore,
    closeSeriesEditor,
    confirmationPopupStore
  } from '$lib/util/modals';
  import { catalog } from '$lib/catalog';
  import { seriesMetadataMap } from '$lib/metadata/store';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import { resolveDisplayTitle } from '$lib/metadata/display-title';
  import { preferredTitleLanguage } from '$lib/settings/settings';
  import { nav, currentView } from '$lib/util/hash-router';
  import { showSnackbar } from '$lib/util';
  import type { Series } from '$lib/catalog/catalog';
  import type { DisplayTitleLanguage, SeriesMetadata } from '$lib/metadata/types';
  import SeriesRenameField from './SeriesRenameField.svelte';
  import SeriesLinkControls from './SeriesLinkControls.svelte';
  import SeriesTitlesEditor from './SeriesTitlesEditor.svelte';
  import SeriesSpineShowcase from './SeriesSpineShowcase.svelte';
  import SeriesTrackingPanel from './SeriesTrackingPanel.svelte';

  let open = $state(false);
  // The nested AniList modal. Escape must close only the top-most modal, so the guard
  // below stands down while this (or a confirmation popup) is on top.
  let linkOpen = $state(false);

  let modalState = $derived($seriesEditorModalStore);
  /** Raw folder title — the identity every series flow keys off. */
  let seriesTitle = $derived(modalState?.seriesTitle ?? '');

  // One-way sync store → dialog. Local closes (X, outsideclose, Close, Escape) go through
  // handleClose(), which clears the store, so this effect never fights them.
  $effect(() => {
    open = !!modalState?.open;
  });

  // Subscribe to the library only while the editor is open. This component is mounted
  // globally (+layout), and `catalog` re-groups + re-sorts every series on each emission —
  // an always-on `$catalog` here would make the reader pay for that too.
  let catalogSeries = $state<Series[] | null>(null);
  let metaMap = $state(new Map<string, SeriesMetadata>());
  let titlePref = $state<DisplayTitleLanguage>('imported');
  $effect(() => {
    if (!open) return;
    const unsubscribes = [
      catalog.subscribe((value) => (catalogSeries = value)),
      seriesMetadataMap.subscribe((value) => (metaMap = value)),
      preferredTitleLanguage.subscribe((value) => (titlePref = value))
    ];
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  });

  let series = $derived.by(() => {
    if (!seriesTitle) return undefined;
    const key = normalizeSeriesKey(seriesTitle);
    return (catalogSeries ?? []).find((s) => normalizeSeriesKey(s.title) === key);
  });
  // Includes placeholders on purpose: the downstream components already filter them
  // (sidecar refresh) or count them (tracking).
  let volumes = $derived(series?.volumes ?? []);
  let seriesUuid = $derived(series?.series_uuid ?? volumes[0]?.series_uuid ?? '');
  let meta = $derived(seriesTitle ? metaMap.get(normalizeSeriesKey(seriesTitle)) : undefined);
  let displayTitle = $derived(seriesTitle ? resolveDisplayTitle(seriesTitle, meta, titlePref) : '');

  /**
   * The next series in catalog order (wrapping) that still has no AniList link — the
   * "link my whole library" loop. Computed only while the modal is open so the catalog
   * page never pays for it (CLAUDE.md: no per-card heavy `$derived`).
   */
  let nextUnlinked = $derived.by(() => {
    if (!open || !seriesTitle) return undefined;
    const list = catalogSeries ?? [];
    if (list.length === 0) return undefined;
    const key = normalizeSeriesKey(seriesTitle);
    const currentIndex = list.findIndex((s) => normalizeSeriesKey(s.title) === key);
    for (let step = 1; step <= list.length; step++) {
      const candidate = list[(currentIndex + step + list.length) % list.length];
      if (!candidate || normalizeSeriesKey(candidate.title) === key) continue;
      const candidateMeta = metaMap.get(normalizeSeriesKey(candidate.title));
      if (candidateMeta?.external_ids?.anilist == null) return candidate;
    }
    return undefined;
  });

  function goToNextUnlinked() {
    const next = nextUnlinked;
    if (!next) return;
    seriesEditorModalStore.update((s) => (s ? { ...s, seriesTitle: next.title } : s));
  }

  function handleRenamed(finalTitle: string) {
    const oldTitle = seriesTitle;
    const oldUuid = seriesUuid;
    seriesEditorModalStore.update((s) => (s ? { ...s, seriesTitle: finalTitle } : s));
    showSnackbar(`Renamed to "${finalTitle}"`);
    // Only re-point the URL when the page behind the modal IS this series' page. The view type
    // has to be checked, not just `routeParams.manga`: reader / volume-text / series-text all
    // carry a `manga` param too, and navigating those to the series page would yank the reader
    // out from under the user. `seriesId` is the folder title, but SeriesView also resolves it
    // by series_uuid, so accept either.
    const view = $currentView;
    if (
      view.type === 'series' &&
      (normalizeSeriesKey(view.seriesId) === normalizeSeriesKey(oldTitle) ||
        view.seriesId === oldUuid)
    ) {
      nav.toSeries(finalTitle, { replaceState: true });
    }
  }

  function handleClose() {
    open = false;
    linkOpen = false;
    const value = $seriesEditorModalStore;
    if (!value) return; // already closed (the dialog's own onclose can fire after ours)
    // Flush a focused field's draft while `seriesTitle` is still valid. Blurring here
    // (before the store is cleared below) makes the field's own onblur handler save
    // normally; otherwise the field loses focus later — dialog teardown, unmount — after
    // the store has already gone blank, and the guarded save just drops the edit instead
    // (see SeriesTitlesEditor.svelte / SeriesLinkControls.svelte's `ownerSeriesTitle`
    // check).
    //
    // Two guards: this runs BELOW the re-entry check (the dialog's own onclose calls us a
    // second time, by which point focus has already returned to whatever opened the
    // editor), and only for focus still inside the dialog — otherwise that second pass
    // would blur the trigger and leave the page with nothing focused.
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest?.('dialog')) active.blur?.();
    closeSeriesEditor();
    value.onClose?.();
  }

  // Capture Escape so it doesn't propagate to the series page's back-navigation handler.
  // Stands down while a modal opened FROM here is on top, so Escape closes that one first.
  $effect(() => {
    if (!open) return;

    function handleKeydown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // A modal opened FROM here is on top: let IT handle Escape (don't preventDefault), but
      // still stop the key from reaching the page underneath, whose bubble-phase handler would
      // navigate back to the catalog.
      if (linkOpen || $confirmationPopupStore?.open) {
        e.stopPropagation();
        return;
      }
      // A field that reverts its own draft on Escape (the folder name) gets first refusal.
      // This listener is capture-phase, so it must NOT stopPropagation here or the key would
      // never reach the field at all; the field stops it before the page sees it.
      if ((e.target as HTMLElement | null)?.closest?.('[data-escape-reverts]')) return;
      e.stopPropagation();
      e.preventDefault();
      handleClose();
    }

    window.addEventListener('keydown', handleKeydown, true);
    return () => window.removeEventListener('keydown', handleKeydown, true);
  });
</script>

<Modal bind:open size="lg" outsideclose onclose={handleClose}>
  {#if seriesTitle}
    <div class="flex flex-col gap-5 p-2 text-sm">
      <h3 class="text-xl font-semibold text-gray-900 dark:text-white">{displayTitle}</h3>

      <!-- Keyed on the folder title: "Next unlinked series →" and a successful rename both
           re-point this modal at a different series, and the per-series local state inside
           (rename draft, tag draft, "sidecars out of date") must not carry over. -->
      {#key seriesTitle}
        <SeriesRenameField {seriesTitle} {seriesUuid} onRenamed={handleRenamed} />

        <section class="flex flex-col gap-2 border-t border-gray-200 pt-4 dark:border-gray-700">
          <h4 class="text-xs font-semibold text-gray-500 uppercase dark:text-gray-400">
            Titles &amp; AniList
          </h4>
          <SeriesLinkControls {seriesTitle} {volumes} bind:linkOpen />
          <SeriesTitlesEditor {seriesTitle} />
        </section>

        <section class="flex flex-col gap-2 border-t border-gray-200 pt-4 dark:border-gray-700">
          <h4 class="text-xs font-semibold text-gray-500 uppercase dark:text-gray-400">Shelf</h4>
          <SeriesSpineShowcase {seriesTitle} {volumes} />
        </section>

        <section class="flex flex-col gap-2 border-t border-gray-200 pt-4 dark:border-gray-700">
          <h4 class="text-xs font-semibold text-gray-500 uppercase dark:text-gray-400">
            Tracking &amp; re-reads
          </h4>
          <SeriesTrackingPanel {seriesTitle} {volumes} />
        </section>
      {/key}

      <!-- relative z-10: night-mode filter on <dialog> creates a stacking context -->
      <div
        class="relative z-10 flex items-center justify-between gap-2 border-t border-gray-200 pt-4 dark:border-gray-700"
      >
        <div>
          {#if nextUnlinked}
            <Button size="sm" color="light" onclick={goToNextUnlinked}>
              Next unlinked series →
            </Button>
          {/if}
        </div>
        <Button color="alternative" onclick={handleClose}>Close</Button>
      </div>
    </div>
  {/if}
</Modal>
