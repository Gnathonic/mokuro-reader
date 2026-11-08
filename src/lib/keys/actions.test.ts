import { describe, expect, it } from 'vitest';
import { GROUP_ORDER, KEY_ACTIONS, type KeyActionDef } from './actions';
import { normalizeChord } from './chord';
import { compileKeymap, findConflicts } from './keymap';
import { refusalReason } from './reserved';

const actions = KEY_ACTIONS as readonly KeyActionDef[];

describe('the action registry', () => {
  it('has 39 actions with unique ids and labels', () => {
    expect(actions).toHaveLength(39);
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
    expect(new Set(actions.map((a) => a.label)).size).toBe(actions.length);
  });

  it('puts every action in a known group, id prefixed by its scope family', () => {
    for (const a of actions) {
      expect(GROUP_ORDER).toContain(a.group);
      const family = a.scope.split('.')[0];
      expect(a.id.startsWith(`${family}.`), a.id).toBe(true);
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.description.length).toBeGreaterThan(0);
    }
  });

  it('spells every default and locked chord canonically, and none is refused', () => {
    for (const a of actions) {
      for (const c of [...a.defaults]) {
        expect(normalizeChord(c), `${a.id} ${c}`).toBe(c);
        expect(refusalReason(c), `${a.id} ${c}`).toBeNull();
      }
      for (const c of a.locked ?? []) expect(normalizeChord(c)).toBe(c);
    }
  });

  it('has no conflicts at defaults', () => {
    expect(findConflicts(compileKeymap({})).size).toBe(0);
  });

  it('ships the five new actions unbound', () => {
    const unbound = actions.filter((a) => a.defaults.length === 0 && !a.locked).map((a) => a.id);
    expect(unbound.sort()).toEqual(
      [
        'reader.controls',
        'reader.timer',
        'reader.volume-next',
        'reader.volume-prev',
        'reader.zoom-fit'
      ].sort()
    );
  });

  it('never repeats a toggle or a navigation away', () => {
    const repeating = actions.filter((a) => a.repeat).map((a) => a.id);
    expect(repeating.sort()).toEqual(
      [
        'reader.page-left',
        'reader.page-right',
        'reader.page-prev',
        'reader.page-next',
        'reader.scroll-up',
        'reader.scroll-down',
        'reader.scroll-left',
        'reader.scroll-right',
        'edit.undo',
        'edit.redo',
        'edit.delete'
      ].sort()
    );
  });
});
