import { describe, it, expect, afterEach } from 'vitest';
import { anyModalOpen, shortcutAllowed } from './delete-shortcut';

function elementWithTag(tag: string, contentEditable = false): Element {
  const el = document.createElement(tag);
  if (contentEditable) {
    Object.defineProperty(el, 'isContentEditable', { value: true });
  }
  return el;
}

const onBody = { target: document.body } as Pick<KeyboardEvent, 'target'>;

describe('shortcutAllowed', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is true with focus outside a field', () => {
    expect(shortcutAllowed(onBody, null)).toBe(true);
    expect(shortcutAllowed(onBody, elementWithTag('div'))).toBe(true);
    expect(shortcutAllowed(onBody, elementWithTag('button'))).toBe(true);
  });

  it('is false while a text field has focus', () => {
    for (const el of [
      elementWithTag('input'),
      elementWithTag('textarea'),
      elementWithTag('select'),
      elementWithTag('div', true)
    ]) {
      expect(shortcutAllowed(onBody, el)).toBe(false);
    }
  });

  it('is false for a key pressed inside the settings panel or a popover', () => {
    document.body.innerHTML =
      '<div id="settings"><button id="a">x</button></div><div data-popover><button id="b">y</button></div>';
    const inSettings = { target: document.getElementById('a') } as Pick<KeyboardEvent, 'target'>;
    const inPopover = { target: document.getElementById('b') } as Pick<KeyboardEvent, 'target'>;
    expect(shortcutAllowed(inSettings, null)).toBe(false);
    expect(shortcutAllowed(inPopover, null)).toBe(false);
  });

  // "Hovered" and "no dialog open" are no longer this guard's: a card provides
  // its handlers only while hovered, and under a dialog only the dialog's own
  // scope is tried (`keys/providers.test.ts`).
});

describe('anyModalOpen', () => {
  afterEach(() => {
    document.querySelectorAll('dialog').forEach((el) => el.remove());
  });

  it('is false with nothing open', () => {
    expect(anyModalOpen()).toBe(false);
  });

  it('is true while any dialog is open — every modal in the app is one', () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.appendChild(dialog);
    expect(anyModalOpen()).toBe(true);
  });

  it('is false again once the dialog closes', () => {
    const dialog = document.createElement('dialog');
    document.body.appendChild(dialog);
    expect(anyModalOpen()).toBe(false);
  });
});
