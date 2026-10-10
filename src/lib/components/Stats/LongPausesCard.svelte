<script lang="ts">
  import { Badge, Button, Card } from 'flowbite-svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { pauseKey, pauseReview, type ReviewPause } from '$lib/reading-history/pause-review';
  import { recordResolve } from '$lib/reading-history/record';
  import type { PauseCount } from '$lib/reading-history/types';
  import { formatDuration, formatRelativeDate } from '$lib/util/reading-speed-history';

  /**
   * "Long pauses to review" (phase 3b; spec: "Long pauses"): pages left open
   * past the idle cutoff. An unanswered pause counts typical time and is
   * marked provisional. Any answer can be changed later; each change is a new
   * `resolve` event, and the latest wins on every device.
   *
   * No layout motion. A pause answered on this visit keeps its place, so the
   * list does not shrink under the pointer. The provisional badge sits in a
   * fixed-width slot, so answering never re-flows the row.
   */
  let { titleOf }: { titleOf: (volume: string) => string } = $props();

  const PAGE_SIZE = 50;
  const CHOICES: ReadonlyArray<{ count: PauseCount; label: string }> = [
    { count: 'full', label: 'All' },
    { count: 'typical', label: 'Typical' },
    { count: 'none', label: 'None' }
  ];

  /** Pauses answered on this visit from the unanswered list: they stay there. */
  const kept = new SvelteSet<string>();
  /**
   * Answers given here, shown at once. The stats recount lands ~0.5 s later.
   * Each one is shown only while the stored answer is still the one it
   * replaced, so a newer answer from another device takes over.
   */
  const picked = new SvelteMap<string, { count: PauseCount; over: PauseCount | null }>();
  let showAnswered = $state(false);
  let limit = $state(PAGE_SIZE);

  let open = $derived(
    $pauseReview.pauses.filter((p) => p.answer === null || kept.has(pauseKey(p)))
  );
  let done = $derived(
    $pauseReview.pauses.filter((p) => p.answer !== null && !kept.has(pauseKey(p)))
  );
  let rows = $derived(showAnswered ? [...open, ...done] : open);
  let shown = $derived(rows.slice(0, limit));

  function answerOf(p: ReviewPause): PauseCount | null {
    const mine = picked.get(pauseKey(p));
    return mine && mine.over === p.answer ? mine.count : p.answer;
  }

  function choose(p: ReviewPause, count: PauseCount): void {
    const key = pauseKey(p);
    if (p.answer === null) kept.add(key);
    picked.set(key, { count, over: p.answer });
    void recordResolve(p.volume, [p.device, p.seq], count);
  }

  const minutes = (ms: number) => formatDuration(ms / 60_000);
</script>

{#if $pauseReview.pauses.length > 0}
  <Card class="mb-6 w-full max-w-none p-6" data-testid="long-pauses">
    <h2 class="mb-1 text-xl font-semibold">Long pauses to review ({$pauseReview.unanswered})</h2>
    <p class="mb-4 text-sm text-gray-400">
      Pages left open past the idle cutoff. Until you answer, each one counts a typical time for its
      page.
    </p>
    {#if shown.length > 0}
      <ul class="divide-y divide-gray-200 dark:divide-gray-700">
        {#each shown as p (pauseKey(p))}
          {@const answer = answerOf(p)}
          <li
            class="flex flex-wrap items-center justify-between gap-3 py-3"
            data-testid="long-pause-row"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium">{titleOf(p.volume)}</p>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                {formatRelativeDate(new Date(p.t))} · page {p.page} · open {minutes(p.dwell)} · counted
                {minutes(p.counted)}
              </p>
            </div>
            <div class="flex items-center gap-3">
              <span class="inline-flex w-24 justify-end">
                {#if answer === null}
                  <Badge color="yellow">provisional</Badge>
                {/if}
              </span>
              <div
                role="group"
                aria-label="Count this pause"
                class="inline-flex overflow-hidden rounded-lg border border-gray-300 dark:border-gray-600"
              >
                {#each CHOICES as choice (choice.count)}
                  <button
                    type="button"
                    aria-pressed={answer === choice.count}
                    class="px-3 py-1 text-sm {answer === choice.count
                      ? 'bg-primary-700 text-white'
                      : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'}"
                    onclick={() => choose(p, choice.count)}>{choice.label}</button
                  >
                {/each}
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="mt-3 flex gap-2">
      {#if rows.length > limit}
        <Button size="xs" color="alternative" onclick={() => (limit += PAGE_SIZE)}>Show more</Button
        >
      {/if}
      {#if done.length > 0}
        <Button size="xs" color="alternative" onclick={() => (showAnswered = !showAnswered)}>
          {showAnswered ? 'Hide answered' : `Show answered (${done.length})`}
        </Button>
      {/if}
    </div>
  </Card>
{/if}
