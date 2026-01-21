<script lang="ts">
  import {
    settings,
    nightModeActive,
    invertColorsActive,
    type SettingsKey,
    updateSetting,
    updateScheduleSetting
  } from '$lib/settings';
  import { Toggle, Range, Label } from 'flowbite-svelte';
  import TimePicker from '../TimePicker.svelte';

  let toggles = $derived([
    {
      key: 'defaultFullscreen',
      text: 'Open reader in fullscreen',
      value: $settings.defaultFullscreen
    },
    { key: 'textEditable', text: 'Editable text', value: $settings.textEditable },
    { key: 'textBoxBorders', text: 'Text box borders', value: $settings.textBoxBorders },
    { key: 'displayOCR', text: 'OCR enabled', value: $settings.displayOCR },
    { key: 'boldFont', text: 'Bold font', value: $settings.boldFont },
    { key: 'pageNum', text: 'Show page number', value: $settings.pageNum },
    { key: 'charCount', text: 'Show character count', value: $settings.charCount },
    { key: 'bounds', text: 'Bounds', value: $settings.bounds },
    { key: 'mobile', text: 'Mobile', value: $settings.mobile },
    { key: 'showTimer', text: 'Show timer', value: $settings.showTimer },
    { key: 'quickActions', text: 'Show quick actions', value: $settings.quickActions },
    {
      key: 'swapWheelBehavior',
      text: 'Swap mouse wheel scroll/zoom',
      value: $settings.swapWheelBehavior
    },
    {
      key: 'textBoxContextMenu',
      text: 'Custom text box menu',
      value: $settings.textBoxContextMenu,
      description: 'Quick copy and Anki card creation on right-click/long-press'
    }
  ] as { key: SettingsKey; text: string; value: any; shortcut?: string; description?: string }[]);

  // Mode selection: 'manual' or 'scheduled'
  let nightModeMode = $derived($settings.nightModeSchedule.enabled ? 'scheduled' : 'manual');
  let invertMode = $derived($settings.invertColorsSchedule.enabled ? 'scheduled' : 'manual');

  function setNightModeMode(mode: 'manual' | 'scheduled') {
    if (mode === 'manual') {
      updateScheduleSetting('nightModeSchedule', 'enabled', false);
    } else {
      updateScheduleSetting('nightModeSchedule', 'enabled', true);
      // Turn off manual when switching to scheduled
      if ($settings.nightMode) {
        updateSetting('nightMode', false);
      }
    }
  }

  function setInvertMode(mode: 'manual' | 'scheduled') {
    if (mode === 'manual') {
      updateScheduleSetting('invertColorsSchedule', 'enabled', false);
    } else {
      updateScheduleSetting('invertColorsSchedule', 'enabled', true);
      // Turn off manual when switching to scheduled
      if ($settings.invertColors) {
        updateSetting('invertColors', false);
      }
    }
  }
</script>

{#each toggles as { key, text, value, shortcut, description }}
  <div>
    <Toggle size="small" checked={value} onchange={() => updateSetting(key, !value)}>
      {text}
      {#if shortcut}
        <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">({shortcut})</span>
      {/if}
    </Toggle>
    {#if description}
      <p class="mt-0.5 ml-11 text-xs text-gray-500 dark:text-gray-400">{description}</p>
    {/if}
  </div>
{/each}

<!-- Night Mode with Schedule -->
<div class="mt-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
  <div class="mb-2 flex items-center justify-between">
    <span class="text-sm font-medium text-gray-900 dark:text-white">
      Night mode
      {#if $nightModeActive}
        <span class="ml-1 text-xs text-green-600 dark:text-green-400">(active)</span>
      {/if}
    </span>
  </div>

  <div class="mb-3 flex gap-4">
    <label class="flex cursor-pointer items-center gap-2">
      <input
        type="radio"
        name="nightModeMode"
        checked={nightModeMode === 'manual'}
        onchange={() => setNightModeMode('manual')}
        class="h-4 w-4 text-primary-600"
      />
      <span class="text-sm text-gray-700 dark:text-gray-300">Manual (N)</span>
    </label>
    <label class="flex cursor-pointer items-center gap-2">
      <input
        type="radio"
        name="nightModeMode"
        checked={nightModeMode === 'scheduled'}
        onchange={() => setNightModeMode('scheduled')}
        class="h-4 w-4 text-primary-600"
      />
      <span class="text-sm text-gray-700 dark:text-gray-300">Scheduled</span>
    </label>
  </div>

  {#if nightModeMode === 'manual'}
    <Toggle
      size="small"
      checked={$settings.nightMode}
      onchange={() => updateSetting('nightMode', !$settings.nightMode)}
    >
      Enable night mode
    </Toggle>
  {:else}
    <div class="space-y-2">
      <div class="flex items-center gap-2">
        <Label class="w-12 text-xs text-gray-700 dark:text-gray-300">Start:</Label>
        <TimePicker
          value={$settings.nightModeSchedule.startTime}
          onchange={(val) => updateScheduleSetting('nightModeSchedule', 'startTime', val)}
        />
      </div>
      <div class="flex items-center gap-2">
        <Label class="w-12 text-xs text-gray-700 dark:text-gray-300">End:</Label>
        <TimePicker
          value={$settings.nightModeSchedule.endTime}
          onchange={(val) => updateScheduleSetting('nightModeSchedule', 'endTime', val)}
        />
      </div>
    </div>
  {/if}
</div>

<!-- Invert Colors with Schedule -->
<div class="mt-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
  <div class="mb-2 flex items-center justify-between">
    <span class="text-sm font-medium text-gray-900 dark:text-white">
      Invert colors
      {#if $invertColorsActive}
        <span class="ml-1 text-xs text-green-600 dark:text-green-400">(active)</span>
      {/if}
    </span>
  </div>

  <div class="mb-3 flex gap-4">
    <label class="flex cursor-pointer items-center gap-2">
      <input
        type="radio"
        name="invertMode"
        checked={invertMode === 'manual'}
        onchange={() => setInvertMode('manual')}
        class="h-4 w-4 text-primary-600"
      />
      <span class="text-sm text-gray-700 dark:text-gray-300">Manual (I)</span>
    </label>
    <label class="flex cursor-pointer items-center gap-2">
      <input
        type="radio"
        name="invertMode"
        checked={invertMode === 'scheduled'}
        onchange={() => setInvertMode('scheduled')}
        class="h-4 w-4 text-primary-600"
      />
      <span class="text-sm text-gray-700 dark:text-gray-300">Scheduled</span>
    </label>
  </div>

  {#if invertMode === 'manual'}
    <Toggle
      size="small"
      checked={$settings.invertColors}
      onchange={() => updateSetting('invertColors', !$settings.invertColors)}
    >
      Enable invert colors
    </Toggle>
  {:else}
    <div class="space-y-2">
      <div class="flex items-center gap-2">
        <Label class="w-12 text-xs text-gray-700 dark:text-gray-300">Start:</Label>
        <TimePicker
          value={$settings.invertColorsSchedule.startTime}
          onchange={(val) => updateScheduleSetting('invertColorsSchedule', 'startTime', val)}
        />
      </div>
      <div class="flex items-center gap-2">
        <Label class="w-12 text-xs text-gray-700 dark:text-gray-300">End:</Label>
        <TimePicker
          value={$settings.invertColorsSchedule.endTime}
          onchange={(val) => updateScheduleSetting('invertColorsSchedule', 'endTime', val)}
        />
      </div>
    </div>
  {/if}
</div>

<div class="mt-4">
  <Label class="mb-2 text-gray-900 dark:text-white">
    Inactivity timeout: {$settings.inactivityTimeoutMinutes} minutes
    <span class="ml-2 text-xs text-gray-500 dark:text-gray-400"
      >(Auto-stop timer and sync after inactivity)</span
    >
  </Label>
  <Range
    min="1"
    max="30"
    value={$settings.inactivityTimeoutMinutes}
    onchange={(e) =>
      updateSetting('inactivityTimeoutMinutes', Number((e.target as HTMLInputElement).value))}
  />
</div>
