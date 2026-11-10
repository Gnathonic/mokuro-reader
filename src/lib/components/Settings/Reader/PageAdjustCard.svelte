<script lang="ts">
  import { settings, updateSetting } from '$lib/settings';
  import { listOptions, sliderDef } from '$lib/settings/setting-defs';
  import { Button, Label, Range, Select } from 'flowbite-svelte';
  import {
    INK_PALETTE,
    clampInkStrength,
    clampPaperAge,
    clampPaperTint,
    inkLayerColor,
    sanitizeInkColor,
    type InkColorSetting
  } from '$lib/reader/ink-color';
  import { clampPageAdjust } from '$lib/reader/page-filter';

  // Every label, option list, limit, step and reset value below is the
  // setting definition's (#55): the same data the key actions step by.

  // Page images only (#256): washed-out scans. The OCR text is never filtered.
  // (Ink color below does recolour the OCR text, to match the ink.)
  type AdjustKey = 'pageBrightness' | 'pageContrast';

  const sliders: { key: AdjustKey; def: ReturnType<typeof sliderDef> }[] = [
    { key: 'pageBrightness', def: sliderDef('brightness') },
    { key: 'pageContrast', def: sliderDef('contrast') }
  ];

  // Ink color for black-and-white pages (#256): colour pages are left alone.
  const inkOptions = listOptions<InkColorSetting>('ink-color');
  let inkColor = $derived(sanitizeInkColor($settings.pageInkColor));

  // The print effect's own controls: black-and-white (inked) pages only, never
  // the scan — brightness/contrast above stay the scan adjustment.
  type EffectKey = 'pageInkStrength' | 'pagePaperTint' | 'pagePaperAge';
  const effectSliders: {
    key: EffectKey;
    def: ReturnType<typeof sliderDef>;
    clamp: (v: unknown) => number;
  }[] = [
    { key: 'pageInkStrength', def: sliderDef('ink-strength'), clamp: clampInkStrength },
    { key: 'pagePaperTint', def: sliderDef('paper-tint'), clamp: clampPaperTint },
    { key: 'pagePaperAge', def: sliderDef('paper-age'), clamp: clampPaperAge }
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
    {#each sliders as { key, def } (key)}
      {@const value = clampPageAdjust($settings[key])}
      <div>
        <div class="flex items-center justify-between">
          <Label for={`page-adjust-${key}`} class="text-gray-900 dark:text-white">
            {def.label}: {def.format(value)}
          </Label>
          <Button
            size="xs"
            color="alternative"
            class="px-2 py-0.5"
            aria-label={`Reset ${def.label.toLowerCase()}`}
            disabled={value === def.reset}
            onclick={() => updateSetting(key, def.reset)}>Reset</Button
          >
        </div>
        <Range
          id={`page-adjust-${key}`}
          min={def.min}
          max={def.max}
          step={def.step}
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
        {@const def = slider.def}
        <div>
          <div class="flex items-center justify-between">
            <Label for={`page-effect-${slider.key}`} class="text-gray-900 dark:text-white">
              {def.label}: {def.format(value)}
            </Label>
            <Button
              size="xs"
              color="alternative"
              class="px-2 py-0.5"
              aria-label={`Reset ${def.label.toLowerCase()}`}
              disabled={value === def.reset}
              onclick={() => updateSetting(slider.key, def.reset)}>Reset</Button
            >
          </div>
          <Range
            id={`page-effect-${slider.key}`}
            min={def.min}
            max={def.max}
            step={def.step}
            {value}
            oninput={(e: Event) =>
              updateSetting(slider.key, slider.clamp(Number((e.target as HTMLInputElement).value)))}
          />
        </div>
      {/each}
    {/if}
  </div>
</div>
