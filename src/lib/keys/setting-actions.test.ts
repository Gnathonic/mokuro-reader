import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));

import { showSnackbar } from '$lib/util/snackbar';
import {
  changeProfile,
  createProfile,
  currentProfile,
  deleteProfile,
  settings,
  updateScheduleSetting,
  updateSetting
} from '$lib/settings/settings';
import { miscSettings, updateMiscSetting } from '$lib/settings/misc';
import { settingDef, type SettingDefId } from '$lib/settings/setting-defs';
import { registerAnnouncer, type AnnounceAction } from './announce';
import { actionDef } from './registry';
import { applySettingOp, runSettingAction, settingToggleOn, stepSetting } from './setting-actions';
import type { ActionId } from './actions';

type Said = { message: string; key: string; action?: AnnounceAction };
let said: Said[] = [];
let stop: () => void = () => {};

const run = (id: ActionId, ctx = {}) => runSettingAction(actionDef(id), ctx);
const last = () => said[said.length - 1];
const apply = (id: SettingDefId, op: Parameters<typeof applySettingOp>[1], value?: string) =>
  applySettingOp(settingDef(id), op, {}, value);

beforeEach(() => {
  said = [];
  stop = registerAnnouncer((message, key, action) => said.push({ message, key, action }));
});
afterEach(() => stop());

describe('toggle', () => {
  it('flips the setting and announces “<Label>: On|Off”', () => {
    updateSetting('boldFont', false);
    expect(run('set.bold.toggle')).toBe(true);
    expect(get(settings).boldFont).toBe(true);
    expect(last()).toEqual({ message: 'Bold font: On', key: 'set-bold', action: undefined });
    run('set.bold.toggle');
    expect(get(settings).boldFont).toBe(false);
    expect(last().message).toBe('Bold font: Off');
  });

  it('the seven pinned toggles run through the same handler, in the common wording', () => {
    updateSetting('pageDividers', false);
    run('reader.dividers');
    expect(get(settings).pageDividers).toBe(true);
    expect(last().message).toBe('Page dividers: On');
    run('reader.dividers');

    const before = get(settings).continuousScroll;
    run('reader.continuous');
    expect(get(settings).continuousScroll).toBe(!before);
    expect(last().message).toBe(`Continuous scroll: ${before ? 'Off' : 'On'}`);
    run('reader.continuous');
  });

  it('a toggle over another shape of value: Anki double-tap', () => {
    run('set.anki-double-tap.toggle');
    const method = get(settings).ankiConnectSettings.triggerMethod;
    expect(['doubleTap', 'neither']).toContain(method);
    run('set.anki-double-tap.toggle');
    expect(get(settings).ankiConnectSettings.triggerMethod).not.toBe(method);
  });

  it('hide completed volumes also switches the stacking preset to Custom', () => {
    apply('stacking', 'to', 'default');
    expect(get(settings).catalogSettings.stackingPreset).toBe('default');
    expect(get(settings).catalogSettings.hideReadVolumes).toBe(true);
    run('set.hide-completed.toggle');
    expect(get(settings).catalogSettings.hideReadVolumes).toBe(false);
    expect(get(settings).catalogSettings.stackingPreset).toBe('custom');
    apply('stacking', 'to', 'default');
  });
});

describe('list', () => {
  it('Next and Previous wrap round by default', () => {
    updateSetting('zoomDefault', 'zoomOriginal');
    run('set.zoom-paged.next');
    expect(get(settings).zoomDefault).toBe('keepZoom');
    expect(last()).toMatchObject({ message: 'Paged zoom: Keep zoom', key: 'set-zoom-paged' });
    run('set.zoom-paged.next');
    expect(get(settings).zoomDefault).toBe('zoomFitToScreen');
    run('set.zoom-paged.prev');
    expect(get(settings).zoomDefault).toBe('keepZoom');
    expect(last().message).toBe('Paged zoom: Keep zoom');
    updateSetting('zoomDefault', 'zoomFitToScreen');
  });

  it('font size does not wrap: Next stops at 60, Previous stops at auto', () => {
    updateSetting('fontSize', '48');
    run('set.font-size.next');
    expect(get(settings).fontSize).toBe('60');
    run('set.font-size.next');
    expect(get(settings).fontSize).toBe('60');
    expect(last().message).toBe('Font size: 60');
    updateSetting('fontSize', 'original');
    run('set.font-size.prev');
    expect(get(settings).fontSize).toBe('auto');
    run('set.font-size.prev');
    expect(get(settings).fontSize).toBe('auto');
  });

  it('Set-to writes the stored value and announces the option’s name', () => {
    run('set.zoom-paged.to.zoomFitToWidth');
    expect(get(settings).zoomDefault).toBe('zoomFitToWidth');
    expect(last().message).toBe('Paged zoom: Fit to width');
    run('set.gallery-sort.to.DESC');
    expect(get(miscSettings).gallerySorting).toBe('DESC');
    expect(last().message).toBe('Gallery sort: Z-A');
    updateSetting('zoomDefault', 'zoomFitToScreen');
    updateMiscSetting('gallerySorting', 'SMART');
  });

  it('a stored value that is not an option: Next starts at the first, Previous at the last', () => {
    updateSetting('pageTransition', 'spiral');
    apply('page-transition', 'next');
    expect(get(settings).pageTransition).toBe('none');
    updateSetting('pageTransition', 'spiral');
    apply('page-transition', 'prev');
    expect(get(settings).pageTransition).toBe('swipe');
    updateSetting('pageTransition', 'none');
  });

  it('a Set-to for an option that no longer exists declines', () => {
    expect(apply('zoom-paged', 'to', 'zoomSideways')).toEqual({ done: false });
  });

  it('stacking preset writes the eight settings the preset stands for', () => {
    run('set.stacking.to.spine');
    expect(get(settings).catalogSettings).toMatchObject({
      stackingPreset: 'spine',
      stackCount: 0,
      hideReadVolumes: false,
      compactCloudSeries: true,
      dropShadow: false
    });
    run('set.stacking.to.default');
    expect(get(settings).catalogSettings).toMatchObject({
      stackingPreset: 'default',
      stackCount: 3
    });
  });

  describe('profiles (the dynamic list)', () => {
    const NAME = 'Handler.Test Profile';
    afterEach(() => {
      changeProfile('Desktop');
      deleteProfile(NAME);
    });

    it('Set to <name>, and Next walks the profiles that exist now', () => {
      changeProfile('Desktop');
      createProfile(NAME);
      expect(run(`set.profile.to.${NAME}`)).toBe(true);
      expect(get(currentProfile)).toBe(NAME);
      expect(last().message).toBe(`Profile: ${NAME}`);
      run('set.profile.next');
      expect(get(currentProfile)).toBe('Mobile');
      run('set.profile.prev');
      expect(get(currentProfile)).toBe(NAME);
    });

    it('a binding to a deleted profile is inert: it declines', () => {
      createProfile(NAME);
      const action = actionDef(`set.profile.to.${NAME}`);
      deleteProfile(NAME);
      said = [];
      expect(runSettingAction(action)).toBe(false);
      expect(said).toEqual([]);
    });
  });
});

describe('slider', () => {
  it('steps by its own step and clamps at both ends', () => {
    updateSetting('pageBrightness', 190);
    run('set.brightness.up');
    expect(get(settings).pageBrightness).toBe(195);
    expect(last()).toMatchObject({ message: 'Brightness: 195%', key: 'set-brightness' });
    run('set.brightness.up');
    run('set.brightness.up');
    expect(get(settings).pageBrightness).toBe(200);
    expect(last().message).toBe('Brightness: 200%');

    updateSetting('pageBrightness', 55);
    run('set.brightness.down');
    run('set.brightness.down');
    expect(get(settings).pageBrightness).toBe(50);
    expect(last().message).toBe('Brightness: 50%');
  });

  it('Reset goes back to the definition’s reset value', () => {
    run('set.brightness.reset');
    expect(get(settings).pageBrightness).toBe(100);
    expect(last().message).toBe('Brightness: 100%');
  });

  it('the page gap steps by one wheel notch, 5 px', () => {
    updateSetting('pagedGap', 0);
    run('set.paged-gap.up');
    run('set.paged-gap.up');
    expect(get(settings).pagedGap).toBe(10);
    expect(last().message).toBe('Paged gap: 10px');
    run('set.paged-gap.reset');
    expect(get(settings).pagedGap).toBe(0);
    run('set.paged-gap.down');
    expect(get(settings).pagedGap).toBe(0);
  });

  it('a print-effect slider says so while the effect is off', () => {
    updateSetting('pageInkColor', 'off');
    updateSetting('pageInkStrength', 0);
    run('set.ink-strength.up');
    expect(get(settings).pageInkStrength).toBe(5);
    expect(last().message).toBe('Ink strength: +5 (print effect off)');
    updateSetting('pageInkColor', 'blue');
    run('set.ink-strength.down');
    expect(last().message).toBe('Ink strength: 0');
    updateSetting('pageInkColor', 'off');
  });
});

describe('a volume setting', () => {
  it('declines without an open volume: nothing written, nothing said', () => {
    expect(run('set.rtl.toggle')).toBe(false);
    expect(said).toEqual([]);
    expect(applySettingOp(settingDef('rtl'), 'toggle', {})).toEqual({ done: false });
  });

  it('with a volume, flips that volume’s direction from the profile default', () => {
    const fallback = get(settings).volumeDefaults.rightToLeft;
    const result = applySettingOp(settingDef('rtl'), 'toggle', { volumeId: 'rtl-test-volume' });
    expect(result).toMatchObject({
      done: true,
      message: `Right to left: ${fallback ? 'Off' : 'On'}`
    });
  });
});

describe('a scheduled filter', () => {
  afterEach(() => {
    updateScheduleSetting('nightModeSchedule', 'enabled', false);
    updateSetting('nightMode', false);
    vi.useRealTimers();
  });

  function scheduleNight(start: string, end: string) {
    updateScheduleSetting('nightModeSchedule', 'startTime', start);
    updateScheduleSetting('nightModeSchedule', 'endTime', end);
    updateScheduleSetting('nightModeSchedule', 'enabled', true);
  }

  it('with the schedule off, N just toggles', () => {
    run('reader.night');
    expect(get(settings).nightMode).toBe(true);
    expect(last()).toEqual({ message: 'Night mode: On', key: 'set-night', action: undefined });
  });

  it('with the schedule on, changes nothing and returns today’s message with one button', () => {
    scheduleNight('00:00', '23:59');
    const before = structuredClone(get(settings));
    expect(run('reader.night')).toBe(true);
    expect(get(settings).nightMode).toBe(before.nightMode);
    expect(get(settings).nightModeSchedule).toEqual(before.nightModeSchedule);
    expect(last().message).toBe('Night Mode is on automatic schedule');
    expect(last().key).toBe('set-night-scheduled');
    expect(last().action?.label).toBe('Set to manual');
  });

  it.each([
    ['inside the scheduled hours: night stays on', '00:00', '23:59', true],
    ['outside the scheduled hours: night stays off', '03:00', '03:00', false]
  ])('the button turns the schedule off and keeps what is on screen (%s)', (_n, start, end, on) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 12, 0, 0));
    // The manual value disagrees with the screen, so "kept" is observable.
    updateSetting('nightMode', !on);
    scheduleNight(start, end);
    run('reader.night');
    last().action!.run();
    expect(get(settings).nightModeSchedule.enabled).toBe(false);
    expect(get(settings).nightMode).toBe(on);
    expect(last().message).toBe(`Night mode: ${on ? 'On' : 'Off'} (manual)`);
    expect(last().action).toBeUndefined();
    // The next press of the key toggles it.
    run('reader.night');
    expect(get(settings).nightMode).toBe(!on);
  });

  it('the quick menu’s pressed state shows what is on screen: the manual value, or the schedule’s', () => {
    const on = () => settingToggleOn(actionDef('reader.night'));
    expect(on()).toBe(false);
    updateSetting('nightMode', true);
    expect(on()).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 12, 0, 0));
    // Scheduled for an hour that is not now: off on screen, whatever the manual value says.
    scheduleNight('03:00', '03:00');
    expect(on()).toBe(false);
    updateSetting('nightMode', false);
    scheduleNight('00:00', '23:59');
    expect(on()).toBe(true);
  });

  it('only a toggle has a pressed state, and a volume toggle needs its volume', () => {
    expect(settingToggleOn(actionDef('set.bold.toggle'))).toBe(false);
    updateSetting('boldFont', true);
    expect(settingToggleOn(actionDef('set.bold.toggle'))).toBe(true);
    updateSetting('boldFont', false);
    expect(settingToggleOn(actionDef('set.brightness.up'))).toBeUndefined();
    expect(settingToggleOn(actionDef('set.zoom-paged.next'))).toBeUndefined();
    expect(settingToggleOn(actionDef('reader.fullscreen'))).toBeUndefined();
    expect(settingToggleOn(actionDef('set.rtl.toggle'))).toBeUndefined();
    expect(typeof settingToggleOn(actionDef('set.rtl.toggle'), { volumeId: 'v1' })).toBe('boolean');
  });

  it('invert and black & white keep today’s names for the message', () => {
    updateScheduleSetting('invertColorsSchedule', 'enabled', true);
    updateScheduleSetting('grayscaleSchedule', 'enabled', true);
    run('reader.invert');
    expect(last().message).toBe('Invert is on automatic schedule');
    run('reader.grayscale');
    expect(last().message).toBe('B&W is on automatic schedule');
    updateScheduleSetting('invertColorsSchedule', 'enabled', false);
    updateScheduleSetting('grayscaleSchedule', 'enabled', false);
  });
});

describe('feedback', () => {
  it('goes to the snackbar when the reader is not mounted', () => {
    stop();
    vi.mocked(showSnackbar).mockClear();
    run('set.bold.toggle');
    expect(showSnackbar).toHaveBeenCalledWith(expect.stringMatching(/^Bold font: O(n|ff)$/));
    expect(said).toEqual([]);
    run('set.bold.toggle');
  });

  it('only the newest reader notification is un-registered by its own disposer', () => {
    const second: string[] = [];
    const stopSecond = registerAnnouncer((m) => second.push(m));
    stop(); // the first reader's teardown, after a second one mounted
    run('set.bold.toggle');
    expect(second).toHaveLength(1);
    stopSecond();
    run('set.bold.toggle');
  });

  it('a settings-page button steps the same order, silently', () => {
    updateMiscSetting('gallerySorting', 'SMART');
    stepSetting('gallery-sort', 'next');
    expect(get(miscSettings).gallerySorting).toBe('ASC');
    stepSetting('gallery-sort', 'next');
    stepSetting('gallery-sort', 'next');
    expect(get(miscSettings).gallerySorting).toBe('SMART');
    expect(said).toEqual([]);
  });

  it('an action that is not generated is not this handler’s', () => {
    expect(runSettingAction(actionDef('reader.fullscreen'))).toBe(false);
  });
});
