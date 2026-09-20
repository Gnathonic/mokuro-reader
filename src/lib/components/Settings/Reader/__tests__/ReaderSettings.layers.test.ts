import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { readable } from 'svelte/store';
import { tick } from 'svelte';

const updateVolumeSetting = vi.hoisted(() => vi.fn());
const runLayerAction = vi.hoisted(() =>
  vi.fn(async (_action: string, _ctx: { onBeforeMutate?: () => Promise<void> }) => {})
);
const loadLayerPages = vi.hoisted(() => vi.fn(async () => null));

vi.mock('$lib/settings', async () => {
  const { writable, readable } = await import('svelte/store');
  return {
    settings: writable({
      continuousScroll: false,
      singlePageView: 'dual',
      scrollMode: 'auto',
      swipeThreshold: 50,
      edgeButtonWidth: 10,
      pagedGap: 0
    }),
    updateSetting: vi.fn(),
    effectiveVolumeSettings: readable({ v1: { rightToLeft: true, hasCover: true } }),
    updateProgress: vi.fn(),
    updateVolumeSetting,
    volumes: readable({ v1: { progress: 1, settings: { ocrLayer: 'english' } } }),
    nightModeActive: readable(false)
  };
});
vi.mock('$lib/util', () => ({ isReader: () => true, showSnackbar: vi.fn() }));
vi.mock('$lib/util/hash-router', () => ({ routeParams: readable({ volume: 'v1' }) }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volume_ocr: { get: vi.fn(async () => undefined) },
    volumes: { get: vi.fn(async () => ({ mokuro_version: '0.2.2' })) }
  }
}));
vi.mock('$lib/reader/edit/layer-list', () => ({
  primaryLayerName: (v: string | undefined) => (v ? `mokuro ${v}` : 'mokuro'),
  layerSummaries: () =>
    readable([
      { layer_id: 'original', name: 'Original', kind: 'original', updated_at: 'x' },
      { layer_id: 'english', name: 'English', kind: 'translation', updated_at: 'x' }
    ])
}));
vi.mock('$lib/reader/edit/layers', () => ({
  LAYER_KIND_LABEL: { original: 'Original', edit: 'Edit', ocr: 'OCR', translation: 'Translation' },
  loadLayerPages
}));
vi.mock('$lib/components/Reader/Layers/layer-actions', () => ({ runLayerAction }));
vi.mock('../ReaderSelects.svelte', async () => {
  const mod = await import('./__stub__/Empty.svelte');
  return { default: mod.default };
});
vi.mock('../ReaderToggles.svelte', async () => {
  const mod = await import('./__stub__/Empty.svelte');
  return { default: mod.default };
});

import ReaderSettings from '../ReaderSettings.svelte';
// The REAL registry: the settings panel reaches the reader's edit session
// through it, so the test registers a hook the way `Reader.svelte` does.
import { registerBeforeLayerMutation } from '$lib/reader/edit/reader-edit-rules';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const flushTasks = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await tick();
};

describe('ReaderSettings — OCR layers', () => {
  it('lists layers in a select bound to the volume setting and exposes the actions', async () => {
    const { getByLabelText, queryByLabelText } = render(ReaderSettings);
    const select = getByLabelText('OCR layer') as HTMLSelectElement;
    // The primary option is named after the mokuro version once the row loads.
    await new Promise((r) => setTimeout(r, 0));
    await tick();
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
      'mokuro 0.2.2',
      'Original (Original)',
      'English (Translation)'
    ]);
    expect(select.value).toBe('english');
    await fireEvent.change(select, { target: { value: '' } });
    expect(updateVolumeSetting).toHaveBeenCalledWith('v1', 'ocrLayer', undefined);
    await fireEvent.click(getByLabelText('Promote layer'));
    expect(runLayerAction).toHaveBeenCalledWith(
      'promote',
      expect.objectContaining({ volumeUuid: 'v1', layerId: 'english', layerName: 'English' })
    );
    expect(queryByLabelText('New layer')).toBeTruthy();
    expect(queryByLabelText('Rename layer')).toBeTruthy();
  });

  it("'new' settles the reader's unsaved edits BEFORE reading the pages it copies", async () => {
    let settled!: () => void;
    const hook = vi.fn(() => new Promise<void>((r) => (settled = r)));
    const unregister = registerBeforeLayerMutation(hook);
    try {
      const { getByLabelText } = render(ReaderSettings);
      await fireEvent.click(getByLabelText('New layer'));
      await flushTasks();
      expect(hook).toHaveBeenCalledWith('new');
      // Still saving: the copy source must not have been read yet, or it
      // misses whatever the debounced autosave had not written.
      expect(loadLayerPages).not.toHaveBeenCalled();
      expect(runLayerAction).not.toHaveBeenCalled();
      settled();
      await flushTasks();
      expect(loadLayerPages).toHaveBeenCalledWith('v1', 'english');
      expect(runLayerAction).toHaveBeenCalledWith(
        'new',
        expect.objectContaining({ volumeUuid: 'v1', layerId: 'english' })
      );
      expect(hook.mock.invocationCallOrder[0]).toBeLessThan(
        loadLayerPages.mock.invocationCallOrder[0]
      );
    } finally {
      unregister();
    }
  });

  it("hands runLayerAction the reader's settle hook as onBeforeMutate, per action", async () => {
    const hook = vi.fn(async () => {});
    const unregister = registerBeforeLayerMutation(hook);
    try {
      const { getByLabelText } = render(ReaderSettings);
      await fireEvent.click(getByLabelText('Promote layer'));
      await flushTasks();
      const ctx = runLayerAction.mock.calls[0][1];
      expect(ctx.onBeforeMutate).toBeTypeOf('function');
      // A promote settles nothing until the user has confirmed it.
      expect(hook).not.toHaveBeenCalled();
      await ctx.onBeforeMutate!();
      expect(hook).toHaveBeenCalledWith('promote');
    } finally {
      unregister();
    }
  });
});
