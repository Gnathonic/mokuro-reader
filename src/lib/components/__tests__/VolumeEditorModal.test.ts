import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { writable } from 'svelte/store';

// The editor records a time edit as the DIFFERENCE from the figure it showed
// (volume-editor.ts `timeRead: { from, to }`), so the figure it loads must be
// the counted one. The stats store is stubbed with a readiness gate the test
// controls; `figuresFor` answers the baseline alone until the gate opens.
const stats = vi.hoisted(() => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return {
    release: () => release(),
    readingStatsReady: vi.fn(() => gate),
    chars: 0,
    figuresFor: vi.fn((state: { ready: boolean }) => ({
      minutes: state.ready ? 60 : 5,
      timeMs: 0,
      chars: stats.chars,
      skippedChars: 0,
      lastReadAt: null,
      credit: { timeMs: 0, chars: 0 }
    }))
  };
});
const readingStats = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof writable> }));
vi.mock('$lib/reading-history/stats-store', async () => {
  const { writable } = await import('svelte/store');
  readingStats.store = writable({ ready: false, byVolume: new Map() });
  return {
    readingStats: readingStats.store,
    readingStatsReady: stats.readingStatsReady,
    figuresFor: stats.figuresFor
  };
});

const editor = vi.hoisted(() => ({
  updateVolumeStats: vi.fn(),
  getVolumeData: vi.fn()
}));
vi.mock('$lib/util/volume-editor', () => ({
  getAllSeriesOptions: vi.fn(async () => [{ uuid: 's1', title: 'Series' }]),
  generateNewSeriesUuid: vi.fn(() => 'new'),
  updateVolumeInDb: vi.fn(async () => {}),
  renameVolumeInCloud: vi.fn(async () => {}),
  updateVolumeStats: editor.updateVolumeStats,
  updateVolumeCover: vi.fn(async () => {}),
  resetVolumeCover: vi.fn(async () => {}),
  getVolumeData: editor.getVolumeData,
  calculateVolumeCharacterCount: vi.fn(async () => 5000),
  getNextVolumeUuidInSeries: vi.fn(async () => null)
}));
vi.mock('$lib/util', () => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/util/sync/provider-interface', () => ({ ProviderError: class extends Error {} }));
vi.mock('$lib/util/sync/account-capabilities', () => ({ renameRefusalMessage: () => null }));
vi.mock('../VolumeEditorCoverPicker.svelte', () => ({ default: () => {} }));
// #224: the editor's "Count pages read elsewhere…" and Remove go through the flow.
const flow = vi.hoisted(() => ({
  notRead: [] as number[],
  prepareSheetVolume: vi.fn(),
  countReadElsewhere: vi.fn(async (_v: unknown, _upTo: number) => true),
  removeCredits: vi.fn(async (_v: string) => ({
    removed: 'Removed 38 min counted',
    undo: vi.fn(async () => {})
  })),
  markReadSheetOpen: vi.fn(() => false)
}));
vi.mock('$lib/reading-history/mark-read-flow', () => ({
  prepareSheetVolume: flow.prepareSheetVolume,
  countReadElsewhere: flow.countReadElsewhere,
  removeCredits: flow.removeCredits,
  markReadSheetOpen: flow.markReadSheetOpen
}));
flow.prepareSheetVolume.mockImplementation(
  async (m: { volume_uuid: string; volume_title: string; page_count: number }) => ({
    uuid: m.volume_uuid,
    title: m.volume_title,
    pageCount: m.page_count,
    pageChars: Array.from({ length: m.page_count }, () => 50),
    notRead: flow.notRead
  })
);

import VolumeEditorModal from '../VolumeEditorModal.svelte';
import { promptVolumeEditor, closeVolumeEditor } from '$lib/util/modals';
import { VolumeData } from '$lib/settings/volume-data';

const hours = () => document.querySelector('#time-hours') as HTMLInputElement | null;

describe('VolumeEditorModal time read', () => {
  beforeEach(() => {
    editor.getVolumeData.mockResolvedValue({
      metadata: {
        volume_uuid: 'vol-1',
        series_uuid: 's1',
        series_title: 'Series',
        volume_title: 'Vol 1',
        page_count: 100
      },
      stats: new VolumeData({ progress: 10, chars: 500, timeReadInMinutes: 5 })
    });
  });
  afterEach(() => {
    closeVolumeEditor();
    cleanup();
  });

  it('loads the counted figure, not the baseline the stats show before their first pass', async () => {
    const { getByText } = render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(editor.getVolumeData).toHaveBeenCalled());

    // The stats finish their first pass only now.
    readingStats.store.set({ ready: true, byVolume: new Map() });
    stats.release();
    await waitFor(() => expect(hours()).not.toBeNull());
    const shownHours = hours()!.value;

    await fireEvent.click(getByText('Save'));
    await waitFor(() => expect(editor.updateVolumeStats).toHaveBeenCalled());
    // An unchanged field records no delta: from = to = the counted 60 min —
    // not the 5-minute baseline the stats showed before their first pass.
    expect(editor.updateVolumeStats.mock.calls[0][1].timeRead).toEqual({ from: 60, to: 60 });
    expect(shownHours).toBe('1');
    expect(stats.readingStatsReady).toHaveBeenCalled();
  });
});

describe('VolumeEditorModal cover preview', () => {
  const originalCreate = globalThis.URL.createObjectURL;
  const originalRevoke = globalThis.URL.revokeObjectURL;
  const meta = {
    volume_uuid: 'vol-1',
    series_uuid: 's1',
    series_title: 'Series',
    volume_title: 'Vol 1',
    page_count: 100
  };

  beforeEach(() => {
    globalThis.URL.createObjectURL = vi.fn(
      (blob: Blob) => `blob:${blob.type}`
    ) as unknown as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    closeVolumeEditor();
    cleanup();
    globalThis.URL.createObjectURL = originalCreate;
    globalThis.URL.revokeObjectURL = originalRevoke;
  });

  const preview = () => document.querySelector('img[src^="blob:"]')?.getAttribute('src') ?? null;

  // Earlier builds stored archive thumbnail sidecars untyped: previewed under a
  // raster label until `processThumbnails` re-types them.
  it('previews an untyped thumbnail under a raster label', async () => {
    editor.getVolumeData.mockResolvedValue({
      metadata: { ...meta, thumbnail: new File(['x'], 'Vol 1.webp') },
      stats: new VolumeData({})
    });
    render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(preview()).toBe('blob:image/webp'));
  });

  it('never previews an SVG-typed thumbnail', async () => {
    editor.getVolumeData.mockResolvedValue({
      metadata: {
        ...meta,
        thumbnail: new File(['<svg/>'], 'c.svg', { type: 'image/svg+xml' })
      },
      stats: new VolumeData({})
    });
    render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(editor.getVolumeData).toHaveBeenCalled());
    await waitFor(() => expect(hours()).not.toBeNull());
    expect(preview()).toBeNull();
    expect(globalThis.URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('VolumeEditorModal reading progress (#224)', () => {
  const MIN = 60_000;
  const meta = {
    volume_uuid: 'vol-1',
    series_uuid: 's1',
    series_title: 'Series',
    volume_title: 'Vol 1',
    page_count: 100
  };
  beforeEach(() => {
    stats.release();
    stats.chars = 1234;
    flow.notRead = [];
    readingStats.store.set({ ready: true, byVolume: new Map() });
    editor.updateVolumeStats.mockClear();
    flow.countReadElsewhere.mockClear();
    flow.removeCredits.mockClear();
    editor.getVolumeData.mockResolvedValue({
      metadata: meta,
      stats: new VolumeData({ progress: 10, chars: 500 })
    });
  });
  afterEach(() => {
    stats.chars = 0;
    closeVolumeEditor();
    cleanup();
  });

  const progressInput = () => document.querySelector('#progress') as HTMLInputElement;
  const text = (id: string) =>
    document.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim();

  it('shows the characters the stats count; a page edit moves the position and records no characters', async () => {
    const { getByText } = render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(progressInput()).not.toBeNull());
    expect(text('editor-chars')).toBe('1,234 / 5,000');
    await fireEvent.input(progressInput(), { target: { value: '4' } });
    // Still the stats' figure: the page is a position, not reading.
    expect(text('editor-chars')).toBe('1,234 / 5,000');
    await fireEvent.click(getByText('Save'));
    await waitFor(() => expect(editor.updateVolumeStats).toHaveBeenCalled());
    const update = editor.updateVolumeStats.mock.calls[0][1];
    expect(update.progress).toBe(4);
    // The record's position count: 4 pages of 50 characters.
    expect(update.chars).toBe(200);
    expect(update.charsRead).toBeUndefined();
  });

  it('Reset All zeroes the characters too, as an explicit edit', async () => {
    const { getByText } = render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(progressInput()).not.toBeNull());
    await fireEvent.click(getByText('Reset All'));
    expect(text('editor-chars')).toBe('0 / 5,000');
    await fireEvent.click(getByText('Save'));
    await waitFor(() => expect(editor.updateVolumeStats).toHaveBeenCalled());
    expect(editor.updateVolumeStats.mock.calls[0][1].charsRead).toEqual({ from: 1234, to: 0 });
  });

  it('Reset All un-reads a finished volume; a plain save leaves the flag alone', async () => {
    editor.getVolumeData.mockResolvedValue({
      metadata: meta,
      stats: new VolumeData({ progress: 100, chars: 5000, completed: true })
    });
    const first = render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(progressInput()).not.toBeNull());
    await fireEvent.click(first.getByText('Save'));
    await waitFor(() => expect(editor.updateVolumeStats).toHaveBeenCalled());
    expect(editor.updateVolumeStats.mock.calls[0][1].completed).toBeUndefined();
    closeVolumeEditor();
    cleanup();
    editor.updateVolumeStats.mockClear();

    const { getByText } = render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(progressInput()).not.toBeNull());
    await fireEvent.click(getByText('Reset All'));
    await fireEvent.click(getByText('Save'));
    await waitFor(() => expect(editor.updateVolumeStats).toHaveBeenCalled());
    expect(editor.updateVolumeStats.mock.calls[0][1]).toMatchObject({
      progress: 0,
      completed: false
    });
  });

  it('shows what marking read counted, with Remove', async () => {
    readingStats.store.set({
      ready: true,
      byVolume: new Map([
        [
          'vol-1',
          {
            pass: 0,
            credits: [
              { device: 'd', seq: 3, t: 0, pass: 0, ms: 38 * MIN, chars: 9412, pages: [1, 2, 3] }
            ]
          }
        ]
      ])
    });
    const { getByText } = render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(text('editor-credit')).toContain('Counted when marked read'));
    expect(text('editor-credit')).toContain(
      'Counted when marked read: 38 min · 9,412 characters (3 pages)'
    );
    await fireEvent.click(getByText('Remove'));
    await waitFor(() => expect(flow.removeCredits).toHaveBeenCalledWith('vol-1'));
    await waitFor(() => expect(text('editor-credit')).toContain('Removed 38 min counted.'));
    expect(getByText('Undo')).toBeTruthy();
  });

  it('offers "Count pages read elsewhere…" up to the current page only when those pages hold text', async () => {
    flow.notRead = [20, 21];
    const first = render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(progressInput()).not.toBeNull());
    // Pages 20–21 are past page 10.
    expect(document.querySelector('[data-testid="editor-count-elsewhere"]')).toBeNull();
    await fireEvent.input(progressInput(), { target: { value: '30' } });
    await fireEvent.click(first.getByText('Count pages read elsewhere…'));
    await waitFor(() => expect(flow.countReadElsewhere).toHaveBeenCalled());
    expect(flow.countReadElsewhere.mock.calls[0][1]).toBe(30);
  });
});
