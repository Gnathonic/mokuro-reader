import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';

// vi.hoisted: the vi.mock factories below run before this module's own imports, so the
// spy they close over has to be created here rather than via a later top-level const.
const { promptSeriesEditor } = vi.hoisted(() => ({ promptSeriesEditor: vi.fn() }));
vi.mock('$lib/util/modals', () => ({ promptSeriesEditor }));

// Stub the download-queue and cloud-thumbnails modules so this test doesn't drag in
// their real dependency graph (Dexie/db, google-drive api client, unified-cloud-manager,
// the whole import/sync pipeline) — none of which matter for the keyboard shortcut.
vi.mock('$lib/util/download-queue', () => ({
  downloadQueue: {
    subscribe: (fn: (v: unknown[]) => void) => {
      fn([]);
      return () => {};
    },
    getSeriesQueueStatus: () => ({ hasQueued: false, hasDownloading: false })
  }
}));
vi.mock('$lib/catalog/cloud-thumbnails', () => ({
  fetchCloudThumbnail: vi.fn(async () => null),
  getCachedCloudThumbnail: vi.fn(() => undefined)
}));

import CatalogItem from '../CatalogItem.svelte';
import type { VolumeMetadata } from '$lib/types';

function localVolume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'uuid-1',
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Vol 1',
    page_count: 10,
    isPlaceholder: false,
    ...overrides
  } as VolumeMetadata;
}

function placeholderVolume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'uuid-cloud-1',
    series_uuid: 'series-uuid',
    series_title: 'Cloud Only Series',
    volume_title: 'Vol 1',
    page_count: 10,
    isPlaceholder: true,
    ...overrides
  } as VolumeMetadata;
}

// The hovered card is the outer <div> the component itself renders inside its <a>.
function getCard(container: HTMLElement): HTMLElement {
  const card = container.querySelector('a > div');
  if (!card) throw new Error('card element not found');
  return card as HTMLElement;
}

describe('CatalogItem hover + "e" opens the series editor', () => {
  beforeEach(() => {
    promptSeriesEditor.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the series editor with the raw series title on hover + "e"', async () => {
    const { container } = render(CatalogItem, { props: { volumes: [localVolume()] } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).toHaveBeenCalledTimes(1);
    expect(promptSeriesEditor).toHaveBeenCalledWith('One Piece');
  });

  it('works for a placeholder (cloud-only) series card, using its raw title', async () => {
    const { container } = render(CatalogItem, { props: { volumes: [placeholderVolume()] } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).toHaveBeenCalledWith('Cloud Only Series');
  });

  it('does not open when a search input has focus, even while hovered', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const { container } = render(CatalogItem, { props: { volumes: [localVolume()] } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).not.toHaveBeenCalled();

    input.remove();
  });

  it('does not open when the card is not hovered', async () => {
    render(CatalogItem, { props: { volumes: [localVolume()] } });

    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).not.toHaveBeenCalled();
  });

  it('stops listening once the mouse leaves the card', async () => {
    const { container } = render(CatalogItem, { props: { volumes: [localVolume()] } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    await fireEvent.mouseLeave(card);
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).not.toHaveBeenCalled();
  });

  it('stops listening once the component is unmounted', async () => {
    const { container, unmount } = render(CatalogItem, { props: { volumes: [localVolume()] } });
    const card = getCard(container);

    await fireEvent.mouseEnter(card);
    unmount();
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).not.toHaveBeenCalled();
  });
});
