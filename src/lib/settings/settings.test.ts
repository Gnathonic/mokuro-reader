// src/lib/settings/settings.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  migrateProfiles,
  grayscaleActive,
  imageFilter,
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
