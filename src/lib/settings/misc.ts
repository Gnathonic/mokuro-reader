import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export type CatalogStackingPreset = 'compact' | 'default' | 'spine' | 'custom';

export type MiscSettings = {
  galleryLayout: 'grid' | 'list';
  gallerySorting: 'ASC' | 'DESC' | 'SMART';
  deviceRamGB: 4 | 8 | 16 | 32;
  turboMode: boolean;
  gdriveAutoReAuth: boolean;
  // Catalog layout settings
  catalogStackingPreset: CatalogStackingPreset; // Preset selection
  catalogHorizontalStep: number; // Horizontal offset percentage (default 11)
  catalogVerticalStep: number; // Vertical offset percentage (default 11)
  catalogStackCount: number; // Number of volumes to show (0 = all, default 3)
  catalogHideReadVolumes: boolean; // Hide read volumes from in-progress series stack
  catalogCenterHorizontal: boolean; // Center horizontally when fewer volumes than stack count
  catalogCenterVertical: boolean; // Center vertically when thumbnails don't fill height
  catalogCompactCloudSeries: boolean; // Show cloud-only series as compact (single thumbnail)
};

export type MiscSettingsKey = keyof MiscSettings;

// Detect device memory and set default RAM config
function getDefaultRamSetting(): 4 | 8 | 16 | 32 {
  if (browser) {
    const deviceMemory = (navigator as any).deviceMemory;
    if (deviceMemory !== undefined) {
      // deviceMemory is capped at 8GB, but if it reports 8, assume 16GB+ is likely
      if (deviceMemory >= 8) return 16;
      if (deviceMemory >= 4) return 8;
      if (deviceMemory >= 2) return 4;
    }
  }
  return 4; // Conservative default
}

const defaultSettings: MiscSettings = {
  galleryLayout: 'grid',
  gallerySorting: 'SMART',
  deviceRamGB: getDefaultRamSetting(),
  turboMode: false, // Default to single-operation mode (patient users)
  gdriveAutoReAuth: true, // Keep users synced during long reading sessions
  // Catalog layout defaults (matches 'default' preset)
  catalogStackingPreset: 'default',
  catalogHorizontalStep: 11,
  catalogVerticalStep: 5,
  catalogStackCount: 3,
  catalogHideReadVolumes: true,
  catalogCenterHorizontal: true,
  catalogCenterVertical: false, // spread vertically
  catalogCompactCloudSeries: false // cloud-only series show as single thumbnail
};

const stored = browser ? window.localStorage.getItem('miscSettings') : undefined;

export const miscSettings = writable<MiscSettings>(stored ? JSON.parse(stored) : defaultSettings);

miscSettings.subscribe((miscSettings) => {
  if (browser) {
    window.localStorage.setItem('miscSettings', JSON.stringify(miscSettings));
  }
});

export function updateMiscSetting(key: MiscSettingsKey, value: any) {
  miscSettings.update((miscSettings) => {
    return {
      ...miscSettings,
      [key]: value
    };
  });
}
