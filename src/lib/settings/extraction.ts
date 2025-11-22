import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export type ExtractionSettings = {
  asCbz: boolean;
  individualVolumes: boolean;
  includeSeriesTitle: boolean;
};

export type ExtractionSettingsKey = keyof ExtractionSettings;

const defaultSettings: ExtractionSettings = {
  asCbz: true,
  individualVolumes: true,
  includeSeriesTitle: true
};

const stored = browser ? window.localStorage.getItem('extractionSettings') : undefined;

export const extractionSettings = writable<ExtractionSettings>(
  stored ? JSON.parse(stored) : defaultSettings
);

extractionSettings.subscribe((settings) => {
  if (browser) {
    window.localStorage.setItem('extractionSettings', JSON.stringify(settings));
  }
});

export function updateExtractionSetting(key: ExtractionSettingsKey, value: any) {
  extractionSettings.update((settings) => {
    return {
      ...settings,
      [key]: value
    };
  });
}
