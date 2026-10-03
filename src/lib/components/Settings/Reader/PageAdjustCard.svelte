<script lang="ts">
  import { settings, updateSetting } from '$lib/settings';
  import { Button, Label, Range, Select } from 'flowbite-svelte';
  import {
    INK_COLOR_NAMES,
    INK_PALETTE,
    INK_STRENGTH_DEFAULT,
    INK_STRENGTH_MAX,
    INK_STRENGTH_MIN,
    PAPER_AGE_DEFAULT,
    PAPER_AGE_MAX,
    PAPER_AGE_MIN,
    PAPER_TINT_DEFAULT,
    PAPER_TINT_MAX,
    PAPER_TINT_MIN,
    clampInkStrength,
    clampPaperAge,
    clampPaperTint,
    inkLayerColor,
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

  // The print effect's own controls: black-and-white (inked) pages only, never
  // the scan — brightness/contrast above stay the scan adjustment.
  type EffectKey = 'pageInkStrength' | 'pagePaperTint' | 'pagePaperAge';
  const effectSliders: {
    key: EffectKey;
    label: string;
    min: number;
    max: number;
    step: number;
    def: number;
    clamp: (v: unknown) => number;
    format: (v: number) => string;
  }[] = [
    {
      key: 'pageInkStrength',
      label: 'Ink strength',
      min: INK_STRENGTH_MIN,
      max: INK_STRENGTH_MAX,
      step: 5,
      def: INK_STRENGTH_DEFAULT,
      clamp: clampInkStrength,
      format: (v) => (v > 0 ? `+${v}` : `${v}`)
    },
    {
      key: 'pagePaperTint',
      label: 'Paper tint',
      min: PAPER_TINT_MIN,
      max: PAPER_TINT_MAX,
      step: 1,
      def: PAPER_TINT_DEFAULT,
      clamp: clampPaperTint,
      format: (v) => `${v}%`
    },
    {
      key: 'pagePaperAge',
      label: 'Paper age',
      min: PAPER_AGE_MIN,
      max: PAPER_AGE_MAX,
      step: 5,
      def: PAPER_AGE_DEFAULT,
      clamp: clampPaperAge,
      format: (v) => `${v}`
    }
  ];
  let swatchName = $derived(inkColor !== 'off' && inkColor !== 'auto' ? inkColor : null);

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
        <Label for="page-ink-color" class="text-gray-900 dark:text-white"
          >Magazine print effect <span lang="ja">（更紙）</span></Label
        >
        {#if swatchName}
          <span
            class="h-4 w-4 rounded-full border border-gray-300 dark:border-gray-600"
            style:background-color={inkLayerColor(
              INK_PALETTE[swatchName].ink,
              $settings.pageInkStrength
            )}
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
        Colored ink on tinted newsprint, like a weekly manga magazine. Black-and-white pages only.
        Auto: each volume its own color, changing every 32 pages.
      </p>
    </div>
    {#if inkColor !== 'off'}
      {#each effectSliders as slider (slider.key)}
        {@const value = slider.clamp($settings[slider.key])}
        <div>
          <div class="flex items-center justify-between">
            <Label for={`page-effect-${slider.key}`} class="text-gray-900 dark:text-white">
              {slider.label}: {slider.format(value)}
            </Label>
            <Button
              size="xs"
              color="alternative"
              class="px-2 py-0.5"
              aria-label={`Reset ${slider.label.toLowerCase()}`}
              disabled={value === slider.def}
              onclick={() => updateSetting(slider.key, slider.def)}>Reset</Button
            >
          </div>
          <Range
            id={`page-effect-${slider.key}`}
            min={slider.min}
            max={slider.max}
            step={slider.step}
            {value}
            oninput={(e: Event) =>
              updateSetting(slider.key, slider.clamp(Number((e.target as HTMLInputElement).value)))}
          />
        </div>
      {/each}
    {/if}
  </div>
</div>
