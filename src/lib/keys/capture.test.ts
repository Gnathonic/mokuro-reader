import { describe, expect, it } from 'vitest';
import type { KeyActionDef } from './actions';
import { assessCapture as assessOver, shadowNote } from './capture';
import type { KeyBindings } from './keymap';
import { actionDef, allActions } from './registry';
import { BROWSER_ACTION_WARNING, SCAN_MODIFIER_WARNING } from './reserved';

const assessCapture = (action: KeyActionDef, chord: string, bindings: KeyBindings) =>
  assessOver(action, chord, bindings, allActions());

describe('assessCapture', () => {
  const right = actionDef('reader.page-right');

  it('accepts a free key (the #55 case: D for Page right)', () => {
    expect(assessCapture(right, 'KeyD', {})).toEqual({ kind: 'ok', notes: [], warnings: [] });
  });

  it.each([
    ['CapsLock'],
    ['NumLock'],
    ['ScrollLock'],
    ['ContextMenu'],
    ['Tab'],
    ['Shift+Tab'],
    ['Escape'],
    ['Ctrl+KeyW'],
    ['Meta+KeyT'],
    ['Ctrl+Shift+KeyN'],
    ['Meta+KeyQ'],
    ['Ctrl+Tab'],
    ['Ctrl+PageUp'],
    ['Meta+PageDown'],
    ['F11'],
    ['Alt+F4']
  ])('refuses %s', (chord) => {
    expect(assessCapture(right, chord, {}).kind).toBe('refused');
  });

  it('warns about Shift/Alt chords and browser actions, but allows them', () => {
    expect(assessCapture(right, 'Shift+KeyD', {})).toMatchObject({
      kind: 'ok',
      warnings: [SCAN_MODIFIER_WARNING]
    });
    for (const chord of ['Ctrl+KeyC', 'Meta+KeyF', 'F5', 'Alt+ArrowLeft']) {
      const v = assessCapture(right, chord, {});
      expect(v.kind, chord).toBe('ok');
      if (v.kind === 'ok') expect(v.warnings, chord).toContain(BROWSER_ACTION_WARNING);
    }
  });

  it('reports a same-scope conflict with the actions holding the chord', () => {
    expect(assessCapture(right, 'ArrowDown', {})).toEqual({
      kind: 'conflict',
      others: ['reader.scroll-down'],
      notes: [],
      warnings: []
    });
    // Back is live everywhere.
    expect(assessCapture(right, 'Escape', {}).kind).toBe('refused');
    expect(assessCapture(actionDef('app.back'), 'KeyF', {})).toMatchObject({
      kind: 'conflict',
      others: ['reader.fullscreen']
    });
  });

  it('no conflict across modes or scopes that never meet', () => {
    // Scroll left lives in vertical only; Page left in paged and horizontal.
    expect(
      assessCapture(actionDef('reader.scroll-left'), 'KeyA', {
        'reader.page-left': ['KeyA']
      }).kind
    ).toBe('ok');
    // E edits OCR in the reader and the series in the library.
    expect(assessCapture(actionDef('library.volume-edit'), 'KeyT', {}).kind).toBe('ok');
  });

  it('a cross-scope overlap with edit mode is a note', () => {
    const v = assessCapture(actionDef('reader.night'), 'Backspace', {});
    expect(v.kind).toBe('ok');
    if (v.kind === 'ok') {
      expect(v.notes).toEqual([
        'In edit mode, this key is “Delete selected boxes” before “Night mode”.'
      ]);
    }
  });

  it('the note names whichever scope is tried first, beyond edit mode', () => {
    const onPage: KeyActionDef = { ...actionDef('app.back'), id: 'series.edit', scope: 'series' };
    const page = { ...onPage, label: 'Edit series (page)', locked: undefined };
    const row = actionDef('library.volume-edit');
    const text =
      'While a volume is under the pointer, this key is “Edit volume” before “Edit series (page)”.';
    expect(shadowNote(page, row)).toBe(text);
    expect(shadowNote(row, page)).toBe(text);
    // Capturing E for the page action: a note about the row, not a prompt.
    const v = assessOver(page, 'KeyE', {}, [...allActions(), page]);
    expect(v).toEqual({ kind: 'ok', notes: [text], warnings: [] });
  });

  it('sees a generated action that already holds the chord', () => {
    const bold = actionDef('set.bold.toggle');
    expect(assessCapture(bold, 'KeyF', {})).toMatchObject({
      kind: 'conflict',
      others: ['reader.fullscreen']
    });
    expect(
      assessCapture(actionDef('reader.fullscreen'), 'KeyB', { 'set.bold.toggle': ['KeyB'] })
    ).toMatchObject({ kind: 'conflict', others: ['set.bold.toggle'] });
  });

  it('a chord already on the action is a duplicate', () => {
    expect(assessCapture(right, 'ArrowRight', {}).kind).toBe('duplicate');
  });

  it('caps an action at 4 chords', () => {
    expect(assessCapture(actionDef('edit.redo'), 'Alt+KeyR', {}).kind).toBe('full');
    expect(
      assessCapture(right, 'KeyK', { 'reader.page-right': ['KeyD', 'KeyH', 'KeyJ', 'KeyL'] }).kind
    ).toBe('full');
  });
});
