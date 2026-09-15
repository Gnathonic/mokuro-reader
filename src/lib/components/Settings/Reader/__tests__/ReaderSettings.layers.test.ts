import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { readable } from 'svelte/store';

const updateVolumeSetting = vi.hoisted(() => vi.fn());
const runLayerAction = vi.hoisted(() => vi.fn(async () => {}));

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
vi.mock('$lib/catalog/db', () => ({ db: { volume_ocr: { get: vi.fn(async () => undefined) } } }));
vi.mock('$lib/reader/edit/layer-list', () => ({
  layerSummaries: () =>
    readable([
      { layer_id: 'original', name: 'Original', kind: 'original', updated_at: 'x' },
      { layer_id: 'english', name: 'English', kind: 'translation', updated_at: 'x' }
    ])
}));
vi.mock('$lib/reader/edit/layers', () => ({
  LAYER_KIND_LABEL: { original: 'Original', edit: 'Edit', ocr: 'OCR', translation: 'Translation' },
  loadLayerPages: vi.fn(async () => null)
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

afterEach(cleanup);

describe('ReaderSettings — OCR layers', () => {
  it('lists layers in a select bound to the volume setting and exposes the actions', async () => {
    const { getByLabelText, queryByLabelText } = render(ReaderSettings);
    const select = getByLabelText('OCR layer') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
      'Primary',
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
});
