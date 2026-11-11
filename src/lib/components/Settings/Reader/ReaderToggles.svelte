<script lang="ts">
  import {
    settings,
    nightModeActive,
    invertColorsActive,
    grayscaleActive,
    type SettingsKey,
    updateSetting
  } from '$lib/settings';
  import { listOptions, settingDef, type WheelMode } from '$lib/settings/setting-defs';
  import { Label, Select, Toggle } from 'flowbite-svelte';
  import ScheduledFilterCard from './ScheduledFilterCard.svelte';
  import PageAdjustCard from './PageAdjustCard.svelte';
  import ReadingTimerSetting from './ReadingTimerSetting.svelte';
  import KeyHint from '../Keys/KeyHint.svelte';
  import type { ActionId } from '$lib/keys/actions';
  import { editModeActive, requestEditMode } from '$lib/reader/edit/edit-mode';

  let isContinuous = $derived($settings.continuousScroll);

  // Mouse wheel in paged mode (#55): two stored booleans, one choice.
  // `wheelTurnsPages` wins over `swapWheelBehavior`; older clients ignore it
  // and pan, which is this select's first option.
  // The options, and how a choice maps onto the two booleans, are the
  // `wheel` setting definition's — shared with its key actions.
  const wheelDef = settingDef('wheel');
  const wheelModes = listOptions<WheelMode>('wheel');
  let wheelMode = $derived<WheelMode>(
    $settings.wheelTurnsPages ? 'turn' : $settings.swapWheelBehavior ? 'zoom' : 'pan'
  );

  function onWheelModeChange(e: Event) {
    wheelDef.write({}, (e.target as HTMLSelectElement).value);
  }

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
        { key: 'textBoxBorders', text: 'Text box borders', value: $settings.textBoxBorders },
        { key: 'displayOCR', text: 'OCR enabled', value: $settings.displayOCR },
        {
          key: 'alwaysShowOCR',
          text: 'Always show OCR',
          value: $settings.alwaysShowOCR,
          shortcut: 'reader.ocr-always'
        },
        { key: 'boldFont', text: 'Bold font', value: $settings.boldFont },
        { key: 'pageNum', text: 'Show page number', value: $settings.pageNum },
        { key: 'charCount', text: 'Show character count', value: $settings.charCount },
        { key: 'bounds', text: 'Bounds', value: $settings.bounds },
        { key: 'mobile', text: 'Mobile', value: $settings.mobile },
        { key: 'showTimer', text: 'Show timer', value: $settings.showTimer },
        { key: 'quickActions', text: 'Show quick actions', value: $settings.quickActions },
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
      ] as {
        key: SettingsKey;
        text: string;
        value: any;
        shortcut?: ActionId;
        description?: string;
      }[]
    ).filter((t) => !isContinuous || !continuousHidden.has(t.key))
  );
</script>

{#each toggles as { key, text, value, shortcut, description } (key)}
  <div>
    <Toggle size="small" checked={value} onchange={() => updateSetting(key, !value)}>
      {text}
      {#if shortcut}
        <KeyHint id={shortcut} />
      {/if}
    </Toggle>
    {#if description}
      <p class="mt-0.5 ml-11 text-xs text-gray-500 dark:text-gray-400">{description}</p>
    {/if}
  </div>
  {#if key === 'defaultFullscreen'}
    <!-- OCR edit mode: reader state, not a setting — where "Editable text" used to be. -->
    <div>
      <Toggle
        size="small"
        checked={$editModeActive}
        disabled={isContinuous}
        onchange={() => requestEditMode(!$editModeActive)}
      >
        Edit OCR text
        <KeyHint id="reader.edit-mode" />
      </Toggle>
      <p class="mt-0.5 ml-11 text-xs text-gray-500 dark:text-gray-400">
        {isContinuous
          ? 'Paged mode only — switch off continuous scroll to edit'
          : 'Move, resize and retype the OCR boxes in the reader'}
      </p>
    </div>
  {/if}
{/each}

<div>
  <Label for="wheel-mode" class="mb-2 text-gray-900 dark:text-white">Mouse wheel</Label>
  <Select
    id="wheel-mode"
    size="sm"
    items={wheelModes}
    value={wheelMode}
    onchange={onWheelModeChange}
  />
  {#if wheelMode === 'turn'}
    <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
      Paged mode. A zoomed page pans to its edge first; continuous scroll keeps scrolling.
    </p>
  {/if}
</div>

<!-- Display filters (Manual or Scheduled) — shared control -->
<ScheduledFilterCard
  title="Night mode"
  enableLabel="Enable night mode"
  hotkeyAction="reader.night"
  settingKey="nightMode"
  scheduleKey="nightModeSchedule"
  active={$nightModeActive}
/>

<ScheduledFilterCard
  title="Invert colors"
  enableLabel="Enable invert colors"
  hotkeyAction="reader.invert"
  settingKey="invertColors"
  scheduleKey="invertColorsSchedule"
  active={$invertColorsActive}
/>

<ScheduledFilterCard
  title="Black & white"
  enableLabel="Enable black & white"
  hotkeyAction="reader.grayscale"
  settingKey="grayscale"
  scheduleKey="grayscaleSchedule"
  active={$grayscaleActive}
/>

<!-- Page brightness / contrast — the images only, never the OCR text -->
<PageAdjustCard />

<ReadingTimerSetting />
