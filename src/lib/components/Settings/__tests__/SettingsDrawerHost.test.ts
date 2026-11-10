import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('../Settings.svelte', async () => await import('./SettingsStub.svelte'));

import DrawerPair from './DrawerPair.svelte';
import { openSettings, settingsOpen } from '$lib/settings/settings-open';
import { currentView } from '$lib/util/hash-router';

const READER = { type: 'reader', seriesId: 's', volumeId: 'v' } as const;

function drawers(container: HTMLElement) {
  const state = (mount: string) =>
    container.querySelector(`[data-mount="${mount}"] [data-drawer]`)!.getAttribute('data-open');
  return { app: state('app'), reader: state('reader') };
}

beforeEach(() => {
  currentView.set({ type: 'catalog' });
  settingsOpen.set(false);
});
afterEach(() => cleanup());

describe('one settings-open flag, two drawer mounts', () => {
  it('both are closed until the store opens', async () => {
    const { container } = render(DrawerPair);
    expect(drawers(container)).toEqual({ app: 'no', reader: 'no' });
  });

  it('outside the reader, exactly the app’s drawer opens from the store', async () => {
    const { container } = render(DrawerPair);
    openSettings();
    await tick();
    expect(drawers(container)).toEqual({ app: 'yes', reader: 'no' });
  });

  it('in the reader, exactly the reader’s drawer opens from the store', async () => {
    currentView.set(READER);
    const { container } = render(DrawerPair);
    openSettings();
    await tick();
    expect(drawers(container)).toEqual({ app: 'no', reader: 'yes' });
  });

  it('the drawer’s own close clears the one flag', async () => {
    currentView.set(READER);
    const { container } = render(DrawerPair);
    openSettings();
    await tick();
    await fireEvent.click(container.querySelector('[data-mount="reader"] [data-close]')!);
    expect(get(settingsOpen)).toBe(false);
    expect(drawers(container)).toEqual({ app: 'no', reader: 'no' });
  });

  it('the mount that is not showing cannot speak for the flag', async () => {
    currentView.set(READER);
    const { container } = render(DrawerPair);
    openSettings();
    await tick();
    // The hidden (app) mount's own close path fires: the reader's drawer stays.
    await fireEvent.click(container.querySelector('[data-mount="app"] [data-close]')!);
    expect(get(settingsOpen)).toBe(true);
    expect(drawers(container)).toEqual({ app: 'no', reader: 'yes' });
  });

  it('leaving the reader with the drawer open does not re-open it in the library', async () => {
    currentView.set(READER);
    const { container } = render(DrawerPair);
    openSettings();
    await tick();
    currentView.set({ type: 'series', seriesId: 's' });
    await tick();
    expect(get(settingsOpen)).toBe(false);
    expect(drawers(container)).toEqual({ app: 'no', reader: 'no' });
  });

  it('entering the reader with the library’s drawer open closes it too', async () => {
    const { container } = render(DrawerPair);
    openSettings();
    await tick();
    currentView.set(READER);
    await tick();
    expect(get(settingsOpen)).toBe(false);
    expect(drawers(container)).toEqual({ app: 'no', reader: 'no' });
  });
});
