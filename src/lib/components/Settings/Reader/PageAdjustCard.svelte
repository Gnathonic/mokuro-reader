<script lang="ts">
  import { settings, updateSetting } from '$lib/settings';
  import { Button, Label, Range } from 'flowbite-svelte';
  import {
    PAGE_ADJUST_DEFAULT,
    PAGE_ADJUST_MAX,
    PAGE_ADJUST_MIN,
    PAGE_ADJUST_STEP,
    clampPageAdjust
  } from '$lib/reader/page-filter';

  // Page images only (#256): washed-out scans. The OCR text is never filtered.
  type AdjustKey = 'pageBrightness' | 'pageContrast';

  const sliders: { key: AdjustKey; label: string }[] = [
    { key: 'pageBrightness', label: 'Brightness' },
    { key: 'pageContrast', label: 'Contrast' }
  ];

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
  </div>
</div>
