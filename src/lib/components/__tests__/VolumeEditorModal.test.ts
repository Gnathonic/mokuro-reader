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
    /** The current pass's characters (`passFiguresFor`); `null` = the same as `chars`. */
    passChars: null as number | null,
    /** The time once a reset is applied (`minutesAfterReset`). */
    afterReset: 60,
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
vi.mock('#lib/reading-history/stats-store.js', async () => {
  const { writable } = await import('svelte/store');
  readingStats.store = writable({ ready: false, byVolume: new Map() });
  return {
    readingStats: readingStats.store,
    readingStatsReady: stats.readingStatsReady,
    figuresFor: stats.figuresFor,
    minutesAfterReset: vi.fn(() => stats.afterReset),
    passFiguresFor: vi.fn(() => ({
      pass: 0,
      chars: stats.passChars ?? stats.chars,
      credit: { timeMs: 0, chars: 0 }
    })),
    creditsFor: vi.fn(
      (state: { byVolume?: Map<string, { credits: unknown[] }> }, volume: string) =>
        state.byVolume?.get(volume)?.credits ?? []
    )
  };
});

const editor = vi.hoisted(() => ({
  updateVolumeStats: vi.fn(),
  getVolumeData: vi.fn()
}));
vi.mock('#lib/util/volume-editor.js', async (importOriginal) => ({
  completionDateInputValue: (await importOriginal<typeof import('#lib/util/volume-editor.js')>())
    .completionDateInputValue,
  completedAtFromDateInput: (await importOriginal<typeof import('#lib/util/volume-editor.js')>())
    .completedAtFromDateInput,
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
vi.mock('#lib/util/index.js', () => ({ showSnackbar: vi.fn() }));
vi.mock('#lib/util/sync/provider-interface.js', () => ({ ProviderError: class extends Error {} }));
vi.mock('#lib/util/sync/account-capabilities.js', () => ({ renameRefusalMessage: () => null }));
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
vi.mock('#lib/reading-history/mark-read-flow.js', () => ({
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
import { promptVolumeEditor, closeVolumeEditor } from '#lib/util/modals.js';
import { VolumeData } from '#lib/settings/volume-data.js';

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
    stats.passChars = null;
    stats.afterReset = 60;
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
    expect(update.reset).toBeUndefined();
  });

  it("shows this pass's characters beside the volume's, never more than it", async () => {
    // A re-read: the lifetime counts both passes; the field is about this one.
    stats.chars = 12_000;
    stats.passChars = 3_000;
    const first = render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(text('editor-chars')).toBe('3,000 / 5,000'));
    closeVolumeEditor();
    first.unmount();
    // Pages counted at an older OCR can exceed today's count: shown as the whole volume.
    stats.passChars = 7_000;
    render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(text('editor-chars')).toBe('5,000 / 5,000'));
  });

  it('Reset All zeroes the characters too: a reset of the pass, recorded on save', async () => {
    const { getByText } = render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(progressInput()).not.toBeNull());
    await fireEvent.click(getByText('Reset All'));
    expect(text('editor-chars')).toBe('0 / 5,000');
    await fireEvent.click(getByText('Save'));
    await waitFor(() => expect(editor.updateVolumeStats).toHaveBeenCalled());
    expect(editor.updateVolumeStats.mock.calls[0][1]).toMatchObject({
      reset: true,
      progress: 0,
      timeRead: { from: 60, to: 0 }
    });
    expect('charsRead' in editor.updateVolumeStats.mock.calls[0][1]).toBe(false);
  });

  it("Reset All's time edit starts from the time after the reset: a credit's time leaves once", async () => {
    // 60 min shown, 22 of them counted when marked read: the reset itself
    // takes those 22 away (its pass keeps no credit).
    stats.afterReset = 38;
    const { getByText } = render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(progressInput()).not.toBeNull());
    await fireEvent.click(getByText('Reset All'));
    await fireEvent.click(getByText('Save'));
    await waitFor(() => expect(editor.updateVolumeStats).toHaveBeenCalled());
    expect(editor.updateVolumeStats.mock.calls[0][1]).toMatchObject({
      reset: true,
      timeRead: { from: 38, to: 0 }
    });
  });

  it('Reset All records no reset when the pass counts nothing', async () => {
    stats.chars = 0;
    stats.afterReset = 12;
    const { getByText } = render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(progressInput()).not.toBeNull());
    await fireEvent.click(getByText('Reset All'));
    await fireEvent.click(getByText('Save'));
    await waitFor(() => expect(editor.updateVolumeStats).toHaveBeenCalled());
    const update = editor.updateVolumeStats.mock.calls[0][1];
    expect(update.reset).toBeUndefined();
    // Nothing is reset, so nothing leaves with it: from the figure shown.
    expect(update).toMatchObject({ progress: 0, completed: false, timeRead: { from: 60, to: 0 } });
  });

  it('after Reset All (before Save) a finished volume offers no counting, and shows no credit', async () => {
    flow.notRead = [99, 100];
    readingStats.store.set({
      ready: true,
      byVolume: new Map([
        [
          'vol-1',
          {
            pass: 0,
            credits: [{ device: 'd', seq: 3, t: 0, pass: 0, ms: 38 * MIN, chars: 9412, pages: [1] }]
          }
        ]
      ])
    });
    editor.getVolumeData.mockResolvedValue({
      metadata: meta,
      stats: new VolumeData({ progress: 100, chars: 5000, completed: true })
    });
    const { getByText } = render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() =>
      expect(document.querySelector('[data-testid="editor-count-elsewhere"]')).not.toBeNull()
    );
    expect(text('editor-credit')).toContain('Counted when marked read');
    await fireEvent.click(getByText('Reset All'));
    expect(document.querySelector('[data-testid="editor-count-elsewhere"]')).toBeNull();
    expect(text('editor-credit')).not.toContain('Counted when marked read');
    // Paging forward again does not bring it back before the Save.
    await fireEvent.input(progressInput(), { target: { value: '100' } });
    expect(document.querySelector('[data-testid="editor-count-elsewhere"]')).toBeNull();
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

describe('VolumeEditorModal completion date (#304)', () => {
  const meta = {
    volume_uuid: 'vol-1',
    series_uuid: 's1',
    series_title: 'Series',
    volume_title: 'Vol 1',
    page_count: 100
  };
  const finishedOn = () => document.querySelector('#completed-on') as HTMLInputElement | null;

  beforeEach(() => {
    editor.updateVolumeStats.mockClear();
    readingStats.store.set({ ready: true, byVolume: new Map() });
    stats.release();
  });
  afterEach(() => {
    closeVolumeEditor();
    cleanup();
  });

  it("shows a finished volume's date and saves a corrected one", async () => {
    const finished = new Date(2026, 9, 11, 21, 30).toISOString();
    editor.getVolumeData.mockResolvedValue({
      metadata: meta,
      stats: new VolumeData({ progress: 100, completed: true, completedAt: finished })
    });
    const { getByText } = render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(finishedOn()?.value).toBe('2026-10-11'));

    await fireEvent.input(finishedOn()!, { target: { value: '2025-03-02' } });
    await fireEvent.click(getByText('Save'));
    await waitFor(() => expect(editor.updateVolumeStats).toHaveBeenCalled());
    // The day moves; the time of day it was finished stays.
    expect(editor.updateVolumeStats.mock.calls[0][1].completedAt).toBe(
      new Date(2025, 2, 2, 21, 30).toISOString()
    );
  });

  it('sends no date when it was left alone', async () => {
    editor.getVolumeData.mockResolvedValue({
      metadata: meta,
      stats: new VolumeData({
        progress: 100,
        completed: true,
        completedAt: new Date(2026, 9, 11).toISOString()
      })
    });
    const { getByText } = render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(finishedOn()).not.toBeNull());
    await fireEvent.click(getByText('Save'));
    await waitFor(() => expect(editor.updateVolumeStats).toHaveBeenCalled());
    expect('completedAt' in editor.updateVolumeStats.mock.calls[0][1]).toBe(false);
  });

  it('has no date to edit for an unfinished volume', async () => {
    editor.getVolumeData.mockResolvedValue({
      metadata: meta,
      stats: new VolumeData({ progress: 10 })
    });
    render(VolumeEditorModal);
    promptVolumeEditor('vol-1');
    await waitFor(() => expect(hours()).not.toBeNull());
    expect(finishedOn()).toBeNull();
  });
});
