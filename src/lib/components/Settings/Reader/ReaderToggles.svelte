<script lang="ts">
  import { settings, type SettingsKey, updateSetting } from '$lib/settings';
  import { Toggle } from 'flowbite-svelte';

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
    { key: 'invertColors', text: 'Invert colors of the images', value: $settings.invertColors },
    { key: 'nightMode', text: 'Night mode (strong red filter)', value: $settings.nightMode }
  ] as { key: SettingsKey; text: string; value: any }[]);
</script>

{#each toggles as { key, text, value }}
  <Toggle size="small" checked={value} on:change={() => updateSetting(key, !value)}>{text}</Toggle>
{/each}
