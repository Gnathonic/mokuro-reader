// src/lib/settings/settings.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  migrateProfiles,
  grayscaleActive,
  imageFilter,
  pageFilter,
  pageInkSetting,
  pageInkLayers,
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

describe('print effect controls (#256)', () => {
  beforeEach(() => {
    updateSetting('pageInkStrength', 0);
    updateSetting('pagePaperTint', 8);
    updateSetting('pagePaperAge', 0);
  });

  it('defaults on a profile that predates them', () => {
    const out = migrateProfiles({ Test: {} as any }).Test;
    expect([out.pageInkStrength, out.pagePaperTint, out.pagePaperAge]).toEqual([0, 8, 0]);
  });

  it('keeps stored values and repairs malformed ones on migration', () => {
    const out = migrateProfiles({
      A: { pageInkStrength: -40, pagePaperTint: 20, pagePaperAge: 70 } as any,
      B: { pageInkStrength: 500, pagePaperTint: 'x', pagePaperAge: -3 } as any
    });
    expect([out.A.pageInkStrength, out.A.pagePaperTint, out.A.pagePaperAge]).toEqual([-40, 20, 70]);
    expect([out.B.pageInkStrength, out.B.pagePaperTint, out.B.pagePaperAge]).toEqual([100, 8, 0]);
  });

  it('pageInkLayers follows the controls and ignores unrelated writes', () => {
    const seen: string[] = [];
    const unsubscribe = pageInkLayers.subscribe((v) =>
      seen.push(`${v['--ink-layer-blue']}/${v['--paper-layer-blue']}`)
    );
    updateSetting('pagedGap', 7);
    updateSetting('pagePaperTint', 0);
    updateSetting('pagedGap', 0);
    unsubscribe();
    expect(seen).toEqual(['#466dc4/#f1f3fa', '#466dc4/#ffffff']);
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

describe('key bindings (#55)', () => {
  it('defaults to {} (today’s keys) and wheelTurnsPages off', () => {
    const out = migrateProfiles({ Test: {} as any });
    expect(out.Test.keyBindings).toEqual({});
    expect(out.Test.wheelTurnsPages).toBe(false);
  });

  it('checks shape only: a non-object becomes {}, a non-array entry is dropped', () => {
    expect(migrateProfiles({ T: { keyBindings: 'KeyA' } as any }).T.keyBindings).toEqual({});
    expect(migrateProfiles({ T: { keyBindings: [['KeyA']] } as any }).T.keyBindings).toEqual({});
    expect(
      migrateProfiles({
        T: { keyBindings: { 'reader.night': 'KeyN', 'reader.page-left': [] } } as any
      }).T.keyBindings
    ).toEqual({ 'reader.page-left': [] });
    expect(migrateProfiles({ T: { wheelTurnsPages: 'yes' } as any }).T.wheelTurnsPages).toBe(false);
  });

  it('keeps unknown ids and unparseable chords: an older client cannot erase a newer one’s', () => {
    const newer = { 'reader.page-left': ['KeyA'], 'future.action': ['Hyper+KeyQ'] };
    // An older client reads the profile, edits something else, writes it back.
    const read = migrateProfiles({ T: { keyBindings: newer } as any });
    const written = { ...read.T, nightMode: true };
    const roundTrip = migrateProfiles({ T: JSON.parse(JSON.stringify(written)) });
    expect(roundTrip.T.keyBindings).toEqual(newer);
  });
});

describe('key bindings: retired actions (#55)', () => {
  it('folds a stored reader.cover into Spreads offset on load, without touching the stamp', () => {
    const stored = {
      T: {
        keyBindings: { 'reader.cover': ['KeyC', 'KeyX'], 'reader.night': ['KeyB'] },
        lastUpdated: '2026-01-01T00:00:00.000Z'
      } as any
    };
    const out = migrateProfiles(stored);
    expect(out.T.keyBindings).toEqual({
      'reader.offset-spreads': ['KeyO', 'KeyX'],
      'reader.night': ['KeyB']
    });
    // A shape migration: two devices converge without a write.
    expect(out.T.lastUpdated).toBe('2026-01-01T00:00:00.000Z');
    expect(migrateProfiles(JSON.parse(JSON.stringify(out))).T.keyBindings).toEqual(
      out.T.keyBindings
    );
  });
});

describe('quick menu selection (#55)', () => {
  it('defaults to {}: today’s menu, nothing to configure', () => {
    expect(migrateProfiles({ Test: {} as any }).Test.quickMenu).toEqual({});
  });

  it('checks shape only: a non-object becomes {}, a non-boolean entry is dropped', () => {
    for (const bad of ['on', 3, null, ['reader.fullscreen'], true]) {
      expect(migrateProfiles({ T: { quickMenu: bad } as any }).T.quickMenu, String(bad)).toEqual(
        {}
      );
    }
    expect(
      migrateProfiles({
        T: {
          quickMenu: {
            'reader.fullscreen': false,
            'set.bold.toggle': true,
            'reader.night': 'yes',
            'reader.invert': 1,
            'reader.timer': null
          }
        } as any
      }).T.quickMenu
    ).toEqual({ 'reader.fullscreen': false, 'set.bold.toggle': true });
  });

  it('keeps unknown ids, and ids that can never be on the menu: an older client cannot erase them', () => {
    const newer = { 'future.action': true, 'library.series-edit': true, 'set.wheel.next': false };
    const read = migrateProfiles({ T: { quickMenu: newer } as any });
    const written = { ...read.T, nightMode: true };
    const roundTrip = migrateProfiles({ T: JSON.parse(JSON.stringify(written)) });
    expect(roundTrip.T.quickMenu).toEqual(newer);
  });
});

describe('copyKeyBindingsToAllProfiles (#55)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the current map into every live profile and touches each one', async () => {
    const {
      copyKeyBindingsToAllProfiles,
      createProfile,
      deleteProfile,
      changeProfile,
      profilesWithTrash
    } = await import('./settings');
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    createProfile('KeysA');
    createProfile('KeysGone');
    deleteProfile('KeysGone');
    changeProfile('Desktop');
    updateSetting('keyBindings', { 'reader.page-left': ['KeyA'] });
    updateSetting('quickMenu', { 'reader.fullscreen': false, 'set.bold.toggle': true });

    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    copyKeyBindingsToAllProfiles();
    const all = get(profilesWithTrash);
    for (const name of ['Desktop', 'Mobile', 'KeysA']) {
      expect(all[name].keyBindings, name).toEqual({ 'reader.page-left': ['KeyA'] });
      // Both maps: the keys and the quick-menu selection.
      expect(all[name].quickMenu, name).toEqual({
        'reader.fullscreen': false,
        'set.bold.toggle': true
      });
      expect(all[name].lastUpdated, name).toBe('2026-02-01T00:00:00.000Z');
    }
    // A tombstone stays a tombstone.
    expect(all.KeysGone.deletedOn).toBeTruthy();
    expect(all.KeysGone.keyBindings).toEqual({});
    expect(all.KeysGone.quickMenu).toEqual({});
    // Copies, not one shared object.
    expect(all.KeysA.keyBindings).not.toBe(all.Desktop.keyBindings);
    expect(all.KeysA.quickMenu).not.toBe(all.Desktop.quickMenu);
    updateSetting('keyBindings', {});
    updateSetting('quickMenu', {});
  });
});
