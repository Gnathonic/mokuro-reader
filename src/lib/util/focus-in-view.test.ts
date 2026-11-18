import { afterEach, describe, expect, it } from 'vitest';
import { focusFirstInView } from './focus-in-view';

// jsdom has no layout: give each element the box a scrolled dialog would.
function box(el: Element, top: number, height = 20) {
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, left: 0, right: 100, width: 100, height }) as DOMRect;
}

function dialog() {
  const dlg = document.createElement('div');
  dlg.tabIndex = -1;
  box(dlg, 0, 500);
  dlg.innerHTML = `
    <input id="top" />
    <button id="hidden-btn" disabled></button>
    <span id="text">label</span>
    <button id="visible-btn"></button>
    <input id="range" type="range" />`;
  document.body.appendChild(dlg);
  // Scrolled down: the first input is above the view.
  box(dlg.querySelector('#top')!, -400);
  box(dlg.querySelector('#hidden-btn')!, 100);
  box(dlg.querySelector('#text')!, 90);
  box(dlg.querySelector('#visible-btn')!, 120);
  box(dlg.querySelector('#range')!, 200);
  return dlg;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('focusFirstInView (#363)', () => {
  it('moves off-screen focus to the first enabled control in view, without scrolling', () => {
    const dlg = dialog();
    const top = dlg.querySelector<HTMLElement>('#top')!;
    top.focus();
    let scrollOption: FocusOptions | undefined;
    const target = dlg.querySelector<HTMLElement>('#visible-btn')!;
    const focus = target.focus.bind(target);
    target.focus = (opts?: FocusOptions) => {
      scrollOption = opts;
      focus(opts);
    };
    expect(focusFirstInView(dlg)).toBe(target);
    expect(document.activeElement).toBe(target);
    expect(scrollOption).toEqual({ preventScroll: true });
  });

  it('moves focus off the container itself', () => {
    const dlg = dialog();
    dlg.focus();
    expect(focusFirstInView(dlg)?.id).toBe('visible-btn');
  });

  it('leaves focus that is already in view', () => {
    const dlg = dialog();
    const range = dlg.querySelector<HTMLElement>('#range')!;
    range.focus();
    expect(focusFirstInView(dlg)).toBeNull();
    expect(document.activeElement).toBe(range);
  });

  it('leaves focus that has moved outside the container', () => {
    const dlg = dialog();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(focusFirstInView(dlg)).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it('does nothing when no control is in view', () => {
    const dlg = dialog();
    for (const id of ['#visible-btn', '#range']) box(dlg.querySelector(id)!, 900);
    const top = dlg.querySelector<HTMLElement>('#top')!;
    top.focus();
    expect(focusFirstInView(dlg)).toBeNull();
    expect(document.activeElement).toBe(top);
  });
});
