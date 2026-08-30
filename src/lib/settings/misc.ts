import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export type ProgressTrackerSorting =
  | 'last-read'
  | 'pages-per-period'
  | 'pages-to-goal'
  | 'fewest-pages'
  | 'deadline';
export type ProgressTargetMode = 'daily' | 'weekly';
export type CompletedVolumesViewMode = 'volumes' | 'series';

export type MiscSettings = {
  galleryLayout: 'grid' | 'list';
  gallerySorting: 'ASC' | 'DESC' | 'SMART';
  progressTrackerSorting: ProgressTrackerSorting;
  progressTargetMode: ProgressTargetMode;
  completedVolumesViewMode: CompletedVolumesViewMode;
  progressResetHour: number; // 0-23, hour when daily/weekly targets reset
  progressResetDay: number; // 0-6 (Sunday-Saturday), day when weekly targets reset
  deviceRamGB: 4 | 8 | 16 | 32;
  turboMode: boolean;
  gdriveAutoReAuth: boolean;
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
  progressTrackerSorting: 'last-read',
  progressTargetMode: 'daily',
  completedVolumesViewMode: 'volumes',
  progressResetHour: 0, // Midnight
  progressResetDay: 1, // Monday
  deviceRamGB: getDefaultRamSetting(),
  turboMode: false, // Default to single-operation mode (patient users)
  gdriveAutoReAuth: true // Keep users synced during long reading sessions
};

/**
 * Stored settings are MERGED OVER the defaults, never used raw.
 *
 * A raw `JSON.parse(stored)` returns whatever shape that key had when it was
 * last written, so every key added after a user's first visit reads back
 * `undefined` for them forever — they never wrote the new key, so it is never
 * in their stored blob. The five progress-tracker keys are the newest example;
 * `deviceRamGB` and `gdriveAutoReAuth` had the same latent hole.
 *
 * The parse is guarded for the same reason the other stores guard theirs: this
 * runs in the module body, so a truncated key would white-screen the app on
 * every load with no way out but clearing site data.
 */
function loadMiscSettings(): MiscSettings {
  if (!browser) return defaultSettings;

  const stored = window.localStorage.getItem('miscSettings');
  if (!stored) return defaultSettings;

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return defaultSettings;

    const merged = { ...defaultSettings, ...(parsed as Partial<MiscSettings>) };

    // Clamp the two numeric keys. They index into date arithmetic, so an
    // out-of-range value from a hand edit or an older build produces an
    // Invalid Date period rather than a wrong-but-usable one.
    merged.progressResetHour = clampInt(merged.progressResetHour, 0, 23, 0);
    merged.progressResetDay = clampInt(merged.progressResetDay, 0, 6, 1);

    return merged;
  } catch {
    return defaultSettings;
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export const miscSettings = writable<MiscSettings>(loadMiscSettings());

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
