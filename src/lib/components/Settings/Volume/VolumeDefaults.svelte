<script lang="ts">
  import {
    settings,
    updateVolumeDefaults,
    type VolumeDefaultsKey,
    type PageViewMode
  } from '$lib/settings';
  import { AccordionItem, Helper, Toggle, Label, Select } from 'flowbite-svelte';
  import { zoomDefault } from '$lib/panzoom';

  let toggles = $derived([
    { key: 'rightToLeft', text: 'Right to left', value: $settings.volumeDefaults?.rightToLeft },
    { key: 'hasCover', text: 'First page is cover', value: $settings.volumeDefaults?.hasCover }
  ] as { key: VolumeDefaultsKey; text: string; value: any }[]);

  const pageViewModes: { value: PageViewMode; name: string }[] = [
    { value: 'single', name: 'Single page' },
    { value: 'dual', name: 'Dual page' },
    { value: 'auto', name: 'Auto (detect orientation & spreads)' }
  ];

  function onPageViewModeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    updateVolumeDefaults('singlePageView', target.value as PageViewMode);
    zoomDefault();
  }
</script>

<AccordionItem open>
  {#snippet header()}Volume defaults{/snippet}
  <div class="flex flex-col gap-5">
    <Helper>The default settings that are applied when you start a new volume</Helper>
    <div>
      <Label for="default-page-view-mode" class="mb-2 text-gray-900 dark:text-white">
        Page view mode
        <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(P)</span>
      </Label>
      <Select
        id="default-page-view-mode"
        size="sm"
        items={pageViewModes}
        bind:value={$settings.volumeDefaults.singlePageView}
        onchange={onPageViewModeChange}
      />
    </div>
    {#each toggles as { key, text, value }}
      <Toggle size="small" checked={value} onchange={() => updateVolumeDefaults(key, !value)}
        >{text}</Toggle
      >
    {/each}
  </div>
</AccordionItem>
