import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { GROUP_ORDER, PINNED_ACTIONS, SCOPES } from '$lib/keys/actions';
import { ICON_NAMES } from '$lib/keys/icon-names';
import { INK_COLOR_SETTINGS } from '$lib/reader/ink-color';
import { PAGE_ADJUST_MAX, PAGE_ADJUST_MIN, PAGE_ADJUST_STEP } from '$lib/reader/page-filter';
import { MAX_PAGE_GAP } from '$lib/reader/zoom-math';
import {
  SETTING_DEFS,
  findSettingDef,
  listOptions,
  optionName,
  resolveOptions,
  settingDef,
  sliderDef,
  type SettingDef
} from './setting-defs';
import { PRESETS, profiles, settings, updateSetting } from './settings';

const defs = SETTING_DEFS as readonly SettingDef[];
const ofKind = <K extends SettingDef['kind']>(kind: K) =>
  defs.filter((d): d is Extract<SettingDef, { kind: K }> => d.kind === kind);

describe('the setting definitions', () => {
  it('are 48: 20 toggles, 21 lists, 7 sliders', () => {
    expect(defs).toHaveLength(48);
    expect(ofKind('toggle')).toHaveLength(20);
    expect(ofKind('list')).toHaveLength(21);
    expect(ofKind('slider')).toHaveLength(7);
  });

  it('have unique, permanent-shaped ids: kebab-case, no dots', () => {
    const ids = defs.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  });

  it('have unique labels, a known group, scope and icon', () => {
    const labels = defs.map((d) => d.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const d of defs) {
      expect(GROUP_ORDER, d.id).toContain(d.group);
      expect(Object.keys(SCOPES), d.id).toContain(d.scope);
      expect(ICON_NAMES, d.id).toContain(d.icon);
      expect(['off', 'never'], d.id).toContain(d.menu);
    }
  });

  it('never put a setting from outside the reader, edit mode or the app on the quick menu', () => {
    for (const d of defs) {
      if (!['reader', 'edit', 'app'].includes(d.scope)) expect(d.menu, d.id).toBe('never');
    }
    expect(settingDef('wheel').menu).toBe('never');
    expect(settingDef('quick-actions').menu).toBe('never');
  });

  it('pin exactly the seven toggles that predate them', () => {
    const pinned = ofKind('toggle')
      .filter((d) => d.actionId)
      .map((d) => [d.id, d.actionId]);
    expect(pinned).toEqual([
      ['continuous', 'reader.continuous'],
      ['dividers', 'reader.dividers'],
      ['timer', 'reader.timer'],
      ['night', 'reader.night'],
      ['invert', 'reader.invert'],
      ['grayscale', 'reader.grayscale'],
      ['ocr-always', 'reader.ocr-always']
    ]);
    expect(pinned.map(([, id]) => id).sort()).toEqual(Object.keys(PINNED_ACTIONS).sort());
  });

  it('carry the schedule on the three scheduled filters, with today’s names', () => {
    const scheduled = ofKind('toggle')
      .filter((d) => d.schedule)
      .map((d) => [d.id, d.schedule, d.scheduleName]);
    expect(scheduled).toEqual([
      ['night', 'nightModeSchedule', 'Night Mode'],
      ['invert', 'invertColorsSchedule', 'Invert'],
      ['grayscale', 'grayscaleSchedule', 'B&W']
    ]);
  });

  it('limit each setting to the layouts it applies in', () => {
    const modes = (id: string) => findSettingDef(id)?.modes;
    for (const id of [
      'page-view',
      'zoom-paged',
      'page-transition',
      'paged-gap',
      'bounds',
      'mobile'
    ]) {
      expect(modes(id), id).toEqual(['paged']);
    }
    for (const id of ['scroll-mode', 'zoom-continuous', 'dividers', 'scroll-gap']) {
      expect(modes(id), id).toEqual(['vertical', 'horizontal']);
    }
    expect(modes('rtl')).toEqual(['paged', 'horizontal']);
    expect(modes('bold')).toBeUndefined();
  });

  it('give every list unique option values, and names', () => {
    for (const d of ofKind('list')) {
      const options = resolveOptions(d);
      expect(options.length, d.id).toBeGreaterThan(1);
      const values = options.map((o) => o.value);
      expect(new Set(values).size, d.id).toBe(values.length);
      for (const o of options) {
        expect(typeof o.value, d.id).toBe('string');
        expect(o.value.length, d.id).toBeGreaterThan(0);
        expect(o.name.length, d.id).toBeGreaterThan(0);
      }
    }
  });

  it('read a default that is one of the list’s options', () => {
    for (const d of ofKind('list')) {
      const values = resolveOptions(d).map((o) => o.value);
      expect(values, `${d.id}: ${String(d.read({}))}`).toContain(String(d.read({})));
    }
  });

  it('read a boolean for every toggle that has something to act on', () => {
    for (const d of ofKind('toggle')) {
      if (d.available && !d.available({})) {
        expect(d.read({}), d.id).toBeUndefined();
        continue;
      }
      expect(typeof d.read({}), d.id).toBe('boolean');
    }
  });

  it('keep every slider’s reset and default inside its range, on its step', () => {
    for (const d of ofKind('slider')) {
      expect(d.min, d.id).toBeLessThan(d.max);
      expect(d.step, d.id).toBeGreaterThan(0);
      expect(d.reset, d.id).toBeGreaterThanOrEqual(d.min);
      expect(d.reset, d.id).toBeLessThanOrEqual(d.max);
      expect((d.max - d.min) % d.step, d.id).toBe(0);
      expect((d.reset - d.min) % d.step, d.id).toBe(0);
      const now = d.read({});
      expect(typeof now, d.id).toBe('number');
      expect(now, d.id).toBeGreaterThanOrEqual(d.min);
      expect(now, d.id).toBeLessThanOrEqual(d.max);
      expect(d.format(d.reset).length, d.id).toBeGreaterThan(0);
    }
  });

  it('take slider limits and steps from the existing constants', () => {
    expect(sliderDef('brightness')).toMatchObject({
      min: PAGE_ADJUST_MIN,
      max: PAGE_ADJUST_MAX,
      step: PAGE_ADJUST_STEP
    });
    // One wheel notch of the Ctrl+Shift+wheel gap chord: 5 px.
    for (const id of ['paged-gap', 'scroll-gap'] as const) {
      expect(sliderDef(id)).toMatchObject({ min: 0, max: MAX_PAGE_GAP, step: 5, reset: 0 });
    }
    expect(sliderDef('paged-gap').format(15)).toBe('15px');
    expect(sliderDef('ink-strength').format(5)).toBe('+5');
    expect(sliderDef('ink-strength').format(-5)).toBe('-5');
    expect(sliderDef('paper-tint').format(8)).toBe('8%');
  });

  it('derive the generated lists from their one source', () => {
    expect(listOptions('ink-color').map((o) => o.value)).toEqual([...INK_COLOR_SETTINGS]);
    expect(listOptions('ink-color')[0]).toEqual({ value: 'off', name: 'Off' });
    expect(listOptions('theme').map((o) => o.value)).toEqual([...Object.keys(PRESETS), 'custom']);
    expect(listOptions('profile').map((o) => o.value)).toEqual(Object.keys(get(profiles)));
    expect(listOptions('font-size')).toHaveLength(15);
    expect(optionName('zoom-paged', 'zoomFitToWidth')).toBe('Fit to width');
    expect(optionName('zoom-paged', 'nope')).toBe('nope');
  });

  it('hand out a fresh list each time, so a component cannot edit the definition', () => {
    const a = listOptions('page-view');
    a.pop();
    expect(listOptions('page-view')).toHaveLength(3);
  });
});

describe('definitions that do more than store a value', () => {
  it('mouse wheel: three options over two booleans', () => {
    const wheel = settingDef('wheel');
    for (const [value, turns, swaps] of [
      ['turn', true, false],
      ['zoom', false, true],
      ['pan', false, false]
    ] as const) {
      wheel.write({}, value);
      expect(get(settings).wheelTurnsPages).toBe(turns);
      expect(get(settings).swapWheelBehavior).toBe(swaps);
      expect(wheel.read({})).toBe(value);
    }
    // `wheelTurnsPages` wins when a synced profile holds both.
    updateSetting('wheelTurnsPages', true);
    updateSetting('swapWheelBehavior', true);
    expect(wheel.read({})).toBe('turn');
    wheel.write({}, 'pan');
  });

  it('theme: selecting Custom never re-seeds the custom colours', () => {
    const theme = settingDef('theme');
    const mine = { ...get(settings).customTheme, accent: '#123456' };
    updateSetting('customTheme', mine);
    theme.write({}, 'nord');
    theme.write({}, 'custom');
    expect(get(settings).theme).toBe('custom');
    expect(get(settings).customTheme).toEqual(mine);
    theme.write({}, 'dark');
  });

  it('scroll gap: the dividers follow the gap, as the wheel chord does', () => {
    const gap = settingDef('scroll-gap');
    gap.write({}, 10);
    expect(get(settings).scrollGap).toBe(10);
    expect(get(settings).pageDividers).toBe(true);
    gap.write({}, 0);
    expect(get(settings).pageDividers).toBe(false);
  });

  it('right to left: nothing to act on without an open volume', () => {
    const rtl = settingDef('rtl');
    expect(rtl.available?.({})).toBe(false);
    expect(rtl.available?.({ volumeId: 'v' })).toBe(true);
    // An unknown volume falls back to the profile's volume default, as the reader does.
    expect(rtl.read({ volumeId: 'no-such-volume' })).toBe(get(settings).volumeDefaults.rightToLeft);
  });
});
