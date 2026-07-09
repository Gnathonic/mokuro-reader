<script lang="ts">
  import {
    settings,
    updateSetting,
    updateScheduleSetting,
    type ScheduleSettingKey
  } from '$lib/settings';
  import { Toggle, Label } from 'flowbite-svelte';
  import TimePicker from '../TimePicker.svelte';

  let {
    title,
    enableLabel,
    hotkeyHint,
    settingKey,
    scheduleKey,
    active
  }: {
    title: string;
    enableLabel: string;
    hotkeyHint: string;
    settingKey: 'nightMode' | 'invertColors' | 'grayscale';
    scheduleKey: ScheduleSettingKey;
    active: boolean;
  } = $props();

  let mode = $derived($settings[scheduleKey].enabled ? 'scheduled' : 'manual');
  // Unique radio-group name so multiple cards on the page stay independent.
  let groupName = $derived(`${scheduleKey}-mode`);

  function setMode(next: 'manual' | 'scheduled') {
    if (next === 'manual') {
      updateScheduleSetting(scheduleKey, 'enabled', false);
    } else {
      updateScheduleSetting(scheduleKey, 'enabled', true);
      // Turn off the manual toggle when switching to scheduled
      if ($settings[settingKey]) {
        updateSetting(settingKey, false);
      }
    }
  }
</script>

<div class="mt-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
  <div class="mb-2 flex items-center justify-between">
    <span class="text-sm font-medium text-gray-900 dark:text-white">
      {title}
      {#if active}
        <span class="ml-1 text-xs text-green-600 dark:text-green-400">(active)</span>
      {/if}
    </span>
  </div>

  <div class="mb-3 flex gap-4">
    <label class="flex cursor-pointer items-center gap-2">
      <input
        type="radio"
        name={groupName}
        checked={mode === 'manual'}
        onchange={() => setMode('manual')}
        class="h-4 w-4 text-primary-600"
      />
      <span class="text-sm text-gray-700 dark:text-gray-300">Manual ({hotkeyHint})</span>
    </label>
    <label class="flex cursor-pointer items-center gap-2">
      <input
        type="radio"
        name={groupName}
        checked={mode === 'scheduled'}
        onchange={() => setMode('scheduled')}
        class="h-4 w-4 text-primary-600"
      />
      <span class="text-sm text-gray-700 dark:text-gray-300">Scheduled</span>
    </label>
  </div>

  {#if mode === 'manual'}
    <Toggle
      size="small"
      checked={$settings[settingKey]}
      onchange={() => updateSetting(settingKey, !$settings[settingKey])}
    >
      {enableLabel}
    </Toggle>
  {:else}
    <div class="space-y-2">
      <div class="flex items-center gap-2">
        <Label class="w-12 text-xs text-gray-700 dark:text-gray-300">Start:</Label>
        <TimePicker
          value={$settings[scheduleKey].startTime}
          onchange={(val) => updateScheduleSetting(scheduleKey, 'startTime', val)}
        />
      </div>
      <div class="flex items-center gap-2">
        <Label class="w-12 text-xs text-gray-700 dark:text-gray-300">End:</Label>
        <TimePicker
          value={$settings[scheduleKey].endTime}
          onchange={(val) => updateScheduleSetting(scheduleKey, 'endTime', val)}
        />
      </div>
    </div>
  {/if}
</div>
