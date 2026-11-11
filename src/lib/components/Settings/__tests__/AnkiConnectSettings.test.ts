import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';

vi.mock('$app/environment', () => ({ browser: true }));

const h = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(value);
        return () => {
          subs.delete(fn);
        };
      },
      set(v: T) {
        value = v;
        subs.forEach((fn) => fn(value));
      },
      get: () => value
    };
  }
  const anki = (url: string) => ({
    ankiConnectSettings: {
      url,
      enabled: false,
      connectionData: null,
      cardMode: 'create',
      selectedModel: '',
      heightField: 0,
      widthField: 0,
      qualityField: 0.5,
      triggerMethod: 'neither',
      createModelConfigs: {},
      updateModelConfigs: {}
    }
  });
  const settings = createStore<any>(anki('http://127.0.0.1:8765'));
  return {
    anki,
    settings,
    updateAnkiSetting: vi.fn((key: string, value: unknown) => {
      const current = settings.get();
      settings.set({
        ...current,
        ankiConnectSettings: { ...current.ankiConnectSettings, [key]: value }
      });
    }),
    page: { url: new URL('http://localhost:5173/') }
  };
});

vi.mock('$app/state', () => ({ page: h.page }));
vi.mock('$lib/settings', () => ({ settings: h.settings, updateAnkiSetting: h.updateAnkiSetting }));
vi.mock('$lib/anki-connect', async () => ({
  // The real trust rules; only the network calls are stand-ins.
  ...(await vi.importActual<typeof import('$lib/anki-connect/url-trust')>(
    '$lib/anki-connect/url-trust'
  )),
  fetchConnectionData: vi.fn(async () => null),
  openConfigureModal: vi.fn()
}));

import { resetAnkiUrlTrustForTest } from '$lib/anki-connect/url-trust';
import AnkiConnectSettings from '../AnkiConnectSettings.svelte';

async function opened(url: string) {
  h.settings.set(h.anki(url));
  const view = render(AnkiConnectSettings);
  await fireEvent.click(view.getByText('Anki Connect'));
  return view;
}

beforeEach(() => {
  localStorage.clear();
  resetAnkiUrlTrustForTest();
  h.updateAnkiSetting.mockClear();
});

describe('AnkiConnect URL confirmation', () => {
  it('asks nothing for Anki on this machine', async () => {
    const { queryByTestId } = await opened('http://127.0.0.1:8765');
    expect(queryByTestId('anki-url-unconfirmed')).toBeNull();
  });

  it('shows an unconfirmed URL from an imported or synced profile, as text, until it is confirmed', async () => {
    const { getByTestId, getByText, queryByTestId } = await opened('https://anki.example.com');
    const banner = getByTestId('anki-url-unconfirmed');
    expect(banner.querySelector('code')?.textContent).toBe('https://anki.example.com');

    await fireEvent.click(getByText('Use this URL'));

    await waitFor(() => expect(queryByTestId('anki-url-unconfirmed')).toBeNull());
    const stored = JSON.parse(localStorage.getItem('anki_connect_confirmed_urls') ?? '{}');
    expect(Object.keys(stored)).toEqual(['https://anki.example.com/']);
  });

  it('can switch back to Anki on this device instead', async () => {
    const { getByText, queryByTestId } = await opened('https://anki.example.com');

    await fireEvent.click(getByText('Use Anki on this device instead'));

    expect(h.updateAnkiSetting).toHaveBeenCalledWith('url', 'http://127.0.0.1:8765');
    await waitFor(() => expect(queryByTestId('anki-url-unconfirmed')).toBeNull());
    expect(localStorage.getItem('anki_connect_confirmed_urls')).toBeNull();
  });

  it('a URL the user types here is confirmed by typing it', async () => {
    const { getByPlaceholderText, queryByTestId } = await opened('http://127.0.0.1:8765');
    const input = getByPlaceholderText('http://127.0.0.1:8765') as HTMLInputElement;

    await fireEvent.input(input, { target: { value: 'http://192.168.1.20:8765' } });
    await fireEvent.change(input);

    expect(h.updateAnkiSetting).toHaveBeenCalledWith('url', 'http://192.168.1.20:8765');
    expect(queryByTestId('anki-url-unconfirmed')).toBeNull();
  });
});

// #55: a key bound to "Anki card mode" or "Anki double-tap capture" changes the
// setting while this drawer is open. The controls used to copy the value at
// mount and showed a stale one afterwards.
describe('card mode and double-tap follow the store', () => {
  const connected = (over: Record<string, unknown> = {}) => {
    const base = h.anki('http://127.0.0.1:8765');
    return {
      ankiConnectSettings: {
        ...base.ankiConnectSettings,
        enabled: true,
        connectionData: { connected: true, decks: [], models: [], modelFields: {} },
        ...over
      }
    };
  };
  const radio = (c: HTMLElement, value: string) =>
    c.querySelector(`input[name="cardMode"][value="${value}"]`) as HTMLInputElement;
  const doubleTapIn = (c: HTMLElement) =>
    [...c.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('Double-tap to capture'))!
      .querySelector('input')!;

  async function openedConnected(over: Record<string, unknown> = {}) {
    h.settings.set(connected(over));
    const view = render(AnkiConnectSettings);
    await fireEvent.click(view.getByText('Anki Connect'));
    return view;
  }

  it('offers the two card modes from the setting definition', async () => {
    const view = await openedConnected();
    expect(view.getByText('Create new card')).toBeTruthy();
    expect(view.getByText('Update last card (within 5 min)')).toBeTruthy();
    expect(radio(view.container, 'create').checked).toBe(true);
    expect(radio(view.container, 'update').checked).toBe(false);
  });

  it('a change made elsewhere (a key press) shows at once', async () => {
    const view = await openedConnected();
    h.settings.set(connected({ cardMode: 'update' }));
    await waitFor(() => expect(radio(view.container, 'update').checked).toBe(true));
    expect(radio(view.container, 'create').checked).toBe(false);
    expect(view.getByText(/Updates the most recently created card/)).toBeTruthy();

    expect(doubleTapIn(view.container).checked).toBe(false);
    h.settings.set(connected({ cardMode: 'update', triggerMethod: 'both' }));
    await waitFor(() => expect(doubleTapIn(view.container).checked).toBe(true));
    h.settings.set(connected({ cardMode: 'update', triggerMethod: 'rightClick' }));
    await waitFor(() => expect(doubleTapIn(view.container).checked).toBe(false));
  });

  it('the controls still write through to the store', async () => {
    const view = await openedConnected();
    await fireEvent.click(radio(view.container, 'update'));
    expect(h.updateAnkiSetting).toHaveBeenCalledWith('cardMode', 'update');
    await waitFor(() => expect(radio(view.container, 'update').checked).toBe(true));

    await fireEvent.click(doubleTapIn(view.container));
    expect(h.updateAnkiSetting).toHaveBeenCalledWith('triggerMethod', 'doubleTap');
    await waitFor(() => expect(doubleTapIn(view.container).checked).toBe(true));
    await fireEvent.click(doubleTapIn(view.container));
    expect(h.updateAnkiSetting).toHaveBeenLastCalledWith('triggerMethod', 'neither');
  });
});
