<script lang="ts">
  import { Modal, Label, Select, Helper } from 'flowbite-svelte';
  import { miscSettings, updateMiscSetting } from '$lib/settings/misc';
  import { getNextResetTime, formatRelativeResetTime } from '$lib/settings/goals';

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

<Modal bind:open size="md" title="Progress Target Settings">
  <div class="flex flex-col gap-4">
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
        <span class="text-sm text-gray-900 dark:text-white">
          {nextResetDisplay}
          <span class="ml-1 text-xs text-gray-500">in {relativeResetTime}</span>
        </span>
      </div>
    </div>
  </div>
</Modal>
