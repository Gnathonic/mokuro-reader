import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';

/**
 * An uploaded cover must be a raster image by its BYTES. SVG is an unsupported
 * format; the picker used to take any `image/*`, SVG included, and showed it
 * through an object URL of the file as uploaded.
 */

vi.mock('$lib/util/volume-editor', () => ({ getVolumeFiles: vi.fn(async () => []) }));
const snackbar = vi.hoisted(() => vi.fn());
vi.mock('$lib/util', () => ({ showSnackbar: snackbar }));

import VolumeEditorCoverPicker from '../VolumeEditorCoverPicker.svelte';
import { RASTER_IMAGE_TYPES } from '$lib/util/raster-image';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

async function upload(file: File) {
  const onSelect = vi.fn();
  render(VolumeEditorCoverPicker, {
    props: { volumeUuid: 'vol-1', onSelect, onCancel: vi.fn() }
  });
  const input = await waitFor(() => {
    const el = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(el).not.toBeNull();
    return el!;
  });
  // jsdom has no DataTransfer to build a real FileList; Flowbite's
  // `bind:files` writes the property back, so it needs a setter too.
  const files = Object.assign([file], { item: (i: number) => (i === 0 ? file : null) });
  Object.defineProperty(input, 'files', { get: () => files, set: () => {}, configurable: true });
  await fireEvent.change(input);
  return { onSelect, input };
}

afterEach(() => {
  cleanup();
  snackbar.mockClear();
});

describe('VolumeEditorCoverPicker upload', () => {
  it('offers raster types only in the file dialog', async () => {
    const { input } = await upload(new File([PNG], 'c.png', { type: 'image/png' }));
    expect(input.accept).toBe(RASTER_IMAGE_TYPES.join(','));
    expect(input.accept).not.toContain('svg');
  });

  it('takes a raster image whatever its type says', async () => {
    const { onSelect } = await upload(new File([PNG], 'cover', { type: '' }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(snackbar).not.toHaveBeenCalled();
  });

  it('refuses an SVG, even one typed or named as a raster image', async () => {
    for (const [name, type] of [
      ['c.svg', 'image/svg+xml'],
      ['c.png', 'image/png']
    ]) {
      const { onSelect } = await upload(new File([SVG], name, { type }));
      await waitFor(() => expect(snackbar).toHaveBeenCalledWith(expect.stringContaining('SVG')));
      expect(onSelect).not.toHaveBeenCalled();
      cleanup();
      snackbar.mockClear();
    }
  });
});
