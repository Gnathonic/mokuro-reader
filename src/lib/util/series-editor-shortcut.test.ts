import { describe, it, expect } from 'vitest';
import { shouldOpenSeriesEditor } from './series-editor-shortcut';

function keyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: 'e',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...overrides
  } as KeyboardEvent;
}

function elementWithTag(tag: string, contentEditable = false): Element {
  const el = document.createElement(tag);
  if (contentEditable) {
    // jsdom's isContentEditable getter only returns true when contentEditable is
    // actually settable/inherited; force it directly since we only need the flag read.
    Object.defineProperty(el, 'isContentEditable', { value: true });
  }
  return el;
}

describe('shouldOpenSeriesEditor', () => {
  it('is true when hovered, key is "e", no modifiers, and focus is not on a typing target', () => {
    expect(shouldOpenSeriesEditor(keyEvent(), true, null)).toBe(true);
  });

  it('is false when not hovered', () => {
    expect(shouldOpenSeriesEditor(keyEvent(), false, null)).toBe(false);
  });

  it('is false for any key other than "e"', () => {
    expect(shouldOpenSeriesEditor(keyEvent({ key: 'E' }), true, null)).toBe(false);
    expect(shouldOpenSeriesEditor(keyEvent({ key: 'Enter' }), true, null)).toBe(false);
    expect(shouldOpenSeriesEditor(keyEvent({ key: 'a' }), true, null)).toBe(false);
  });

  it('is false when ctrl, meta, or alt is held', () => {
    expect(shouldOpenSeriesEditor(keyEvent({ ctrlKey: true }), true, null)).toBe(false);
    expect(shouldOpenSeriesEditor(keyEvent({ metaKey: true }), true, null)).toBe(false);
    expect(shouldOpenSeriesEditor(keyEvent({ altKey: true }), true, null)).toBe(false);
  });

  it('is false when focus is on an input, textarea, select, or contentEditable element', () => {
    expect(shouldOpenSeriesEditor(keyEvent(), true, elementWithTag('input'))).toBe(false);
    expect(shouldOpenSeriesEditor(keyEvent(), true, elementWithTag('textarea'))).toBe(false);
    expect(shouldOpenSeriesEditor(keyEvent(), true, elementWithTag('select'))).toBe(false);
    expect(shouldOpenSeriesEditor(keyEvent(), true, elementWithTag('div', true))).toBe(false);
  });

  it('is true when focus is on a non-typing element, e.g. the card itself', () => {
    expect(shouldOpenSeriesEditor(keyEvent(), true, elementWithTag('div'))).toBe(true);
    expect(shouldOpenSeriesEditor(keyEvent(), true, elementWithTag('body'))).toBe(true);
  });

  it('shift is allowed (not treated as a modifier that blocks the shortcut)', () => {
    expect(shouldOpenSeriesEditor(keyEvent({ shiftKey: true } as any), true, null)).toBe(true);
  });
});
