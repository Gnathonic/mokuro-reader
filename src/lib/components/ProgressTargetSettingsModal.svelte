<script lang="ts">
  import { Button, Modal, Label, Select, Helper } from 'flowbite-svelte';
  import { miscSettings, updateMiscSetting } from '$lib/settings/misc';
  import { getNextResetTime, formatRelativeResetTime } from '$lib/goals';

  interface Props {
    open?: boolean;
  }

  let { open = $bindable(false) }: Props = $props();

  // Day names (hardcoded English for now)
  // TODO: Can use Intl.DateTimeFormat for localization in the future
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Generate hour options in 12-hour format
  const hourOptions = Array.from({ length: 24 }, (_, i) => {
    const hour12 = i === 0 ? 12 : i > 12 ? i - 12 : i;
    const period = i < 12 ? 'AM' : 'PM';
    return {
      value: i,
      name: `${hour12}:00 ${period}`
    };
  });

  // Generate day options
  const dayOptions = dayNames.map((name, index) => ({
    value: index,
    name
  }));

  // Local state for settings (bound to store, with defaults for null/undefined)
  let resetHour = $derived($miscSettings.progressResetHour ?? 0);
  let resetDay = $derived($miscSettings.progressResetDay ?? 1);
  let targetMode = $derived($miscSettings.progressTargetMode ?? 'daily');

  // Calculate next reset time for live preview
  let nextResetTimestamp = $derived(getNextResetTime(targetMode, resetHour, resetDay));
  let nextResetDate = $derived(new Date(nextResetTimestamp));
  let relativeResetTime = $derived(formatRelativeResetTime(nextResetTimestamp));

  // Format next reset for display
  let nextResetDisplay = $derived.by(() => {
    const hour12 =
      nextResetDate.getHours() === 0
        ? 12
        : nextResetDate.getHours() > 12
          ? nextResetDate.getHours() - 12
          : nextResetDate.getHours();
    const period = nextResetDate.getHours() < 12 ? 'AM' : 'PM';
    const timeStr = `${hour12}:00 ${period}`;

    if (targetMode === 'weekly') {
      const dayName = dayNames[nextResetDate.getDay()];
      return `${dayName} at ${timeStr}`;
    }
    return timeStr;
  });

  function onHourChange(event: Event) {
    const value = Number((event.target as HTMLSelectElement).value);
    updateMiscSetting('progressResetHour', value);
  }

  function onDayChange(event: Event) {
    const value = Number((event.target as HTMLSelectElement).value);
    updateMiscSetting('progressResetDay', value);
  }
</script>

<Modal bind:open size="md" outsideclose title="Progress Target Settings">
  <!-- relative z-10: night mode filters the <dialog>, which creates a stacking context
       and lets a scrollable sibling swallow clicks meant for the controls below. -->
  <div class="relative z-10 flex flex-col gap-4">
    <!-- Explanation of feature -->
    <div class="rounded-lg bg-blue-50 p-3 dark:bg-blue-900/20">
      <p class="text-sm text-gray-700 dark:text-gray-300">
        Progress targets show how many pages you've read in the current period vs. your target to
        stay on track for your deadline. The target excludes pages already read this period.
      </p>
    </div>

    <!-- Reset hour setting -->
    <div>
      <Label class="mb-2 text-gray-900 dark:text-white">Reset Time</Label>
      <Select items={hourOptions} value={resetHour} onchange={onHourChange} />
      <Helper class="mt-1.5 text-xs">
        {#if (targetMode ?? 'daily') === 'daily'}
          Daily targets reset at this time each day.
        {:else}
          Weekly targets reset at this time on the selected day.
        {/if}
      </Helper>
    </div>

    <!-- Reset day setting (only for weekly mode) -->
    {#if (targetMode ?? 'daily') === 'weekly'}
      <div>
        <Label class="mb-2 text-gray-900 dark:text-white">Reset Day</Label>
        <Select items={dayOptions} value={resetDay} onchange={onDayChange} />
        <Helper class="mt-1.5 text-xs">Weekly targets reset on this day each week.</Helper>
      </div>
    {/if}

    <!-- Live preview -->
    <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-gray-700 dark:text-gray-300">Next reset:</span>
        <!-- Keyed: Migaku/Yomitan rewrite this readout in place and then keep showing the
             old reset time after the hour or day is changed (CLAUDE.md). -->
        {#key `${nextResetDisplay}|${relativeResetTime}`}
          <span class="text-sm text-gray-900 dark:text-white">
            {nextResetDisplay}
            <span class="ml-1 text-xs text-gray-500">in {relativeResetTime}</span>
          </span>
        {/key}
      </div>
    </div>

    <!-- Every control above writes through on change, so Close is the only action — but
         without it the only ways out are Escape and the header X. relative z-10 for the
         same night-mode stacking context as the wrapper.
         data-autofocus: otherwise the dialog focuses the first control it finds, which is
         the reset-hour Select — an arrow key away from silently changing the setting. -->
    <div
      class="relative z-10 flex justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-700"
    >
      <Button color="alternative" onclick={() => (open = false)} data-autofocus>Close</Button>
    </div>
  </div>
</Modal>
