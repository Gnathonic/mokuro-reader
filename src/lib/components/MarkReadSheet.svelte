<script lang="ts">
  import { markReadSheet, type SheetVolume } from '$lib/reading-history/mark-read-flow';
  import { creditPages, estimateMinutes, formatMinutes } from '$lib/reading-history/credit';

  /**
   * The "Mark as read" sheet (#224): how many pages of a volume this app never
   * saw read, what they hold, and whether to count them. A modal on wide
   * screens, a bottom sheet under 640 px. Two buttons, each of which finishes
   * the action; ×, Escape and the backdrop cancel with nothing written.
   * Driven by `markReadSheet` (`mark-read-flow.ts`), which also acts on the
   * answer.
   *
   * Characters are an exact OCR count and never typed: only the time is an
   * estimate. "Count up to page" narrows the pages counted, and the time
   * re-estimates with it until the user types one.
   */

  let dialog: HTMLDialogElement | undefined = $state();
  let countButton: HTMLButtonElement | undefined = $state();
  let skipButton: HTMLButtonElement | undefined = $state();

  let request = $derived($markReadSheet);
  let mode = $derived(request?.mode ?? 'single');
  let speed = $derived(request?.speed ?? null);

  // Per-request state, reset whenever a new request opens.
  let shownFor: object | null = null;
  let checked = $state<string[]>([]);
  let upTo = $state(1);
  let adjustOpen = $state(false);
  let typed = $state(false);
  let typedHours = $state('');
  let typedMinutes = $state('');
  let dontAsk = $state(false);

  const number = (n: number) => n.toLocaleString();
  const pagesWord = (n: number) => `${number(n)} page${n === 1 ? '' : 's'}`;

  function creditOf(v: SheetVolume, bound: number) {
    return creditPages(v.notRead, v.pageChars, bound);
  }

  let single = $derived(mode !== 'bulk' ? request?.volumes[0] : undefined);
  let singleCredit = $derived(single ? creditOf(single, upTo) : null);

  /** Bulk: the ticked volumes that can be marked, with what each would count. */
  let bulkParts = $derived(
    mode === 'bulk' && request
      ? request.volumes
          .filter((v) => checked.includes(v.uuid) && v.pageCount > 0)
          .map((v) => creditOf(v, v.pageCount))
      : []
  );

  let pages = $derived(
    singleCredit ? singleCredit.pages.length : bulkParts.reduce((n, p) => n + p.pages.length, 0)
  );
  let chars = $derived(
    singleCredit ? singleCredit.chars : bulkParts.reduce((n, p) => n + p.chars, 0)
  );
  /** The estimate: per volume, summed (bulk). `null` = not enough reading to say. */
  let estimate = $derived.by(() => {
    if (!speed) return null;
    if (singleCredit) return estimateMinutes(singleCredit.chars, speed);
    return bulkParts.reduce((n, p) => n + (estimateMinutes(p.chars, speed) ?? 0), 0);
  });

  const parseField = (text: string) => {
    const n = Math.floor(Number(text));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  let chosenMinutes = $derived(
    typed ? parseField(typedHours) * 60 + Math.min(59, parseField(typedMinutes)) : null
  );
  let shownHours = $derived(
    typed ? typedHours : estimate === null ? '' : String(Math.floor(estimate / 60))
  );
  let shownMinutes = $derived(
    typed ? typedMinutes : estimate === null ? '' : String(estimate % 60)
  );
  let timeText = $derived(
    chosenMinutes !== null
      ? formatMinutes(chosenMinutes)
      : estimate !== null
        ? `about ${formatMinutes(estimate)}`
        : null
  );
  let lowData = $derived(speed === null);
  /**
   * Adjust reveals what is not already shown: the page bound (one volume; the
   * editor shows it from the start) and the time (shown from the start when
   * there is no estimate).
   */
  let canAdjust = $derived(mode === 'single' || (mode === 'bulk' && !lowData));
  /** "5 volumes · 768 pages · 176,912 characters · about 11 h 55 min". */
  let summary = $derived(
    [
      ...(mode === 'bulk'
        ? [`${number(checked.length)} volume${checked.length === 1 ? '' : 's'}`]
        : []),
      pagesWord(pages),
      `${number(chars)} characters`,
      ...(timeText ? [timeText] : [])
    ].join(' · ') + (timeText ? '' : '.')
  );

  let title = $derived.by(() => {
    if (mode === 'bulk') return 'Mark volumes as read';
    if (mode === 'editor') return 'Count reading done elsewhere';
    return `Mark “${single?.title ?? ''}” as read`;
  });

  let countDisabled = $derived(
    mode === 'bulk' ? checked.length === 0 : mode === 'editor' ? chars <= 0 : false
  );

  $effect(() => {
    const r = request;
    if (!dialog) return;
    if (r && r !== shownFor) {
      shownFor = r;
      checked = [...r.checked];
      upTo = r.upTo;
      adjustOpen = false;
      typed = false;
      typedHours = '';
      typedMinutes = '';
      dontAsk = false;
      if (!dialog.open) dialog.showModal();
      queueMicrotask(() => (r.focus === 'count' ? countButton : skipButton)?.focus());
    } else if (!r && dialog.open) {
      shownFor = null;
      dialog.close();
    }
  });

  // Escape cancels here and goes no further: the page under the sheet (the
  // series view, the layout) would otherwise take it as "go back".
  $effect(() => {
    if (!request) return;
    function onKeydown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
    window.addEventListener('keydown', onKeydown, true);
    return () => window.removeEventListener('keydown', onKeydown, true);
  });

  function cancel() {
    request?.answer(null);
  }

  function finish(count: boolean) {
    if (!request) return;
    request.answer({
      count,
      checked: [...checked],
      upTo,
      typedMinutes: chosenMinutes,
      dontAskAgain: mode === 'single' && dontAsk
    });
  }

  function onTimeInput(hoursInput: string, minutesInput: string) {
    typed = true;
    typedHours = hoursInput;
    typedMinutes = minutesInput;
  }

  function onUpToInput(e: Event) {
    const max = single?.pageCount ?? 1;
    const n = Math.floor(Number((e.target as HTMLInputElement).value));
    if (Number.isFinite(n)) upTo = Math.min(max, Math.max(1, n));
  }

  function toggle(uuid: string) {
    checked = checked.includes(uuid) ? checked.filter((u) => u !== uuid) : [...checked, uuid];
  }

  function rowText(v: SheetVolume): string {
    if (v.pageCount <= 0) return 'page count unknown';
    if (v.notRead.length === 0) return 'every page read here';
    if (v.notRead.length === v.pageCount) return `${pagesWord(v.pageCount)} not read here`;
    return `${number(v.notRead.length)} of ${pagesWord(v.pageCount)} not read here`;
  }

  let lead = $derived.by(() => {
    if (!single) return '';
    const n = single.pageCount;
    const k = single.notRead.length;
    if (k === n) return `None of its ${pagesWord(n)} were read in this app.`;
    return `${number(k)} of its ${pagesWord(n)} weren’t read in this app.`;
  });

  let speedText = $derived.by(() => {
    if (!speed) return '';
    const cpm = `${number(speed.charsPerMinute)} chars/min`;
    if (speed.source === 'series') return `At your speed in this series, ${cpm}.`;
    return `At your recent speed, ${cpm}${speed.rough ? ' (rough estimate)' : ''}.`;
  });
</script>

<dialog
  bind:this={dialog}
  class="m-0 mt-auto max-h-[92dvh] w-full max-w-full overflow-y-auto rounded-t-2xl bg-white p-0 text-gray-900 shadow-xl backdrop:bg-black/60 sm:m-auto sm:max-w-lg sm:rounded-2xl dark:bg-gray-800 dark:text-white"
  aria-labelledby="mark-read-sheet-title"
  data-testid="mark-read-sheet"
  onclick={(e) => {
    // A click on the dialog box itself (not its content) is the backdrop.
    if (e.target === dialog) cancel();
  }}
  oncancel={(e) => {
    e.preventDefault();
    cancel();
  }}
>
  {#if request}
    <div class="p-4 sm:p-5">
      <div class="mx-auto mb-3 h-1 w-10 rounded bg-gray-300 sm:hidden dark:bg-gray-600"></div>
      <div class="flex items-start justify-between gap-3">
        <h3 id="mark-read-sheet-title" class="text-lg font-semibold break-words">{title}</h3>
        <button
          type="button"
          class="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-2xl leading-none text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          aria-label="Cancel"
          data-testid="mark-read-cancel"
          onclick={cancel}>×</button
        >
      </div>

      {#if mode === 'bulk'}
        <ul class="mt-3 max-h-[40dvh] overflow-y-auto" data-testid="mark-read-list">
          {#each request.volumes as v (v.uuid)}
            <li>
              <label
                class="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-1 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              >
                <input
                  type="checkbox"
                  class="h-5 w-5 rounded"
                  checked={checked.includes(v.uuid)}
                  onchange={() => toggle(v.uuid)}
                />
                <span class="min-w-0 flex-1 truncate font-medium">{v.title}</span>
                <span class="shrink-0 text-sm text-gray-500 dark:text-gray-400">{rowText(v)}</span>
              </label>
            </li>
          {/each}
        </ul>
        <hr class="my-3 border-gray-200 dark:border-gray-700" />
      {:else}
        <p class="mt-2 text-gray-700 dark:text-gray-300">{lead}</p>
        <p class="font-semibold">Count them in your stats?</p>
      {/if}

      <div
        class="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-gray-600 dark:bg-gray-900"
        data-testid="mark-read-estimate"
      >
        <p class="font-semibold">{summary}</p>
        {#if lowData && !timeText}
          <p class="text-sm text-gray-600 dark:text-gray-400">
            Not enough reading here yet to estimate your time.
          </p>
        {/if}
        {#if speedText || canAdjust}
          <div class="mt-1 flex flex-wrap items-center justify-between gap-x-3 text-sm">
            <span class="text-gray-600 dark:text-gray-400">{speedText}</span>
            {#if canAdjust}
              <button
                type="button"
                class="ml-auto min-h-11 text-primary-600 hover:underline dark:text-primary-400"
                aria-expanded={adjustOpen}
                onclick={() => (adjustOpen = !adjustOpen)}
              >
                Adjust {adjustOpen ? '▴' : '▾'}{mode === 'bulk' ? ' (total time)' : ''}
              </button>
            {/if}
          </div>
        {/if}
        {#if adjustOpen || lowData || mode === 'editor'}
          <div class="mt-2 space-y-2 border-t border-gray-200 pt-2 text-sm dark:border-gray-600">
            <div class="flex flex-wrap items-center gap-2">
              <span class="w-32 text-gray-600 dark:text-gray-400"
                >{mode === 'bulk' ? 'Total time' : 'Time'}</span
              >
              <input
                type="number"
                min="0"
                inputmode="numeric"
                class="h-11 w-16 rounded-lg border-gray-300 bg-white px-2 text-sm dark:border-gray-600 dark:bg-gray-700"
                aria-label="Hours"
                data-testid="mark-read-hours"
                value={shownHours}
                oninput={(e) => onTimeInput((e.target as HTMLInputElement).value, shownMinutes)}
              />
              <span>h</span>
              <input
                type="number"
                min="0"
                max="59"
                inputmode="numeric"
                class="h-11 w-16 rounded-lg border-gray-300 bg-white px-2 text-sm dark:border-gray-600 dark:bg-gray-700"
                aria-label="Minutes"
                data-testid="mark-read-minutes"
                value={shownMinutes}
                oninput={(e) => onTimeInput(shownHours, (e.target as HTMLInputElement).value)}
              />
              <span>min</span>
              {#if lowData && !typed}
                <span class="text-xs text-gray-500 dark:text-gray-400">optional</span>
              {/if}
              {#if typed && speed}
                <button
                  type="button"
                  class="min-h-11 text-primary-600 hover:underline dark:text-primary-400"
                  onclick={() => (typed = false)}>Use estimate</button
                >
              {/if}
            </div>
            {#if mode !== 'bulk' && single && (adjustOpen || mode === 'editor')}
              <div class="flex flex-wrap items-center gap-2">
                <label for="mark-read-up-to" class="w-32 text-gray-600 dark:text-gray-400"
                  >Count up to page</label
                >
                <input
                  id="mark-read-up-to"
                  type="number"
                  min="1"
                  max={single.pageCount}
                  inputmode="numeric"
                  class="h-11 w-20 rounded-lg border-gray-300 bg-white px-2 text-sm dark:border-gray-600 dark:bg-gray-700"
                  data-testid="mark-read-up-to"
                  value={upTo}
                  oninput={onUpToInput}
                />
                <span class="text-gray-500 dark:text-gray-400">of {number(single.pageCount)}</span>
              </div>
            {/if}
          </div>
        {/if}
      </div>

      {#if mode === 'bulk'}
        <p class="mt-3 text-sm text-gray-600 dark:text-gray-400">
          Either way they’re marked read and count for your goals.
        </p>
      {:else if mode === 'single'}
        <p class="mt-3 text-sm text-gray-600 dark:text-gray-400">
          Either way it’s marked read and counts for your goals.
        </p>
        <label class="mt-2 flex min-h-11 cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            class="h-5 w-5 rounded"
            bind:checked={dontAsk}
            data-testid="mark-read-dont-ask"
          />
          Don’t ask again
        </label>
        {#if dontAsk}
          <p class="text-xs text-gray-500 dark:text-gray-400">
            Change this in Settings → Reader → Reading timer.
          </p>
        {/if}
      {/if}

      <!-- relative z-10: night mode's filter on <dialog> resets stacking (see CLAUDE.md). -->
      <div class="relative z-10 mt-4 flex flex-wrap justify-end gap-2">
        <button
          bind:this={skipButton}
          type="button"
          class="min-h-11 rounded-lg border border-gray-300 px-4 text-sm font-medium hover:bg-gray-100 focus:ring-4 focus:ring-gray-200 focus:outline-none dark:border-gray-600 dark:hover:bg-gray-700 dark:focus:ring-gray-700"
          data-testid="mark-read-skip"
          disabled={mode === 'bulk' && checked.length === 0}
          onclick={() => (mode === 'editor' ? cancel() : finish(false))}
        >
          {mode === 'editor' ? 'Cancel' : 'Don’t count'}
        </button>
        <button
          bind:this={countButton}
          type="button"
          class="min-h-11 rounded-lg bg-primary-700 px-4 text-sm font-medium text-white hover:bg-primary-800 focus:ring-4 focus:ring-primary-300 focus:outline-none disabled:opacity-50 dark:bg-primary-600 dark:hover:bg-primary-700 dark:focus:ring-primary-800"
          data-testid="mark-read-count"
          disabled={countDisabled}
          onclick={() => finish(true)}
        >
          Count them
        </button>
      </div>
    </div>
  {/if}
</dialog>
