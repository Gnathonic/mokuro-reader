<script lang="ts">
  import { AccordionItem, Label, Range, Toggle, Select, Helper, Button } from 'flowbite-svelte';
  import ReaderSelects from './ReaderSelects.svelte';
  import ReaderToggles from './ReaderToggles.svelte';
  import {
    settings,
    updateSetting,
    effectiveVolumeSettings,
    updateProgress,
    updateVolumeSetting,
    volumes,
    type ScrollMode,
    type PageViewMode,
    type VolumeSettingsKey
  } from '$lib/settings';
  import { zoomDefault } from '$lib/panzoom';
  import { isReader } from '$lib/util';
  import { routeParams } from '$lib/util/hash-router';

  // Derived visibility flags
  let isContinuous = $derived($settings.continuousScroll);
  let isVertical = $derived(isContinuous && $settings.scrollMode === 'vertical');
  let isHorizontal = $derived(isContinuous && $settings.scrollMode === 'horizontal');
  let isAutoScroll = $derived(isContinuous && $settings.scrollMode === 'auto');
  let isPaged = $derived(!isContinuous);
  let isDualOrAuto = $derived($settings.singlePageView !== 'single');
  let showRtl = $derived(isPaged || isHorizontal || isAutoScroll);
  let showCover = $derived(isPaged && isDualOrAuto);
  let showOffset = $derived(isPaged && isDualOrAuto);
  let showPagedOnly = $derived(isPaged);

  // Volume-specific settings (only available in reader view)
  let inReader = $derived(isReader());
  let volumeId = $derived($routeParams.volume);
  let volSettings = $derived(volumeId ? $effectiveVolumeSettings[volumeId] : undefined);

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

  let swipeThresholdValue = $state($settings.swipeThreshold);
  let edgeButtonWidthValue = $state($settings.edgeButtonWidth);

  function onSwipeChange() {
    updateSetting('swipeThreshold', swipeThresholdValue);
  }

  function onWidthChange() {
    updateSetting('edgeButtonWidth', edgeButtonWidthValue);
  }

  function onPageViewModeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    updateSetting('singlePageView', target.value as PageViewMode);
    zoomDefault();
  }

  function onVolumeToggle(key: VolumeSettingsKey, value: any) {
    if (!volumeId) return;
    if (key === 'hasCover') {
      updateVolumeSetting(volumeId, key, !value);
      const pageClamped = Math.max($volumes[volumeId].progress - 1, 1);
      updateProgress(volumeId, pageClamped);
      zoomDefault();
    } else {
      updateVolumeSetting(volumeId, key, !value);
    }
  }
</script>

<AccordionItem open={inReader}>
  {#snippet header()}Reader{/snippet}
  <div class="flex flex-col gap-5">
    <!-- 1. Continuous scroll toggle - always visible -->
    <Toggle
      size="small"
      checked={isContinuous}
      onchange={() => updateSetting('continuousScroll', !isContinuous)}
    >
      Continuous scroll
      <span class="ml-1 text-xs font-medium text-amber-600 dark:text-amber-400">Alpha</span>
      <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(V)</span>
    </Toggle>

    <!-- 2. If paged: Page view mode dropdown -->
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
    {/if}

    <!-- 3. If continuous: Scroll mode dropdown + gap slider -->
    {#if isContinuous}
      <div>
        <Label class="text-gray-900 dark:text-white">Scroll mode:</Label>
        <Select
          size="sm"
          items={scrollModes}
          value={$settings.scrollMode}
          onchange={(e) => updateSetting('scrollMode', (e.target as HTMLSelectElement).value)}
        />
      </div>
      <Toggle
        size="small"
        checked={$settings.pageDividers}
        onchange={() => updateSetting('pageDividers', !$settings.pageDividers)}
      >
        Page dividers
        <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(M)</span>
      </Toggle>
      {#if $settings.pageDividers}
        <div>
          <Label class="text-gray-900 dark:text-white">
            Divider size: {$settings.scrollGap}px
          </Label>
          <Range
            min={0}
            max={100}
            value={$settings.scrollGap}
            onchange={(e) =>
              updateSetting('scrollGap', Number((e.target as HTMLInputElement).value))}
          />
        </div>
      {/if}
    {/if}

    <!-- 4. Zoom dropdown (handles continuous vs paged internally) -->
    <!-- 5. If paged: Page transition dropdown -->
    <ReaderSelects />

    <hr class="border-gray-100 opacity-10" />

    <!-- 6. Volume settings section -->
    {#if inReader && volSettings && volumeId}
      <Helper>Per-volume settings</Helper>

      <!-- 7. Right to left toggle -->
      {#if showRtl}
        <Toggle
          size="small"
          checked={volSettings.rightToLeft}
          onchange={() => onVolumeToggle('rightToLeft', volSettings?.rightToLeft)}
        >
          Right to left
        </Toggle>
      {/if}

      <!-- 8. First page is cover -->
      {#if showCover}
        <Toggle
          size="small"
          checked={volSettings.hasCover}
          onchange={() => onVolumeToggle('hasCover', volSettings?.hasCover)}
        >
          First page is cover
          <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(C)</span>
        </Toggle>
      {/if}

      <!-- 9. Offset spreads button -->
      {#if showOffset}
        <Button
          size="xs"
          color="alternative"
          onclick={() => window.dispatchEvent(new CustomEvent('offset-spreads'))}
        >
          Offset spreads
          <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(O)</span>
        </Button>
      {/if}

      <hr class="border-gray-100 opacity-10" />
    {/if}

    <!-- 10. Display toggles (already handles hiding bounds/mobile in continuous) -->
    <ReaderToggles />

    <!-- 13. If paged: Swipe threshold, Edge button width -->
    {#if showPagedOnly}
      <div>
        <Label>
          Swipe threshold
          <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(Mobile only)</span>
        </Label>
        <Range
          onchange={onSwipeChange}
          min={20}
          max={90}
          disabled={!$settings.mobile}
          bind:value={swipeThresholdValue}
        />
      </div>
      <div>
        <Label>Edge button width</Label>
        <Range onchange={onWidthChange} min={1} max={100} bind:value={edgeButtonWidthValue} />
      </div>
    {/if}
  </div>
</AccordionItem>
