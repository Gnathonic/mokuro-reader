<script lang="ts">
  import { AccordionItem, Label, Select, Toggle } from 'flowbite-svelte';
  import { settings, updateSetting } from '#lib/settings/index.js';
  import { editModeActive, requestEditMode } from '#lib/reader/edit/edit-mode.js';
  import SettingToggle from './SettingToggle.svelte';

  /** "Text & OCR": the OCR text layer — whether and how it shows, and editing it. */
  let isContinuous = $derived($settings.continuousScroll);

  const fontSizes = [
    'auto',
    'original',
    '9',
    '10',
    '11',
    '12',
    '14',
    '16',
    '18',
    '20',
    '24',
    '32',
    '40',
    '48',
    '60'
  ].map((value) => ({ value, name: value }));
</script>

<AccordionItem>
  {#snippet header()}Text & OCR{/snippet}
  <div class="flex flex-col gap-5">
    <SettingToggle key="displayOCR" text="OCR enabled" />
    <SettingToggle key="alwaysShowOCR" text="Always show OCR" shortcut="T" />
    <SettingToggle key="textBoxBorders" text="Text box borders" />
    <SettingToggle key="boldFont" text="Bold font" />
    <div>
      <Label for="ocr-font-size" class="text-gray-900 dark:text-white">Font size:</Label>
      <Select
        id="ocr-font-size"
        items={fontSizes}
        value={$settings.fontSize}
        onchange={(e) => updateSetting('fontSize', (e.target as HTMLSelectElement).value)}
      />
    </div>
    <SettingToggle
      key="textBoxContextMenu"
      text="Custom text box menu"
      description="Quick copy and Anki card creation on right-click/long-press"
    />
    <!-- OCR edit mode: reader state, not a setting. -->
    <div>
      <Toggle
        size="small"
        checked={$editModeActive}
        disabled={isContinuous}
        onchange={() => requestEditMode(!$editModeActive)}
      >
        Edit OCR text
        <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(E)</span>
      </Toggle>
      <p class="mt-0.5 ml-11 text-xs text-gray-500 dark:text-gray-400">
        {isContinuous
          ? 'Paged mode only — switch off continuous scroll to edit'
          : 'Move, resize and retype the OCR boxes in the reader'}
      </p>
    </div>
  </div>
</AccordionItem>
