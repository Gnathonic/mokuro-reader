<script lang="ts">
  import { settings, type SettingsKey, updateSetting } from '$lib/settings';
  import { Toggle, Range, Label } from 'flowbite-svelte';

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
      key: 'invertColors',
      text: 'Invert colors of the images',
      value: $settings.invertColors,
      shortcut: 'I'
    },
    {
      key: 'nightMode',
      text: 'Night mode (strong red filter)',
      value: $settings.nightMode,
      shortcut: 'N'
    }
  ] as { key: SettingsKey; text: string; value: any; shortcut?: string }[]);
</script>

{#each toggles as { key, text, value, shortcut }}
  <Toggle size="small" checked={value} onchange={() => updateSetting(key, !value)}>
    {text}
    {#if shortcut}
      <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">({shortcut})</span>
    {/if}
  </Toggle>
{/each}

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
