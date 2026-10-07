<script lang="ts">
  import { answerPosition, positionPlan, showsChip } from '$lib/reading-history/position-store';

  /**
   * The volume card's reminder of an unanswered cross-device position offer,
   * once the reader's prompts for it are used up (phase 2c). Its buttons
   * answer it in place without opening the volume.
   */
  let { volumeId, pageCount }: { volumeId: string; pageCount: number } = $props();

  let plan = $derived(positionPlan(volumeId));
  let answered = $state<number | null>(null);
  let offer = $derived(
    $plan.offer && $plan.offer.at !== answered && showsChip(volumeId, $plan.offer)
      ? $plan.offer
      : null
  );

  function answer(event: MouseEvent, kind: 'jump' | 'stay') {
    event.stopPropagation();
    event.preventDefault();
    const current = offer;
    if (!current) return;
    answered = current.at;
    void answerPosition(volumeId, current, kind, pageCount);
  }
</script>

{#if offer}
  <span
    data-testid="position-offer-chip"
    class="inline-flex items-center gap-1 rounded bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200"
    title={offer.ownDevice ? 'Read on this device' : 'Read on another device'}
  >
    Also read to p.{offer.page}
    <button
      class="rounded px-1 font-medium hover:bg-indigo-200 dark:hover:bg-indigo-800"
      aria-label="Go to page {offer.page}"
      onclick={(e) => answer(e, 'jump')}>Go</button
    >
    <button
      class="rounded px-1 hover:bg-indigo-200 dark:hover:bg-indigo-800"
      aria-label="Stay where you are"
      onclick={(e) => answer(e, 'stay')}>Stay</button
    >
  </span>
{/if}
