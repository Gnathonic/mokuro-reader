import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

const { toReader, showSnackbar, queueVolume } = vi.hoisted(() => ({
  toReader: vi.fn(),
  showSnackbar: vi.fn(),
  queueVolume: vi.fn()
}));
vi.mock('$lib/util/hash-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/util/hash-router')>();
  return { ...actual, nav: { ...actual.nav, toReader } };
});
vi.mock('$lib/util/snackbar', () => ({ showSnackbar }));
vi.mock('$lib/util/download-queue', () => ({ downloadQueue: { queueVolume } }));
vi.mock('$lib/catalog/cover-service', () => ({
  requestCover: vi.fn(async () => 'none' as const),
  isCoverFetchTarget: vi.fn(() => false)
}));

import VolumeCard from '../VolumeCard.svelte';
import type { VolumeMetadata } from '$lib/types';

function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'v-1',
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Vol 1',
    mokuro_version: '0.4.11',
    page_count: 100,
    character_count: 1000,
    page_char_counts: [],
    ...overrides
  } as VolumeMetadata;
}

const baseProps = {
  volumeId: 'v-1',
  seriesId: 'series-uuid',
  volumeTitle: 'Vol 1',
  progressPercentString: '10%',
  remainingPages: 90,
  isHovered: false,
  onHover: () => {},
  showProgressBar: false,
  showDeadline: false
};

/*
 * The tracker lists every volume with reading history. Three of those cannot
 * open in the reader: a row whose pages were removed (metadata-only), a cloud
 * placeholder, and — the case this file exists for — history with NO catalog
 * row at all (read on another device, series never resolved here). The last
 * one used to be treated as installed and sent the reader to "Volume not
 * found".
 */
describe('VolumeCard click', () => {
  beforeEach(() => {
    toReader.mockClear();
    showSnackbar.mockClear();
    queueVolume.mockClear();
  });
  afterEach(() => cleanup());

  it('opens an installed volume in the reader', async () => {
    const { container } = render(VolumeCard, { props: { ...baseProps, volume: volume() } });
    await tick();
    await fireEvent.click(container.querySelector('a')!);
    expect(toReader).toHaveBeenCalledWith('series-uuid', 'v-1');
    expect(showSnackbar).not.toHaveBeenCalled();
  });

  it('never sends a volume with no catalog row to the reader, and says why', async () => {
    const { container } = render(VolumeCard, { props: { ...baseProps, volume: undefined } });
    await tick();
    const link = container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('#/series/series-uuid');
    expect(container.textContent).toContain('Not on device');

    await fireEvent.click(link);
    expect(toReader).not.toHaveBeenCalled();
    expect(queueVolume).not.toHaveBeenCalled();
    expect(showSnackbar).toHaveBeenCalledTimes(1);
    const message = showSnackbar.mock.calls[0][0] as string;
    expect(message).toContain('Vol 1');
    expect(message).toMatch(/cloud/i);
  });

  it('draws a card-sized placeholder that wraps the full title above the badge', async () => {
    // The catalog's 250×350 placeholder centred its label off the bottom-right
    // edge of this 125×180 box, under "Not on device", so the title read as a
    // cut-off fragment.
    const title = 'Magical Girl Site Sept 01 — A Long Title That Needs Wrapping';
    const { container } = render(VolumeCard, {
      props: { ...baseProps, volumeTitle: title, volume: undefined }
    });
    await tick();

    const placeholder = container.querySelector('.placeholder')!;
    expect(placeholder).not.toBeNull();
    expect(placeholder.textContent).toContain(title);
    const classes = placeholder.className.split(/\s+/);
    expect(classes).toContain('text-center');
    expect(classes).toContain('break-words');
    expect(classes).toContain('pb-7'); // room for the badge strip
    expect(container.querySelector('img')).toBeNull();
  });

  it('names the volume when its row has no cloud copy to download', async () => {
    const { container } = render(VolumeCard, {
      props: { ...baseProps, volume: volume({ metadata_only: true }) }
    });
    await tick();
    await fireEvent.click(container.querySelector('a')!);
    expect(toReader).not.toHaveBeenCalled();
    expect(showSnackbar).toHaveBeenCalledTimes(1);
    expect(showSnackbar.mock.calls[0][0]).toContain('Vol 1');
  });

  it('queues a download when a not-installed row has a cloud copy', async () => {
    const { container } = render(VolumeCard, {
      props: {
        ...baseProps,
        volume: volume({
          metadata_only: true,
          cloudFileId: 'f-1',
          cloudProvider: 'webdav'
        } as never)
      }
    });
    await tick();
    await fireEvent.click(container.querySelector('a')!);
    expect(queueVolume).toHaveBeenCalledTimes(1);
    expect(toReader).not.toHaveBeenCalled();
  });
});
