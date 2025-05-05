import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export type MiscSettings = {
  galleryLayout: 'grid' | 'list';
  gallerySorting: 'ASC' | 'DESC' | 'SMART';
  throttleDownloads: boolean;
};

export type MiscSettingsKey = keyof MiscSettings;

const defaultSettings: MiscSettings = {
  galleryLayout: 'grid',
  gallerySorting: 'SMART',
  throttleDownloads: true
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
