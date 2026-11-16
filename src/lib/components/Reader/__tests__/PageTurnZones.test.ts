import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';

const store = vi.hoisted(() => ({ current: undefined as any }));

vi.mock('#lib/settings/index.js', async () => {
  const { writable } = await import('svelte/store');
  store.current = writable<Record<string, unknown>>({
    tapOutsideImageToTurn: true,
    edgeButtonWidth: 40
  });
  return { settings: store.current };
});

import PageTurnZones from '../PageTurnZones.svelte';

const BACKGROUND = [
  'Previous page (left background)',
  'Next page (right background)',
  'Previous page (below, left)',
  'Next page (below, right)'
];
const PAGE_EDGE = ['Previous page (left page edge)', 'Next page (right page edge)'];

function setup(
  variant: 'viewport' | 'screen',
  settings: Record<string, unknown>,
  overPage = (_x: number, _y: number) => true
) {
  store.current.set(settings);
  const onPress = vi.fn();
  const onLeft = vi.fn();
  const onRight = vi.fn();
  const result = render(PageTurnZones, { variant, onPress, onLeft, onRight, overPage });
  return { ...result, onPress, onLeft, onRight };
}

const labels = (els: HTMLElement[]) => els.map((b) => b.getAttribute('aria-label'));

afterEach(() => cleanup());

describe('PageTurnZones — one region, one control (#54)', () => {
  it('both on: the background zones and the page-edge strips', () => {
    const { getAllByRole } = setup('viewport', {
      tapOutsideImageToTurn: true,
      edgeButtonWidth: 40
    });
    expect(labels(getAllByRole('button'))).toEqual([...BACKGROUND, ...PAGE_EDGE]);
  });

  it('the background zones are flush with the page: no reach onto it', () => {
    const { getAllByRole } = setup('viewport', {
      tapOutsideImageToTurn: true,
      edgeButtonWidth: 40
    });
    const [left, right] = getAllByRole('button');
    expect(left.className).toContain('-left-full');
    expect(left.className).toContain('w-full');
    expect(right.className).toContain('-right-full');
    for (const b of getAllByRole('button').slice(0, 4)) {
      expect(b.style.marginLeft).toBe('');
      expect(b.style.marginRight).toBe('');
      expect(b.style.width).toBe('');
    }
  });

  it('the page-edge strips sit ON the page, edgeButtonWidth wide', () => {
    const { getByLabelText } = setup('viewport', {
      tapOutsideImageToTurn: false,
      edgeButtonWidth: 23
    });
    const left = getByLabelText('Previous page (left page edge)');
    const right = getByLabelText('Next page (right page edge)');
    expect(left.className).toMatch(/(^| )left-0( |$)/);
    expect(right.className).toMatch(/(^| )right-0( |$)/);
    expect([left.style.width, right.style.width]).toEqual(['23px', '23px']);
  });

  it('slider at 0: no page-edge strips; the background still turns', async () => {
    const { getAllByRole, onLeft, onRight } = setup('viewport', {
      tapOutsideImageToTurn: true,
      edgeButtonWidth: 0
    });
    const buttons = getAllByRole('button');
    expect(labels(buttons)).toEqual(BACKGROUND);
    for (const b of buttons) await fireEvent.mouseUp(b);
    expect(onLeft).toHaveBeenCalledTimes(2);
    expect(onRight).toHaveBeenCalledTimes(2);
  });

  it('toggle off: the background is inert, the page edges still turn', async () => {
    const { getAllByRole, container, onPress, onLeft, onRight } = setup('viewport', {
      tapOutsideImageToTurn: false,
      edgeButtonWidth: 40
    });
    expect(labels(getAllByRole('button'))).toEqual(PAGE_EDGE);
    const zones = [...container.querySelectorAll<HTMLElement>('[data-page-turn-zone]')];
    expect(zones.map((z) => z.className)).toEqual([
      'fixed -left-full z-10 h-full w-full',
      'fixed -right-full z-10 h-full w-full',
      'fixed top-full -left-full z-10 h-screen w-[150%]',
      'fixed top-full -right-full z-10 h-screen w-[150%]'
    ]);
    for (const z of zones) {
      expect(z.getAttribute('aria-hidden')).toBe('true');
      await fireEvent.mouseDown(z);
      await fireEvent.mouseUp(z);
    }
    expect(onPress).not.toHaveBeenCalled();
    expect(onLeft).not.toHaveBeenCalled();
    expect(onRight).not.toHaveBeenCalled();

    const [edgeLeft, edgeRight] = getAllByRole('button');
    await fireEvent.mouseDown(edgeLeft);
    await fireEvent.mouseUp(edgeLeft);
    await fireEvent.mouseUp(edgeRight);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onLeft).toHaveBeenCalledTimes(1);
    expect(onRight).toHaveBeenCalledTimes(1);
  });

  it('both off: nothing turns, the background zones stay inert', () => {
    const { queryAllByRole, container } = setup('viewport', {
      tapOutsideImageToTurn: false,
      edgeButtonWidth: 0
    });
    expect(queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelectorAll('[data-page-turn-zone]')).toHaveLength(4);
  });

  it.each([
    [true, 'button'],
    [false, '[data-page-turn-zone]']
  ])(
    'background gestures bubble to the viewport wrapper (toggle %s)',
    (on: boolean, selector: string) => {
      // PagedViewport's gesture tracker, wheel listener and touch-action live
      // on its wrapper; the zones are what carry the margins inside it.
      store.current.set({ tapOutsideImageToTurn: on, edgeButtonWidth: 0 });
      const wrapper = document.createElement('div');
      document.body.appendChild(wrapper);
      render(PageTurnZones, {
        target: wrapper,
        props: { variant: 'viewport', onPress: vi.fn(), onLeft: vi.fn(), onRight: vi.fn() }
      });
      const types = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'touchstart'];
      const seen: string[] = [];
      for (const type of types) wrapper.addEventListener(type, () => seen.push(type));
      const zones = wrapper.querySelectorAll(selector);
      expect(zones).toHaveLength(4);
      for (const z of zones) {
        for (const type of types) z.dispatchEvent(new Event(type, { bubbles: true }));
      }
      expect(seen).toHaveLength(20);
      wrapper.remove();
    }
  );

  it('reacts to both settings changing while mounted', async () => {
    const { queryAllByRole, container } = setup('viewport', {
      tapOutsideImageToTurn: true,
      edgeButtonWidth: 40
    });
    expect(queryAllByRole('button')).toHaveLength(6);
    store.current.set({ tapOutsideImageToTurn: false, edgeButtonWidth: 40 });
    await Promise.resolve();
    expect(labels(queryAllByRole('button'))).toEqual(PAGE_EDGE);
    store.current.set({ tapOutsideImageToTurn: false, edgeButtonWidth: 0 });
    await Promise.resolve();
    expect(queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelectorAll('[data-page-turn-zone]')).toHaveLength(4);
  });
});

describe('PageTurnZones — desktop screen-edge strips', () => {
  it('are the page-edge control: edgeButtonWidth wide, gone at 0', () => {
    const a = setup('screen', { tapOutsideImageToTurn: true, edgeButtonWidth: 23 });
    const buttons = a.getAllByRole('button');
    expect(labels(buttons)).toEqual([
      'Previous page (left screen edge)',
      'Next page (right screen edge)'
    ]);
    expect(buttons.map((b) => b.style.width)).toEqual(['23px', '23px']);
    cleanup();
    const b = setup('screen', { tapOutsideImageToTurn: true, edgeButtonWidth: 0 });
    expect(b.queryAllByRole('button')).toHaveLength(0);
  });

  it('over the page they turn whatever the background toggle says', async () => {
    const { getAllByRole, onLeft, onRight } = setup(
      'screen',
      { tapOutsideImageToTurn: false, edgeButtonWidth: 40 },
      () => true
    );
    const [left, right] = getAllByRole('button');
    await fireEvent.mouseUp(left, { clientX: 3, clientY: 500 });
    await fireEvent.mouseUp(right, { clientX: 1916, clientY: 500 });
    expect(onLeft).toHaveBeenCalledTimes(1);
    expect(onRight).toHaveBeenCalledTimes(1);
  });

  it('over the background they follow the background toggle', async () => {
    const hits: Array<[number, number]> = [];
    const off = setup('screen', { tapOutsideImageToTurn: false, edgeButtonWidth: 40 }, (x, y) => {
      hits.push([x, y]);
      return false;
    });
    const [left, right] = off.getAllByRole('button');
    await fireEvent.mouseUp(left, { clientX: 3, clientY: 500 });
    await fireEvent.mouseUp(right, { clientX: 1916, clientY: 400 });
    expect(off.onLeft).not.toHaveBeenCalled();
    expect(off.onRight).not.toHaveBeenCalled();
    // Hit-tested at the release point.
    expect(hits).toEqual([
      [3, 500],
      [1916, 400]
    ]);
    cleanup();

    const on = setup('screen', { tapOutsideImageToTurn: true, edgeButtonWidth: 40 }, () => false);
    const [l2, r2] = on.getAllByRole('button');
    await fireEvent.mouseUp(l2);
    await fireEvent.mouseUp(r2);
    expect(on.onLeft).toHaveBeenCalledTimes(1);
    expect(on.onRight).toHaveBeenCalledTimes(1);
  });
});
