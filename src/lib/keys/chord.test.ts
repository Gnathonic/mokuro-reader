import { describe, expect, it } from 'vitest';
import {
  chordFromEvent,
  formatChord,
  keyFromEvent,
  normalizeChord,
  parseChord,
  usKeyLabel
} from './chord';

function ev(over: Partial<KeyboardEvent> = {}) {
  return {
    code: 'KeyA',
    key: 'a',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 65,
    ...over
  } as KeyboardEvent;
}

describe('chordFromEvent', () => {
  it('is the code alone without modifiers', () => {
    expect(chordFromEvent(ev())).toBe('KeyA');
  });

  it('puts modifiers in the canonical order Ctrl, Alt, Shift, Meta', () => {
    expect(chordFromEvent(ev({ metaKey: true, shiftKey: true, altKey: true, ctrlKey: true }))).toBe(
      'Ctrl+Alt+Shift+Meta+KeyA'
    );
    expect(chordFromEvent(ev({ code: 'KeyZ', key: 'Z', shiftKey: true, ctrlKey: true }))).toBe(
      'Ctrl+Shift+KeyZ'
    );
  });

  it('matches by position: a Cyrillic layout still gives KeyF', () => {
    expect(chordFromEvent(ev({ code: 'KeyF', key: 'а' }))).toBe('KeyF');
  });

  it('falls back to e.key when the event has no code', () => {
    expect(chordFromEvent(ev({ code: '', key: 'd' }))).toBe('KeyD');
    expect(chordFromEvent(ev({ code: '', key: ' ' }))).toBe('Space');
    expect(chordFromEvent(ev({ code: '', key: '7' }))).toBe('Digit7');
    expect(chordFromEvent(ev({ code: '', key: 'ArrowLeft' }))).toBe('ArrowLeft');
    expect(chordFromEvent(ev({ code: '', key: 'Esc' }))).toBe('Escape');
    expect(chordFromEvent(ev({ code: '', key: ',' }))).toBe('Comma');
    expect(chordFromEvent(ev({ code: '', key: 'ж' }))).toBeNull();
  });

  it('counts a Numpad key with NumLock off as the navigation key it sends', () => {
    expect(chordFromEvent(ev({ code: 'Numpad4', key: 'ArrowLeft' }))).toBe('ArrowLeft');
    expect(chordFromEvent(ev({ code: 'Numpad9', key: 'PageUp' }))).toBe('PageUp');
    // NumLock on: the digit, by position.
    expect(chordFromEvent(ev({ code: 'Numpad4', key: '4' }))).toBe('Numpad4');
  });

  it('drops bare modifiers, IME composition and keyCode 229', () => {
    expect(chordFromEvent(ev({ code: 'ShiftLeft', key: 'Shift', shiftKey: true }))).toBeNull();
    expect(chordFromEvent(ev({ code: 'ControlRight', key: 'Control' }))).toBeNull();
    expect(chordFromEvent(ev({ code: 'AltRight', key: 'AltGraph' }))).toBeNull();
    expect(chordFromEvent(ev({ isComposing: true }))).toBeNull();
    expect(chordFromEvent(ev({ keyCode: 229 }))).toBeNull();
  });
});

describe('keyFromEvent', () => {
  it('ignores an Unidentified code', () => {
    expect(keyFromEvent({ code: 'Unidentified', key: 'x' })).toBe('KeyX');
  });
});

describe('parseChord / normalizeChord', () => {
  it('round-trips canonical chords', () => {
    for (const c of ['KeyA', 'Shift+Space', 'Ctrl+Shift+KeyZ', 'ArrowLeft', 'Shift+Meta+KeyZ']) {
      expect(normalizeChord(c)).toBe(c);
    }
  });

  it('canonicalises a hand-edited modifier order', () => {
    expect(normalizeChord('Meta+Shift+KeyZ')).toBe('Shift+Meta+KeyZ');
    expect(normalizeChord('Shift+Ctrl+KeyA')).toBe('Ctrl+Shift+KeyA');
  });

  it('rejects what it cannot read', () => {
    for (const c of [
      '',
      'Ctrl+',
      'Ctrl+Ctrl+KeyA',
      'Hyper+KeyA',
      'Shift',
      'Ctrl+Shift',
      'a b',
      7
    ]) {
      expect(parseChord(c)).toBeNull();
    }
    expect(parseChord('x'.repeat(41))).toBeNull();
  });
});

describe('formatChord', () => {
  it('uses arrows, Esc and US names by default', () => {
    expect(formatChord('ArrowLeft')).toBe('←');
    expect(formatChord('Escape')).toBe('Esc');
    expect(formatChord('Ctrl+Shift+KeyZ')).toBe('Ctrl+Shift+Z');
    expect(formatChord('Digit1')).toBe('1');
    expect(formatChord('Slash')).toBe('/');
  });

  it('says Cmd and Option on Apple platforms', () => {
    expect(formatChord('Alt+Meta+KeyY', { apple: true })).toBe('Option+Cmd+Y');
    expect(formatChord('Meta+KeyY')).toBe('Meta+Y');
  });

  it('takes the device glyph for layout keys only', () => {
    const labelFor = (code: string) => ({ KeyQ: 'A', ArrowLeft: 'nope' })[code];
    expect(formatChord('KeyQ', { labelFor })).toBe('A');
    expect(formatChord('ArrowLeft', { labelFor })).toBe('←');
    // Unknown to the device: the US name.
    expect(formatChord('KeyW', { labelFor })).toBe('W');
  });

  it('labels the numpad', () => {
    expect(usKeyLabel('NumpadAdd')).toBe('Num +');
    expect(usKeyLabel('Numpad5')).toBe('Num 5');
  });
});
