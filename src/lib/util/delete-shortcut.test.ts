import { describe, it, expect, afterEach } from 'vitest';
import { anyModalOpen, shouldTriggerDelete } from './delete-shortcut';

function keyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: 'Delete',
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  } as KeyboardEvent;
}

function elementWithTag(tag: string, contentEditable = false): Element {
  const el = document.createElement(tag);
  if (contentEditable) {
    Object.defineProperty(el, 'isContentEditable', { value: true });
  }
  return el;
}

describe('shouldTriggerDelete', () => {
  it('is true when hovered, key is Delete, no repeat, no modal, focus outside a field', () => {
    expect(shouldTriggerDelete(keyEvent(), true, null, false)).toBe(true);
  });

  it('is false when not hovered', () => {
    expect(shouldTriggerDelete(keyEvent(), false, null, false)).toBe(false);
  });

  it('is false for any other key', () => {
    expect(shouldTriggerDelete(keyEvent({ key: 'Backspace' }), true, null, false)).toBe(false);
    expect(shouldTriggerDelete(keyEvent({ key: 'd' }), true, null, false)).toBe(false);
  });

  it('ignores auto-repeat, so holding the key cannot stack dialogs', () => {
    expect(shouldTriggerDelete(keyEvent({ repeat: true }), true, null, false)).toBe(false);
  });

  it('is false while a modal is already open', () => {
    expect(shouldTriggerDelete(keyEvent(), true, null, true)).toBe(false);
  });

  it('is false when ctrl, meta or alt is held', () => {
    expect(shouldTriggerDelete(keyEvent({ ctrlKey: true }), true, null, false)).toBe(false);
    expect(shouldTriggerDelete(keyEvent({ metaKey: true }), true, null, false)).toBe(false);
    expect(shouldTriggerDelete(keyEvent({ altKey: true }), true, null, false)).toBe(false);
  });

  it('leaves shift to the caller (a volume reads it as "cloud copy only")', () => {
    expect(shouldTriggerDelete(keyEvent({ shiftKey: true }), true, null, false)).toBe(true);
  });

  it('is false while a text field has focus', () => {
    expect(shouldTriggerDelete(keyEvent(), true, elementWithTag('input'), false)).toBe(false);
    expect(shouldTriggerDelete(keyEvent(), true, elementWithTag('textarea'), false)).toBe(false);
    expect(shouldTriggerDelete(keyEvent(), true, elementWithTag('select'), false)).toBe(false);
    expect(shouldTriggerDelete(keyEvent(), true, elementWithTag('div', true), false)).toBe(false);
  });

  it('is true when focus is on a non-typing element', () => {
    expect(shouldTriggerDelete(keyEvent(), true, elementWithTag('div'), false)).toBe(true);
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
