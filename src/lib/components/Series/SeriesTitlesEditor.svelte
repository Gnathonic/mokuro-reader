<!-- src/lib/components/Series/SeriesTitlesEditor.svelte -->
<script lang="ts">
  /**
   * Manual alt titles + synonyms editor. Self-published/Kindle-only series are in no
   * database, so users type these by hand — the fields feed the display overlay, catalog
   * search and the `.mokuro` embed automatically (the same `SeriesMetadata` fields an
   * AniList link would otherwise populate). Works for linked AND unlinked series; linking
   * replaces whatever is typed here (hence the helper line below the fields).
   *
   * Same draft/dirty pattern as the tag field in SeriesLinkControls: each field keeps its
   * own draft + dirty flag so a liveQuery emission mid-edit doesn't clobber unsaved typing,
   * and each saves on blur/Enter only when its value actually changed.
   */
  import { Label } from 'flowbite-svelte';
  import { seriesMetadataMap, updateSeriesMetadata } from '$lib/metadata/store';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import type { SeriesTitles } from '$lib/metadata/types';

  let { seriesTitle }: { seriesTitle: string } = $props();

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

  /**
   * Any of the three inputs blurring saves the whole group — `titles` is replaced wholesale
   * by `updateSeriesMetadata` (not deep-merged), so the patch always carries the current
   * value of all three, with blank ones omitted (blank all three -> `titles: {}`).
   */
  async function saveTitles() {
    nativeDirty = false;
    romajiDirty = false;
    englishDirty = false;
    const titles: SeriesTitles = {};
    const native = nativeDraft.trim();
    const romaji = romajiDraft.trim();
    const english = englishDraft.trim();
    if (native) titles.native = native;
    if (romaji) titles.romaji = romaji;
    if (english) titles.english = english;
    if (titlesEqual(titles, meta?.titles ?? {})) return;
    await updateSeriesMetadata(seriesTitle, { titles });
  }

  /** Enter commits the field like the tag field does, without adding a form submit. */
  function handleTitleKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    (e.currentTarget as HTMLInputElement).blur();
  }

  function parseSynonyms(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of text.split(/[\n,]+/)) {
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

  async function saveSynonyms() {
    synonymsDirty = false;
    const synonyms = parseSynonyms(synonymsDraft);
    if (synonymsEqual(synonyms, meta?.synonyms ?? [])) return;
    await updateSeriesMetadata(seriesTitle, { synonyms });
  }
</script>

<div class="flex flex-col gap-2">
  <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
    <div class="flex flex-col gap-1">
      <Label class="text-xs text-gray-500 uppercase">Native</Label>
      <input
        type="text"
        aria-label="Native"
        value={nativeDraft}
        oninput={(e) => {
          nativeDirty = true;
          nativeDraft = (e.currentTarget as HTMLInputElement).value;
        }}
        onblur={saveTitles}
        onkeydown={handleTitleKeydown}
        class="min-w-0 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-gray-900 focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:border-primary-500 dark:focus:ring-primary-500"
      />
    </div>
    <div class="flex flex-col gap-1">
      <Label class="text-xs text-gray-500 uppercase">Romaji</Label>
      <input
        type="text"
        aria-label="Romaji"
        value={romajiDraft}
        oninput={(e) => {
          romajiDirty = true;
          romajiDraft = (e.currentTarget as HTMLInputElement).value;
        }}
        onblur={saveTitles}
        onkeydown={handleTitleKeydown}
        class="min-w-0 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-gray-900 focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:border-primary-500 dark:focus:ring-primary-500"
      />
    </div>
    <div class="flex flex-col gap-1">
      <Label class="text-xs text-gray-500 uppercase">English</Label>
      <input
        type="text"
        aria-label="English"
        value={englishDraft}
        oninput={(e) => {
          englishDirty = true;
          englishDraft = (e.currentTarget as HTMLInputElement).value;
        }}
        onblur={saveTitles}
        onkeydown={handleTitleKeydown}
        class="min-w-0 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-gray-900 focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:border-primary-500 dark:focus:ring-primary-500"
      />
    </div>
  </div>

  <div class="flex flex-col gap-1">
    <Label class="text-xs text-gray-500 uppercase">Synonyms</Label>
    <textarea
      aria-label="Synonyms"
      rows="2"
      value={synonymsDraft}
      oninput={(e) => {
        synonymsDirty = true;
        synonymsDraft = (e.currentTarget as HTMLTextAreaElement).value;
      }}
      onblur={saveSynonyms}
      placeholder="Comma- or newline-separated"
      class="min-w-0 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-gray-900 focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:border-primary-500 dark:focus:ring-primary-500"
    ></textarea>
  </div>

  <p class="text-xs text-gray-500 dark:text-gray-400">Linking to AniList replaces these.</p>
</div>
