/**
 * The catalog's thumbnail-stacking presets (#55: moved out of
 * `CatalogSettings.svelte` so the "Stacking preset" setting definition, and a
 * key bound to it, applies exactly what the select applies).
 */
import { get } from 'svelte/store';
import {
  catalogSettings,
  updateCatalogSetting,
  type CatalogSettings,
  type CatalogStackingPreset
} from './settings';

type PresetConfig = Pick<
  CatalogSettings,
  | 'stackCount'
  | 'horizontalStep'
  | 'verticalStep'
  | 'hideReadVolumes'
  | 'centerHorizontal'
  | 'centerVertical'
  | 'compactCloudSeries'
  | 'dropShadow'
>;

export const CATALOG_PRESETS: Record<Exclude<CatalogStackingPreset, 'custom'>, PresetConfig> = {
  compact: {
    stackCount: 1,
    horizontalStep: 0,
    verticalStep: 0,
    hideReadVolumes: true,
    centerHorizontal: true,
    centerVertical: true,
    compactCloudSeries: false,
    dropShadow: true
  },
  default: {
    stackCount: 3,
    horizontalStep: 11,
    verticalStep: 5,
    hideReadVolumes: true,
    centerHorizontal: true,
    centerVertical: false,
    compactCloudSeries: false,
    dropShadow: true
  },
  spine: {
    stackCount: 0, // 0 = all volumes in series
    horizontalStep: 11,
    verticalStep: 0,
    hideReadVolumes: false,
    centerHorizontal: true,
    centerVertical: true,
    compactCloudSeries: true,
    dropShadow: false
  }
};

/** Select a preset: stores it and, unless it is Custom, the eight settings it stands for. */
export function applyCatalogPreset(preset: CatalogStackingPreset) {
  updateCatalogSetting('stackingPreset', preset);
  if (preset === 'custom') return;
  const config = CATALOG_PRESETS[preset];
  for (const key of Object.keys(config) as (keyof PresetConfig)[]) {
    updateCatalogSetting(key, config[key]);
  }
}

/** A stacking setting was changed by hand: the preset no longer describes it. */
export function markCatalogPresetCustom() {
  if (get(catalogSettings)?.stackingPreset !== 'custom') {
    updateCatalogSetting('stackingPreset', 'custom');
  }
}
