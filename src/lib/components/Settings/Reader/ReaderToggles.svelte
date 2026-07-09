<script lang="ts">
  import {
    settings,
    nightModeActive,
    invertColorsActive,
    grayscaleActive,
    type SettingsKey,
    updateSetting
  } from '$lib/settings';
  import { Toggle, Range, Label } from 'flowbite-svelte';
  import ScheduledFilterCard from './ScheduledFilterCard.svelte';

  let isContinuous = $derived($settings.continuousScroll);

  // Keys hidden in continuous scroll mode (not applicable)
  const continuousHidden = new Set<SettingsKey>(['bounds', 'mobile']);

  let toggles = $derived(
    (
      [
        {
          key: 'defaultFullscreen',
          text: 'Open reader in fullscreen',
          value: $settings.defaultFullscreen
        },
        { key: 'textEditable', text: 'Editable text', value: $settings.textEditable },
        { key: 'textBoxBorders', text: 'Text box borders', value: $settings.textBoxBorders },
        { key: 'displayOCR', text: 'OCR enabled', value: $settings.displayOCR },
        {
          key: 'alwaysShowOCR',
          text: 'Always show OCR',
          value: $settings.alwaysShowOCR,
          shortcut: 'T'
        },
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
          key: 'disableAnimations',
          text: 'Disable animations (e-ink)',
          value: $settings.disableAnimations
        },
        {
          key: 'textBoxContextMenu',
          text: 'Custom text box menu',
          value: $settings.textBoxContextMenu,
          description: 'Quick copy and Anki card creation on right-click/long-press'
        }
      ] as { key: SettingsKey; text: string; value: any; shortcut?: string; description?: string }[]
    ).filter((t) => !isContinuous || !continuousHidden.has(t.key))
  );
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

<!-- Display filters (Manual or Scheduled) — shared control -->
<ScheduledFilterCard
  title="Night mode"
  enableLabel="Enable night mode"
  hotkeyHint="N"
  settingKey="nightMode"
  scheduleKey="nightModeSchedule"
  active={$nightModeActive}
/>

<ScheduledFilterCard
  title="Invert colors"
  enableLabel="Enable invert colors"
  hotkeyHint="I"
  settingKey="invertColors"
  scheduleKey="invertColorsSchedule"
  active={$invertColorsActive}
/>

<ScheduledFilterCard
  title="Black & white"
  enableLabel="Enable black & white"
  hotkeyHint="G"
  settingKey="grayscale"
  scheduleKey="grayscaleSchedule"
  active={$grayscaleActive}
/>

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
