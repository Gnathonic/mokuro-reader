<script lang="ts">
  import { AccordionItem, Label, Range, Toggle, Select } from 'flowbite-svelte';
  import ReaderSelects from './ReaderSelects.svelte';
  import SettingToggle from './SettingToggle.svelte';
  import {
    settings,
    updateSetting,
    type ScrollMode,
    type PageViewMode
  } from '#lib/settings/index.js';
  import { isReader } from '#lib/util/index.js';
  import { MAX_PAGE_GAP } from '#lib/reader/zoom-math.js';

  /**
   * "Reader": how pages are laid out and shown — paged or continuous, page
   * view, gaps, zoom, transitions. The section the drawer opens in the reader.
   * Text, controls, filters and overlays have their own sections.
   */
  let isContinuous = $derived($settings.continuousScroll);
  let isPaged = $derived(!isContinuous);
  let isDualOrAuto = $derived($settings.singlePageView !== 'single');
  let inReader = $derived(isReader());

  const scrollModes: { value: ScrollMode; name: string }[] = [
    { value: 'auto', name: 'Match orientation' },
    { value: 'vertical', name: 'Vertical scroll' },
    { value: 'horizontal', name: 'Horizontal scroll' }
  ];

  const pageViewModes: { value: PageViewMode; name: string }[] = [
    { value: 'single', name: 'Single page' },
    { value: 'dual', name: 'Dual page' },
    { value: 'auto', name: 'Auto (detect orientation & spreads)' }
  ];

  function onPageViewModeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    updateSetting('singlePageView', target.value as PageViewMode);
  }
</script>

<AccordionItem open={inReader}>
  {#snippet header()}Reader{/snippet}
  <div class="flex flex-col gap-5">
    <Toggle
      size="small"
      checked={isContinuous}
      onchange={() => updateSetting('continuousScroll', !isContinuous)}
    >
      Continuous scroll
      <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(V)</span>
    </Toggle>

    {#if isPaged}
      <div>
        <Label for="page-view-mode" class="mb-2 text-gray-900 dark:text-white">
          Page view mode
          <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(P)</span>
        </Label>
        <Select
          id="page-view-mode"
          size="sm"
          items={pageViewModes}
          value={$settings.singlePageView}
          onchange={onPageViewModeChange}
        />
      </div>
      {#if isDualOrAuto}
        <div>
          <Label class="text-gray-900 dark:text-white">
            Page gap: {$settings.pagedGap}px
            <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(Ctrl+Shift+Scroll)</span>
          </Label>
          <Range
            min={0}
            max={MAX_PAGE_GAP}
            value={$settings.pagedGap}
            onchange={(e) =>
              updateSetting('pagedGap', Number((e.target as HTMLInputElement).value))}
          />
        </div>
      {/if}
    {:else}
      <div>
        <Label class="text-gray-900 dark:text-white">Scroll mode:</Label>
        <Select
          size="sm"
          items={scrollModes}
          value={$settings.scrollMode}
          onchange={(e) => updateSetting('scrollMode', (e.target as HTMLSelectElement).value)}
        />
      </div>
      <SettingToggle key="pageDividers" text="Page dividers" shortcut="M" />
      {#if $settings.pageDividers}
        <div>
          <Label class="text-gray-900 dark:text-white">
            Divider size: {$settings.scrollGap}px
            <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(Ctrl+Shift+Scroll)</span>
          </Label>
          <Range
            min={0}
            max={MAX_PAGE_GAP}
            value={$settings.scrollGap}
            onchange={(e) =>
              updateSetting('scrollGap', Number((e.target as HTMLInputElement).value))}
          />
        </div>
      {/if}
    {/if}

    <!-- Zoom (paged vs continuous handled inside) and, paged only, the page transition. -->
    <ReaderSelects />

    <SettingToggle key="defaultFullscreen" text="Open reader in fullscreen" />
    <SettingToggle key="disableAnimations" text="Disable animations (e-ink)" />
  </div>
</AccordionItem>
