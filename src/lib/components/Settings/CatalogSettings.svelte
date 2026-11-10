<script lang="ts">
  import { AccordionItem, Button, Label, Range, Select, Toggle } from 'flowbite-svelte';
  import { db } from '$lib/catalog/db';
  import { clearAllLayers } from '$lib/catalog/layer-store';
  import { promptConfirmation } from '$lib/util';
  import { clearVolumes } from '$lib/settings';
  import {
    catalogSettings,
    updateCatalogSetting,
    type CatalogStackingPreset
  } from '$lib/settings/settings';
  import { applyCatalogPreset, markCatalogPresetCustom } from '$lib/settings/catalog-presets';
  import { listOptions } from '$lib/settings/setting-defs';
  import { nav } from '$lib/util/hash-router';
  import { isCatalog } from '$lib/util';
  import type { DisplayTitleLanguage } from '$lib/metadata/types';

  // Option lists, the presets and what selecting one writes are the setting
  // definitions' (#55), shared with the key actions.
  const presetOptions = listOptions<CatalogStackingPreset>('stacking');
  const titleLanguageOptions = listOptions<DisplayTitleLanguage>('title-language');
  const applyPreset = applyCatalogPreset;
  // When any stacking setting changes by hand, the preset becomes Custom.
  const handleSettingChange = markCatalogPresetCustom;

  function onConfirm() {
    clearVolumes();
    db.volumes.clear();
    db.volume_ocr.clear();
    db.volume_files.clear();
    clearAllLayers(db);
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
            <p class="text-xs text-gray-500 dark:text-gray-400">
              0 = show all volumes in series. Cloud series are capped at 25 thumbnails.
            </p>
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

          <!-- Drop shadow -->
          <div class="mt-4">
            <Toggle
              checked={$catalogSettings?.dropShadow ?? true}
              onchange={(e) => {
                updateCatalogSetting('dropShadow', e.currentTarget.checked);
                handleSettingChange();
              }}
            >
              Drop shadow
            </Toggle>
          </div>
        {/if}
      </div>
    {/if}

    <div>
      <Label class="mb-2 text-sm font-medium">Preferred series title</Label>
      <Select
        items={titleLanguageOptions}
        value={$catalogSettings?.preferredTitleLanguage ?? 'imported'}
        onchange={(e) =>
          updateCatalogSetting(
            'preferredTitleLanguage',
            e.currentTarget.value as DisplayTitleLanguage
          )}
      />
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Applies to series with alt titles (AniList link or manual titles). Folder names are never
        changed; when a language is missing the reader falls back to English → Romaji → Native →
        folder name.
      </p>
    </div>

    <div class="flex flex-col gap-2">
      <Button onclick={() => nav.toMergeSeries()} outline color="blue">Merge series</Button>
      <Button onclick={onClear} outline color="red">Clear catalog</Button>
    </div>
  </div>
</AccordionItem>
