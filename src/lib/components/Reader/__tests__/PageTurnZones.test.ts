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

  it.each(['viewport', 'screen'] as const)('renders no %s zones when it is off', (variant) => {
    store.current.set({ tapPageEdgesToTurn: false, edgeButtonWidth: 40 });
    const { queryAllByRole, container } = setup(variant);
    expect(queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelector('button')).toBeNull();
  });

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
