<script lang="ts">
  import { CloseCircleSolid } from 'flowbite-svelte-icons';
  import {
    volumeDeadlines,
    setVolumeDeadline,
    removeVolumeDeadline,
    calculatePagesPerDay,
    dateUtils
  } from '$lib/settings/goals';

  interface Props {
    volumeId: string;
    remainingPages: number;
  }

  let { volumeId, remainingPages }: Props = $props();

  // Get the deadline for this volume from the store
  let deadline = $derived($volumeDeadlines[volumeId] || null);

  // Calculate pages per day needed
  let pagesPerDay = $derived(calculatePagesPerDay(remainingPages, deadline));

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
    }
    isEditing = false;
  }

  function handleRemoveDeadline(e: Event) {
    e.stopPropagation();
    removeVolumeDeadline(volumeId);
    isEditing = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      hideDatePicker();
    }
  }

  function handleBlur(e: FocusEvent) {
    // Only hide if we're not clicking on the remove button
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (!relatedTarget?.closest('.deadline-controls')) {
      hideDatePicker();
    }
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

  // Determine urgency color
  let urgencyClass = $derived.by(() => {
    if (!deadline || !pagesPerDay) return 'text-gray-400';

    const daysRemaining = dateUtils.calculateDaysRemaining(deadline);

    if (daysRemaining <= 0) return 'text-red-500 font-bold';
    if (pagesPerDay > 50) return 'text-red-400';
    if (pagesPerDay > 30) return 'text-yellow-500';
    if (pagesPerDay > 15) return 'text-blue-500';
    return 'text-green-600';
  });
</script>

<div class="goal deadline-controls relative mt-1 text-center">
  {#if !isEditing}
    <!-- Display mode -->
    <button
      class="w-full cursor-pointer rounded px-2 py-1 text-xs transition-colors hover:bg-gray-700"
      onclick={showDatePicker}
      title={deadline ? `Deadline: ${deadline}` : 'Click to set a deadline'}
    >
      {#if deadline && pagesPerDay !== null}
        <div class={urgencyClass}>
          {pagesPerDay} p/day
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
    <div class="flex items-center gap-1 rounded bg-gray-700 p-1">
      <input
        bind:this={dateInputRef}
        type="date"
        value={dateInputValue}
        class="flex-1 rounded border-none bg-gray-600 px-2 py-1 text-xs text-white"
        min={dateUtils.formatDate(new Date())}
        onchange={handleDateChange}
        onkeydown={handleKeydown}
        onblur={handleBlur}
      />
      {#if deadline}
        <button
          class="rounded p-1 text-red-400 transition-colors hover:bg-gray-600 hover:text-red-300"
          onclick={handleRemoveDeadline}
          title="Remove deadline"
        >
          <CloseCircleSolid class="h-4 w-4" />
        </button>
      {/if}
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
