import { browser } from '$app/environment';
import { derived, get, writable } from 'svelte/store';
import type { GoalSettings } from './types';

const defaultSettings: GoalSettings = {
  volumeDeadlines: {}
};

function loadGoalSettings(): GoalSettings {
  if (!browser) return defaultSettings;

  const stored = window.localStorage.getItem('goalSettings');
  if (!stored) return defaultSettings;

  try {
    const parsed = JSON.parse(stored);
    return {
      volumeDeadlines: parsed.volumeDeadlines || defaultSettings.volumeDeadlines
    };
  } catch {
    return defaultSettings;
  }
}

const _goalSettings = writable<GoalSettings>(loadGoalSettings());

_goalSettings.subscribe((settings) => {
  if (browser) {
    window.localStorage.setItem('goalSettings', JSON.stringify(settings));
  }
});

export const goalSettings = _goalSettings;

export function getVolumeDeadline(volumeId: string): string | null {
  const settings = get(_goalSettings);
  return settings.volumeDeadlines[volumeId] || null;
}

export function setVolumeDeadline(volumeId: string, deadline: string) {
  _goalSettings.update((settings) => {
    return {
      ...settings,
      volumeDeadlines: {
        ...settings.volumeDeadlines,
        [volumeId]: deadline
      }
    };
  });
}

export function removeVolumeDeadline(volumeId: string) {
  _goalSettings.update((settings) => {
    const { [volumeId]: _, ...rest } = settings.volumeDeadlines;
    return {
      ...settings,
      volumeDeadlines: rest
    };
  });
}

export const volumeDeadlines = derived(goalSettings, ($settings) => {
  return $settings.volumeDeadlines;
});
