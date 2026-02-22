<script lang="ts">
  import {
    volumeDeadlines,
    setVolumeDeadline,
    removeVolumeDeadline,
    dateUtils
  } from '$lib/settings/goals';
  import type { ProgressTargetMode } from '$lib/settings/misc';

  interface Props {
    volumeId: string;
    remainingPages: number;
    pagesReadInPeriod?: number | null;
    targetPagesPerPeriod?: number | null;
    targetMode?: ProgressTargetMode;
  }

  let {
    volumeId,
    remainingPages,
    pagesReadInPeriod = null,
    targetPagesPerPeriod = null,
    targetMode = 'daily'
  }: Props = $props();

  // Get the deadline for this volume from the store
  let deadline = $derived($volumeDeadlines[volumeId] || null);

  // Local state for showing the date picker
  let isEditing = $state(false);
  let dateInputValue = $state('');

  // Reference to the date input for focus management
  let dateInputRef = $state<HTMLInputElement | null>(null);

  function showDatePicker() {
    // Set initial value to current deadline or tomorrow
    if (deadline) {
      dateInputValue = deadline;
    } else {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      dateInputValue = dateUtils.formatDate(tomorrow);
    }
    isEditing = true;

    // Focus the input after a tick
    setTimeout(() => {
      dateInputRef?.focus();
      dateInputRef?.showPicker?.();
    }, 0);
  }

  function hideDatePicker() {
    isEditing = false;
  }

  function handleDateChange(e: Event) {
    const target = e.target as HTMLInputElement;
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

    const deadlineDate = new Date(deadline);
    const today = new Date();

    // Calculate days remaining
    const daysRemaining = dateUtils.calculateDaysRemaining(deadline) - 1;

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

    const daysRemaining = dateUtils.calculateDaysRemaining(deadline);

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

  // Show the deadline display when deadline is set and progress data is available
  let showDeadlineDisplay = $derived(
    pagesReadInPeriod !== null && targetPagesPerPeriod !== null && deadline !== null
  );
</script>

<div class="goal deadline-controls relative mt-1 text-center">
  {#if !isEditing}
    <!-- Display mode -->
    <button
      class="w-full cursor-pointer rounded px-2 py-1 text-xs transition-colors hover:bg-gray-700"
      onclick={showDatePicker}
      title={deadline ? `Deadline: ${deadline}` : 'Click to set a deadline'}
    >
      {#if showDeadlineDisplay}
        <div class={urgencyClass}>
          {pagesReadInPeriod}/{targetPagesPerPeriod}
          {targetMode === 'daily' ? 'pages' : 'pages'}
        </div>
        <div class="ml-1 text-gray-500">
          ({deadlineDisplay})
        </div>
      {:else}
        <div class="text-gray-500 italic">Set deadline</div>
      {/if}
    </button>
  {:else}
    <!-- Edit mode -->
    <div class="box-border rounded bg-gray-700 p-1">
      <input
        bind:this={dateInputRef}
        type="date"
        value={dateInputValue}
        class="box-border w-full rounded border-none bg-gray-600 p-1 text-xs text-white"
        min={dateUtils.formatDate(new Date())}
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
