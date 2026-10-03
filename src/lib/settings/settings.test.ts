// src/lib/settings/settings.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  migrateProfiles,
  grayscaleActive,
  imageFilter,
  pageFilter,
  pageInkSetting,
  preferredTitleLanguage,
  updateCatalogSetting,
  updateSetting,
  updateScheduleSetting
} from './settings';

describe('theme migration', () => {
  it('defaults a profile with no theme to the Dark preset', () => {
    const out = migrateProfiles({ Test: { backgroundColor: '#030712' } as any });
    expect(out.Test.theme).toBe('dark');
    expect(out.Test.customTheme.base).toBe('light');
  });

  it('preserves an explicit theme choice', () => {
    const out = migrateProfiles({ Test: { theme: 'sepia' } as any });
    expect(out.Test.theme).toBe('sepia');
  });

  it('seeds a custom theme from a non-default legacy backgroundColor', () => {
    const out = migrateProfiles({ Test: { backgroundColor: '#123456' } as any });
    expect(out.Test.theme).toBe('custom');
    expect(out.Test.customTheme.background).toBe('#123456');
    expect(out.Test.customTheme.base).toBe('dark');
    // Must keep dark-appropriate tokens (light text), not the default light
    // palette — otherwise text-white chrome would be mapped to black.
    expect(out.Test.customTheme.text).toBe('#ffffff');
  });

  it('merges customTheme over defaults', () => {
    const out = migrateProfiles({
      Test: { theme: 'custom', customTheme: { accent: '#abcdef' } } as any
    });
    expect(out.Test.customTheme.accent).toBe('#abcdef');
    expect(out.Test.customTheme.background).toBeDefined();
  });
});

describe('pagedGap migration', () => {
  it('fills pagedGap with its default for profiles saved before the setting existed', () => {
    const migrated = migrateProfiles({ Default: { dark: true } } as any);
    expect(migrated.Default.pagedGap).toBe(0);
  });
});

describe('grayscaleActive', () => {
  beforeEach(() => {
    // Known baseline: manual mode, filter off
    updateScheduleSetting('grayscaleSchedule', 'enabled', false);
    updateSetting('grayscale', false);
  });

  it('reflects the manual toggle when the schedule is disabled', () => {
    updateSetting('grayscale', true);
    expect(get(grayscaleActive)).toBe(true);

    updateSetting('grayscale', false);
    expect(get(grayscaleActive)).toBe(false);
  });

  describe('scheduled mode', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('is active when the current time is within a crossing-midnight schedule', () => {
      vi.setSystemTime(new Date(2026, 0, 1, 22, 0, 0)); // 22:00
      updateScheduleSetting('grayscaleSchedule', 'startTime', '21:00');
      updateScheduleSetting('grayscaleSchedule', 'endTime', '06:00');
      updateScheduleSetting('grayscaleSchedule', 'enabled', true);
      expect(get(grayscaleActive)).toBe(true);
    });

    it('is inactive when the current time is outside the schedule', () => {
      vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0)); // 12:00
      updateScheduleSetting('grayscaleSchedule', 'startTime', '21:00');
      updateScheduleSetting('grayscaleSchedule', 'endTime', '06:00');
      updateScheduleSetting('grayscaleSchedule', 'enabled', true);
      expect(get(grayscaleActive)).toBe(false);
    });
  });
});

describe('imageFilter', () => {
  beforeEach(() => {
    // Manual mode for both filters, both off
    updateScheduleSetting('invertColorsSchedule', 'enabled', false);
    updateScheduleSetting('grayscaleSchedule', 'enabled', false);
    updateSetting('invertColors', false);
    updateSetting('grayscale', false);
  });

  it('is both-off by default', () => {
    expect(get(imageFilter)).toBe('invert(0) grayscale(0)');
  });

  it('reflects invert only', () => {
    updateSetting('invertColors', true);
    expect(get(imageFilter)).toBe('invert(1) grayscale(0)');
  });

  it('reflects grayscale only', () => {
    updateSetting('grayscale', true);
    expect(get(imageFilter)).toBe('invert(0) grayscale(1)');
  });

  it('reflects both on', () => {
    updateSetting('invertColors', true);
    updateSetting('grayscale', true);
    expect(get(imageFilter)).toBe('invert(1) grayscale(1)');
  });
});

describe('page brightness / contrast (#256)', () => {
  beforeEach(() => {
    updateSetting('pageBrightness', 100);
    updateSetting('pageContrast', 100);
  });

  it('defaults both to 100 on a profile that predates them', () => {
    const out = migrateProfiles({ Test: {} as any });
    expect(out.Test.pageBrightness).toBe(100);
    expect(out.Test.pageContrast).toBe(100);
  });

  it('keeps stored values and repairs malformed ones on migration', () => {
    const out = migrateProfiles({
      A: { pageBrightness: 130, pageContrast: 150 } as any,
      B: { pageBrightness: 'bright', pageContrast: 5000 } as any
    });
    expect(out.A.pageBrightness).toBe(130);
    expect(out.A.pageContrast).toBe(150);
    expect(out.B.pageBrightness).toBe(100);
    expect(out.B.pageContrast).toBe(200);
  });

  it('pageFilter is none at the defaults', () => {
    expect(get(pageFilter)).toBe('none');
  });

  it('pageFilter follows the active profile', () => {
    updateSetting('pageBrightness', 130);
    updateSetting('pageContrast', 150);
    expect(get(pageFilter)).toBe('brightness(130%) contrast(150%)');
  });

  it('pageFilter does not re-emit for unrelated setting writes', () => {
    const seen: string[] = [];
    const unsubscribe = pageFilter.subscribe((v) => seen.push(v));
    updateSetting('pagedGap', 7);
    updateSetting('pagedGap', 0);
    unsubscribe();
    expect(seen).toEqual(['none']);
  });
});

describe('page ink color (#256)', () => {
  beforeEach(() => {
    updateSetting('pageInkColor', 'off');
  });

  it('defaults to off on a profile that predates it', () => {
    expect(migrateProfiles({ Test: {} as any }).Test.pageInkColor).toBe('off');
  });

  it('keeps valid values and turns anything else off on migration', () => {
    const out = migrateProfiles({
      A: { pageInkColor: 'auto' } as any,
      B: { pageInkColor: 'violet' } as any,
      C: { pageInkColor: 'mauve' } as any,
      D: { pageInkColor: 3 } as any
    });
    expect(out.A.pageInkColor).toBe('auto');
    expect(out.B.pageInkColor).toBe('violet');
    expect(out.C.pageInkColor).toBe('off');
    expect(out.D.pageInkColor).toBe('off');
  });

  it('pageInkSetting follows the active profile and ignores unrelated writes', () => {
    const seen: string[] = [];
    const unsubscribe = pageInkSetting.subscribe((v) => seen.push(v));
    updateSetting('pagedGap', 7);
    updateSetting('pageInkColor', 'blue');
    updateSetting('pagedGap', 0);
    unsubscribe();
    expect(seen).toEqual(['off', 'blue']);
  });
});

describe('preferredTitleLanguage migration', () => {
  it('defaults a profile with no catalogSettings.preferredTitleLanguage to native', () => {
    // Japanese is the default: this is a Japanese learning app (user ruling 2026-08-24).
    const out = migrateProfiles({ Test: { catalogSettings: { stackCount: 2 } } as any });
    expect(out.Test.catalogSettings.preferredTitleLanguage).toBe('native');
    // Existing catalog values must survive the merge
    expect(out.Test.catalogSettings.stackCount).toBe(2);
  });

  it('preserves a valid preferredTitleLanguage', () => {
    const out = migrateProfiles({
      Test: { catalogSettings: { preferredTitleLanguage: 'english' } } as any
    });
    expect(out.Test.catalogSettings.preferredTitleLanguage).toBe('english');
  });

  it("migrates the retired 'romaji' preference to the native progression", () => {
    // Romaji stopped being a primary choice when languages became progressions;
    // it is the second step of both chains instead.
    const out = migrateProfiles({
      Test: { catalogSettings: { preferredTitleLanguage: 'romaji' } } as any
    });
    expect(out.Test.catalogSettings.preferredTitleLanguage).toBe('native');
  });

  it('coerces an unknown preferredTitleLanguage back to native', () => {
    const out = migrateProfiles({
      Test: { catalogSettings: { preferredTitleLanguage: 'klingon' } } as any
    });
    expect(out.Test.catalogSettings.preferredTitleLanguage).toBe('native');
  });
});

describe('preferredTitleLanguage store', () => {
  afterEach(() => {
    updateCatalogSetting('preferredTitleLanguage', 'native');
  });

  it('emits only when the language itself changes', () => {
    // The catalog store joins this one instead of `catalogSettings` precisely because a
    // primitive dedupes: an unrelated write must not rebuild the whole library.
    const seen: string[] = [];
    const unsubscribe = preferredTitleLanguage.subscribe((value) => seen.push(value));
    expect(seen).toEqual(['native']);

    updateSetting('pagedGap', 9);
    updateCatalogSetting('stackCount', 5);
    expect(seen).toEqual(['native']);

    updateCatalogSetting('preferredTitleLanguage', 'english');
    expect(seen).toEqual(['native', 'english']);

    updateCatalogSetting('preferredTitleLanguage', 'english');
    expect(seen).toEqual(['native', 'english']);

    unsubscribe();
  });
});

describe('pushProgressToAniList migration', () => {
  it('defaults to true for profiles saved before the setting existed', () => {
    const migrated = migrateProfiles({
      Default: { catalogSettings: { stackingPreset: 'default' } }
    } as any);
    expect(migrated.Default.catalogSettings.pushProgressToAniList).toBe(true);
    expect(migrated.Default.catalogSettings.stackingPreset).toBe('default');
  });

  it('coerces a non-boolean stored value back to true', () => {
    const migrated = migrateProfiles({
      Default: { catalogSettings: { pushProgressToAniList: 'false' } }
    } as any);
    expect(migrated.Default.catalogSettings.pushProgressToAniList).toBe(true);
  });
});

describe('notOnDeviceDisplay removal', () => {
  it('strips the retired key from stored profiles', () => {
    // The mixed/cloud-section display mode was removed 2026-08-24: cloud content
    // is always its own section now, with no setting to change it.
    const out = migrateProfiles({
      Test: { catalogSettings: { notOnDeviceDisplay: 'mixed', stackCount: 2 } } as any
    });
    expect('notOnDeviceDisplay' in out.Test.catalogSettings).toBe(false);
    expect(out.Test.catalogSettings.stackCount).toBe(2);
  });
});
