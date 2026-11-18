import { describe, it, expect } from 'vitest';
import { isTypingTarget } from './series-editor-shortcut';

function elementWithTag(tag: string, contentEditable = false): Element {
  const el = document.createElement(tag);
  if (contentEditable) {
    // jsdom's isContentEditable getter only returns true when contentEditable is
    // actually settable/inherited; force it directly since we only need the flag read.
    Object.defineProperty(el, 'isContentEditable', { value: true });
  }
  return el;
}

describe('isTypingTarget', () => {
  it('is true for inputs, textareas, selects and contentEditable elements', () => {
    expect(isTypingTarget(elementWithTag('input'))).toBe(true);
    expect(isTypingTarget(elementWithTag('textarea'))).toBe(true);
    expect(isTypingTarget(elementWithTag('select'))).toBe(true);
    expect(isTypingTarget(elementWithTag('div', true))).toBe(true);
  });

  it('is false for anything else, and for no focus at all', () => {
    expect(isTypingTarget(elementWithTag('div'))).toBe(false);
    expect(isTypingTarget(elementWithTag('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
