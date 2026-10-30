<script lang="ts" module>
  /** "Always do this" is offered once this many pauses are answered (any volume, any device). */
  export const DONT_ASK_AFTER = 3;
  /** How often the open-for time refreshes while the prompt is up. */
  export const REFRESH_MS = 10_000;
</script>

<script lang="ts">
  import { AWAY_AFTER_MS, livePause, type LivePause } from '$lib/reading-history/pause-watch';
  import { readingStats } from '$lib/reading-history/stats-store';
  import type { PauseCount } from '$lib/reading-history/types';

  /**
   * "Still reading?" (phase 3b): the open view reached its idle cap. It is
   * non-modal and keyboard-neutral, like the position banner, so reading goes
   * on underneath. A page turn, a hidden tab or a pause ends the view
   * unanswered; the pause then waits in the review list, counted as typical.
   * If the reader comes back a while later, the copy changes to "open N min —
   * count it?". The box keeps one width, so changing copy and the refreshing
   * time never move anything around it.
   */
  let {
    onAnswer
  }: {
    onAnswer: (count: PauseCount, opts: { stillReading: boolean; always: boolean }) => void;
  } = $props();

  /** The view (by `since`) answered here: hidden even before the reader clears the store. */
  let settled = $state<number | null>(null);
  let pause = $derived<LivePause | null>(
    $livePause && $livePause.since !== settled ? $livePause : null
  );

  let now = $state(Date.now());
  let always = $state(false);
  // Before the DOM updates, so the first paint already shows the right copy.
  $effect.pre(() => {
    if (!pause) return;
    now = Date.now();
    always = false;
    const id = setInterval(() => (now = Date.now()), REFRESH_MS);
    return () => clearInterval(id);
  });

  // Counted only while a prompt is up: one pass over the listed pauses.
  let answered = $derived.by(() => {
    if (!pause) return 0;
    let n = 0;
    for (const totals of $readingStats.byVolume.values()) {
      for (const p of totals.pauses) if (p.answer !== null) n++;
    }
    return n;
  });

  let away = $derived(pause !== null && now - (pause.since + pause.cap) > AWAY_AFTER_MS);
  let elapsed = $derived(pause ? minutes(now - pause.since) : '');
  let typical = $derived(pause ? minutes(pause.typical) : '');

  function minutes(ms: number): string {
    const total = Math.max(1, Math.round(ms / 60_000));
    if (total < 60) return `${total} min`;
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  function answer(count: PauseCount, stillReading = false) {
    if (!pause) return;
    settled = pause.since;
    onAnswer(count, { stillReading, always });
  }
</script>

{#if pause}
  <div
    class="fixed bottom-16 left-1/2 z-20 flex w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg px-4 py-2 text-sm text-white shadow-lg"
    style="backdrop-filter: blur(8px); background-color: rgba(17, 24, 39, 0.9);"
    role="status"
    data-testid="long-pause"
  >
    {#if away}
      <span class="w-full">This page has been open {elapsed}. Count it?</span>
      <span class="relative z-10 flex flex-wrap gap-2">
        <button
          class="rounded bg-primary-700 px-2 py-1 font-medium hover:bg-primary-600"
          onclick={() => answer('full')}>Count all ({elapsed})</button
        >
        <button
          class="rounded bg-gray-700 px-2 py-1 hover:bg-gray-600"
          onclick={() => answer('typical')}>Count typical (~{typical})</button
        >
        <button
          class="rounded px-2 py-1 text-gray-400 hover:text-white"
          onclick={() => answer('none')}>Don't count</button
        >
      </span>
    {:else}
      <span class="w-full"
        >Still reading? The timer stopped at {minutes(pause.cap)} on this page.</span
      >
      <span class="relative z-10 flex flex-wrap gap-2">
        <button
          class="rounded bg-primary-700 px-2 py-1 font-medium hover:bg-primary-600"
          onclick={() => answer('full', true)}>Still reading</button
        >
        <button
          class="rounded bg-gray-700 px-2 py-1 hover:bg-gray-600"
          onclick={() => answer('typical')}>Count ~{typical}</button
        >
        <button
          class="rounded px-2 py-1 text-gray-400 hover:text-white"
          onclick={() => answer('none')}>Don't count</button
        >
      </span>
    {/if}
    {#if answered >= DONT_ASK_AFTER}
      <label class="relative z-10 flex items-center gap-1 text-gray-300">
        <input type="checkbox" class="rounded" bind:checked={always} />
        Always do this
      </label>
    {/if}
  </div>
{/if}
