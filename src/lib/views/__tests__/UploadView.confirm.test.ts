/**
 * The import-by-link view asks before it fetches anything, shows where the
 * link downloads from, and passes the confirmation's series-info answer on to
 * the importer — and only that answer.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';

const h = vi.hoisted(() => ({
  promptConfirmationWith: vi.fn(),
  showSnackbar: vi.fn(),
  download: vi.fn(),
  importDeepLinkedArchive: vi.fn(async () => ({ volume_uuid: 'v1' })),
  localSeriesKeys: vi.fn(async () => new Set<string>()),
  toCatalog: vi.fn(),
  fetch: vi.fn()
}));

vi.mock('$lib/util', async () => ({
  confirmationPopupStore: (await import('svelte/store')).writable<unknown>(undefined),
  normalizeFilename: (name: string) => name,
  promptConfirmationWith: h.promptConfirmationWith,
  showSnackbar: h.showSnackbar
}));
// The real parsers, reached lazily: importing the provider inside this factory
// would wait on modules that import `$lib/import` itself — a cycle that hangs.
type Provider = typeof import('$lib/import/html-download-provider');
let provider: Provider;
vi.mock('$lib/import', () => ({
  describeImportOutcome: () => '',
  importFiles: vi.fn(),
  htmlDownloadProvider: { download: h.download },
  getUploadParamsFromLocation: (...args: Parameters<Provider['getUploadParamsFromLocation']>) =>
    provider.getUploadParamsFromLocation(...args),
  parseHtmlDownloadRequest: (...args: Parameters<Provider['parseHtmlDownloadRequest']>) =>
    provider.parseHtmlDownloadRequest(...args)
}));
vi.mock('$lib/import/deep-link-import', () => ({
  importDeepLinkedArchive: h.importDeepLinkedArchive,
  localSeriesKeys: h.localSeriesKeys
}));
vi.mock('$lib/catalog/db', () => ({ db: { volumes: { toArray: async () => [] } } }));
vi.mock('$lib/catalog/thumbnail-cache', () => ({ thumbnailCache: { invalidate: vi.fn() } }));
vi.mock('$lib/util/upload', () => ({ requestPersistentStorage: vi.fn(async () => true) }));
vi.mock('$lib/util/hash-router', () => ({ nav: { toCatalog: h.toCatalog } }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));

import UploadView from '../UploadView.svelte';

type Prompt = {
  message: string;
  source: { label: string; values: string[] };
  warnings: string[];
  notes: string[];
  checkboxOption?: { label: string; storageKey?: string; defaultValue: boolean };
  onConfirm: (box?: boolean) => Promise<void>;
  onCancel: () => void;
};

function setLink(hash: string) {
  window.history.replaceState(null, '', `/${hash}`);
}

async function mountAndGetPrompt(): Promise<Prompt> {
  render(UploadView);
  await waitFor(() => expect(h.promptConfirmationWith).toHaveBeenCalledTimes(1));
  return h.promptConfirmationWith.mock.calls[0][0] as Prompt;
}

const cbzLink = (cbz: string, extra = '') => `#/upload?cbz=${encodeURIComponent(cbz)}${extra}`;

beforeAll(async () => {
  provider = await vi.importActual<Provider>('$lib/import/html-download-provider');
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', h.fetch);
  h.localSeriesKeys.mockResolvedValue(new Set());
  h.download.mockResolvedValue({
    bundleType: 'single',
    archiveFile: new File(['x'], 'V.cbz'),
    mokuroFile: null,
    importFiles: [new File(['x'], 'V.cbz')],
    coverFile: null,
    layers: [],
    seriesFile: null,
    manifest: null,
    manifestUrl: null
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('UploadView (import by link)', () => {
  it('asks first, showing the host and the warnings, and fetches nothing before the answer', async () => {
    setLink(cbzLink('http://192.168.1.20:8080/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz'));
    const prompt = await mountAndGetPrompt();
    expect(prompt.message).toBe('Import Dr Stone 01 into your catalog?');
    expect(prompt.source.values).toEqual(['192.168.1.20:8080']);
    expect(prompt.warnings.join(' ')).toContain('secure connection (https)');
    expect(prompt.warnings.join(' ')).toContain('private address');
    expect(h.download).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('cancelling goes back to the catalog and downloads nothing', async () => {
    setLink(cbzLink('https://books.example.com/S/V.cbz'));
    const prompt = await mountAndGetPrompt();
    prompt.onCancel();
    expect(h.toCatalog).toHaveBeenCalled();
    expect(h.download).not.toHaveBeenCalled();
  });

  it('leaving the page takes the open question with it, and its “no” sends no one anywhere', async () => {
    const { confirmationPopupStore } = await import('$lib/util');
    setLink(cbzLink('https://books.example.com/S/V.cbz'));
    const view = render(UploadView);
    await waitFor(() => expect(h.promptConfirmationWith).toHaveBeenCalledTimes(1));
    const prompt = h.promptConfirmationWith.mock.calls[0][0] as Prompt;
    confirmationPopupStore.set({ ...prompt, open: true } as never);

    view.unmount();
    expect((get(confirmationPopupStore) as { open: boolean }).open).toBe(false);
    prompt.onCancel();
    expect(h.toCatalog).not.toHaveBeenCalled();
  });

  it('refuses a link whose archive is not a web address, without asking', async () => {
    setLink('#/upload?cbz=javascript:alert(1)');
    render(UploadView);
    await waitFor(() => expect(h.toCatalog).toHaveBeenCalled());
    expect(h.promptConfirmationWith).not.toHaveBeenCalled();
    expect(h.showSnackbar).toHaveBeenCalledWith(expect.stringContaining('Invalid import URL'));
  });

  describe('a series already in the library', () => {
    const link = cbzLink(
      'https://books.example.com/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz',
      `&manifest=${encodeURIComponent('https://books.example.com/manifest')}`
    );
    beforeEach(() => {
      h.localSeriesKeys.mockResolvedValue(new Set(['dr stone']));
      setLink(link);
    });

    it('offers an unticked, unremembered box for its series info', async () => {
      const prompt = await mountAndGetPrompt();
      expect(prompt.checkboxOption).toEqual({
        label: 'Let this link update the series info of “Dr Stone”',
        defaultValue: false
      });
      expect(prompt.checkboxOption?.storageKey).toBeUndefined();
    });

    it('left unticked, the importer is told to leave the series alone', async () => {
      const prompt = await mountAndGetPrompt();
      await prompt.onConfirm(false);
      await waitFor(() => expect(h.importDeepLinkedArchive).toHaveBeenCalledTimes(1));
      expect(h.importDeepLinkedArchive.mock.calls[0]).toContainEqual({
        allowSeriesKey: undefined
      });
    });

    it('ticked, the importer may update that one series', async () => {
      const prompt = await mountAndGetPrompt();
      await prompt.onConfirm(true);
      await waitFor(() => expect(h.importDeepLinkedArchive).toHaveBeenCalledTimes(1));
      expect(h.importDeepLinkedArchive.mock.calls[0]).toContainEqual({
        allowSeriesKey: 'dr stone'
      });
    });
  });

  it('offers no box for a series that is new here', async () => {
    setLink(
      cbzLink(
        'https://books.example.com/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz',
        `&manifest=${encodeURIComponent('https://books.example.com/manifest')}`
      )
    );
    const prompt = await mountAndGetPrompt();
    expect(prompt.checkboxOption).toBeUndefined();
  });
});
