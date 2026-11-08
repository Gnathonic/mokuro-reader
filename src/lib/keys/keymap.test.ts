import { describe, expect, it } from 'vitest';
import { actionDef } from './actions';
import {
  addChord,
  chordRelation,
  compileKeymap,
  effectiveChords,
  findConflicts,
  isModified,
  lookup,
  removeChord,
  replaceChord,
  resetAction,
  sanitizeKeyBindings,
  withChords
} from './keymap';

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
    const next = replaceChord({}, actionDef('reader.fullscreen'), 'KeyN', ['reader.night']);
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

  it('caps a list at 8 strings of at most 40 chars', () => {
    const long = Array.from({ length: 12 }, (_, i) => `Digit${i % 10}`);
    expect(sanitizeKeyBindings({ a: long }).a).toHaveLength(8);
    expect(sanitizeKeyBindings({ a: ['x'.repeat(41), 7, 'KeyA'] }).a).toEqual(['KeyA']);
  });
});
