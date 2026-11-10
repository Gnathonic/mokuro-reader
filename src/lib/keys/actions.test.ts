import { describe, expect, it } from 'vitest';
import {
  GROUP_ORDER,
  KEY_ACTIONS,
  PINNED_ACTIONS,
  SCOPES,
  type KeyActionDef,
  type KeyScope
} from './actions';
import { normalizeChord } from './chord';
import { ICON_NAMES } from './icon-names';
import { ACTION_ICONS, actionIcon } from './icons';
import { compileKeymap, findConflicts } from './keymap';
import { allActions } from './registry';
import { refusalReason } from './reserved';

const hand = KEY_ACTIONS as readonly KeyActionDef[];
const all = allActions();

describe('the hand-registered actions', () => {
  it('has 31 actions with unique ids and labels', () => {
    expect(hand).toHaveLength(31);
    expect(new Set(hand.map((a) => a.id)).size).toBe(hand.length);
    expect(new Set(hand.map((a) => a.label)).size).toBe(hand.length);
  });

  it('puts every action in a known group, id prefixed by its scope family', () => {
    for (const a of hand) {
      expect(GROUP_ORDER).toContain(a.group);
      const family = a.scope.split('.')[0];
      expect(a.id.startsWith(`${family}.`), a.id).toBe(true);
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.description.length).toBeGreaterThan(0);
    }
  });

  it('no longer holds the cover toggle, nor the seven toggles their definitions generate', () => {
    const ids = hand.map((a) => a.id as string);
    expect(ids).not.toContain('reader.cover');
    for (const pinned of Object.keys(PINNED_ACTIONS)) expect(ids).not.toContain(pinned);
  });

  it('never repeats a toggle or a navigation away', () => {
    const repeating = hand.filter((a) => a.repeat).map((a) => a.id);
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

describe('the full registry', () => {
  it('has unique ids and unique labels', () => {
    expect(new Set(all.map((a) => a.id)).size).toBe(all.length);
    const labels = all.map((a) => a.label);
    expect(labels.filter((l, i) => labels.indexOf(l) !== i)).toEqual([]);
  });

  it('gives every action a known group, scope, label and description', () => {
    for (const a of all) {
      expect(GROUP_ORDER, a.id).toContain(a.group);
      expect(Object.keys(SCOPES), a.id).toContain(a.scope);
      expect(a.label.length, a.id).toBeGreaterThan(0);
      expect(a.description.length, a.id).toBeGreaterThan(0);
    }
  });

  it('spells every default and locked chord canonically, and none is refused', () => {
    for (const a of all) {
      for (const c of [...a.defaults]) {
        expect(normalizeChord(c), `${a.id} ${c}`).toBe(c);
        expect(refusalReason(c), `${a.id} ${c}`).toBeNull();
      }
      for (const c of a.locked ?? []) expect(normalizeChord(c)).toBe(c);
    }
  });

  it('has no conflicts at defaults', () => {
    expect(findConflicts(compileKeymap({}, all)).size).toBe(0);
  });

  it('gives every action an icon that the map resolves to a component', () => {
    for (const a of all) {
      expect(ICON_NAMES, a.id).toContain(a.icon);
      expect(actionIcon(a.icon), `${a.id} ${a.icon}`).toBeTruthy();
    }
    expect(Object.keys(ACTION_ICONS).sort()).toEqual([...ICON_NAMES].sort());
    // No name is carried that nothing uses.
    const used = new Set(all.map((a) => a.icon));
    expect(ICON_NAMES.filter((n) => !used.has(n))).toEqual([]);
  });

  it('lets nothing outside reader, edit and app onto the quick menu', () => {
    const eligible: KeyScope[] = ['reader', 'edit', 'app'];
    for (const a of all) {
      expect(['off', 'never'], a.id).toContain(a.menu);
      if (!eligible.includes(a.scope)) expect(a.menu, a.id).toBe('never');
    }
    // The menu's own button and the wheel list can never be on it either.
    const never = (id: string) => all.find((a) => a.id === id)?.menu;
    expect(never('set.quick-actions.toggle')).toBe('never');
    expect(never('set.wheel.next')).toBe('never');
    expect(never('set.wheel.to.turn')).toBe('never');
    expect(never('reader.fullscreen')).toBe('off');
    expect(never('set.bold.toggle')).toBe('off');
    expect(never('set.theme.next')).toBe('off');
  });

  it('describes every scope: a shadowed scope exists, and only a dialog hides from app', () => {
    for (const [scope, def] of Object.entries(SCOPES)) {
      expect(def.label.length, scope).toBeGreaterThan(0);
      for (const under of def.shadows) {
        expect(Object.keys(SCOPES), `${scope} → ${under}`).toContain(under);
        expect(def.when, `${scope} needs the words for its capture note`).toBeTruthy();
      }
    }
    expect(SCOPES.edit.shadows).toEqual(['reader', 'app']);
    expect(SCOPES['library.series'].shadows).toEqual(['library']);
    expect(SCOPES['library.volume'].shadows).toEqual(['series']);
    expect(
      Object.entries(SCOPES)
        .filter(([, d]) => d.dialog)
        .map(([s]) => s)
    ).toEqual(['series-editor']);
  });
});
