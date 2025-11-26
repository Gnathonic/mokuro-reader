<script lang="ts">
  import {
    effectiveVolumeSettings,
    updateProgress,
    updateVolumeSetting,
    volumes,
    type VolumeSettingsKey,
    type PageViewMode
  } from '$lib/settings';
  import { zoomDefault } from '$lib/panzoom';
  import { AccordionItem, Helper, Toggle, Label, Select } from 'flowbite-svelte';
  import { routeParams } from '$lib/util/navigation';

  const volumeId = $routeParams.volume!;

  let settings = $derived($effectiveVolumeSettings[volumeId]);

  let toggles = $derived([
    { key: 'rightToLeft', text: 'Right to left', value: settings.rightToLeft },
    { key: 'hasCover', text: 'First page is cover', value: settings.hasCover, shortcut: 'C' }
  ] as { key: VolumeSettingsKey; text: string; value: any; shortcut?: string }[]);

  const pageViewModes: { value: PageViewMode; name: string }[] = [
    { value: 'single', name: 'Single page' },
    { value: 'dual', name: 'Dual page' },
    { value: 'auto', name: 'Auto (detect orientation & spreads)' }
  ];

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
  </div>
</AccordionItem>
