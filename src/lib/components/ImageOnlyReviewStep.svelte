<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from 'flowbite-svelte';
  import { CloseOutline } from 'flowbite-svelte-icons';
  import { locateVolume, storedTitle } from '$lib/import/image-only-naming';
  import {
    canonicalSeriesTitle,
    nameGroup,
    type LibrarySeries,
    type NamingMode,
    type ReviewGroup
  } from '$lib/import/image-only-review';
  import { existingVolumeCount } from '$lib/import/library-series';
  import type { GroupDecision } from '$lib/import/review-session';
  import { updateMiscSetting } from '$lib/settings/misc';

  interface Props {
    group: ReviewGroup;
    step: number;
    total: number;
    library: LibrarySeries[];
    initialMode: NamingMode;
    onDecide: (decision: GroupDecision) => void;
    onSkipAll: () => void;
  }

  let { group, step, total, library, initialMode, onDecide, onSkipAll }: Props = $props();

  // The dialog re-creates this step per group ({#key}), so these start from
  // the group once and are the user's from then on.
  // svelte-ignore state_referenced_locally
  let series = $state(group.series);
  // svelte-ignore state_referenced_locally
  let mode = $state<NamingMode>(initialMode);
  // svelte-ignore state_referenced_locally
  let start = $state(group.existingCount + 1);
  let startEdited = $state(false);
  let seriesEdited = $state(false);
  let overrides = $state<Record<string, string>>({});

  const names = $derived(nameGroup(group, { series, mode, start, overrides }));
  const canImport = $derived(series.trim().length > 0);

  let countRequest = 0;
  let countTimer: ReturnType<typeof setTimeout> | undefined;
  // The (trimmed) series `start` was last counted for: the group's own count
  // is its default series'. Import never decides on a count for another name.
  // svelte-ignore state_referenced_locally
  let countedFor = group.series.trim();
  // Import is waiting on that count: every other decision from this step waits.
  let deciding = $state(false);
  let destroyed = false;
  let root: HTMLElement | undefined = $state();

  /** Count `target`'s volumes now; the start follows unless it was typed or the name moved on. */
  async function countSeries(target: string, request: number) {
    const count = await existingVolumeCount(target, group.ownUuids);
    if (request === countRequest && !startEdited && !destroyed) {
      start = count + 1;
      countedFor = target;
    }
  }

  /** A new series name: numbering follows that series' volumes unless the start was typed. */
  function setSeries(value: string) {
    series = value;
    clearTimeout(countTimer);
    const request = ++countRequest;
    const target = value.trim();
    countTimer = setTimeout(() => {
      countSeries(target, request).catch((error) =>
        console.error('[Import] Could not count the series volumes:', error)
      );
    }, 200);
  }

  // The count the group was offered with can be stale by the time this step
  // is on screen: a step decided before it may have approved volumes of the
  // same series (a second pick appended behind the first). Recount once now.
  onMount(() => {
    countSeries(group.series.trim(), ++countRequest).catch((error) =>
      console.error('[Import] Could not count the series volumes:', error)
    );
  });

  // A step that REPLACES a decided one ignores activation for a moment: its
  // Import takes focus at once, so a double click or a second Enter aimed at
  // the previous step would otherwise decide this series unseen.
  const ARM_DELAY_MS = 300;
  // svelte-ignore state_referenced_locally
  let armed = $state(step <= 1);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  onMount(() => {
    if (!armed) armTimer = setTimeout(() => (armed = true), ARM_DELAY_MS);
  });

  /** A held Enter auto-repeats: never let a repeat activate a button. */
  function keydown(event: KeyboardEvent) {
    if (event.repeat && event.key === 'Enter') event.preventDefault();
  }

  $effect(() => () => {
    destroyed = true;
    clearTimeout(countTimer);
    clearTimeout(armTimer);
  });

  // A new step takes focus on its Import, as the dialog's first step does:
  // the previous step's DOM (and its focus) is gone, and the next Tab from
  // <body> would land on the skip-all close button. (On the first step the
  // dialog is not shown yet; Flowbite focuses [data-autofocus] itself.)
  $effect(() => {
    root?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  });

  // Once the library has loaded, an untouched series field takes the
  // library's spelling of the series it names ("killing bites").
  $effect(() => {
    if (seriesEdited) return;
    const canonical = canonicalSeriesTitle(library, series);
    if (canonical && canonical !== series) setSeries(canonical);
  });

  function seriesInput(value: string) {
    seriesEdited = true;
    setSeries(value);
  }

  function seriesBlur() {
    const canonical = canonicalSeriesTitle(library, series);
    if (canonical && canonical !== series) setSeries(canonical);
  }

  function startInput(value: string) {
    startEdited = true;
    const n = Number.parseInt(value, 10);
    if (Number.isInteger(n) && n >= 1) start = n;
  }

  function nameBlur(id: string) {
    if (!overrides[id]?.trim()) delete overrides[id];
  }

  async function importGroup() {
    if (!canImport || deciding || !armed) return;
    deciding = true;
    // The click's own mousedown may have just blurred the series field, whose
    // canonical spelling then only SCHEDULED its count; a keyboard Import never
    // blurred it at all. Settle the name, then count exactly that name.
    seriesBlur();
    const final = series.trim();
    if (!startEdited && countedFor !== final) {
      clearTimeout(countTimer);
      const request = ++countRequest;
      let count: number;
      try {
        count = await existingVolumeCount(final, group.ownUuids);
      } catch (error) {
        console.error('[Import] Could not count the series volumes:', error);
        if (!destroyed) deciding = false;
        return;
      }
      // Torn down meanwhile (Escape, close): this group was decided already.
      if (destroyed) return;
      if (request === countRequest && !startEdited) {
        start = count + 1;
        countedFor = final;
      }
    }
    if (destroyed) return;
    updateMiscSetting('keepFolderNamesAsTitles', mode === 'folder');
    const typed: Record<string, string> = {};
    for (const [id, name] of Object.entries(overrides)) if (name.trim()) typed[id] = name;
    onDecide({
      action: 'import',
      naming: { series: final, mode, start, overrides: typed }
    });
  }

  function skipGroup() {
    if (deciding || !armed) return;
    deciding = true;
    onDecide({ action: 'skip' });
  }

  /**
   * Bound to the VISUAL viewport, which shrinks when a phone raises its
   * keyboard, so the buttons below the list stay on screen while a name is
   * being edited.
   */
  function fitVisualViewport(node: HTMLElement) {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => node.style.setProperty('--review-vvh', `${viewport.height}px`);
    update();
    viewport.addEventListener('resize', update);
    return { destroy: () => viewport.removeEventListener('resize', update) };
  }
</script>

<div
  bind:this={root}
  use:fitVisualViewport
  class="flex flex-col gap-3"
  style="max-height: min(80svh, calc(var(--review-vvh, 100svh) - 5rem))"
  data-testid="review-step-body"
  data-armed={armed}
  role="presentation"
  onkeydown={keydown}
>
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <p
        class="text-xs font-medium tracking-wide text-gray-500 uppercase dark:text-gray-400"
        data-testid="review-step"
      >
        Series {step} of {total}
      </p>
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">Import without OCR text</h3>
      <p class="text-sm text-gray-600 dark:text-gray-400">
        {group.candidates.length}
        {group.candidates.length === 1 ? 'volume has' : 'volumes have'} no .mokuro file.
      </p>
    </div>
    <button
      type="button"
      class="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-600 dark:hover:text-white"
      aria-label="Close and skip all remaining"
      data-testid="review-close"
      onclick={onSkipAll}
    >
      <CloseOutline class="h-5 w-5" />
    </button>
  </div>

  <label class="flex flex-col gap-1 text-sm">
    <span class="font-medium text-gray-700 dark:text-gray-300">Series</span>
    <input
      type="text"
      list="review-series-{group.id}"
      autocomplete="off"
      enterkeyhint="done"
      data-testid="review-series"
      class="w-full rounded-lg border border-gray-300 bg-gray-50 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
      value={series}
      oninput={(e) => seriesInput(e.currentTarget.value)}
      onblur={seriesBlur}
    />
    <datalist id="review-series-{group.id}">
      {#each library as entry (entry.title)}
        <option value={entry.title}>{entry.count} {entry.count === 1 ? 'volume' : 'volumes'}</option
        >
      {/each}
    </datalist>
  </label>

  <div class="flex flex-wrap items-center gap-3">
    <div
      class="inline-flex rounded-lg border border-gray-200 p-0.5 dark:border-gray-600"
      role="radiogroup"
      aria-label="Volume names"
    >
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'cleaned'}
        class="rounded-md px-3 py-1 text-sm {mode === 'cleaned'
          ? 'bg-blue-600 text-white'
          : 'text-gray-700 dark:text-gray-300'}"
        onclick={() => (mode = 'cleaned')}
      >
        Cleaned up
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'folder'}
        class="rounded-md px-3 py-1 text-sm {mode === 'folder'
          ? 'bg-blue-600 text-white'
          : 'text-gray-700 dark:text-gray-300'}"
        onclick={() => (mode = 'folder')}
      >
        Folder names
      </button>
    </div>
    {#if mode === 'cleaned'}
      <label class="flex items-center gap-2 text-sm">
        <span class="text-gray-700 dark:text-gray-300">Start at</span>
        <input
          type="number"
          inputmode="numeric"
          min="1"
          data-testid="review-start"
          class="w-20 rounded-lg border border-gray-300 bg-gray-50 p-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
          value={start}
          oninput={(e) => startInput(e.currentTarget.value)}
        />
      </label>
    {/if}
  </div>
  <p class="text-xs text-gray-500 dark:text-gray-400">
    {#if mode === 'folder'}
      Each volume's own folder or file name, exactly as written.
    {:else}
      The series name, with volumes numbered in folder order.
    {/if}
  </p>

  <ul
    class="min-h-0 flex-1 divide-y overflow-y-auto overscroll-contain rounded-lg border dark:divide-gray-600 dark:border-gray-600"
    data-testid="review-volumes"
  >
    {#each group.candidates as candidate (candidate.id)}
      {@const saved = storedTitle(names.get(candidate.id)?.volume ?? '')}
      {@const match = group.matches?.get(candidate.id)}
      <li class="flex flex-col gap-0.5 px-3 py-2">
        {#if match}
          <span class="px-1 py-0.5 text-sm text-gray-500 dark:text-gray-400"
            >{locateVolume(candidate).own}</span
          >
          <span
            class="px-1 text-xs text-gray-500 dark:text-gray-400"
            data-testid="review-volume-match"
            >{match.installed
              ? 'Already in your library'
              : 'Removed from this device — its pages come back'}</span
          >
        {:else}
          <input
            type="text"
            aria-label="Volume name"
            enterkeyhint="done"
            data-testid="review-volume-name"
            class="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm text-gray-900 focus:border-blue-500 dark:text-white"
            value={overrides[candidate.id] ?? saved}
            oninput={(e) => (overrides[candidate.id] = e.currentTarget.value)}
            onblur={() => nameBlur(candidate.id)}
          />
          {#if overrides[candidate.id]?.trim() && saved !== overrides[candidate.id]}
            <span class="px-1 text-xs text-gray-500 dark:text-gray-400">Saved as {saved}</span>
          {/if}
        {/if}
        <span
          class="truncate px-1 text-xs text-gray-400 dark:text-gray-500"
          title={candidate.source}
          data-testid="review-volume-source">{candidate.source}</span
        >
      </li>
    {/each}
  </ul>

  <div class="relative z-10 flex flex-wrap justify-end gap-2 pt-1">
    {#if total > step}
      <Button color="alternative" size="sm" onclick={onSkipAll}>Skip all remaining</Button>
    {/if}
    <Button color="alternative" size="sm" disabled={deciding} onclick={skipGroup}>Skip</Button>
    <!-- The dialog's first focus: otherwise it lands on the close button, where a
         stray Enter would skip every series still pending. -->
    <Button color="blue" size="sm" disabled={!canImport} onclick={importGroup} data-autofocus
      >Import</Button
    >
  </div>
</div>
