import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  changeProfile,
  createProfile,
  deleteProfile,
  profiles,
  settings,
  updateSetting
} from '$lib/settings/settings';
import type { KeyActionDef } from './actions';
import { currentKeymap } from './live';
import { actionDef, allActions } from './registry';
import {
  addChord,
  chordRelation,
  compileKeymap as compileOver,
  effectiveChords,
  findConflicts,
  isModified,
  lookup,
  removeChord,
  replaceChord,
  resetAction,
  sanitizeKeyBindings,
  withChords,
  type KeyBindings
} from './keymap';

/** Compile over the full list, as the live keymap does. */
const compileKeymap = (bindings: KeyBindings | undefined) => compileOver(bindings, allActions());

describe('compileKeymap', () => {
  it('absent id = the defaults', () => {
    const map = compileKeymap({});
    expect(map.chords.get('reader.page-next')).toEqual(['PageDown', 'Space']);
    expect(lookup(map, 'reader', 'Space', 'paged')).toEqual(['reader.page-next']);
  });

  it('[] = unbound', () => {
    const map = compileKeymap({ 'reader.fullscreen': [] });
    expect(map.chords.get('reader.fullscreen')).toEqual([]);
    expect(lookup(map, 'reader', 'KeyF', 'paged')).toEqual([]);
  });

  it('a stored list replaces the defaults', () => {
    const map = compileKeymap({ 'reader.page-left': ['KeyA'] });
    expect(lookup(map, 'reader', 'KeyA', 'paged')).toEqual(['reader.page-left']);
    expect(lookup(map, 'reader', 'ArrowLeft', 'paged')).toEqual([]);
  });

  it('keeps the locked Escape on Back however the list is stored', () => {
    expect(compileKeymap({ 'app.back': [] }).chords.get('app.back')).toEqual(['Escape']);
    expect(compileKeymap({ 'app.back': ['KeyQ'] }).chords.get('app.back')).toEqual([
      'Escape',
      'KeyQ'
    ]);
    expect(compileKeymap({ 'edit.back': [] }).chords.get('edit.back')).toEqual(['Escape']);
  });

  it('ignores unknown ids and unparseable chords without failing', () => {
    const map = compileKeymap({
      'future.action': ['KeyQ'],
      'reader.page-right': ['KeyD', 'Bogus+KeyX', '']
    });
    expect(map.chords.get('reader.page-right')).toEqual(['KeyD']);
    expect([...map.chords.keys()]).not.toContain('future.action');
  });

  it('canonicalises stored chords', () => {
    const map = compileKeymap({ 'edit.redo': ['Meta+Shift+KeyZ'] });
    expect(map.chords.get('edit.redo')).toEqual(['Shift+Meta+KeyZ']);
  });

  it('filters by live mode: ← is Page left in paged, Scroll left in vertical', () => {
    const map = compileKeymap({});
    expect(lookup(map, 'reader', 'ArrowLeft', 'paged')).toEqual(['reader.page-left']);
    expect(lookup(map, 'reader', 'ArrowLeft', 'horizontal')).toEqual(['reader.page-left']);
    expect(lookup(map, 'reader', 'ArrowLeft', 'vertical')).toEqual(['reader.scroll-left']);
  });

  it('keeps registry order when a synced map holds a conflict', () => {
    const map = compileKeymap({ 'reader.fullscreen': ['KeyQ'], 'reader.night': ['KeyQ'] });
    expect(lookup(map, 'reader', 'KeyQ', 'paged')).toEqual(['reader.fullscreen', 'reader.night']);
  });
});

describe('conflicts', () => {
  it('same scope + shared mode conflicts; disjoint modes do not', () => {
    expect(chordRelation(actionDef('reader.page-left'), actionDef('reader.night'))).toBe(
      'conflict'
    );
    expect(chordRelation(actionDef('reader.page-left'), actionDef('reader.scroll-left'))).toBe(
      'none'
    );
  });

  it('edit shadows reader and app (a note, not a prompt)', () => {
    expect(chordRelation(actionDef('edit.delete'), actionDef('reader.night'))).toBe('shadow');
    expect(chordRelation(actionDef('edit.back'), actionDef('app.back'))).toBe('shadow');
  });

  it('app conflicts with every scope but edit; reader and library never meet', () => {
    expect(chordRelation(actionDef('app.back'), actionDef('reader.fullscreen'))).toBe('conflict');
    expect(chordRelation(actionDef('app.back'), actionDef('library.volume-edit'))).toBe('conflict');
    expect(chordRelation(actionDef('reader.edit-mode'), actionDef('library.series-edit'))).toBe(
      'none'
    );
    expect(chordRelation(actionDef('library.series-edit'), actionDef('library.volume-edit'))).toBe(
      'none'
    );
  });

  it('a hovered card shadows its page; pages that never meet do not relate', () => {
    const on = (scope: KeyActionDef['scope'], id = `${scope}.x`): KeyActionDef => ({
      ...actionDef('app.back'),
      id,
      scope,
      locked: undefined
    });
    // Hover scope before the page it sits on: a note, not a prompt.
    expect(chordRelation(on('library.series'), on('library'))).toBe('shadow');
    expect(chordRelation(on('library.volume'), on('series'))).toBe('shadow');
    expect(chordRelation(on('series'), on('library.volume'))).toBe('shadow');
    // A card is not on the other page.
    expect(chordRelation(on('library.series'), on('series'))).toBe('none');
    expect(chordRelation(on('library.volume'), on('library'))).toBe('none');
    // Views that are never on screen together.
    for (const [a, b] of [
      ['library', 'series'],
      ['library', 'tracker'],
      ['series', 'text'],
      ['reader', 'library'],
      ['reader', 'series'],
      ['edit', 'library']
    ] as const) {
      expect(chordRelation(on(a), on(b)), `${a} / ${b}`).toBe('none');
    }
    // Same page scope: a conflict.
    expect(chordRelation(on('series', 'series.a'), on('series', 'series.b'))).toBe('conflict');
    // `app` is live on every page, never under a dialog.
    for (const scope of ['library', 'series', 'tracker', 'text', 'reader'] as const) {
      expect(chordRelation(on('app'), on(scope)), scope).toBe('conflict');
    }
    expect(chordRelation(on('app'), on('series-editor'))).toBe('none');
    expect(chordRelation(on('series-editor'), on('series'))).toBe('none');
  });

  it('generated actions take their definition’s modes: two zooms can share a key', () => {
    const paged = actionDef('set.zoom-paged.to.zoomFitToScreen');
    const continuous = actionDef('set.zoom-continuous.to.zoomFitToScreen');
    expect(chordRelation(paged, continuous)).toBe('none');
    expect(chordRelation(paged, actionDef('reader.fullscreen'))).toBe('conflict');
    const map = compileKeymap({ [paged.id]: ['KeyQ'], [continuous.id]: ['KeyQ'] });
    expect(findConflicts(map).size).toBe(0);
    expect(lookup(map, 'reader', 'KeyQ', 'paged')).toEqual([paged.id]);
    expect(lookup(map, 'reader', 'KeyQ', 'vertical')).toEqual([continuous.id]);
  });

  it('findConflicts flags both sides of a stored conflict', () => {
    const map = compileKeymap({ 'reader.fullscreen': ['KeyN'] });
    const c = findConflicts(map);
    expect([...(c.get('reader.fullscreen') ?? [])]).toEqual(['reader.night']);
    expect([...(c.get('reader.night') ?? [])]).toEqual(['reader.fullscreen']);
  });
});

describe('edits stay sparse', () => {
  const left = actionDef('reader.page-left');

  it('add, then remove back to the default, drops the entry', () => {
    const added = addChord({}, left, 'KeyA');
    expect(added).toEqual({ 'reader.page-left': ['ArrowLeft', 'KeyA'] });
    expect(removeChord(added, left, 'KeyA')).toEqual({});
  });

  it('removing every chord stores [] (unbound, not default)', () => {
    const next = removeChord({}, left, 'ArrowLeft');
    expect(next).toEqual({ 'reader.page-left': [] });
    expect(isModified(left, next)).toBe(true);
  });

  it('never stores a locked chord', () => {
    const back = actionDef('app.back');
    expect(addChord({}, back, 'KeyQ')).toEqual({ 'app.back': ['KeyQ'] });
    expect(withChords({}, back, ['Escape'])).toEqual({});
  });

  it('reset deletes the entry; isModified compares as sets', () => {
    const next = withChords({}, actionDef('reader.page-next'), ['Space', 'PageDown']);
    expect(next).toEqual({});
    expect(isModified(left, { 'reader.page-left': ['ArrowLeft'] })).toBe(false);
    expect(resetAction({ 'reader.page-left': [] }, left)).toEqual({});
  });

  it('replace moves the chord off the other action', () => {
    const next = replaceChord({}, actionDef('reader.fullscreen'), 'KeyN', [
      actionDef('reader.night')
    ]);
    expect(next).toEqual({ 'reader.night': [], 'reader.fullscreen': ['KeyF', 'KeyN'] });
  });

  it('effectiveChords lists the locked chord first', () => {
    expect(effectiveChords(actionDef('app.back'), { 'app.back': ['KeyQ'] })).toEqual([
      'Escape',
      'KeyQ'
    ]);
  });
});

describe('sanitizeKeyBindings', () => {
  it('turns a non-object into {}', () => {
    for (const v of [null, undefined, 3, 'x', ['KeyA']]) expect(sanitizeKeyBindings(v)).toEqual({});
  });

  it('drops non-array entries, keeps unknown ids and unparseable chords', () => {
    expect(
      sanitizeKeyBindings({
        'reader.page-left': ['KeyA', 'Weird+Chord'],
        'future.action': ['KeyQ'],
        'reader.night': 'KeyN'
      })
    ).toEqual({ 'reader.page-left': ['KeyA', 'Weird+Chord'], 'future.action': ['KeyQ'] });
  });

  // `reader.cover` (C) is retired into `reader.offset-spreads` (O): spec 17.3.
  describe('the reader.cover fold', () => {
    it('absent: nothing to do', () => {
      expect(sanitizeKeyBindings({ 'reader.night': ['KeyB'] })).toEqual({
        'reader.night': ['KeyB']
      });
    });

    it('[] (unbound): the entry is deleted, O untouched', () => {
      expect(sanitizeKeyBindings({ 'reader.cover': [] })).toEqual({});
    });

    it('[C]: C is freed for everyone', () => {
      expect(sanitizeKeyBindings({ 'reader.cover': ['KeyC'] })).toEqual({});
    });

    it('[C, X]: X moves onto Spreads offset beside its default O', () => {
      expect(sanitizeKeyBindings({ 'reader.cover': ['KeyC', 'KeyX'] })).toEqual({
        'reader.offset-spreads': ['KeyO', 'KeyX']
      });
    });

    it('[X] with a customised O: X joins the stored list', () => {
      expect(
        sanitizeKeyBindings({ 'reader.cover': ['KeyX'], 'reader.offset-spreads': ['KeyP'] })
      ).toEqual({ 'reader.offset-spreads': ['KeyP', 'KeyX'] });
      // Already there: not added twice. Unbound O: X becomes its only key.
      expect(
        sanitizeKeyBindings({ 'reader.cover': ['KeyX'], 'reader.offset-spreads': ['KeyX'] })
      ).toEqual({ 'reader.offset-spreads': ['KeyX'] });
      expect(
        sanitizeKeyBindings({ 'reader.cover': ['KeyX'], 'reader.offset-spreads': [] })
      ).toEqual({ 'reader.offset-spreads': ['KeyX'] });
    });

    it('is deterministic, idempotent and stops at the stored-chord cap', () => {
      const stored = {
        'reader.cover': ['KeyC', 'KeyX', 'KeyY'],
        'reader.offset-spreads': ['F1', 'F2', 'F3', 'F4', 'F6', 'F7', 'F8']
      };
      const once = sanitizeKeyBindings(stored);
      expect(once['reader.offset-spreads']).toEqual([
        'F1',
        'F2',
        'F3',
        'F4',
        'F6',
        'F7',
        'F8',
        'KeyX'
      ]);
      expect(sanitizeKeyBindings(once)).toEqual(once);
      expect(sanitizeKeyBindings(structuredClone(stored))).toEqual(once);
      // The input is never mutated.
      expect(stored['reader.cover']).toEqual(['KeyC', 'KeyX', 'KeyY']);
    });

    it('after the fold C fires nothing in the reader and O still offsets', () => {
      const map = compileKeymap(sanitizeKeyBindings({ 'reader.cover': ['KeyC', 'KeyX'] }));
      expect(lookup(map, 'reader', 'KeyC', 'paged')).toEqual([]);
      expect(lookup(map, 'reader', 'KeyO', 'paged')).toEqual(['reader.offset-spreads']);
      expect(lookup(map, 'reader', 'KeyX', 'paged')).toEqual(['reader.offset-spreads']);
    });
  });

  it('caps a list at 8 strings of at most 40 chars', () => {
    const long = Array.from({ length: 12 }, (_, i) => `Digit${i % 10}`);
    expect(sanitizeKeyBindings({ a: long }).a).toHaveLength(8);
    expect(sanitizeKeyBindings({ a: ['x'.repeat(41), 7, 'KeyA'] }).a).toEqual(['KeyA']);
  });
});

describe('profile actions follow the profile list', () => {
  const NAME = 'Keys.Test Profile';
  afterEach(() => {
    changeProfile('Desktop');
    deleteProfile(NAME);
  });

  it('a new profile gets a “Set to” action in the live keymap; deleting it removes it', () => {
    const id = `set.profile.to.${NAME}` as const;
    expect(currentKeymap().actions.has(id)).toBe(false);
    for (const name of Object.keys(get(profiles))) {
      expect(currentKeymap().actions.has(`set.profile.to.${name}`), name).toBe(true);
    }

    createProfile(NAME);
    const action = currentKeymap().actions.get(id);
    expect(action?.setting).toEqual({ def: 'profile', op: 'to', value: NAME });
    expect(action?.scope).toBe('app');

    deleteProfile(NAME);
    expect(currentKeymap().actions.has(id)).toBe(false);
  });

  it('a profile write that changes no name and no binding does not recompile', () => {
    const before = currentKeymap();
    createProfile(NAME);
    const withProfile = currentKeymap();
    expect(withProfile).not.toBe(before);
    // Same names, same `keyBindings` reference: the same compiled keymap.
    updateSetting('boldFont', !get(settings).boldFont);
    updateSetting('pagedGap', 10);
    expect(currentKeymap()).toBe(withProfile);
    // A new bindings object does recompile.
    updateSetting('keyBindings', { 'set.bold.toggle': ['KeyB'] });
    expect(currentKeymap()).not.toBe(withProfile);
    expect(currentKeymap().chords.get('set.bold.toggle')).toEqual(['KeyB']);
    updateSetting('keyBindings', {});
    updateSetting('boldFont', false);
    updateSetting('pagedGap', 0);
  });
});
