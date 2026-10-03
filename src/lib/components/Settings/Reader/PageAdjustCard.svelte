<script lang="ts">
  import { settings, updateSetting } from '$lib/settings';
  import { Button, Label, Range, Select } from 'flowbite-svelte';
  import {
    INK_COLOR_NAMES,
    INK_PALETTE,
    sanitizeInkColor,
    type InkColorSetting
  } from '$lib/reader/ink-color';
  import {
    PAGE_ADJUST_DEFAULT,
    PAGE_ADJUST_MAX,
    PAGE_ADJUST_MIN,
    PAGE_ADJUST_STEP,
    clampPageAdjust
  } from '$lib/reader/page-filter';

  // Page images only (#256): washed-out scans. The OCR text is never filtered.
  // (Ink color below does recolour the OCR text, to match the ink.)
  type AdjustKey = 'pageBrightness' | 'pageContrast';

  const sliders: { key: AdjustKey; label: string }[] = [
    { key: 'pageBrightness', label: 'Brightness' },
    { key: 'pageContrast', label: 'Contrast' }
  ];

  // Ink color for black-and-white pages (#256): colour pages are left alone.
  const inkOptions: { value: InkColorSetting; name: string }[] = [
    { value: 'off', name: 'Off' },
    { value: 'auto', name: 'Auto' },
    ...INK_COLOR_NAMES.map((c) => ({ value: c, name: c[0].toUpperCase() + c.slice(1) }))
  ];
  let inkColor = $derived(sanitizeInkColor($settings.pageInkColor));

  // Live while dragging: the page behind the drawer follows the thumb.
  function onInput(key: AdjustKey, e: Event) {
    updateSetting(key, clampPageAdjust(Number((e.target as HTMLInputElement).value)));
  }
</script>

<div class="mt-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
  <div class="mb-2 text-sm font-medium text-gray-900 dark:text-white">Page image</div>
  <div class="space-y-3">
    {#each sliders as { key, label } (key)}
      {@const value = clampPageAdjust($settings[key])}
      <div>
        <div class="flex items-center justify-between">
          <Label for={`page-adjust-${key}`} class="text-gray-900 dark:text-white">
            {label}: {value}%
          </Label>
          <Button
            size="xs"
            color="alternative"
            class="px-2 py-0.5"
            aria-label={`Reset ${label.toLowerCase()}`}
            disabled={value === PAGE_ADJUST_DEFAULT}
            onclick={() => updateSetting(key, PAGE_ADJUST_DEFAULT)}>Reset</Button
          >
        </div>
        <Range
          id={`page-adjust-${key}`}
          min={PAGE_ADJUST_MIN}
          max={PAGE_ADJUST_MAX}
          step={PAGE_ADJUST_STEP}
          {value}
          oninput={(e: Event) => onInput(key, e)}
        />
      </div>
    {/each}
    <div>
      <div class="flex items-center justify-between gap-2">
        <Label for="page-ink-color" class="text-gray-900 dark:text-white">Ink color</Label>
        {#if inkColor !== 'off' && inkColor !== 'auto'}
          <span
            class="h-4 w-4 rounded-full border border-gray-300 dark:border-gray-600"
            style:background-color={INK_PALETTE[inkColor].ink}
            aria-hidden="true"
          ></span>
        {/if}
      </div>
      <Select
        id="page-ink-color"
        size="sm"
        placeholder=""
        items={inkOptions}
        value={inkColor}
        onchange={(e: Event) =>
          updateSetting('pageInkColor', sanitizeInkColor((e.target as HTMLSelectElement).value))}
      />
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Black-and-white pages only. Auto: each volume its own color, changing every 32 pages.
      </p>
    </div>
  </div>
</div>
