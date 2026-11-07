<script lang="ts" module>
  /** How often the open-for time refreshes while the prompt is up. */
  export const REFRESH_MS = 10_000;
</script>

<script lang="ts">
  import { AWAY_AFTER_MS, livePause, type LivePause } from '$lib/reading-history/pause-watch';
  import type { PauseAnswer } from '$lib/reading-history/pause-answer';

  /**
   * The open page reached its cutoff, so the timer stopped (phase 3b). It is
   * non-modal and keyboard-neutral, like the position banner, so reading goes
   * on underneath. Nothing needs an answer: a page turn, a hidden tab, Close
   * or "Keep" all leave the time counted up to the cutoff, which is what the
   * timer always did. "Still reading" counts the rest too and teaches the
   * automatic cutoff this pace. If the reader comes back a while later, the
   * copy says how long the page was open and offers to count all of it or
   * none. The box keeps one width and Close one place, so the copy changing
   * and the refreshing time never move anything around it.
   */
  let { onAnswer }: { onAnswer: (answer: PauseAnswer) => void } = $props();

  /** The view (by `since`) answered here: hidden even before the reader clears the store. */
  let settled = $state<number | null>(null);
  let pause = $derived<LivePause | null>(
    $livePause && $livePause.since !== settled ? $livePause : null
  );

  let now = $state(Date.now());
  // Before the DOM updates, so the first paint already shows the right copy.
  $effect.pre(() => {
    if (!pause) return;
    now = Date.now();
    const id = setInterval(() => (now = Date.now()), REFRESH_MS);
    return () => clearInterval(id);
  });

  let away = $derived(pause !== null && now - (pause.since + pause.cap) > AWAY_AFTER_MS);
  let elapsed = $derived(pause ? minutes(now - pause.since) : '');
  let counted = $derived(pause ? minutes(pause.cap) : '');

  function minutes(ms: number): string {
    const total = Math.max(1, Math.round(ms / 60_000));
    if (total < 60) return `${total} min`;
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  function answer(choice: PauseAnswer) {
    if (!pause) return;
    settled = pause.since;
    onAnswer(choice);
  }
</script>

{#if pause}
  <div
    class="fixed bottom-16 left-1/2 z-20 flex w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2 rounded-lg px-4 py-3 text-sm text-white shadow-lg"
    style="backdrop-filter: blur(8px); background-color: rgba(17, 24, 39, 0.9);"
    role="status"
    data-testid="long-pause"
  >
    <div class="flex items-start gap-3">
      <p class="min-w-0 flex-1">
        {#if away}
          This page was open {elapsed}. {counted} counted.
        {:else}
          No page turn for {counted}, so the timer stopped.
        {/if}
      </p>
      <button
        type="button"
        class="relative z-10 -mt-1 -mr-2 shrink-0 rounded px-2 py-1 text-gray-400 hover:text-white"
        aria-label="Close"
        title="Keep {counted}"
        onclick={() => answer('keep')}>✕</button
      >
    </div>
    <div class="relative z-10 flex flex-wrap items-center gap-2">
      {#if away}
        <button
          type="button"
          class="rounded bg-primary-700 px-3 py-1 font-medium hover:bg-primary-600"
          onclick={() => answer('keep')}>Keep {counted}</button
        >
        <button
          type="button"
          class="rounded bg-gray-700 px-3 py-1 hover:bg-gray-600"
          onclick={() => answer('all')}>Count all {elapsed}</button
        >
        <button
          type="button"
          class="rounded bg-gray-700 px-3 py-1 hover:bg-gray-600"
          onclick={() => answer('none')}>Count none</button
        >
      {:else}
        <button
          type="button"
          class="rounded bg-primary-700 px-3 py-1 font-medium hover:bg-primary-600"
          onclick={() => answer('still-reading')}>Still reading</button
        >
      {/if}
      <button
        type="button"
        class="ml-auto rounded px-2 py-1 text-xs text-gray-400 hover:text-white hover:underline"
        onclick={() => answer('stop-asking')}>Don’t ask again</button
      >
    </div>
  </div>
{/if}
