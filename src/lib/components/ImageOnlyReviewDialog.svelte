<script lang="ts">
  import { Modal } from 'flowbite-svelte';
  import { get } from 'svelte/store';
  import { miscSettings } from '$lib/settings/misc';
  import {
    currentStep,
    decideCurrent,
    reviewSession,
    skipAllRemaining
  } from '$lib/import/review-session';
  import { listLibrarySeries } from '$lib/import/library-series';
  import type { LibrarySeries } from '$lib/import/image-only-review';
  import ImageOnlyReviewStep from './ImageOnlyReviewStep.svelte';

  const step = $derived(currentStep($reviewSession));
  const open = $derived(step !== null);
  let library = $state<LibrarySeries[]>([]);

  // The library's series, re-read (keys only) for every step, so a series
  // approved a step ago is already a suggestion.
  $effect(() => {
    const groupId = step?.group.id;
    if (!groupId) return;
    let live = true;
    listLibrarySeries()
      .then((list) => {
        if (live) library = list;
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  });

  // An Escape that cancels an IME composition (Japanese input in the series or
  // a volume name) belongs to the field. The composition ends, or the
  // composing keydown is seen, in the same task as any `cancel` that Escape
  // raises, so both flags hold until the next task.
  let composing = false;
  let composingKey = false;

  function compositionStart() {
    composing = true;
  }

  function compositionEnd() {
    setTimeout(() => (composing = false), 0);
  }

  function keydown(event: KeyboardEvent) {
    if (!event.isComposing && event.keyCode !== 229) return;
    composingKey = true;
    setTimeout(() => (composingKey = false), 0);
  }

  // Escape (the dialog's cancel) = Skip all remaining. Never the dialog's own
  // close on teardown: by then nothing is pending.
  function cancel(event: Event) {
    event.preventDefault();
    if (composing || composingKey) return;
    if (get(reviewSession).pending.length > 0) skipAllRemaining();
  }
</script>

<Modal
  {open}
  size="md"
  placement="top-center"
  dismissable={false}
  outsideclose={false}
  oncancel={cancel}
  onkeydown={keydown}
  oncompositionstart={compositionStart}
  oncompositionend={compositionEnd}
  data-testid="image-only-review"
>
  {#if step}
    {#key step.group.id}
      <ImageOnlyReviewStep
        group={step.group}
        step={step.step}
        total={step.total}
        {library}
        initialMode={$miscSettings.keepFolderNamesAsTitles ? 'folder' : 'cleaned'}
        onDecide={decideCurrent}
        onSkipAll={skipAllRemaining}
      />
    {/key}
  {/if}
</Modal>
