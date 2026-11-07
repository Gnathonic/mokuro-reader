import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';

const store = vi.hoisted(() => ({ current: undefined as any }));

vi.mock('$lib/settings', async () => {
  const { writable } = await import('svelte/store');
  store.current = writable<Record<string, unknown>>({
    tapPageEdgesToTurn: true,
    edgeButtonWidth: 40
  });
  return { settings: store.current };
});

import PageTurnZones from '../PageTurnZones.svelte';

function setup(variant: 'viewport' | 'screen') {
  const onPress = vi.fn();
  const onLeft = vi.fn();
  const onRight = vi.fn();
  const result = render(PageTurnZones, { variant, onPress, onLeft, onRight });
  return { ...result, onPress, onLeft, onRight };
}

afterEach(() => {
  cleanup();
  store.current.set({ tapPageEdgesToTurn: true, edgeButtonWidth: 40 });
});

describe('PageTurnZones', () => {
  it('renders the four viewport zones when tapping page edges is on', () => {
    const { getAllByRole } = setup('viewport');
    expect(getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Previous page (left edge)',
      'Next page (right edge)',
      'Previous page (bottom left)',
      'Next page (bottom right)'
    ]);
  });

  it('renders the two screen-edge zones, sized by edgeButtonWidth', () => {
    store.current.set({ tapPageEdgesToTurn: true, edgeButtonWidth: 23 });
    const { getAllByRole } = setup('screen');
    const buttons = getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => (b as HTMLElement).style.width)).toEqual(['23px', '23px']);
  });

  it('turns the page on mouseup in each zone when on', async () => {
    const { getAllByRole, onPress, onLeft, onRight } = setup('viewport');
    const [left, right, bottomLeft, bottomRight] = getAllByRole('button');
    await fireEvent.mouseDown(left);
    expect(onPress).toHaveBeenCalledTimes(1);
    await fireEvent.mouseUp(left);
    await fireEvent.mouseUp(bottomLeft);
    expect(onLeft).toHaveBeenCalledTimes(2);
    await fireEvent.mouseUp(right);
    await fireEvent.mouseUp(bottomRight);
    expect(onRight).toHaveBeenCalledTimes(2);
  });

  it('renders no screen-edge strips when it is off', () => {
    store.current.set({ tapPageEdgesToTurn: false, edgeButtonWidth: 40 });
    const { container } = setup('screen');
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[data-page-turn-zone]')).toBeNull();
  });

  it('keeps the four viewport margins as inert, handler-less zones when it is off', async () => {
    store.current.set({ tapPageEdgesToTurn: false, edgeButtonWidth: 40 });
    const { queryAllByRole, container, onPress, onLeft, onRight } = setup('viewport');
    expect(queryAllByRole('button')).toHaveLength(0);
    const zones = [...container.querySelectorAll<HTMLElement>('[data-page-turn-zone]')];
    expect(zones).toHaveLength(4);
    // Same margin geometry as the buttons, minus the reach onto the page.
    expect(zones.map((z) => z.className)).toEqual([
      'fixed -left-full z-10 h-full w-full',
      'fixed -right-full z-10 h-full w-full',
      'fixed top-full -left-full z-10 h-screen w-[150%]',
      'fixed top-full -right-full z-10 h-screen w-[150%]'
    ]);
    for (const z of zones) {
      expect(z.getAttribute('aria-hidden')).toBe('true');
      expect(z.style.marginLeft).toBe('');
      expect(z.style.marginRight).toBe('');
      await fireEvent.mouseDown(z);
      await fireEvent.mouseUp(z);
    }
    expect(onPress).not.toHaveBeenCalled();
    expect(onLeft).not.toHaveBeenCalled();
    expect(onRight).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'lets margin gestures bubble to the viewport wrapper (tapPageEdgesToTurn=%s)',
    (on) => {
      // PagedViewport's gesture tracker, wheel listener and touch-action live
      // on its wrapper; the zones are what carry the margins inside it.
      store.current.set({ tapPageEdgesToTurn: on, edgeButtonWidth: 40 });
      const wrapper = document.createElement('div');
      document.body.appendChild(wrapper);
      render(PageTurnZones, {
        target: wrapper,
        props: { variant: 'viewport', onPress: vi.fn(), onLeft: vi.fn(), onRight: vi.fn() }
      });
      const seen: string[] = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'touchstart']) {
        wrapper.addEventListener(type, () => seen.push(type));
      }
      const zones = wrapper.querySelectorAll(on ? 'button' : '[data-page-turn-zone]');
      expect(zones).toHaveLength(4);
      for (const z of zones) {
        z.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        z.dispatchEvent(new Event('pointermove', { bubbles: true }));
        z.dispatchEvent(new Event('pointerup', { bubbles: true }));
        z.dispatchEvent(new Event('wheel', { bubbles: true }));
        z.dispatchEvent(new Event('touchstart', { bubbles: true }));
      }
      expect(seen).toHaveLength(20);
      wrapper.remove();
    }
  );

  it('reacts to the setting changing while mounted', async () => {
    const { queryAllByRole } = setup('screen');
    expect(queryAllByRole('button')).toHaveLength(2);
    store.current.update((s: Record<string, unknown>) => ({ ...s, tapPageEdgesToTurn: false }));
    await Promise.resolve();
    expect(queryAllByRole('button')).toHaveLength(0);
  });

  it('treats a missing key as on', () => {
    store.current.set({ edgeButtonWidth: 40 });
    const { queryAllByRole } = setup('screen');
    expect(queryAllByRole('button')).toHaveLength(2);
  });
});
