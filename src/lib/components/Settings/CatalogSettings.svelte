<script lang="ts">
  import { AccordionItem, Button, Label, Range, Select, Toggle } from 'flowbite-svelte';
  import { db } from '$lib/catalog/db';
  import { promptConfirmation } from '$lib/util';
  import { clearVolumes } from '$lib/settings';
  import {
    catalogSettings,
    updateCatalogSetting,
    type CatalogStackingPreset
  } from '$lib/settings/settings';
  import { nav } from '$lib/util/hash-router';
  import { isCatalog } from '$lib/util';

  const presetOptions = [
    { value: 'compact', name: 'Compact' },
    { value: 'default', name: 'Default' },
    { value: 'spine', name: 'Spine Showcase (Alpha)' },
    { value: 'custom', name: 'Custom' }
  ];

  // Preset configurations
  const presets: Record<
    Exclude<CatalogStackingPreset, 'custom'>,
    {
      stackCount: number;
      horizontalStep: number;
      verticalStep: number;
      hideReadVolumes: boolean;
      centerHorizontal: boolean;
      centerVertical: boolean;
      compactCloudSeries: boolean;
    }
  > = {
    compact: {
      stackCount: 1,
      horizontalStep: 0,
      verticalStep: 0,
      hideReadVolumes: true,
      centerHorizontal: true,
      centerVertical: true,
      compactCloudSeries: false
    },
    default: {
      stackCount: 3,
      horizontalStep: 11,
      verticalStep: 5,
      hideReadVolumes: true,
      centerHorizontal: true,
      centerVertical: false,
      compactCloudSeries: false
    },
    spine: {
      stackCount: 0, // 0 = all volumes in series
      horizontalStep: 11,
      verticalStep: 0,
      hideReadVolumes: false,
      centerHorizontal: true,
      centerVertical: true,
      compactCloudSeries: true
    }
  };

  function applyPreset(preset: CatalogStackingPreset) {
    updateCatalogSetting('stackingPreset', preset);
    if (preset !== 'custom') {
      const config = presets[preset];
      updateCatalogSetting('stackCount', config.stackCount);
      updateCatalogSetting('horizontalStep', config.horizontalStep);
      updateCatalogSetting('verticalStep', config.verticalStep);
      updateCatalogSetting('hideReadVolumes', config.hideReadVolumes);
      updateCatalogSetting('centerHorizontal', config.centerHorizontal);
      updateCatalogSetting('centerVertical', config.centerVertical);
      updateCatalogSetting('compactCloudSeries', config.compactCloudSeries);
    }
  }

  function handleSettingChange() {
    // When any setting changes manually, switch to custom preset
    if ($catalogSettings?.stackingPreset !== 'custom') {
      updateCatalogSetting('stackingPreset', 'custom');
    }
  }

  function onConfirm() {
    clearVolumes();
    db.volumes.clear();
    db.volume_ocr.clear();
    db.volume_files.clear();
  }

  function onClear() {
    promptConfirmation('Are you sure you want to clear your catalog?', onConfirm);
    nav.toCatalog();
  }

  let isCustom = $derived($catalogSettings?.stackingPreset === 'custom');
  let isAllVolumes = $derived($catalogSettings?.stackCount === 0);
</script>

<AccordionItem>
  {#snippet header()}Catalog settings{/snippet}
  <div class="flex flex-col gap-4">
    {#if isCatalog()}
      <!-- Thumbnail Stacking Section -->
      <div class="border-b border-gray-200 pb-4 dark:border-gray-700">
        <Label class="mb-3 text-sm font-medium">Thumbnail stacking</Label>

        <Select
          class="mb-4"
          items={presetOptions}
          value={$catalogSettings?.stackingPreset}
          onchange={(e) => applyPreset(e.currentTarget.value as CatalogStackingPreset)}
        />

        {#if isCustom}
          <!-- Stack count -->
          <div class="mb-4">
            <Label class="mb-2"
              >Stack count: {$catalogSettings?.stackCount === 0
                ? 'All'
                : $catalogSettings?.stackCount}</Label
            >
            <Range
              min={0}
              max={10}
              value={$catalogSettings?.stackCount ?? 3}
              oninput={(e) => {
                updateCatalogSetting('stackCount', parseInt(e.currentTarget.value));
                handleSettingChange();
              }}
            />
            <p class="text-xs text-gray-500 dark:text-gray-400">0 = show all volumes in series</p>
          </div>

          <!-- Hide completed -->
          <div class="mb-4">
            <Toggle
              checked={$catalogSettings?.hideReadVolumes ?? true}
              onchange={(e) => {
                updateCatalogSetting('hideReadVolumes', e.currentTarget.checked);
                handleSettingChange();
              }}
            >
              Hide completed volumes
            </Toggle>
          </div>

          <!-- Horizontal axis group -->
          <div class="mb-4 rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
            <Label class="mb-2 text-xs text-gray-500 uppercase">Horizontal</Label>
            <div class="mb-2">
              <Label class="mb-1">Offset: {$catalogSettings?.horizontalStep ?? 11}%</Label>
              <Range
                min={0}
                max={30}
                value={$catalogSettings?.horizontalStep ?? 11}
                oninput={(e) => {
                  updateCatalogSetting('horizontalStep', parseInt(e.currentTarget.value));
                  handleSettingChange();
                }}
              />
            </div>
            <Toggle
              checked={$catalogSettings?.centerHorizontal ?? true}
              disabled={isAllVolumes}
              onchange={(e) => {
                updateCatalogSetting('centerHorizontal', e.currentTarget.checked);
                handleSettingChange();
              }}
            >
              <span class:opacity-50={isAllVolumes}>
                {$catalogSettings?.centerHorizontal ? 'Center' : 'Spread'}
              </span>
            </Toggle>
          </div>

          <!-- Vertical axis group -->
          <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-800" class:opacity-50={isAllVolumes}>
            <Label class="mb-2 text-xs text-gray-500 uppercase">Vertical</Label>
            <div class="mb-2">
              <Label class="mb-1"
                >Offset: {isAllVolumes ? 0 : ($catalogSettings?.verticalStep ?? 5)}%</Label
              >
              <Range
                min={0}
                max={30}
                disabled={isAllVolumes}
                value={$catalogSettings?.verticalStep ?? 5}
                oninput={(e) => {
                  updateCatalogSetting('verticalStep', parseInt(e.currentTarget.value));
                  handleSettingChange();
                }}
              />
            </div>
            <Toggle
              checked={$catalogSettings?.centerVertical ?? false}
              disabled={isAllVolumes}
              onchange={(e) => {
                updateCatalogSetting('centerVertical', e.currentTarget.checked);
                handleSettingChange();
              }}
            >
              {$catalogSettings?.centerVertical ? 'Center' : 'Spread'}
            </Toggle>
          </div>

          <!-- Cloud series display -->
          <div class="mt-4">
            <Toggle
              checked={$catalogSettings?.compactCloudSeries ?? false}
              onchange={(e) => {
                updateCatalogSetting('compactCloudSeries', e.currentTarget.checked);
                handleSettingChange();
              }}
            >
              Compact cloud-only series
            </Toggle>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Show cloud-only series as single thumbnails
            </p>
          </div>
        {/if}
      </div>
    {/if}

    <div class="flex flex-col gap-2">
      <Button onclick={() => nav.toMergeSeries()} outline color="blue">Merge series</Button>
      <Button onclick={onClear} outline color="red">Clear catalog</Button>
    </div>
  </div>
</AccordionItem>
