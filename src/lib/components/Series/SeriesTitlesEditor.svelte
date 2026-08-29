<!-- src/lib/components/Series/SeriesTitlesEditor.svelte -->
<script lang="ts">
  /**
   * Manual alt titles + synonyms editor. Self-published/Kindle-only series are in no
   * database, so users type these by hand — the fields feed the display overlay, catalog
   * search and the `series.json` sidecar automatically (the same `SeriesMetadata` fields an
   * AniList link would otherwise populate). Works for linked AND unlinked series; linking
   * replaces whatever is typed here (hence the helper line below the fields).
   *
   * Same draft/dirty pattern as the tag field in SeriesLinkControls: each field keeps its
   * own draft + dirty flag so a liveQuery emission mid-edit doesn't clobber unsaved typing.
   * Two things a plain "clear dirty after await" version gets wrong, both fixed here:
   *
   * 1. `titles` is one object (native+romaji+english together, not deep-merged by the
   *    store), so ANY of the three inputs blurring re-saves all three current drafts. If
   *    that clears all three dirty flags unconditionally once the write lands, a sibling
   *    field edited *while the write was in flight* gets its still-unsaved draft wiped by
   *    the resync effect. Fixed by snapshotting each field's value when its save starts and
   *    only clearing ITS dirty flag if the draft still matches that snapshot when the write
   *    resolves — an edit that moved on in the meantime stays dirty (and on screen).
   * 2. Two saves can be triggered close together (blur field A, then blur field B before
   *    A's write resolves). Saves are chained through `titlesSaveChain`/`synonymsSaveChain`
   *    so at most one write is ever in flight, and each queued save reads drafts fresh at
   *    the moment it actually runs (not when it was queued) — so it never re-sends a stale
   *    snapshot over a newer edit.
   */
  import { Label } from 'flowbite-svelte';
  import { seriesMetadataMap, updateSeriesMetadata } from '$lib/metadata/store';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import {
    activeMetadataPermissions,
    canEditSeriesMetadata
  } from '$lib/util/sync/metadata-permissions';
  import type { SeriesTitles } from '$lib/metadata/types';

  let { seriesTitle }: { seriesTitle: string } = $props();

  // Server-reported edit scope for THIS series (mokuro-bunko's identity endpoint). Disabled,
  // not hidden, with the reason shown below — see $lib/util/sync/metadata-permissions.ts.
  // Touches $activeMetadataPermissions so this recomputes if the scope changes after mount
  // (a slow identity check, a reconnect) — canEditSeriesMetadata reads the live value itself.
  let editGate = $derived.by(() => {
    void $activeMetadataPermissions;
    return canEditSeriesMetadata(seriesTitle);
  });

  // The series this component instance's drafts belong to, captured once at mount. The
  // host modal remounts this component (via `{#key seriesTitle}`) on every legitimate
  // series switch, so `seriesTitle` should never actually drift from this within one
  // instance's life — EXCEPT when the modal is closing (e.g. Escape) and clears its store
  // out from under a still-focused field before that field's blur has fired. Saves below
  // refuse to run once that happens, instead of writing a junk record for a blank/foreign
  // series title.
  const ownerSeriesTitle = seriesTitle;

  let meta = $derived($seriesMetadataMap.get(normalizeSeriesKey(seriesTitle)));

  let nativeDraft = $state('');
  let romajiDraft = $state('');
  let englishDraft = $state('');
  let synonymsDraft = $state('');

  let nativeDirty = $state(false);
  let romajiDirty = $state(false);
  let englishDirty = $state(false);
  let synonymsDirty = $state(false);

  // Keep each draft in step with the record unless the user is mid-edit of THAT field —
  // per-field dirty tracking so an external write (another field, another device) can still
  // refresh the fields the user isn't touching right now.
  $effect(() => {
    if (!nativeDirty) nativeDraft = meta?.titles.native ?? '';
  });
  $effect(() => {
    if (!romajiDirty) romajiDraft = meta?.titles.romaji ?? '';
  });
  $effect(() => {
    if (!englishDirty) englishDraft = meta?.titles.english ?? '';
  });
  $effect(() => {
    if (!synonymsDirty) synonymsDraft = (meta?.synonyms ?? []).join('\n');
  });

  function titlesEqual(a: SeriesTitles, b: SeriesTitles): boolean {
    return (
      (a.native ?? '') === (b.native ?? '') &&
      (a.romaji ?? '') === (b.romaji ?? '') &&
      (a.english ?? '') === (b.english ?? '')
    );
  }

  // A save-in-progress mutex: chaining through this (rather than firing each save the
  // instant a blur happens) guarantees at most one `updateSeriesMetadata` call for the
  // title group is ever in flight, so two close-together blurs can't race each other or
  // the mocked store in tests.
  let titlesSaveChain: Promise<void> = Promise.resolve();

  /**
   * Any of the three inputs blurring queues a save of the whole group (see file header).
   *
   * `seriesTitle` is captured HERE, synchronously, at blur time — not inside the queued
   * task. The task can sit behind an earlier save for a microtask or two, and by the time
   * it runs, the host modal may have already cleared its store (a close raced this blur).
   * Reading the live `seriesTitle` prop from inside the deferred task would see that
   * cleared value and wrongly drop an edit that was perfectly valid the moment the user
   * blurred the field. The drafts themselves are read fresh inside the task on purpose
   * (see runTitlesSave) — only the series identity needs this snapshot.
   */
  function saveTitles() {
    const savingFor = seriesTitle;
    // `.catch` keeps the chain usable: `runTitlesSave` handles its own write failures, but
    // anything unexpected escaping it would leave a rejected promise as the chain's tail
    // and every later blur would queue onto it and never run.
    titlesSaveChain = titlesSaveChain.then(() => runTitlesSave(savingFor)).catch(() => {});
  }

  async function runTitlesSave(savingFor: string) {
    if (!savingFor.trim() || savingFor !== ownerSeriesTitle || !editGate.allowed) return;

    // Snapshot each field's draft NOW (this save's turn, so these are already the freshest
    // values pending any earlier save in the chain) — used both to build the patch and,
    // after the write, to decide which dirty flags are still safe to clear.
    const nativeAtSave = nativeDraft.trim();
    const romajiAtSave = romajiDraft.trim();
    const englishAtSave = englishDraft.trim();
    const titles: SeriesTitles = {};
    if (nativeAtSave) titles.native = nativeAtSave;
    if (romajiAtSave) titles.romaji = romajiAtSave;
    if (englishAtSave) titles.english = englishAtSave;

    // Only mark a field clean if its draft hasn't moved since THIS save captured it — a
    // field edited while this write was in flight stays dirty (and its typed value stays
    // on screen) instead of being reset by the resync effect once this write lands.
    function settleUnchangedFields() {
      if (nativeDraft.trim() === nativeAtSave) nativeDirty = false;
      if (romajiDraft.trim() === romajiAtSave) romajiDirty = false;
      if (englishDraft.trim() === englishAtSave) englishDirty = false;
    }

    if (titlesEqual(titles, meta?.titles ?? {})) {
      settleUnchangedFields();
      return;
    }
    try {
      await updateSeriesMetadata(savingFor, { titles });
      settleUnchangedFields();
    } catch (err) {
      // Leave the fields dirty so the resync effect doesn't fall back to the stale stored
      // value and silently discard the edit; the draft stays on screen to retry.
      console.error('Failed to save series titles:', err);
    }
  }

  /** Enter commits the field like the tag field does, without adding a form submit. */
  function handleTitleKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    (e.currentTarget as HTMLInputElement).blur();
  }

  // Comma/newline plus the full-width variants (、 U+3001, ， U+FF0C) that Japanese IMEs
  // and pasted Japanese text commonly use as separators.
  const SYNONYM_SEPARATORS = /[\n,、，]+/;

  function parseSynonyms(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of text.split(SYNONYM_SEPARATORS)) {
      const trimmed = raw.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out;
  }

  function synonymsEqual(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  let synonymsSaveChain: Promise<void> = Promise.resolve();

  /** Same synchronous-capture reasoning as `saveTitles` above. */
  function saveSynonyms() {
    const savingFor = seriesTitle;
    synonymsSaveChain = synonymsSaveChain.then(() => runSynonymsSave(savingFor)).catch(() => {});
  }

  async function runSynonymsSave(savingFor: string) {
    if (!savingFor.trim() || savingFor !== ownerSeriesTitle || !editGate.allowed) return;

    const draftAtSave = synonymsDraft;
    const synonyms = parseSynonyms(draftAtSave);

    function settleIfUnchanged() {
      if (synonymsDraft === draftAtSave) synonymsDirty = false;
    }

    if (synonymsEqual(synonyms, meta?.synonyms ?? [])) {
      settleIfUnchanged();
      return;
    }
    try {
      await updateSeriesMetadata(savingFor, { synonyms });
      settleIfUnchanged();
    } catch (err) {
      console.error('Failed to save series synonyms:', err);
    }
  }
</script>

<div class="flex flex-col gap-2">
  <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
    <div class="flex flex-col gap-1">
      <Label for="series-titles-native" class="text-xs text-gray-500 uppercase">Native</Label>
      <input
        id="series-titles-native"
        type="text"
        aria-label="Native"
        value={nativeDraft}
        oninput={(e) => {
          nativeDirty = true;
          nativeDraft = (e.currentTarget as HTMLInputElement).value;
        }}
        onblur={saveTitles}
        onkeydown={handleTitleKeydown}
        disabled={!editGate.allowed}
        class="min-w-0 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-gray-900 focus:border-primary-500 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:border-primary-500 dark:focus:ring-primary-500"
      />
    </div>
    <div class="flex flex-col gap-1">
      <Label for="series-titles-romaji" class="text-xs text-gray-500 uppercase">Romaji</Label>
      <input
        id="series-titles-romaji"
        type="text"
        aria-label="Romaji"
        value={romajiDraft}
        oninput={(e) => {
          romajiDirty = true;
          romajiDraft = (e.currentTarget as HTMLInputElement).value;
        }}
        onblur={saveTitles}
        onkeydown={handleTitleKeydown}
        disabled={!editGate.allowed}
        class="min-w-0 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-gray-900 focus:border-primary-500 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:border-primary-500 dark:focus:ring-primary-500"
      />
    </div>
    <div class="flex flex-col gap-1">
      <Label for="series-titles-english" class="text-xs text-gray-500 uppercase">English</Label>
      <input
        id="series-titles-english"
        type="text"
        aria-label="English"
        value={englishDraft}
        oninput={(e) => {
          englishDirty = true;
          englishDraft = (e.currentTarget as HTMLInputElement).value;
        }}
        onblur={saveTitles}
        onkeydown={handleTitleKeydown}
        disabled={!editGate.allowed}
        class="min-w-0 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-gray-900 focus:border-primary-500 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:border-primary-500 dark:focus:ring-primary-500"
      />
    </div>
  </div>

  <div class="flex flex-col gap-1">
    <Label for="series-titles-synonyms" class="text-xs text-gray-500 uppercase">Synonyms</Label>
    <textarea
      id="series-titles-synonyms"
      aria-label="Synonyms"
      rows="2"
      value={synonymsDraft}
      oninput={(e) => {
        synonymsDirty = true;
        synonymsDraft = (e.currentTarget as HTMLTextAreaElement).value;
      }}
      onblur={saveSynonyms}
      disabled={!editGate.allowed}
      placeholder="Comma- or newline-separated"
      class="min-w-0 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-gray-900 focus:border-primary-500 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:border-primary-500 dark:focus:ring-primary-500"
    ></textarea>
  </div>

  {#if !editGate.allowed}
    <p class="text-xs text-amber-600 dark:text-amber-400">{editGate.reason}</p>
  {:else}
    <p class="text-xs text-gray-500 dark:text-gray-400">Linking to AniList replaces these.</p>
  {/if}
</div>
