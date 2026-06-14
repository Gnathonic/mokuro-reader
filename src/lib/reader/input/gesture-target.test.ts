// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { gestureTargetRole, keyboardShouldIgnore } from './gesture-target';

function el(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.querySelector('[data-probe]') as HTMLElement;
}

describe('gestureTargetRole', () => {
  it('classifies text boxes — including descendants (extension-injected spans)', () => {
    expect(gestureTargetRole(el('<div class="textBox" data-probe></div>'))).toBe('textbox');
    expect(
      gestureTargetRole(el('<div class="textBox"><p><span data-probe>言葉</span></p></div>'))
    ).toBe('textbox');
  });

  it('classifies interactive chrome', () => {
    expect(gestureTargetRole(el('<button data-probe></button>'))).toBe('interactive');
    expect(gestureTargetRole(el('<div role="button" data-probe></div>'))).toBe('interactive');
    expect(gestureTargetRole(el('<a href="#" data-probe>x</a>'))).toBe('interactive');
    expect(gestureTargetRole(el('<button><svg data-probe></svg></button>'))).toBe('interactive');
  });

  it('textbox wins over interactive when nested (Anki controls inside a box)', () => {
    expect(gestureTargetRole(el('<div class="textBox"><button data-probe></button></div>'))).toBe(
      'textbox'
    );
  });

  it('defaults to page', () => {
    expect(gestureTargetRole(el('<div data-probe></div>'))).toBe('page');
    expect(gestureTargetRole(null)).toBe('page');
    expect(gestureTargetRole(document)).toBe('page'); // non-Element targets
  });
});

describe('keyboardShouldIgnore', () => {
  it('ignores form fields and editable content', () => {
    expect(keyboardShouldIgnore(el('<input data-probe />'))).toBe(true);
    expect(keyboardShouldIgnore(el('<textarea data-probe></textarea>'))).toBe(true);
    expect(keyboardShouldIgnore(el('<select data-probe></select>'))).toBe(true);
    const ce = el('<div contenteditable="true" data-probe></div>');
    Object.defineProperty(ce, 'isContentEditable', { value: true });
    expect(keyboardShouldIgnore(ce)).toBe(true);
  });

  it('ignores text boxes and UI overlays', () => {
    expect(keyboardShouldIgnore(el('<div class="textBox"><span data-probe>x</span></div>'))).toBe(
      true
    );
    expect(keyboardShouldIgnore(el('<div id="settings"><div data-probe></div></div>'))).toBe(true);
    expect(keyboardShouldIgnore(el('<div data-popover><div data-probe></div></div>'))).toBe(true);
  });

  it('allows the page itself', () => {
    expect(keyboardShouldIgnore(el('<div data-probe></div>'))).toBe(false);
    expect(keyboardShouldIgnore(null)).toBe(false);
  });
});
