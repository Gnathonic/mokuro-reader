<script lang="ts">
  import {
    effectiveVolumeSettings,
    updateProgress,
    updateVolumeSetting,
    updateSetting,
    settings as globalSettings,
    volumes,
    type VolumeSettingsKey,
    type PageViewMode,
    type SettingsKey,
    type ContinuousZoomMode
  } from '$lib/settings';
  import { zoomDefault } from '$lib/panzoom';
  import { AccordionItem, Helper, Toggle, Label, Select } from 'flowbite-svelte';
  import { routeParams } from '$lib/util/hash-router';

  const volumeId = $routeParams.volume!;

  let settings = $derived($effectiveVolumeSettings[volumeId]);

  let toggles = $derived([
    { key: 'rightToLeft', text: 'Right to left', value: settings.rightToLeft },
    { key: 'hasCover', text: 'First page is cover', value: settings.hasCover, shortcut: 'C' }
  ] as { key: VolumeSettingsKey; text: string; value: any; shortcut?: string }[]);

  // Global settings for continuous scroll mode
  let continuousScroll = $derived($globalSettings.continuousScroll);
  let continuousZoomDefault = $derived($globalSettings.continuousZoomDefault);
  let scrollSnap = $derived($globalSettings.scrollSnap);

  const pageViewModes: { value: PageViewMode; name: string }[] = [
    { value: 'single', name: 'Single page' },
    { value: 'dual', name: 'Dual page' },
    { value: 'auto', name: 'Auto (detect orientation & spreads)' }
  ];

  const continuousZoomModes: { value: ContinuousZoomMode; name: string }[] = [
    { value: 'zoomFitToWidth', name: 'Fit to width' },
    { value: 'zoomFitToScreen', name: 'Fit to screen' },
    { value: 'zoomOriginal', name: 'Original size (1:1)' }
  ];

  function onContinuousZoomChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    updateSetting('continuousZoomDefault', target.value as ContinuousZoomMode);
  }

  function onChange(key: VolumeSettingsKey, value: any) {
    if (key === 'hasCover') {
      updateVolumeSetting(volumeId, key, !value);
      const pageClamped = Math.max($volumes[volumeId].progress - 1, 1);
      updateProgress(volumeId, pageClamped);
      zoomDefault();
    } else {
      updateVolumeSetting(volumeId, key, !value);
    }
  }

  function onPageViewModeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    updateVolumeSetting(volumeId, 'singlePageView', target.value as PageViewMode);
    zoomDefault();
  }
</script>

<AccordionItem open>
  {#snippet header()}Volume settings{/snippet}
  <div class="flex flex-col gap-5">
    <Helper>These settings only apply to this volume</Helper>
    <div>
      <Label for="page-view-mode" class="mb-2 text-gray-900 dark:text-white">
        Page view mode
        <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(P)</span>
      </Label>
      <Select
        id="page-view-mode"
        size="sm"
        items={pageViewModes}
        bind:value={settings.singlePageView}
        onchange={onPageViewModeChange}
      />
    </div>
    {#each toggles as { key, text, value, shortcut }}
      <Toggle size="small" checked={value} onchange={() => onChange(key, value)}>
        {text}
        {#if shortcut}
          <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">({shortcut})</span>
        {/if}
      </Toggle>
    {/each}

    <div class="mt-2 border-t border-gray-200 pt-4 dark:border-gray-700">
      <Helper class="mb-3">Scroll mode (applies to all volumes)</Helper>
      <Toggle
        size="small"
        checked={continuousScroll}
        onchange={() => updateSetting('continuousScroll', !continuousScroll)}
      >
        Continuous scroll
        <span class="ml-1 text-xs font-medium text-amber-600 dark:text-amber-400">Beta</span>
        <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(V)</span>
      </Toggle>
      {#if continuousScroll}
        <div class="mt-3 flex flex-col gap-3">
          <div>
            <Label for="continuous-zoom-mode" class="mb-2 text-gray-900 dark:text-white">
              Zoom mode
            </Label>
            <Select
              id="continuous-zoom-mode"
              size="sm"
              items={continuousZoomModes}
              value={continuousZoomDefault}
              onchange={onContinuousZoomChange}
            />
          </div>
          <Toggle
            size="small"
            checked={scrollSnap}
            onchange={() => updateSetting('scrollSnap', !scrollSnap)}
          >
            Snap to page boundaries
          </Toggle>
        </div>
      {/if}
    </div>
  </div>
</AccordionItem>
