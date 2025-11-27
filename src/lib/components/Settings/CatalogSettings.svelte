<script lang="ts">
  import { AccordionItem, Button, Label, Range, Select, Toggle } from 'flowbite-svelte';
  import { db } from '$lib/catalog/db';
  import { promptConfirmation } from '$lib/util';
  import { clearVolumes } from '$lib/settings';
  import { miscSettings, updateMiscSetting, type CatalogStackingPreset } from '$lib/settings/misc';
  import { nav } from '$lib/util/navigation';
  import { isCatalog } from '$lib/util';

  const presetOptions = [
    { value: 'compact', name: 'Compact' },
    { value: 'default', name: 'Default' },
    { value: 'spine', name: 'Spine Showcase' },
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
    updateMiscSetting('catalogStackingPreset', preset);
    if (preset !== 'custom') {
      const config = presets[preset];
      updateMiscSetting('catalogStackCount', config.stackCount);
      updateMiscSetting('catalogHorizontalStep', config.horizontalStep);
      updateMiscSetting('catalogVerticalStep', config.verticalStep);
      updateMiscSetting('catalogHideReadVolumes', config.hideReadVolumes);
      updateMiscSetting('catalogCenterHorizontal', config.centerHorizontal);
      updateMiscSetting('catalogCenterVertical', config.centerVertical);
      updateMiscSetting('catalogCompactCloudSeries', config.compactCloudSeries);
    }
  }

  function handleSettingChange() {
    // When any setting changes manually, switch to custom preset
    if ($miscSettings.catalogStackingPreset !== 'custom') {
      updateMiscSetting('catalogStackingPreset', 'custom');
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

  let isCustom = $derived($miscSettings.catalogStackingPreset === 'custom');
  let isAllVolumes = $derived($miscSettings.catalogStackCount === 0);
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
          value={$miscSettings.catalogStackingPreset}
          onchange={(e) => applyPreset(e.currentTarget.value as CatalogStackingPreset)}
        />

        {#if isCustom}
          <!-- Stack count -->
          <div class="mb-4">
            <Label class="mb-2"
              >Stack count: {$miscSettings.catalogStackCount === 0
                ? 'All'
                : $miscSettings.catalogStackCount}</Label
            >
            <Range
              min={0}
              max={10}
              value={$miscSettings.catalogStackCount}
              oninput={(e) => {
                updateMiscSetting('catalogStackCount', parseInt(e.currentTarget.value));
                handleSettingChange();
              }}
            />
            <p class="text-xs text-gray-500 dark:text-gray-400">0 = show all volumes in series</p>
          </div>

          <!-- Hide completed -->
          <div class="mb-4">
            <Toggle
              checked={$miscSettings.catalogHideReadVolumes}
              onchange={(e) => {
                updateMiscSetting('catalogHideReadVolumes', e.currentTarget.checked);
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
              <Label class="mb-1">Offset: {$miscSettings.catalogHorizontalStep}%</Label>
              <Range
                min={0}
                max={30}
                value={$miscSettings.catalogHorizontalStep}
                oninput={(e) => {
                  updateMiscSetting('catalogHorizontalStep', parseInt(e.currentTarget.value));
                  handleSettingChange();
                }}
              />
            </div>
            <Toggle
              checked={$miscSettings.catalogCenterHorizontal}
              disabled={isAllVolumes}
              onchange={(e) => {
                updateMiscSetting('catalogCenterHorizontal', e.currentTarget.checked);
                handleSettingChange();
              }}
            >
              <span class:opacity-50={isAllVolumes}>
                {$miscSettings.catalogCenterHorizontal ? 'Center' : 'Spread'}
              </span>
            </Toggle>
          </div>

          <!-- Vertical axis group -->
          <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-800" class:opacity-50={isAllVolumes}>
            <Label class="mb-2 text-xs text-gray-500 uppercase">Vertical</Label>
            <div class="mb-2">
              <Label class="mb-1"
                >Offset: {isAllVolumes ? 0 : $miscSettings.catalogVerticalStep}%</Label
              >
              <Range
                min={0}
                max={30}
                disabled={isAllVolumes}
                value={$miscSettings.catalogVerticalStep}
                oninput={(e) => {
                  updateMiscSetting('catalogVerticalStep', parseInt(e.currentTarget.value));
                  handleSettingChange();
                }}
              />
            </div>
            <Toggle
              checked={$miscSettings.catalogCenterVertical}
              disabled={isAllVolumes}
              onchange={(e) => {
                updateMiscSetting('catalogCenterVertical', e.currentTarget.checked);
                handleSettingChange();
              }}
            >
              {$miscSettings.catalogCenterVertical ? 'Center' : 'Spread'}
            </Toggle>
          </div>

          <!-- Cloud series display -->
          <div class="mt-4">
            <Toggle
              checked={$miscSettings.catalogCompactCloudSeries}
              onchange={(e) => {
                updateMiscSetting('catalogCompactCloudSeries', e.currentTarget.checked);
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

    <Button onclick={onClear} outline color="red">Clear catalog</Button>
  </div>
</AccordionItem>
