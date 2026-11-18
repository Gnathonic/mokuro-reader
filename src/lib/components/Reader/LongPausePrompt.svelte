<script lang="ts" module>
  /** How often the open-for time refreshes while the prompt is up. */
  export const REFRESH_MS = 10_000;
</script>

<script lang="ts">
  import { AWAY_AFTER_MS, livePause, type LivePause } from '#lib/reading-history/pause-watch.js';
  import type { PauseAnswer } from '#lib/reading-history/pause-answer.js';
  import { bottomOverlay } from '#lib/reader/bottom-overlay.js';

  /**
   * The open page reached its cutoff, so the timer stopped (phase 3b). It is
   * non-modal and keyboard-neutral, like the position banner, so reading goes
   * on underneath. Nothing needs an answer: a page turn, a hidden tab, Close
   * or "Keep" all leave the time counted up to the cutoff, which is what the
   * timer always did. "Still reading" counts the rest too and teaches the
   * automatic cutoff this pace. If the reader comes back a while later, the
   * copy says how long the page was open and offers to count all of it or
   * none. The box keeps one width and Close one place, so the copy changing
   * and the refreshing time never move anything around it. Nor does its
   * height: the copy turning "away" adds a line and a row of buttons on a
   * narrow screen, so the box always holds an invisible copy of the variant
   * it is NOT showing in the same grid cell, and is as tall as the taller of
   * the two from the start. It shares the bottom centre with the page image
   * panel: whichever shows up second stacks above the other
   * (`reader/bottom-overlay.ts`), so neither covers the other — and a box
   * that never grows never pushes the panel stacked above it up under a
   * slider being held.
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

  /** The away copy's minutes at the moment it first shows — what its stand-in reserves. */
  let awayElapsed = $derived(pause ? minutes(pause.cap + AWAY_AFTER_MS) : '');

  function answer(choice: PauseAnswer) {
    if (!pause) return;
    settled = pause.since;
    onAnswer(choice);
  }
</script>

<!--
  One variant of the prompt's content. `ghost` renders it as the size-only
  stand-in: no text nodes (its words are a ::before `content`, so no text or
  role query and no screen reader finds them), no buttons, invisible and inert.
-->
{#snippet body(isAway: boolean, ghost: boolean)}
  {@const open = ghost ? awayElapsed : elapsed}
  {#snippet text(words: string)}
    {#if ghost}<span class="ghost-text" data-text={words}></span>{:else}{words}{/if}
  {/snippet}
  {#snippet control(cls: string, words: string, choice: PauseAnswer, extra = {})}
    <svelte:element
      this={ghost ? 'span' : 'button'}
      type={ghost ? undefined : 'button'}
      class={cls}
      {...extra}
      onclick={ghost ? undefined : () => answer(choice)}>{@render text(words)}</svelte:element
    >
  {/snippet}
  <div class="flex items-start gap-3">
    <svelte:element this={ghost ? 'div' : 'p'} class="min-w-0 flex-1">
      {@render text(
        isAway
          ? `This page was open ${open}. ${counted} counted.`
          : `No page turn for ${counted}, so the timer stopped.`
      )}
    </svelte:element>
    {@render control(
      'relative z-10 -mt-1 -mr-2 shrink-0 rounded px-2 py-1 text-gray-400 hover:text-white',
      '✕',
      'keep',
      ghost ? {} : { 'aria-label': 'Close', title: `Keep ${counted}` }
    )}
  </div>
  <div class="relative z-10 flex flex-wrap items-center gap-2">
    {#if isAway}
      {@render control(
        'rounded bg-primary-700 px-3 py-1 font-medium hover:bg-primary-600',
        `Keep ${counted}`,
        'keep'
      )}
      {@render control(
        'rounded bg-gray-700 px-3 py-1 hover:bg-gray-600',
        `Count all ${open}`,
        'all'
      )}
      {@render control('rounded bg-gray-700 px-3 py-1 hover:bg-gray-600', 'Count none', 'none')}
    {:else}
      {@render control(
        'rounded bg-primary-700 px-3 py-1 font-medium hover:bg-primary-600',
        'Still reading',
        'still-reading'
      )}
    {/if}
    {@render control(
      'ml-auto rounded px-2 py-1 text-xs text-gray-400 hover:text-white hover:underline',
      'Don’t ask again',
      'stop-asking'
    )}
  </div>
{/snippet}

{#if pause}
  <div
    class="fixed bottom-16 left-1/2 z-20 grid w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg px-4 py-3 text-sm text-white shadow-lg"
    style="backdrop-filter: blur(8px); background-color: rgba(17, 24, 39, 0.9);"
    role="status"
    data-testid="long-pause"
    use:bottomOverlay
  >
    <div class="col-start-1 row-start-1 flex flex-col gap-2">
      {@render body(away, false)}
    </div>
    <div
      class="invisible col-start-1 row-start-1 flex flex-col gap-2"
      aria-hidden="true"
      inert
      data-reserve
    >
      {@render body(!away, true)}
    </div>
  </div>
{/if}

<style>
  .ghost-text::before {
    content: attr(data-text);
  }
</style>
