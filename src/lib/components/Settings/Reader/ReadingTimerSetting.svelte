<script lang="ts">
  import { Button, Label, Select, Toggle } from 'flowbite-svelte';
  import { DEFAULT_K } from '$lib/reading-history/stats-engine';
  import {
    askOnLongPause,
    idleSettings,
    resetIdleK,
    setAskOnLongPause,
    setIdleOverride,
    trackingState
  } from '$lib/settings/tracking-data';

  /**
   * The reading timer's cutoff and its long-pause prompt, as one group. Both
   * are the user's settings for every device (synced in `volume-data.json`'s
   * `tracking` section), never a profile.
   *
   * - "Stop the timer after": how long one page may stay open before the time
   *   stops counting. Automatic adapts to the characters on screen and the
   *   user's pace; a fixed value replaces it everywhere.
   * - "Ask if I'm still reading": the prompt at the cutoff. Off, a long pause
   *   simply counts up to the cutoff, as an unanswered one does.
   * - "Still reading" answers stretch the automatic cutoff (`k`). Shown, with
   *   Reset, only while automatic: a fixed cutoff is never stretched.
   */
  const AUTO = 'auto';
  const PRESET_MINUTES = [2, 3, 5, 10, 15, 20, 30, 45, 60];

  let override = $derived($trackingState.idle?.override_minutes ?? null);
  let value = $derived(override === null ? AUTO : String(override));
  let options = $derived([
    { value: AUTO, name: 'Automatic' },
    ...[...new Set([...PRESET_MINUTES, ...(override === null ? [] : [override])])]
      .sort((a, b) => a - b)
      .map((m) => ({ value: String(m), name: `${m} minutes` }))
  ]);
  let stretch = $derived(Math.round(($idleSettings.k / DEFAULT_K) * 10) / 10);

  function onStopChange(e: Event) {
    const next = (e.target as HTMLSelectElement).value;
    setIdleOverride(next === AUTO ? null : Number(next));
  }
</script>

<div class="mt-4 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
  <h3 class="mb-2 text-sm font-medium text-gray-900 dark:text-white">Reading timer</h3>
  <div class="space-y-3">
    <div>
      <Label for="reading-timer-stop" class="mb-2 text-gray-900 dark:text-white">
        Stop the timer after
      </Label>
      <Select
        id="reading-timer-stop"
        size="sm"
        placeholder=""
        items={options}
        {value}
        onchange={onStopChange}
      />
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
        If a page stays open longer than this without a page turn, the extra time isn’t counted.
        Automatic works it out from how much text is on the page and your reading speed.
      </p>
      {#if override === null && $idleSettings.k > DEFAULT_K}
        <div
          class="mt-2 flex items-center justify-between gap-2 text-xs text-gray-700 dark:text-gray-300"
        >
          <span>Your “Still reading” answers made the automatic cutoff {stretch}× longer.</span>
          <Button size="xs" color="alternative" onclick={resetIdleK}>Reset</Button>
        </div>
      {/if}
    </div>
    <div>
      <Toggle
        size="small"
        checked={$askOnLongPause}
        onchange={() => setAskOnLongPause(!$askOnLongPause)}
      >
        Ask if I’m still reading
      </Toggle>
      <p class="mt-0.5 ml-11 text-xs text-gray-500 dark:text-gray-400">
        When the timer stops, a small bar lets you keep it going. Otherwise the time up to the
        cutoff is counted.
      </p>
    </div>
  </div>
</div>
