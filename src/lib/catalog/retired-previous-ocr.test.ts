import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deleteRetired } = vi.hoisted(() => ({ deleteRetired: vi.fn() }));

vi.mock('./db', () => ({ db: { name: 'test-db' } }));
vi.mock('./layer-store', () => ({ deleteRetiredPreviousOcrLayers: deleteRetired }));
vi.mock('$lib/settings/volume-data', async () => {
  const { writable } = await import('svelte/store');
  return {
    volumesWithTrash: writable({
      v1: { settings: { ocrLayer: 'previous-ocr' } },
      v2: { settings: {} }
    })
  };
});

import { PREVIOUS_OCR_RETIRED_KEY, retirePreviousOcrLayers } from './retired-previous-ocr';

describe('retirePreviousOcrLayers', () => {
  beforeEach(() => {
    localStorage.clear();
    deleteRetired.mockReset();
  });

  it('runs once per browser: the marker makes every later start a no-op', async () => {
    deleteRetired.mockResolvedValue(2);
    expect(await retirePreviousOcrLayers()).toBe(2);
    expect(localStorage.getItem(PREVIOUS_OCR_RETIRED_KEY)).toBe('1');
    expect(await retirePreviousOcrLayers()).toBe(0);
    expect(deleteRetired).toHaveBeenCalledTimes(1);
  });

  it('tells the storage which layer each volume displays (its ocrLayer setting)', async () => {
    deleteRetired.mockResolvedValue(0);
    await retirePreviousOcrLayers();
    const isDisplayed = deleteRetired.mock.calls[0][1] as (v: string, id: string) => boolean;
    expect(isDisplayed('v1', 'previous-ocr')).toBe(true);
    expect(isDisplayed('v1', 'previous-ocr-2')).toBe(false);
    expect(isDisplayed('v2', 'previous-ocr')).toBe(false);
    expect(isDisplayed('v9', 'previous-ocr')).toBe(false);
  });

  it('a failed run leaves the marker unset, so the next start retries', async () => {
    deleteRetired.mockRejectedValueOnce(new Error('idb closed'));
    await expect(retirePreviousOcrLayers()).rejects.toThrow('idb closed');
    expect(localStorage.getItem(PREVIOUS_OCR_RETIRED_KEY)).toBeNull();
    deleteRetired.mockResolvedValueOnce(1);
    expect(await retirePreviousOcrLayers()).toBe(1);
    expect(deleteRetired).toHaveBeenCalledTimes(2);
  });
});
