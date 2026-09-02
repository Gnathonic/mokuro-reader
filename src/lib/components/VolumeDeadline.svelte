<script lang="ts">
  import { volumeDeadlines, setVolumeDeadline, removeVolumeDeadline, dateUtils } from '$lib/goals';

  interface Props {
    volumeId: string;
    pagesReadInPeriod?: number | null;
    targetPagesPerPeriod?: number | null;
    /**
     * The view's clock. Threaded in rather than read from `Date.now()` inside
     * the deriveds so the countdown actually rolls over: "Due tomorrow" left on
     * screen across midnight used to stay "Due tomorrow" until a reload.
     */
    now?: number;
  }

  let {
    volumeId,
    pagesReadInPeriod = null,
    targetPagesPerPeriod = null,
    now = Date.now()
  }: Props = $props();

  // Get the deadline for this volume from the store
  let deadline = $derived($volumeDeadlines[volumeId] || null);

  // Local state for showing the date picker
  let isEditing = $state(false);
  let dateInputValue = $state('');

  function focusDateInput(node: HTMLInputElement) {
    node.focus();
    node.showPicker?.();
  }

  function showDatePicker() {
    // Set initial value to current deadline or tomorrow
    if (deadline) {
      dateInputValue = deadline;
    } else {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      dateInputValue = dateUtils.formatDate(tomorrow);
    }
    isEditing = true;
  }

  function hideDatePicker() {
    isEditing = false;
  }

  function handleDateChange(e: Event) {
    const target = e.target as HTMLInputElement;
    // setVolumeDeadline takes a real YYYY-MM-DD and drops anything else without a word,
    // which would close this editor looking like the deadline saved. A date input
    // sanitizes its own value to '' or exactly that shape; `max` below caps the year at
    // four digits, the one value its spinner could otherwise hand back that the store
    // refuses.
    const newDeadline = target.value;

    if (newDeadline) {
      setVolumeDeadline(volumeId, newDeadline);
    } else {
      removeVolumeDeadline(volumeId);
    }
    isEditing = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      hideDatePicker();
    }
  }

  function handleBlur() {
    hideDatePicker();
  }

  // Format the deadline for display
  let deadlineDisplay = $derived.by(() => {
    if (!deadline) return null;

    // Calculate days remaining
    const daysRemaining = dateUtils.calculateDaysRemaining(deadline, new Date(now)) - 1;

    if (daysRemaining < 0) {
      return 'Past due';
    } else if (daysRemaining === 0) {
      return 'Due today!';
    } else if (daysRemaining === 1) {
      return 'Due tomorrow';
    } else {
      // Format as relative date
      return `${daysRemaining} days left`;
    }
  });

  // Determine urgency color based on progress
  let urgencyClass = $derived.by(() => {
    if (!deadline || !targetPagesPerPeriod || pagesReadInPeriod === null) return 'text-gray-400';

    const daysRemaining = dateUtils.calculateDaysRemaining(deadline, new Date(now));

    // If deadline has passed, always show as urgent
    if (daysRemaining <= 0) return 'text-red-500 font-bold';

    // Calculate progress ratio
    const progressRatio = pagesReadInPeriod / targetPagesPerPeriod;

    // Color based on progress toward target
    if (progressRatio >= 1.0) return 'text-green-600 font-bold'; // On track or ahead
    if (progressRatio >= 0.75) return 'text-blue-500'; // Close to target
    if (progressRatio >= 0.5) return 'text-yellow-500'; // Halfway there
    return 'text-red-400'; // Falling behind
  });

  /*
   * The two readouts are independent.
   *
   * They used to share one gate, so a volume with a deadline but no page target
   * — every volume whose pages are not on this device, since the target needs a
   * page count — rendered "Set deadline" over the deadline the user had already
   * set. Clicking it then reopened the picker as though there were none.
   */
  let showDeadline = $derived(deadline !== null);
  let showPageTarget = $derived(pagesReadInPeriod !== null && targetPagesPerPeriod !== null);
</script>

<div class="goal deadline-controls relative mt-1 text-center">
  {#if !isEditing}
    <!-- Display mode -->
    <button
      class="w-full cursor-pointer rounded px-2 py-1 text-xs transition-colors hover:bg-gray-700"
      onclick={showDatePicker}
      title={deadline ? `Deadline: ${deadline}` : 'Click to set a deadline'}
    >
      <!-- Both readouts are keyed: a page count and a countdown are precisely the text
           Migaku/Yomitan rewrite in place, and they then keep showing yesterday's
           figure across a page turn or a date change (CLAUDE.md). -->
      {#if showPageTarget}
        {#key `${pagesReadInPeriod}/${targetPagesPerPeriod}`}
          <div class={urgencyClass}>
            {pagesReadInPeriod}/{targetPagesPerPeriod} pages
          </div>
        {/key}
      {/if}
      {#if showDeadline}
        {#key deadlineDisplay}
          <div class="ml-1 text-gray-500">
            ({deadlineDisplay})
          </div>
        {/key}
      {:else if !showPageTarget}
        <div class="text-gray-500 italic">Set deadline</div>
      {/if}
    </button>
  {:else}
    <!-- Edit mode -->
    <div class="box-border rounded bg-gray-700 p-1">
      <input
        {@attach focusDateInput}
        type="date"
        value={dateInputValue}
        class="box-border w-full rounded border-none bg-gray-600 p-1 text-xs text-white"
        min={dateUtils.formatDate(new Date())}
        max="9999-12-31"
        onchange={handleDateChange}
        onkeydown={handleKeydown}
        onblur={handleBlur}
      />
    </div>
  {/if}
</div>

<style>
  /* Style the date input for dark mode */
  input[type='date'] {
    color-scheme: dark;
  }

  input[type='date']::-webkit-calendar-picker-indicator {
    filter: invert(1);
    cursor: pointer;
  }
</style>
