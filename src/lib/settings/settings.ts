import { browser } from '$app/environment';
import { derived, get, writable } from 'svelte/store';
import { isMobilePlatform } from '$lib/util/platform';

export type FontSize =
  | 'auto'
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
  pictureField: string;
  sentenceField: string;
  heightField: number;
  widthField: number;
  qualityField: number;
  cropImage: boolean;
  overwriteImage: boolean;
  grabSentence: boolean;
  triggerMethod: 'rightClick' | 'doubleTap' | 'both';
};

export type PageViewMode = 'single' | 'dual' | 'auto';

export type VolumeDefaults = {
  rightToLeft: boolean;
  singlePageView: PageViewMode;
  hasCover: boolean;
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
  invertColors: boolean;
  nightMode: boolean;
  inactivityTimeoutMinutes: number;
  swapWheelBehavior: boolean;
  volumeDefaults: VolumeDefaults;
  ankiConnectSettings: AnkiConnectSettings;
  lastUpdated?: string; // ISO 8601 timestamp for sync conflict resolution
  deletedOn?: string; // ISO 8601 timestamp when profile was deleted (tombstone)
};

export type SettingsKey = keyof Settings;

export type AnkiSettingsKey = keyof AnkiConnectSettings;

export type VolumeDefaultsKey = keyof VolumeDefaults;

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
  invertColors: false,
  nightMode: false,
  inactivityTimeoutMinutes: 5,
  swapWheelBehavior: false,
  volumeDefaults: {
    singlePageView: 'auto',
    rightToLeft: true,
    hasCover: true
  },
  ankiConnectSettings: {
    enabled: false,
    cropImage: false,
    grabSentence: false,
    overwriteImage: true,
    pictureField: 'Picture',
    sentenceField: 'Sentence',
    heightField: 0,
    widthField: 0,
    qualityField: 1,
    triggerMethod: 'both'
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

    migratedProfile.ankiConnectSettings = {
      ...defaultSettings.ankiConnectSettings,
      ...(profile.ankiConnectSettings || {})
    };

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

export const settings = derived([profiles, currentProfile], ([profiles, currentProfile]) => {
  return profiles[currentProfile];
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
