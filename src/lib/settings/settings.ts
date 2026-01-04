import { browser } from '$app/environment';
import { derived, get, readable, writable } from 'svelte/store';
import { isMobilePlatform } from '$lib/util/platform';

export type FontSize =
  | 'auto'
  | 'original'
  | '9'
  | '10'
  | '11'
  | '12'
  | '14'
  | '16'
  | '18'
  | '20'
  | '24'
  | '32'
  | '40'
  | '48'
  | '60';

export type ZoomModes =
  | 'zoomFitToScreen'
  | 'zoomFitToWidth'
  | 'zoomOriginal'
  | 'keepZoom'
  | 'keepZoomStart';

export type PageTransition = 'none' | 'crossfade' | 'vertical' | 'pageTurn' | 'swipe';

export type AnkiConnectSettings = {
  enabled: boolean;
  url: string;
  pictureField: string;
  sentenceField: string;
  heightField: number;
  widthField: number;
  qualityField: number;
  cropImage: boolean;
  overwriteImage: boolean;
  grabSentence: boolean;
  triggerMethod: 'rightClick' | 'doubleTap' | 'both' | 'neither';
  tags: string;
  cardMode: 'update' | 'create';
  deckName: string;
  modelName: string;
};

export type TimeSchedule = {
  enabled: boolean;
  startTime: string; // HH:MM format
  endTime: string; // HH:MM format
};

export type PageViewMode = 'single' | 'dual' | 'auto';

export type VolumeDefaults = {
  rightToLeft: boolean;
  singlePageView: PageViewMode;
  hasCover: boolean;
};

export type CatalogStackingPreset = 'compact' | 'default' | 'spine' | 'custom';

export type CatalogSettings = {
  stackingPreset: CatalogStackingPreset;
  horizontalStep: number;
  verticalStep: number;
  stackCount: number;
  hideReadVolumes: boolean;
  centerHorizontal: boolean;
  centerVertical: boolean;
  compactCloudSeries: boolean;
};

export type Settings = {
  defaultFullscreen: boolean;
  textEditable: boolean;
  textBoxBorders: boolean;
  displayOCR: boolean;
  boldFont: boolean;
  pageNum: boolean;
  charCount: boolean;
  bounds: boolean;
  mobile: boolean;
  backgroundColor: string;
  swipeThreshold: number;
  edgeButtonWidth: number;
  showTimer: boolean;
  quickActions: boolean;
  fontSize: FontSize;
  zoomDefault: ZoomModes;
  pageTransition: PageTransition;
  nightMode: boolean;
  nightModeSchedule: TimeSchedule;
  invertColors: boolean;
  invertColorsSchedule: TimeSchedule;
  inactivityTimeoutMinutes: number;
  swapWheelBehavior: boolean;
  textBoxContextMenu: boolean;
  volumeDefaults: VolumeDefaults;
  ankiConnectSettings: AnkiConnectSettings;
  catalogSettings: CatalogSettings;
  lastUpdated?: string; // ISO 8601 timestamp for sync conflict resolution
  deletedOn?: string; // ISO 8601 timestamp when profile was deleted (tombstone)
};

export type SettingsKey = keyof Settings;

export type AnkiSettingsKey = keyof AnkiConnectSettings;

export type VolumeDefaultsKey = keyof VolumeDefaults;

export type CatalogSettingsKey = keyof CatalogSettings;

export type TimeScheduleKey = keyof TimeSchedule;

export type ScheduleSettingKey = 'nightModeSchedule' | 'invertColorsSchedule';

const defaultSettings: Settings = {
  defaultFullscreen: false,
  displayOCR: true,
  textEditable: false,
  textBoxBorders: false,
  boldFont: false,
  pageNum: true,
  charCount: false,
  mobile: false,
  bounds: true,
  backgroundColor: '#030712',
  swipeThreshold: 50,
  edgeButtonWidth: 40,
  showTimer: false,
  quickActions: true,
  fontSize: 'auto',
  zoomDefault: 'zoomFitToScreen',
  pageTransition: 'none',
  nightMode: false,
  nightModeSchedule: {
    enabled: false,
    startTime: '21:00',
    endTime: '06:00'
  },
  invertColors: false,
  invertColorsSchedule: {
    enabled: false,
    startTime: '21:00',
    endTime: '06:00'
  },
  inactivityTimeoutMinutes: 5,
  swapWheelBehavior: false,
  textBoxContextMenu: true,
  volumeDefaults: {
    singlePageView: 'auto',
    rightToLeft: true,
    hasCover: true
  },
  ankiConnectSettings: {
    enabled: false,
    url: 'http://127.0.0.1:8765',
    cropImage: false,
    grabSentence: true,
    overwriteImage: true,
    pictureField: 'Picture',
    sentenceField: 'Sentence',
    heightField: 0,
    widthField: 0,
    qualityField: 1,
    triggerMethod: 'both',
    tags: '{series}',
    cardMode: 'update',
    deckName: 'Default',
    modelName: 'Basic'
  },
  catalogSettings: {
    stackingPreset: 'default',
    horizontalStep: 11,
    verticalStep: 5,
    stackCount: 3,
    hideReadVolumes: true,
    centerHorizontal: true,
    centerVertical: false,
    compactCloudSeries: false
  }
};

// Mobile-optimized default settings
const mobileDefaultSettings: Settings = {
  ...defaultSettings,
  mobile: true,
  defaultFullscreen: true,
  edgeButtonWidth: 60,
  showTimer: false,
  swipeThreshold: 50
};

// Desktop-optimized default settings
const desktopDefaultSettings: Settings = {
  ...defaultSettings,
  mobile: false,
  defaultFullscreen: false,
  edgeButtonWidth: 40,
  showTimer: true,
  swipeThreshold: 50
};

type Profiles = Record<string, Settings>;

// Built-in profiles that cannot be deleted or renamed
export const BUILT_IN_PROFILES = ['Mobile', 'Desktop'] as const;
export type BuiltInProfile = (typeof BUILT_IN_PROFILES)[number];

// Default profiles include both built-in profiles
const builtInProfiles: Profiles = {
  Mobile: mobileDefaultSettings,
  Desktop: desktopDefaultSettings
};

/**
 * Migrate old profiles to ensure all fields exist with defaults
 * Adds missing settings fields and timestamps
 */
export function migrateProfiles(profiles: Profiles): Profiles {
  const migrated: Profiles = {};

  for (const [name, profile] of Object.entries(profiles)) {
    // Start with defaults and overlay profile data
    // This ensures all new fields get their default values
    const migratedProfile: Settings = {
      ...defaultSettings,
      ...profile
    };

    // Ensure nested objects are properly merged (not replaced)
    migratedProfile.volumeDefaults = {
      ...defaultSettings.volumeDefaults,
      ...(profile.volumeDefaults || {})
    };

    // Validate singlePageView: convert legacy boolean to 'auto', or use default for any invalid value
    const validPageViewModes = ['single', 'dual', 'auto'];
    if (!validPageViewModes.includes(migratedProfile.volumeDefaults.singlePageView)) {
      migratedProfile.volumeDefaults.singlePageView = 'auto';
    }

    migratedProfile.ankiConnectSettings = {
      ...defaultSettings.ankiConnectSettings,
      ...(profile.ankiConnectSettings || {})
    };

    migratedProfile.nightModeSchedule = {
      ...defaultSettings.nightModeSchedule,
      ...(profile.nightModeSchedule || {})
    };

    migratedProfile.invertColorsSchedule = {
      ...defaultSettings.invertColorsSchedule,
      ...(profile.invertColorsSchedule || {})
    };

    migratedProfile.catalogSettings = {
      ...defaultSettings.catalogSettings,
      ...(profile.catalogSettings || {})
    };

    // Reset unstable "spine showcase" settings to defaults on page load
    // stackCount=0 causes performance issues and can make the app unusable
    if (
      migratedProfile.catalogSettings.stackCount === 0 ||
      migratedProfile.catalogSettings.stackingPreset === 'spine'
    ) {
      console.log(
        `⚠️ Profile migration: Resetting unstable spine showcase settings to defaults for [${name}]`
      );
      migratedProfile.catalogSettings = { ...defaultSettings.catalogSettings };
    }

    // Add timestamp if missing
    if (!migratedProfile.lastUpdated) {
      const newTimestamp = new Date().toISOString();
      console.log(`📝 Profile migration: Adding timestamp to [${name}]`, newTimestamp);
      migratedProfile.lastUpdated = newTimestamp;
    }

    migrated[name] = migratedProfile;
  }

  return migrated;
}

// Initialize profiles: merge stored user profiles with built-in profiles
// Built-in profiles always exist and take precedence to ensure they're never missing
const storedProfiles = browser ? window.localStorage.getItem('profiles') : undefined;
const rawUserProfiles: Profiles = storedProfiles && browser ? JSON.parse(storedProfiles) : {};
const userProfiles = migrateProfiles(rawUserProfiles);

// Merge: built-ins first (always present), then user profiles (can override built-ins)
const initialProfiles: Profiles = migrateProfiles({
  ...builtInProfiles,
  ...userProfiles
});

// Internal writable store containing all profiles including tombstones (deleted entries)
const _profilesInternal = writable<Profiles>(initialProfiles);

// Full writable store for sync and special operations (includes tombstones)
// Sync code should use this to read/write all profile data including deleted entries
export const profilesWithTrash = _profilesInternal;

// Public derived store - filters out deleted profiles (tombstones)
// This is what UI code should use
export const profiles = derived(_profilesInternal, ($internal) => {
  return Object.fromEntries(Object.entries($internal).filter(([_, profile]) => !profile.deletedOn));
});

// Initialize current profile: use stored preference, or detect platform
const storedCurrentProfile = browser ? window.localStorage.getItem('currentProfile') : null;
const platformDefaultProfile = isMobilePlatform() ? 'Mobile' : 'Desktop';
const initialCurrentProfile = storedCurrentProfile || platformDefaultProfile;

export const currentProfile = writable(initialCurrentProfile);

// Save internal store (including tombstones) to localStorage
_profilesInternal.subscribe((profiles) => {
  if (browser) {
    window.localStorage.setItem('profiles', JSON.stringify(profiles));
  }
});

currentProfile.subscribe((currentProfile) => {
  if (browser) {
    window.localStorage.setItem('currentProfile', currentProfile);
  }
});

export const settings = derived(
  [profiles, currentProfile],
  ([$profiles, $currentProfile], set: (value: Settings) => void) => {
    if ($profiles[$currentProfile]) {
      set($profiles[$currentProfile]);
    } else {
      // Fall back to Desktop or Mobile profile if current profile doesn't exist
      const fallbackProfile = $profiles['Desktop'] ? 'Desktop' : 'Mobile';
      if ($profiles[fallbackProfile]) {
        currentProfile.set(fallbackProfile);
        set($profiles[fallbackProfile]);
      } else {
        // Ultimate fallback to default settings
        set(defaultSettings);
      }
    }
  }
);

// Derived store for easy access to catalog settings
export const catalogSettings = derived(settings, ($settings) => $settings?.catalogSettings);

// A store that updates every minute to trigger schedule checks
const currentMinute = readable(Date.now(), (set) => {
  if (!browser) return;
  const interval = setInterval(() => set(Date.now()), 60000);
  return () => clearInterval(interval);
});

/**
 * Check if the current time falls within a schedule's time range.
 * Handles schedules that cross midnight (e.g., 21:00 - 06:00).
 */
export function isWithinSchedule(schedule: TimeSchedule): boolean {
  if (!schedule.enabled) return false;

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const [startHour, startMin] = schedule.startTime.split(':').map(Number);
  const [endHour, endMin] = schedule.endTime.split(':').map(Number);

  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;

  if (startMinutes <= endMinutes) {
    // Same day range (e.g., 09:00 - 17:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Crosses midnight (e.g., 21:00 - 06:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

// Derived stores for effective state (manual mode uses toggle, scheduled mode uses time check)
export const nightModeActive = derived([settings, currentMinute], ([$settings, _]) => {
  if (!$settings) return false;
  if ($settings.nightModeSchedule?.enabled) {
    return isWithinSchedule($settings.nightModeSchedule);
  }
  return $settings.nightMode ?? false;
});

export const invertColorsActive = derived([settings, currentMinute], ([$settings, _]) => {
  if (!$settings) return false;
  if ($settings.invertColorsSchedule?.enabled) {
    return isWithinSchedule($settings.invertColorsSchedule);
  }
  return $settings.invertColors ?? false;
});

/**
 * Helper function to update a profile's timestamp
 */
function touchProfile(profile: Settings): Settings {
  return {
    ...profile,
    lastUpdated: new Date().toISOString()
  };
}

export function updateSetting(key: SettingsKey, value: any) {
  _profilesInternal.update((profiles) => {
    const profileId = get(currentProfile);
    return {
      ...profiles,
      [profileId]: touchProfile({
        ...profiles[profileId],
        [key]: value
      })
    };
  });
}

export function updateVolumeDefaults(key: VolumeDefaultsKey, value: any) {
  _profilesInternal.update((profiles) => {
    const profileId = get(currentProfile);
    return {
      ...profiles,
      [profileId]: touchProfile({
        ...profiles[profileId],
        volumeDefaults: {
          ...profiles[profileId].volumeDefaults,
          [key]: value
        }
      })
    };
  });
}

export function updateAnkiSetting(key: AnkiSettingsKey, value: any) {
  _profilesInternal.update((profiles) => {
    const profileId = get(currentProfile);
    return {
      ...profiles,
      [profileId]: touchProfile({
        ...profiles[profileId],
        ankiConnectSettings: {
          ...profiles[profileId].ankiConnectSettings,
          [key]: value
        }
      })
    };
  });
}

export function updateCatalogSetting(key: CatalogSettingsKey, value: any) {
  _profilesInternal.update((profiles) => {
    const profileId = get(currentProfile);
    return {
      ...profiles,
      [profileId]: touchProfile({
        ...profiles[profileId],
        catalogSettings: {
          ...profiles[profileId].catalogSettings,
          [key]: value
        }
      })
    };
  });
}

export function updateScheduleSetting(
  scheduleKey: ScheduleSettingKey,
  key: TimeScheduleKey,
  value: any
) {
  _profilesInternal.update((profiles) => {
    const profileId = get(currentProfile);
    return {
      ...profiles,
      [profileId]: touchProfile({
        ...profiles[profileId],
        [scheduleKey]: {
          ...profiles[profileId][scheduleKey],
          [key]: value
        }
      })
    };
  });
}

export function resetSettings() {
  const profile = get(currentProfile);

  // Determine which default to use based on profile name
  let defaultForProfile: Settings;
  if (profile === 'Mobile') {
    defaultForProfile = mobileDefaultSettings;
  } else if (profile === 'Desktop') {
    defaultForProfile = desktopDefaultSettings;
  } else {
    // Custom profile - reset to generic default
    defaultForProfile = defaultSettings;
  }

  _profilesInternal.update((profiles) => {
    return {
      ...profiles,
      [profile]: touchProfile(defaultForProfile)
    };
  });
}

export function createProfile(profileId: string) {
  _profilesInternal.update((profiles) => {
    return {
      ...profiles,
      [profileId]: touchProfile(defaultSettings)
    };
  });
}

export function deleteProfile(profileId: string) {
  // Protect built-in profiles from deletion
  if (BUILT_IN_PROFILES.includes(profileId as BuiltInProfile)) {
    console.warn(`Cannot delete built-in profile: ${profileId}`);
    return false;
  }

  if (get(currentProfile) === profileId) {
    currentProfile.set('Desktop');
  }

  _profilesInternal.update((profiles) => {
    const existing = profiles[profileId];
    if (!existing) return profiles; // Already gone or never existed

    // Create tombstone with deletion timestamp
    const tombstone: Settings = {
      ...defaultSettings,
      deletedOn: new Date().toISOString(),
      lastUpdated: new Date().toISOString()
    };

    return {
      ...profiles,
      [profileId]: tombstone
    };
  });

  return true;
}

export function renameProfile(oldName: string, newName: string) {
  // Protect built-in profiles from renaming
  if (BUILT_IN_PROFILES.includes(oldName as BuiltInProfile)) {
    console.warn(`Cannot rename built-in profile: ${oldName}`);
    return false;
  }

  if (get(currentProfile) === oldName) {
    currentProfile.set(newName);
  }

  _profilesInternal.update((profiles) => {
    delete Object.assign(profiles, { [newName]: profiles[oldName] })[oldName];
    return profiles;
  });

  return true;
}

export function copyProfile(profileToCopy: string, newName: string) {
  _profilesInternal.update((profiles) => {
    return {
      ...profiles,
      [newName]: touchProfile({
        ...profiles[profileToCopy],
        deletedOn: undefined // Remove tombstone flag if copying a deleted profile
      })
    };
  });
}

export function changeProfile(profileId: string) {
  currentProfile.set(profileId);
}
