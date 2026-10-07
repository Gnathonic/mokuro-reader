<script lang="ts">
  import {
    answerPosition,
    markPrompted,
    positionPlan,
    shouldPrompt
  } from '$lib/reading-history/position-store';
  import type { PositionOffer } from '$lib/reading-history/position-offer';

  /**
   * "You also read to page N on another device" (phase 2c). Non-modal and
   * keyboard-neutral: reading goes on underneath. Shown at most once a session
   * per offer, in at most two sessions (`shouldPrompt`); after that the volume
   * card carries a chip. "Later" hides it without answering.
   */
  let {
    volumeId,
    pageCount,
    currentPage
  }: { volumeId: string; pageCount: number; currentPage: number } = $props();

  let plan = $derived(positionPlan(volumeId));
  /** The offer (by its `at`) this banner is showing; null when hidden. */
  let showing = $state<number | null>(null);
  /** Offers answered or put off in this banner: never re-shown, even before
   * the recorded answer reaches the plan. */
  let settled = $state<number[]>([]);

  $effect(() => {
    const offer = $plan.offer;
    if (!offer) {
      showing = null;
      return;
    }
    if (showing === offer.at || settled.includes(offer.at)) return;
    if (shouldPrompt(volumeId, offer)) {
      markPrompted(volumeId, offer);
      showing = offer.at;
    }
  });

  let offer = $derived<PositionOffer | null>(
    $plan.offer && showing === $plan.offer.at ? $plan.offer : null
  );

  const when = (at: number) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);

  function answer(kind: 'jump' | 'stay') {
    if (!offer) return;
    const answered = offer;
    settled = [...settled, answered.at];
    showing = null;
    void answerPosition(volumeId, answered, kind, pageCount);
  }

  function later() {
    if (offer) settled = [...settled, offer.at];
    showing = null;
  }
</script>

{#if offer}
  <div
    class="fixed top-16 left-1/2 z-20 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg px-4 py-2 text-sm text-white shadow-lg"
    style="backdrop-filter: blur(8px); background-color: rgba(17, 24, 39, 0.9);"
    role="status"
    data-testid="position-offer"
  >
    <span>
      You also read to page {offer.page}
      {offer.ownDevice ? 'on this device' : 'on another device'}
      <span class="text-gray-400">({when(offer.at)})</span>
    </span>
    <span class="relative z-10 flex gap-2">
      <button
        class="rounded bg-primary-700 px-2 py-1 font-medium hover:bg-primary-600"
        onclick={() => answer('jump')}>Go to page {offer.page}</button
      >
      <button class="rounded bg-gray-700 px-2 py-1 hover:bg-gray-600" onclick={() => answer('stay')}
        >Stay on page {currentPage}</button
      >
      <button class="rounded px-2 py-1 text-gray-400 hover:text-white" onclick={later}>Later</button
      >
    </span>
  </div>
{/if}
