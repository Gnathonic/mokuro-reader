import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

// The AnkiConnect client reads the URL from the current profile; a stand-in
// store lets each test say what the profile holds (as an import or a synced
// profiles.json would have left it).
const h = vi.hoisted(() => {
  let value: any = { ankiConnectSettings: { url: 'http://127.0.0.1:8765' } };
  const subs = new Set<(v: any) => void>();
  return {
    settings: {
      subscribe(fn: (v: any) => void) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      },
      set(v: any) {
        value = v;
        subs.forEach((fn) => fn(value));
      }
    },
    showSnackbar: vi.fn()
  };
});
vi.mock('$lib/settings', () => ({ settings: h.settings, DEFAULT_MODEL_CONFIGS: {} }));
vi.mock('$lib/util', () => ({ showSnackbar: h.showSnackbar }));
vi.mock('$lib/util/platform', () => ({ isMobilePlatform: () => false }));

import {
  CONFIRMED_ANKI_URLS_KEY,
  ankiUrlKey,
  ankiUrlRefusal,
  confirmAnkiUrl,
  isAnkiUrlTrusted,
  isLoopbackAnkiUrl,
  resetAnkiUrlTrustForTest
} from '../url-trust';
import { ankiConnect, fetchConnectionData, testConnection, updateLastCard } from '../index';

const fetchMock = vi.fn(async () => ({ json: async () => ({ result: 6, error: null }) }));

beforeEach(() => {
  localStorage.clear();
  resetAnkiUrlTrustForTest();
  h.showSnackbar.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function profileUrl(url: string) {
  h.settings.set({ ankiConnectSettings: { url } });
}

describe('isLoopbackAnkiUrl', () => {
  it.each([
    'http://127.0.0.1:8765',
    'http://localhost:8765',
    'http://LOCALHOST:8765/',
    'http://[::1]:8765',
    'https://127.0.0.1:8765',
    '',
    '   '
  ])('%s is Anki on this machine', (url) => {
    expect(isLoopbackAnkiUrl(url)).toBe(true);
  });

  it.each([
    'https://anki.example.com',
    'http://192.168.1.20:8765',
    'http://10.0.0.5:8765',
    // userinfo, not a host: this goes to the host after the @
    'http://127.0.0.1@evil.example:8765',
    'http://127.0.0.1.evil.example:8765',
    'http://localhost.evil.example',
    'ftp://127.0.0.1:8765',
    'not a url'
  ])('%s is not', (url) => {
    expect(isLoopbackAnkiUrl(url)).toBe(false);
  });
});

describe('confirming a URL on this device', () => {
  it('a loopback URL is trusted without asking', () => {
    expect(isAnkiUrlTrusted('http://127.0.0.1:8765')).toBe(true);
    expect(isAnkiUrlTrusted('http://localhost:8765')).toBe(true);
  });

  it('any other URL is not, until it is confirmed', () => {
    expect(isAnkiUrlTrusted('http://192.168.1.20:8765')).toBe(false);
    confirmAnkiUrl('http://192.168.1.20:8765');
    expect(isAnkiUrlTrusted('http://192.168.1.20:8765')).toBe(true);
    // Only that one.
    expect(isAnkiUrlTrusted('https://anki.example.com')).toBe(false);
  });

  it('is stored in localStorage keyed by the URL, and survives a reload', () => {
    confirmAnkiUrl('https://Anki.Example.com');
    const stored = JSON.parse(localStorage.getItem(CONFIRMED_ANKI_URLS_KEY) ?? '{}');
    expect(Object.keys(stored)).toEqual(['https://anki.example.com/']);
    expect(Date.parse(stored['https://anki.example.com/'])).not.toBeNaN();

    resetAnkiUrlTrustForTest(); // a fresh page load reading storage
    // The same address however it is spelled.
    expect(isAnkiUrlTrusted('https://anki.example.com/')).toBe(true);
    expect(ankiUrlKey('https://ANKI.example.com')).toBe('https://anki.example.com/');
  });

  it('storage that holds junk trusts nothing', () => {
    localStorage.setItem(CONFIRMED_ANKI_URLS_KEY, '["https://anki.example.com/"]');
    resetAnkiUrlTrustForTest();
    expect(isAnkiUrlTrusted('https://anki.example.com')).toBe(false);
    localStorage.setItem(CONFIRMED_ANKI_URLS_KEY, '{not json');
    resetAnkiUrlTrustForTest();
    expect(isAnkiUrlTrusted('https://anki.example.com')).toBe(false);
  });
});

describe('a confirmation made in another tab', () => {
  // Each tab reads the confirmations once at load. A user told to confirm the
  // URL may do it in another tab; this one must follow, or it keeps refusing.
  const url = 'http://192.168.1.20:8765';
  const otherTabWrites = (value: string | null) => {
    if (value === null) localStorage.removeItem(CONFIRMED_ANKI_URLS_KEY);
    else localStorage.setItem(CONFIRMED_ANKI_URLS_KEY, value);
    // The browser tells every OTHER tab; jsdom's own writes fire nothing.
    window.dispatchEvent(new StorageEvent('storage', { key: CONFIRMED_ANKI_URLS_KEY }));
  };

  it('is trusted here at once', async () => {
    expect(isAnkiUrlTrusted(url)).toBe(false);
    otherTabWrites(JSON.stringify({ [ankiUrlKey(url)]: new Date().toISOString() }));
    expect(isAnkiUrlTrusted(url)).toBe(true);

    profileUrl(url);
    await expect(ankiConnect('version', {})).resolves.toBe(6);
    expect(fetchMock).toHaveBeenCalledWith(url, expect.anything());
  });

  it('and storage cleared in another tab takes the trust with it', () => {
    confirmAnkiUrl(url);
    localStorage.clear();
    // `clear()` in another tab arrives with no key.
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(isAnkiUrlTrusted(url)).toBe(false);
  });

  it('a change to any other key is none of its business', () => {
    localStorage.setItem(CONFIRMED_ANKI_URLS_KEY, JSON.stringify({ [ankiUrlKey(url)]: 'x' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'something_else' }));
    expect(isAnkiUrlTrusted(url)).toBe(false);
  });
});

describe('the AnkiConnect client sends nothing to an unconfirmed URL', () => {
  it('a profile that arrived pointing at another host: no request, and the user is told', async () => {
    profileUrl('https://anki.example.com');

    await expect(ankiConnect('addNote', { note: { fields: { Front: 'x' } } })).resolves.toBe(
      undefined
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.showSnackbar).toHaveBeenCalledWith(
      expect.stringContaining('https://anki.example.com is not confirmed on this device')
    );
  });

  it('silent calls stay silent, and still send nothing', async () => {
    profileUrl('https://anki.example.com');
    await ankiConnect('findNotes', { query: 'added:1' }, { silent: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.showSnackbar).not.toHaveBeenCalled();
  });

  it('the connection test and the settings fetch refuse it too', async () => {
    profileUrl('http://192.168.1.20:8765');
    await expect(testConnection()).resolves.toMatchObject({
      success: false,
      error: 'unconfirmed_url'
    });
    await expect(fetchConnectionData()).resolves.toBeNull();
    // A URL handed in for testing is held to the same rule.
    await expect(testConnection('https://anki.example.com')).resolves.toMatchObject({
      error: 'unconfirmed_url'
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('once confirmed here, calls go to it', async () => {
    profileUrl('http://192.168.1.20:8765');
    confirmAnkiUrl('http://192.168.1.20:8765');

    await expect(ankiConnect('version', {})).resolves.toBe(6);
    expect(fetchMock).toHaveBeenCalledWith('http://192.168.1.20:8765', expect.anything());
  });

  it('Anki on this machine needs no confirmation', async () => {
    profileUrl('http://127.0.0.1:8765');
    await expect(ankiConnect('version', {})).resolves.toBe(6);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765', expect.anything());

    profileUrl('');
    await ankiConnect('version', {});
    expect(fetchMock).toHaveBeenLastCalledWith('http://127.0.0.1:8765', expect.anything());
  });
});

describe('update mode with an unconfirmed URL', () => {
  // The snackbar holds ONE message. A flow that reads the guard's silence as
  // "no recent card" and reports that replaces the guard's notice, and the
  // user never learns the URL needs confirming.
  function updateProfile(url: string) {
    h.settings.set({
      ankiConnectSettings: {
        url,
        enabled: true,
        cardMode: 'update',
        connectionData: { modelFields: { Basic: ['Front'] } },
        updateModelConfigs: {}
      }
    });
  }

  it('updateLastCard tells the user to confirm it, and that is the last word', async () => {
    updateProfile('http://192.168.1.10:8765');

    await updateLastCard('data:image/webp;base64,AAAA', 's', '', undefined, undefined, 'Basic');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.showSnackbar).toHaveBeenCalledTimes(1);
    expect(h.showSnackbar.mock.calls.at(-1)?.[0]).toContain(
      'http://192.168.1.10:8765 is not confirmed on this device'
    );
  });

  it('a card id handed in (quick capture, the update modal) is refused the same way', async () => {
    updateProfile('https://anki.example.com');

    await updateLastCard('data:image/webp;base64,AAAA', 's', '', undefined, 1234, 'Basic');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.showSnackbar).toHaveBeenCalledTimes(1);
    expect(h.showSnackbar.mock.calls[0][0]).toContain('is not confirmed on this device');
  });

  it('every component that looks up the last card checks the URL first', () => {
    // A component reads "no result" from getLastCardInfo() as "no recent
    // card" and says so, over the guard's notice. Each one must stop on
    // ankiUrlRefusal() before it asks.
    const sources = import.meta.glob('/src/lib/components/**/*.svelte', {
      query: '?raw',
      import: 'default',
      eager: true
    }) as Record<string, string>;
    const callers = Object.entries(sources).filter(([, src]) => src.includes('getLastCardInfo()'));
    expect(callers.map(([path]) => path.split('/').pop()).sort()).toEqual([
      'Reader.svelte',
      'TextBoxPicker.svelte',
      'TextBoxes.svelte'
    ]);
    for (const [path, src] of callers) {
      for (const call of src.matchAll(/getLastCardInfo\(\)/g)) {
        const fnStart = src.lastIndexOf('function ', call.index);
        expect(src.slice(fnStart, call.index), path).toContain('ankiUrlRefusal(');
      }
    }
  });

  it('ankiUrlRefusal names the notice for an unconfirmed URL, and nothing otherwise', () => {
    expect(ankiUrlRefusal('http://192.168.1.10:8765')).toContain(
      'http://192.168.1.10:8765 is not confirmed on this device'
    );
    expect(ankiUrlRefusal('http://127.0.0.1:8765')).toBeNull();
    expect(ankiUrlRefusal('')).toBeNull();
    confirmAnkiUrl('http://192.168.1.10:8765');
    expect(ankiUrlRefusal('http://192.168.1.10:8765')).toBeNull();
  });
});
