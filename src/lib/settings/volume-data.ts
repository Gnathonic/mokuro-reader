import { browser } from '$app/environment';
import { derived, get, writable } from 'svelte/store';
import { settings, updateSetting, } from './settings';
import { zoomDefault } from '$lib/panzoom';
import { page } from '$app/stores';
import { currentSeries, currentVolume } from '$lib/catalog';

export type VolumeSettings = {
  rightToLeft: boolean;
  singlePageView: boolean;
  hasCover: boolean;
}

export type VolumeSettingsKey = keyof VolumeSettings;

type Progress = Record<string, number> | undefined;

type VolumeData = {
  progress: number;
  chars: number;
  completed: boolean;
  timeReadInMinutes: number,
  settings: VolumeSettings;
}

type TotalStats = {
  completed: number;
  pagesRead: number;
  charsRead: number;
  minutesRead: number;
}

type Volumes = Record<string, VolumeData>;


const stored = browser ? window.localStorage.getItem('volumes') : undefined;
const initial: Volumes = stored && browser ? JSON.parse(stored) : {};

export const volumes = writable<Volumes>(initial);

export function initializeVolume(volume: string) {
  const volumeDefaults = get(settings).volumeDefaults;

  if (!volumeDefaults) {
    updateSetting('volumeDefaults', {
      singlePageView: false,
      rightToLeft: true,
      hasCover: false
    })
  }

  const { hasCover, rightToLeft, singlePageView } = volumeDefaults
  volumes.update((prev) => {
    const existingVolume = prev[volume];
    return {
      ...prev,
      [volume]: {
        chars: existingVolume?.chars ?? 0,
        completed: existingVolume?.completed ?? false,
        progress: existingVolume?.progress ?? 1,
        timeReadInMinutes: existingVolume?.timeReadInMinutes ?? 0,
        settings: {
          hasCover,
          rightToLeft,
          singlePageView
        }
      }
    };
  });
}

export function deleteVolume(volume: string) {
  volumes.update((prev) => {
    delete prev[volume]
    return prev
  })
}

export function clearVolumes() {
  volumes.set({});
}

export function updateProgress(volume: string, progress: number, chars?: number, completed = false) {
  volumes.update((prev) => {
    return {
      ...prev,
      [volume]: {
        ...prev?.[volume],
        progress,
        chars: chars || prev?.[volume].chars,
        completed
      }
    };
  });
}

export function startCount(volume: string) {
  return setInterval(() => {
    volumes.update((prev) => {
      return {
        ...prev,
        [volume]: {
          ...prev?.[volume],
          timeReadInMinutes: prev?.[volume].timeReadInMinutes + 1
        }
      };
    });
  }, 60 * 1000)
}

volumes.subscribe((volumes) => {
  if (browser) {
    window.localStorage.setItem('volumes', volumes ? JSON.stringify(volumes) : '');
  }
});

export const progress = derived(volumes, ($volumes) => {
  const progress: Progress = {}

  if ($volumes) {
    Object.keys($volumes).forEach((key) => {
      progress[key] = $volumes[key].progress
    });
  }

  return progress
})

export const volumeSettings = derived(volumes, ($volumes) => {
  const settings: Record<string, VolumeSettings> = {}

  if ($volumes) {
    Object.keys($volumes).forEach((key) => {
      settings[key] = $volumes[key].settings
    });
  }

  return settings
})

export function updateVolumeSetting(volume: string, key: VolumeSettingsKey, value: any) {
  volumes.update((prev) => {
    return {
      ...prev,
      [volume]: {
        ...prev[volume],
        settings: {
          ...prev[volume].settings,
          [key]: value
        }
      }
    };
  });
  zoomDefault();
}

export const totalStats = derived([volumes, page], ([$volumes, $page]) => {
  if ($page && $volumes) {
    return Object.values($volumes).reduce<TotalStats>((stats, { chars, completed, timeReadInMinutes, progress }) => {
      if (completed) {
        stats.completed++;
      }

      stats.pagesRead += progress;
      stats.minutesRead += timeReadInMinutes;
      stats.charsRead += chars

      return stats;
    }, {
      charsRead: 0,
      completed: 0,
      pagesRead: 0,
      minutesRead: 0
    })
  }
})

export const mangaStats = derived([currentSeries, volumes], ([$titleVolumes, $volumes]) => {
  if ($titleVolumes && $volumes) {
    return $titleVolumes.map((vol) => vol.volume_uuid).reduce(
      (stats: any, volumeId) => {
        const timeReadInMinutes = $volumes[volumeId]?.timeReadInMinutes || 0;
        const chars = $volumes[volumeId]?.chars || 0;
        const completed = $volumes[volumeId]?.completed || 0;

        stats.timeReadInMinutes = stats.timeReadInMinutes + timeReadInMinutes;
        stats.chars = stats.chars + chars;
        stats.completed = stats.completed + completed;

        return stats;
      },
      { timeReadInMinutes: 0, chars: 0, completed: 0 }
    );
  }
});

export const volumeStats = derived([currentVolume, volumes], ([$currentVolume, $volumes]) => {
  if ($currentVolume && $volumes) {
    const { chars, completed, timeReadInMinutes, progress } = $volumes[$currentVolume.volume_uuid];
    return { chars, completed, timeReadInMinutes, progress };
  }
  return { chars: 0, completed: 0, timeReadInMinutes: 0, progress: 0 };
});