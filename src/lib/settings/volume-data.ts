import { browser } from '$app/environment';
import { derived, writable, readable } from 'svelte/store';
import { zoomDefault } from '$lib/panzoom';
import { page } from '$app/stores';
import { currentSeries, currentVolume } from '$lib/catalog';
import { settings as globalSettings } from './settings';

import type { PageViewMode } from './settings';

// Deep equality check for settings objects
function settingsEqual(
  a: Record<string, { rightToLeft: boolean; singlePageView: PageViewMode; hasCover: boolean }>,
  b: Record<string, { rightToLeft: boolean; singlePageView: PageViewMode; hasCover: boolean }>
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!b[key]) return false;
    if (
      a[key].rightToLeft !== b[key].rightToLeft ||
      a[key].singlePageView !== b[key].singlePageView ||
      a[key].hasCover !== b[key].hasCover
    ) {
      return false;
    }
  }

  return true;
}

export type VolumeSettings = {
  rightToLeft?: boolean;
  singlePageView?: PageViewMode;
  hasCover?: boolean;
};

export type VolumeSettingsKey = keyof VolumeSettings;

// Session tracking types
export type PageTurn = [number, number]; // [timestamp_ms, page_number]

// Aggregate session data (for reading speed calculation)
export type AggregateSession = {
  durationMs: number;
  charsRead: number;
};

type Progress = Record<string, number> | undefined;
type VolumeDataJSON = {
  progress?: number;
  chars?: number;
  completed?: boolean;
  timeReadInMinutes?: number;
  settings?: VolumeSettings;
  lastProgressUpdate?: string;
  // Recent page turns for active reading session (will be compacted into sessions)
  recentPageTurns?: PageTurn[];
  // Aggregate session data for reading speed calculation
  sessions?: AggregateSession[];
};

class VolumeData implements VolumeDataJSON {
  progress: number;
  chars: number;
  completed: boolean;
  timeReadInMinutes: number;
  settings: VolumeSettings;
  lastProgressUpdate: string;
  recentPageTurns: PageTurn[];
  sessions: AggregateSession[];

  constructor(data: Partial<VolumeDataJSON> = {}) {
    this.progress = typeof data.progress === 'number' ? data.progress : 0;
    this.chars = typeof data.chars === 'number' ? data.chars : 0;
    this.completed = !!data.completed;
    this.timeReadInMinutes =
      typeof data.timeReadInMinutes === 'number' ? data.timeReadInMinutes : 0;
    this.lastProgressUpdate = data.lastProgressUpdate || new Date(0).toISOString();

    // Session tracking fields
    this.recentPageTurns = data.recentPageTurns || [];
    this.sessions = data.sessions || [];

    // Only store explicitly set values, leave others undefined to fall back to global defaults
    this.settings = {};

    // Migrate old boolean values to new PageViewMode
    if (data.settings?.singlePageView !== undefined) {
      if (typeof data.settings.singlePageView === 'boolean') {
        // Old boolean value -> migrate to 'auto'
        this.settings.singlePageView = 'auto';
      } else {
        this.settings.singlePageView = data.settings.singlePageView;
      }
    }

    // Only store if explicitly provided
    if (typeof data.settings?.rightToLeft === 'boolean') {
      this.settings.rightToLeft = data.settings.rightToLeft;
    }

    if (typeof data.settings?.hasCover === 'boolean') {
      this.settings.hasCover = data.settings.hasCover;
    }
  }

  static fromJSON(json: any): VolumeData {
    if (typeof json === 'string') {
      try {
        json = JSON.parse(json);
      } catch {
        json = {};
      }
    }
    return new VolumeData(json || {});
  }

  toJSON() {
    const result: Partial<VolumeDataJSON> = {};

    // Only include non-default values
    if (this.progress > 0) result.progress = this.progress;
    if (this.chars > 0) result.chars = this.chars;
    if (this.completed) result.completed = this.completed;
    if (this.timeReadInMinutes > 0) result.timeReadInMinutes = this.timeReadInMinutes;

    // Only include lastProgressUpdate if it's not epoch
    if (this.lastProgressUpdate !== new Date(0).toISOString()) {
      result.lastProgressUpdate = this.lastProgressUpdate;
    }

    // Include volume properties (rightToLeft, hasCover) but exclude device preferences (singlePageView)
    // rightToLeft and hasCover are facts about the volume itself that should sync
    // singlePageView is a device-specific viewing preference that should stay local
    const syncableSettings: Partial<VolumeSettings> = {};
    if (typeof this.settings.rightToLeft === 'boolean') {
      syncableSettings.rightToLeft = this.settings.rightToLeft;
    }
    if (typeof this.settings.hasCover === 'boolean') {
      syncableSettings.hasCover = this.settings.hasCover;
    }

    if (Object.keys(syncableSettings).length > 0) {
      result.settings = syncableSettings;
    }

    // Only include recentPageTurns if there are any
    if (this.recentPageTurns.length > 0) {
      result.recentPageTurns = this.recentPageTurns;
    }

    // Only include sessions if there are any
    if (this.sessions.length > 0) {
      result.sessions = this.sessions;
    }

    return result;
  }
}

type TotalStats = {
  completed: number;
  pagesRead: number;
  charsRead: number;
  minutesRead: number;
};

type Volumes = Record<string, VolumeData>;

export function parseVolumesFromJson(storedData: string): Volumes {
  try {
    const parsed = JSON.parse(storedData);
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, VolumeData.fromJSON(value)])
    );
  } catch {
    return {};
  }
}

const initial: Volumes = browser
  ? parseVolumesFromJson(window.localStorage.getItem('volumes') || '{}')
  : {};

export const volumes = writable<Volumes>(initial);

export function initializeVolume(volume: string) {
  volumes.update((prev) => {
    return {
      ...prev,
      [volume]: new VolumeData()
    };
  });
}

export function deleteVolume(volume: string) {
  volumes.update((prev) => {
    delete prev[volume];
    return prev;
  });
}

export function clearVolumes() {
  volumes.set({});
}

export function updateProgress(
  volume: string,
  progress: number,
  chars?: number,
  completed = false
) {
  volumes.update((prev) => {
    const currentVolume = prev[volume] || new VolumeData();
    const now = Date.now();

    // Get session timeout from user settings (in minutes, convert to ms)
    let sessionTimeoutMs = 30 * 60 * 1000; // Default 30 minutes
    globalSettings.subscribe(s => {
      sessionTimeoutMs = s.inactivityTimeoutMinutes * 60 * 1000;
    })();

    // Session tracking logic - just add to recentPageTurns
    // Compaction into aggregate sessions will happen later
    let recentPageTurns = currentVolume.recentPageTurns;

    // Check if we need to clear old turns (session timeout)
    if (recentPageTurns.length > 0) {
      const lastTurn = recentPageTurns[recentPageTurns.length - 1];
      if (now - lastTurn[0] > sessionTimeoutMs) {
        // TODO: Compact recentPageTurns into an aggregate session before clearing
        // For now, just clear
        recentPageTurns = [];
      }
    }

    // Add new turn
    recentPageTurns = [...recentPageTurns, [now, progress]];

    return {
      ...prev,
      [volume]: new VolumeData({
        ...currentVolume,
        progress,
        chars: chars ?? currentVolume.chars,
        completed,
        lastProgressUpdate: new Date().toISOString(),
        recentPageTurns
      })
    };
  });
}

export function startCount(volume: string) {
  return setInterval(() => {
    volumes.update((prev) => {
      const currentVolume = prev[volume] || new VolumeData();
      return {
        ...prev,
        [volume]: new VolumeData({
          ...currentVolume,
          timeReadInMinutes: currentVolume.timeReadInMinutes + 1
        })
      };
    });
  }, 60 * 1000);
}

volumes.subscribe((volumes) => {
  if (browser) {
    const serializedVolumes = volumes
      ? Object.fromEntries(Object.entries(volumes).map(([key, value]) => [key, value.toJSON()]))
      : {};
    window.localStorage.setItem('volumes', JSON.stringify(serializedVolumes));
  }
});

export const progress = derived(volumes, ($volumes) => {
  const progress: Progress = {};

  if ($volumes) {
    Object.keys($volumes).forEach((key) => {
      progress[key] = $volumes[key].progress;
    });
  }

  return progress;
});

export const volumeSettings = derived(volumes, ($volumes) => {
  const settings: Record<string, VolumeSettings> = {};

  if ($volumes) {
    Object.keys($volumes).forEach((key) => {
      settings[key] = $volumes[key].settings;
    });
  }

  return settings;
});

// Effective settings that merge volume-specific overrides with current global defaults
// Uses custom readable with deep equality check to prevent re-renders when timer updates
// (which modifies volumes but not settings)
export const effectiveVolumeSettings = readable(
  {} as Record<string, { rightToLeft: boolean; singlePageView: PageViewMode; hasCover: boolean }>,
  (set) => {
    let previousEffective: Record<
      string,
      { rightToLeft: boolean; singlePageView: PageViewMode; hasCover: boolean }
    > = {};

    const unsubscribe = derived([volumes, globalSettings], ([$volumes, $globalSettings]) => {
      const effective: Record<
        string,
        { rightToLeft: boolean; singlePageView: PageViewMode; hasCover: boolean }
      > = {};

      if ($volumes) {
        Object.keys($volumes).forEach((key) => {
          const volumeSettings = $volumes[key].settings;
          effective[key] = {
            rightToLeft: volumeSettings.rightToLeft ?? $globalSettings.volumeDefaults.rightToLeft,
            singlePageView:
              volumeSettings.singlePageView ?? $globalSettings.volumeDefaults.singlePageView,
            hasCover: volumeSettings.hasCover ?? $globalSettings.volumeDefaults.hasCover
          };
        });
      }

      return effective;
    }).subscribe((effective) => {
      // Only emit if settings actually changed
      if (!settingsEqual(previousEffective, effective)) {
        previousEffective = effective;
        set(effective);
      }
    });

    return unsubscribe;
  }
);

export function updateVolumeSetting(volume: string, key: VolumeSettingsKey, value: any) {
  volumes.update((prev) => {
    const currentVolume = prev[volume] || new VolumeData();
    return {
      ...prev,
      [volume]: new VolumeData({
        ...currentVolume,
        settings: {
          ...currentVolume.settings,
          [key]: value
        }
      })
    };
  });
  zoomDefault();
}

export const totalStats = derived([volumes, page], ([$volumes, $page]) => {
  if ($page && $volumes) {
    return Object.values($volumes).reduce<TotalStats>(
      (stats, { chars, completed, timeReadInMinutes, progress }) => {
        if (completed) {
          stats.completed++;
        }

        stats.pagesRead += progress;
        stats.minutesRead += timeReadInMinutes;
        stats.charsRead += chars;

        return stats;
      },
      {
        charsRead: 0,
        completed: 0,
        pagesRead: 0,
        minutesRead: 0
      }
    );
  }
});

export const mangaStats = derived([currentSeries, volumes], ([$titleVolumes, $volumes]) => {
  if ($titleVolumes && $volumes) {
    return $titleVolumes
      .map((vol) => vol.volume_uuid)
      .reduce(
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
    const { chars, completed, timeReadInMinutes, progress, lastProgressUpdate } =
      $volumes[$currentVolume.volume_uuid];
    return { chars, completed, timeReadInMinutes, progress, lastProgressUpdate };
  }
  return {
    chars: 0,
    completed: 0,
    timeReadInMinutes: 0,
    progress: 0,
    lastProgressUpdate: new Date(0).toISOString()
  };
});
