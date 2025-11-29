import { browser } from '$app/environment';
import { derived, writable, readable } from 'svelte/store';
import { zoomDefault } from '$lib/panzoom';
import { settings as globalSettings } from './settings';
import { db } from '$lib/catalog/db';

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
export type PageTurn = [number, number, number]; // [timestamp_ms, page_number, char_count]

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
  // Volume metadata for self-describing sync data
  series_uuid?: string;
  series_title?: string;
  volume_title?: string;
  // Deletion tracking for sync (mutually exclusive)
  addedOn?: string; // ISO datetime when volume was added/created
  deletedOn?: string; // ISO datetime when metadata was deleted
};

export class VolumeData implements VolumeDataJSON {
  progress: number;
  chars: number;
  completed: boolean;
  timeReadInMinutes: number;
  settings: VolumeSettings;
  lastProgressUpdate: string;
  recentPageTurns: PageTurn[];
  sessions: AggregateSession[];
  series_uuid?: string;
  series_title?: string;
  volume_title?: string;
  addedOn?: string; // ISO datetime when volume was added/created
  deletedOn?: string; // ISO datetime when metadata was deleted

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

    // Volume metadata (optional, for self-describing sync data)
    this.series_uuid = data.series_uuid;
    this.series_title = data.series_title;
    this.volume_title = data.volume_title;

    // Deletion tracking (optional, undefined means epoch in merge logic)
    this.addedOn = data.addedOn;
    this.deletedOn = data.deletedOn;

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

    // Include volume metadata if present (for self-describing sync data)
    if (this.series_uuid) {
      result.series_uuid = this.series_uuid;
    }
    if (this.series_title) {
      result.series_title = this.series_title;
    }
    if (this.volume_title) {
      result.volume_title = this.volume_title;
    }

    // Include deletion tracking timestamps if present (for sync)
    if (this.addedOn) {
      result.addedOn = this.addedOn;
    }
    if (this.deletedOn) {
      result.deletedOn = this.deletedOn;
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

/**
 * Enriches VolumeData with metadata from IndexedDB
 * Useful for populating self-describing sync data
 */
export async function enrichVolumeDataWithMetadata(
  volumeUuid: string,
  volumeData: VolumeData
): Promise<VolumeData> {
  if (!browser) return volumeData;

  try {
    const metadata = await db.volumes.get(volumeUuid);
    if (metadata) {
      return new VolumeData({
        ...volumeData,
        series_uuid: metadata.series_uuid,
        series_title: metadata.series_title,
        volume_title: metadata.volume_title
      });
    }
  } catch (error) {
    console.warn(`Failed to fetch metadata for volume ${volumeUuid}:`, error);
  }

  return volumeData;
}

/**
 * Updates metadata for a specific volume in the store
 */
export function updateVolumeMetadata(
  volumeUuid: string,
  series_uuid?: string,
  series_title?: string,
  volume_title?: string
) {
  _volumesInternal.update((prev) => {
    const currentVolume = prev[volumeUuid] || new VolumeData();
    return {
      ...prev,
      [volumeUuid]: new VolumeData({
        ...currentVolume,
        series_uuid,
        series_title,
        volume_title
      })
    };
  });
}

/**
 * Enriches ALL orphaned volumes (those lacking metadata) from the catalog
 * This is more aggressive than lazy enrichment and runs proactively
 */
export async function enrichAllOrphanedVolumes() {
  if (!browser) return;

  try {
    const catalog = await db.volumes.toArray();
    const catalogMap = new Map(catalog.map((v) => [v.volume_uuid, v]));

    _volumesInternal.update((prev) => {
      const updated = { ...prev };
      let enrichedCount = 0;

      Object.entries(prev).forEach(([volumeId, volumeData]) => {
        // Skip deleted volumes (tombstones)
        if (volumeData.deletedOn) return;

        // Check if volume lacks metadata
        const needsEnrichment =
          !volumeData.series_uuid ||
          volumeData.series_uuid === 'missing-series-info' ||
          !volumeData.series_title ||
          volumeData.series_title === '[Missing Series Info]' ||
          !volumeData.volume_title ||
          volumeData.volume_title.startsWith('Volume ');

        if (needsEnrichment) {
          const catalogInfo = catalogMap.get(volumeId);
          if (catalogInfo) {
            updated[volumeId] = new VolumeData({
              ...volumeData,
              series_uuid: catalogInfo.series_uuid,
              series_title: catalogInfo.series_title,
              volume_title: catalogInfo.volume_title
            });
            enrichedCount++;
          }
        }
      });

      if (enrichedCount > 0) {
        console.log(`Enriched ${enrichedCount} orphaned volume(s) with catalog metadata`);
      }

      return updated;
    });
  } catch (error) {
    console.warn('Failed to enrich orphaned volumes:', error);
  }
}

const initial: Volumes = browser
  ? parseVolumesFromJson(window.localStorage.getItem('volumes') || '{}')
  : {};

// Internal writable store containing all volumes including tombstones (deleted entries)
const _volumesInternal = writable<Volumes>(initial);

// Full writable store for sync and special operations (includes tombstones)
// Sync code should use this to read/write all volume data including deleted entries
export const volumesWithTrash = _volumesInternal;

// Public derived store - filters out deleted volumes (tombstones)
// This is what UI and stats code should use
export const volumes = derived(_volumesInternal, ($internal) => {
  return Object.fromEntries(Object.entries($internal).filter(([_, vol]) => !vol.deletedOn));
});

export function initializeVolume(volume: string) {
  _volumesInternal.update((prev) => {
    return {
      ...prev,
      [volume]: new VolumeData({
        addedOn: new Date().toISOString()
      })
    };
  });
}

export function deleteVolume(volume: string) {
  _volumesInternal.update((prev) => {
    const existing = prev[volume];
    if (!existing) return prev; // Already gone or never existed

    // Create tombstone with deletion timestamp
    const tombstone = new VolumeData({
      deletedOn: new Date().toISOString(),
      // Keep metadata for sync identification
      series_uuid: existing.series_uuid,
      series_title: existing.series_title,
      volume_title: existing.volume_title,
      lastProgressUpdate: new Date().toISOString()
    });

    return {
      ...prev,
      [volume]: tombstone
    };
  });
}

export function clearVolumes() {
  _volumesInternal.set({});
}

export function clearVolumeSpeedData(volume: string) {
  _volumesInternal.update((prev) => {
    const currentVolume = prev[volume];
    if (!currentVolume) return prev;

    // Parse the existing timestamp and add 1ms to win sync conflicts
    const currentTimestamp = new Date(currentVolume.lastProgressUpdate).getTime();
    const newTimestamp = new Date(currentTimestamp + 1).toISOString();

    return {
      ...prev,
      [volume]: new VolumeData({
        ...currentVolume,
        timeReadInMinutes: 0,
        lastProgressUpdate: newTimestamp
        // Keep: progress, chars, completed, settings, recentPageTurns, sessions
      })
    };
  });
}

export function clearOrphanedVolumeData(volumeIds: string[]) {
  _volumesInternal.update((prev) => {
    const updated = { ...prev };
    const now = new Date().toISOString();

    volumeIds.forEach((id) => {
      const existing = updated[id];
      if (existing) {
        // Create tombstone instead of deleting
        updated[id] = new VolumeData({
          deletedOn: now,
          series_uuid: existing.series_uuid,
          series_title: existing.series_title,
          volume_title: existing.volume_title,
          lastProgressUpdate: now
        });
      }
    });

    return updated;
  });
}

export function updateProgress(
  volume: string,
  progress: number,
  chars?: number,
  completed = false
) {
  _volumesInternal.update((prev) => {
    const currentVolume = prev[volume] || new VolumeData();
    const now = Date.now();

    // Get session timeout from user settings (in minutes, convert to ms)
    let sessionTimeoutMs = 30 * 60 * 1000; // Default 30 minutes
    globalSettings.subscribe((s) => {
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

    // Add new turn with cumulative character count
    // Store cumulative chars so we can calculate reading speed even if volume is deleted from IndexedDB
    const cumulativeChars = chars ?? currentVolume.chars;
    recentPageTurns = [...recentPageTurns, [now, progress, cumulativeChars]];

    // Lazy metadata population: If metadata is missing, fetch it asynchronously
    // This ensures stats pages work even if IndexedDB is later deleted
    if (!currentVolume.series_uuid && browser) {
      enrichVolumeDataWithMetadata(volume, currentVolume)
        .then((enriched) => {
          if (enriched.series_uuid) {
            _volumesInternal.update((vols) => ({
              ...vols,
              [volume]: new VolumeData({
                ...(vols[volume] || currentVolume),
                series_uuid: enriched.series_uuid,
                series_title: enriched.series_title,
                volume_title: enriched.volume_title
              })
            }));
          }
        })
        .catch((err) => {
          console.warn(`Failed to enrich metadata for ${volume}:`, err);
        });
    }

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
    _volumesInternal.update((prev) => {
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

// Save internal store (including tombstones) to localStorage
_volumesInternal.subscribe((volumes) => {
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
  _volumesInternal.update((prev) => {
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

export const totalStats = derived(volumes, ($volumes) => {
  if ($volumes) {
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

// mangaStats moved to series page to avoid circular dependency with currentSeries
// volumeStats moved to Timer component to avoid circular dependency with currentVolume
