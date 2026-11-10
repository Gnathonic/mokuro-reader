import { describe, expect, it } from 'vitest';
import { PINNED_ACTIONS, type KeyActionDef } from './actions';
import {
  actionsForSetting,
  generateSettingActions,
  parseSettingActionId,
  settingActionId
} from './generate';
import { allActions } from './registry';
import {
  SETTING_DEFS,
  findSettingDef,
  resolveOptions,
  settingDef,
  type SettingDef
} from '$lib/settings/setting-defs';

const defs = SETTING_DEFS as readonly SettingDef[];
const generated = generateSettingActions(defs);
const byId = new Map(generated.map((a) => [a.id, a]));
const ids = (def: SettingDef) => actionsForSetting(def).map((a) => a.id);

describe('the id scheme', () => {
  it('toggle → one Toggle', () => {
    expect(ids(settingDef('bold'))).toEqual(['set.bold.toggle']);
  });

  it('list → Next, Previous and one Set-to per option, by STORED value', () => {
    expect(ids(settingDef('zoom-paged'))).toEqual([
      'set.zoom-paged.next',
      'set.zoom-paged.prev',
      'set.zoom-paged.to.zoomFitToScreen',
      'set.zoom-paged.to.zoomFitToWidth',
      'set.zoom-paged.to.zoomFillScreen',
      'set.zoom-paged.to.zoomOriginal',
      'set.zoom-paged.to.keepZoom'
    ]);
    expect(ids(settingDef('gallery-sort')).slice(2)).toEqual([
      'set.gallery-sort.to.SMART',
      'set.gallery-sort.to.ASC',
      'set.gallery-sort.to.DESC'
    ]);
    expect(ids(settingDef('font-size'))).toHaveLength(17);
    expect(ids(settingDef('font-size'))).toContain('set.font-size.to.9');
  });

  it('slider → Step up, Step down, Reset', () => {
    expect(ids(settingDef('brightness'))).toEqual([
      'set.brightness.up',
      'set.brightness.down',
      'set.brightness.reset'
    ]);
  });

  it('a pinned toggle keeps its old id, default key and description', () => {
    const night = actionsForSetting(settingDef('night'));
    expect(night).toHaveLength(1);
    expect(night[0]).toMatchObject({
      id: 'reader.night',
      label: 'Night mode',
      defaults: ['KeyN'],
      description: PINNED_ACTIONS['reader.night'].description,
      setting: { def: 'night', op: 'toggle' }
    });
    expect(settingActionId(settingDef('timer'), 'toggle')).toBe('reader.timer');
    expect(byId.get('reader.timer')?.defaults).toEqual([]);
    for (const [id, pinned] of Object.entries(PINNED_ACTIONS)) {
      expect(byId.get(id)?.defaults, id).toEqual(pinned.defaults);
    }
  });

  it('parses an id back; everything after `.to.` is the option', () => {
    expect(parseSettingActionId('set.bold.toggle')).toEqual({ def: 'bold', op: 'toggle' });
    expect(parseSettingActionId('set.zoom-paged.to.zoomFitToWidth')).toEqual({
      def: 'zoom-paged',
      op: 'to',
      value: 'zoomFitToWidth'
    });
    expect(parseSettingActionId('set.profile.to.My.Profile v2 .to. x')).toEqual({
      def: 'profile',
      op: 'to',
      value: 'My.Profile v2 .to. x'
    });
    for (const bad of [
      'reader.night',
      'set.',
      'set.bold',
      'set.bold.flip',
      'set.x.to.',
      'set..up'
    ]) {
      expect(parseSettingActionId(bad), bad).toBeNull();
    }
  });
});

describe('every generated action', () => {
  it('resolves to a definition and an operation that definition has', () => {
    const ops: Record<SettingDef['kind'], string[]> = {
      toggle: ['toggle'],
      list: ['next', 'prev', 'to'],
      slider: ['up', 'down', 'reset']
    };
    expect(generated.length).toBe(170);
    for (const a of generated) {
      expect(a.setting, a.id).toBeDefined();
      const def = findSettingDef(a.setting!.def);
      expect(def, a.id).toBeDefined();
      expect(ops[def!.kind], a.id).toContain(a.setting!.op);
      if (a.setting!.op === 'to') {
        const values = resolveOptions(def as Extract<SettingDef, { kind: 'list' }>).map(
          (o) => o.value
        );
        expect(values, a.id).toContain(a.setting!.value);
      } else {
        expect(a.setting!.value, a.id).toBeUndefined();
      }
      // The id and the link agree (a pinned id has no `set.` form).
      const parsed = parseSettingActionId(a.id);
      if (parsed) expect(parsed, a.id).toEqual(a.setting);
      else expect(Object.keys(PINNED_ACTIONS), a.id).toContain(a.id);
    }
  });

  it('takes its scope, modes, group, icon and menu eligibility from the definition', () => {
    for (const a of generated) {
      const def = findSettingDef(a.setting!.def)!;
      expect(a.scope, a.id).toBe(def.scope);
      expect(a.modes, a.id).toEqual(def.modes);
      expect(a.group, a.id).toBe(def.group);
      expect(a.icon, a.id).toBe(def.icon);
      expect(a.menu, a.id).toBe(def.menu);
    }
  });

  it('is unbound unless pinned; only slider steps repeat', () => {
    for (const a of generated) {
      if (!(a.id in PINNED_ACTIONS)) expect(a.defaults, a.id).toEqual([]);
      expect(a.locked, a.id).toBeUndefined();
      expect(a.repeat, a.id).toBe(a.setting!.op === 'up' || a.setting!.op === 'down');
    }
  });

  it('a list’s and a slider’s actions name their parent; a toggle is its own row', () => {
    for (const a of generated) {
      const def = findSettingDef(a.setting!.def)!;
      expect(a.parent, a.id).toBe(def.kind === 'toggle' ? undefined : def.id);
    }
  });

  it('is labelled so the setting can be found by name', () => {
    const label = (id: string) => byId.get(id)?.label;
    expect(label('set.bold.toggle')).toBe('Bold font');
    expect(label('set.zoom-paged.next')).toBe('Paged zoom: Next');
    expect(label('set.zoom-paged.prev')).toBe('Paged zoom: Previous');
    expect(label('set.zoom-paged.to.zoomFitToWidth')).toBe('Paged zoom: Set to Fit to width');
    expect(label('set.brightness.up')).toBe('Brightness: Step up');
    expect(label('set.brightness.down')).toBe('Brightness: Step down');
    expect(label('set.brightness.reset')).toBe('Brightness: Reset');
    expect(byId.get('set.brightness.up')?.description).toContain('5%');
  });
});

describe('the full list', () => {
  it('is the hand-registered tuple, then the generated actions, then nothing else', () => {
    const all = allActions();
    const fromDefs = all.filter((a: KeyActionDef) => a.setting);
    expect(fromDefs.map((a) => a.id)).toEqual(generated.map((a) => a.id));
    expect(all.length - fromDefs.length).toBe(31);
    expect(all.slice(0, 31).every((a) => !a.setting)).toBe(true);
  });
});
