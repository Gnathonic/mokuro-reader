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
    figuresFor: vi.fn((state: { ready: boolean }) => ({
      minutes: state.ready ? 60 : 5,
      timeMs: 0,
      chars: 0,
      skippedChars: 0,
      lastReadAt: null
    }))
  };
});
const readingStats = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof writable> }));
vi.mock('#lib/reading-history/stats-store.js', async () => {
  const { writable } = await import('svelte/store');
  readingStats.store = writable({ ready: false });
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
    readingStats.store.set({ ready: true });
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
    readingStats.store.set({ ready: true });
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
