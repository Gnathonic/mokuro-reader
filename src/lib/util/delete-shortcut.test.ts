import { describe, it, expect, afterEach } from 'vitest';
import { anyModalOpen, libraryShortcutAllowed } from './delete-shortcut';

function elementWithTag(tag: string, contentEditable = false): Element {
  const el = document.createElement(tag);
  if (contentEditable) {
    Object.defineProperty(el, 'isContentEditable', { value: true });
  }
  return el;
}

const onBody = { target: document.body } as Pick<KeyboardEvent, 'target'>;

describe('libraryShortcutAllowed', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is true when hovered, no modal, focus outside a field', () => {
    expect(libraryShortcutAllowed(onBody, true, null, false)).toBe(true);
    expect(libraryShortcutAllowed(onBody, true, elementWithTag('div'), false)).toBe(true);
  });

  it('is false when not hovered', () => {
    expect(libraryShortcutAllowed(onBody, false, null, false)).toBe(false);
  });

  it('is false while a modal is already open (no stacked dialogs)', () => {
    expect(libraryShortcutAllowed(onBody, true, null, true)).toBe(false);
  });

  it('is false while a text field has focus', () => {
    for (const el of [
      elementWithTag('input'),
      elementWithTag('textarea'),
      elementWithTag('select'),
      elementWithTag('div', true)
    ]) {
      expect(libraryShortcutAllowed(onBody, true, el, false)).toBe(false);
    }
  });

  it('is false for a key pressed inside the settings panel or a popover', () => {
    document.body.innerHTML =
      '<div id="settings"><button id="a">x</button></div><div data-popover><button id="b">y</button></div>';
    const inSettings = { target: document.getElementById('a') } as Pick<KeyboardEvent, 'target'>;
    const inPopover = { target: document.getElementById('b') } as Pick<KeyboardEvent, 'target'>;
    expect(libraryShortcutAllowed(inSettings, true, null, false)).toBe(false);
    expect(libraryShortcutAllowed(inPopover, true, null, false)).toBe(false);
  });
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
