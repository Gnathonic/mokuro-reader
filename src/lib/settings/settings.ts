import { browser } from '$app/environment';
import { derived, get, writable } from 'svelte/store';

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

export type AnkiConnectSettings = {
  enabled: boolean;
  pictureField: string;
  sentenceField: string;
  cropImage: boolean;
  overwriteImage: boolean;
  grabSentence: boolean;
  triggerMethod: 'rightClick' | 'doubleTap' | 'both';
};

export type VolumeDefaults = {
  rightToLeft: boolean;
  singlePageView: boolean;
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
  invertColors: boolean;
  nightMode: boolean;
  volumeDefaults: VolumeDefaults;
  ankiConnectSettings: AnkiConnectSettings;
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
  bounds: false,
  backgroundColor: '#030712',
  swipeThreshold: 50,
  edgeButtonWidth: 40,
  showTimer: false,
  quickActions: true,
  fontSize: 'auto',
  zoomDefault: 'zoomFitToScreen',
  invertColors: false,
  nightMode: false,
  volumeDefaults: {
    singlePageView: false,
    rightToLeft: true,
    hasCover: false
  },
  ankiConnectSettings: {
    enabled: false,
    cropImage: false,
    grabSentence: false,
    overwriteImage: true,
    pictureField: 'Picture',
    sentenceField: 'Sentence',
    triggerMethod: 'both'
  }
};

type Profiles = Record<string, Settings>;

const defaultProfiles: Profiles = {
  Default: defaultSettings
};

const storedProfiles = browser ? window.localStorage.getItem('profiles') : undefined;
const initialProfiles: Profiles =
  storedProfiles && browser ? JSON.parse(storedProfiles) : defaultProfiles;
export const profiles = writable<Profiles>(initialProfiles);

const storedCurrentProfile = browser
  ? window.localStorage.getItem('currentProfile') || 'Default'
  : 'Default';
export const currentProfile = writable(storedCurrentProfile);

profiles.subscribe((profiles) => {
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

export function updateSetting(key: SettingsKey, value: any) {
  profiles.update((profiles) => {
    return {
      ...profiles,
      [get(currentProfile)]: {
        ...profiles[get(currentProfile)],
        [key]: value
      }
    };
  });
}

export function updateVolumeDefaults(key: VolumeDefaultsKey, value: any) {
  profiles.update((profiles) => {
    return {
      ...profiles,
      [get(currentProfile)]: {
        ...profiles[get(currentProfile)],
        volumeDefaults: {
          ...profiles[get(currentProfile)].volumeDefaults,
          [key]: value
        }
      }
    };
  });
}

export function updateAnkiSetting(key: AnkiSettingsKey, value: any) {
  profiles.update((profiles) => {
    return {
      ...profiles,
      [get(currentProfile)]: {
        ...profiles[get(currentProfile)],
        ankiConnectSettings: {
          ...profiles[get(currentProfile)].ankiConnectSettings,
          [key]: value
        }
      }
    };
  });
}

export function resetSettings() {
  profiles.update((profiles) => {
    return {
      ...profiles,
      [get(currentProfile)]: defaultSettings
    };
  });
}

export function createProfile(profileId: string) {
  profiles.update((profiles) => {
    return {
      ...profiles,
      [profileId]: defaultSettings
    };
  });
}

export function deleteProfile(profileId: string) {
  if (get(currentProfile) === profileId) {
    currentProfile.set('Default');
  }

  profiles.update((profiles) => {
    delete profiles[profileId];
    return profiles;
  });
}

export function renameProfile(oldName: string, newName: string) {
  if (get(currentProfile) === oldName) {
    currentProfile.set('Default');
  }

  profiles.update((profiles) => {
    delete Object.assign(profiles, { [newName]: profiles[oldName] })[oldName];
    return profiles;
  });
}

export function copyProfile(profileToCopy: string, newName: string) {
  profiles.update((profiles) => {
    return {
      ...profiles,
      [newName]: {
        ...profiles[profileToCopy]
      }
    };
  });
}

export function changeProfile(profileId: string) {
  currentProfile.set(profileId);
}
