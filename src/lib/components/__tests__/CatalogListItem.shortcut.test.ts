import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';

// vi.hoisted: the vi.mock factories below run before this module's own imports, so the
// spy they close over has to be created here rather than via a later top-level const.
const { promptSeriesEditor, promptSeriesRemoval } = vi.hoisted(() => ({
  promptSeriesEditor: vi.fn(),
  promptSeriesRemoval: vi.fn(async (_volumes: unknown[], _options?: unknown) => true)
}));
vi.mock('$lib/util/modals', () => ({ promptSeriesEditor, promptConfirmation: vi.fn() }));
vi.mock('$lib/catalog/series-delete', () => ({ promptSeriesRemoval }));

// Stub download-queue and the catalog barrel (which pulls in Dexie/db, unified-cloud-manager,
// and the rest of the sync stack) — none of that matters for the keyboard shortcut.
vi.mock('$lib/util/download-queue', () => ({
  downloadQueue: {
    subscribe: (fn: (v: unknown[]) => void) => {
      fn([]);
      return () => {};
    },
    getSeriesQueueStatus: () => ({ hasQueued: false, hasDownloading: false })
  }
}));
vi.mock('$lib/catalog', () => ({
  volumes: {
    subscribe: (fn: (v: Record<string, unknown>) => void) => {
      fn({});
      return () => {};
    }
  }
}));

import CatalogListItem from '../CatalogListItem.svelte';
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

// The hovered row is the outer <div> the component renders around the ListgroupItem.
function getRow(container: HTMLElement): HTMLElement {
  const row = container.querySelector('div');
  if (!row) throw new Error('row element not found');
  return row as HTMLElement;
}

describe('CatalogListItem hover + "e" opens the series editor', () => {
  beforeEach(() => {
    promptSeriesEditor.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the series editor with the raw series title on hover + "e"', async () => {
    const { container } = render(CatalogListItem, { props: { volumes: [localVolume()] } });
    const row = getRow(container);

    await fireEvent.mouseEnter(row);
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).toHaveBeenCalledTimes(1);
    expect(promptSeriesEditor).toHaveBeenCalledWith('One Piece');
  });

  it('works for a placeholder (cloud-only) series row, using its raw title', async () => {
    const { container } = render(CatalogListItem, { props: { volumes: [placeholderVolume()] } });
    const row = getRow(container);

    await fireEvent.mouseEnter(row);
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).toHaveBeenCalledWith('Cloud Only Series');
  });

  it('does not open when a search input has focus, even while hovered', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const { container } = render(CatalogListItem, { props: { volumes: [localVolume()] } });
    const row = getRow(container);

    await fireEvent.mouseEnter(row);
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).not.toHaveBeenCalled();

    input.remove();
  });

  it('does not open when the row is not hovered', async () => {
    render(CatalogListItem, { props: { volumes: [localVolume()] } });

    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).not.toHaveBeenCalled();
  });

  it('stops listening once the mouse leaves the row', async () => {
    const { container } = render(CatalogListItem, { props: { volumes: [localVolume()] } });
    const row = getRow(container);

    await fireEvent.mouseEnter(row);
    await fireEvent.mouseLeave(row);
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).not.toHaveBeenCalled();
  });

  it('stops listening once the component is unmounted', async () => {
    const { container, unmount } = render(CatalogListItem, { props: { volumes: [localVolume()] } });
    const row = getRow(container);

    await fireEvent.mouseEnter(row);
    unmount();
    await fireEvent.keyDown(window, { key: 'e' });

    expect(promptSeriesEditor).not.toHaveBeenCalled();
  });
});

describe('CatalogListItem hover + Delete raises the series removal dialog', () => {
  beforeEach(() => {
    promptSeriesRemoval.mockClear();
  });

  afterEach(() => {
    cleanup();
    document.querySelectorAll('dialog').forEach((el) => el.remove());
  });

  it('removes the hovered series, handing over its volumes', async () => {
    const volumes = [localVolume(), localVolume({ volume_uuid: 'uuid-2' })];
    const { container } = render(CatalogListItem, { props: { volumes } });

    await fireEvent.mouseEnter(getRow(container));
    await fireEvent.keyDown(window, { key: 'Delete' });

    expect(promptSeriesRemoval).toHaveBeenCalledTimes(1);
    expect(promptSeriesRemoval.mock.calls[0][0]).toEqual(volumes);
  });

  it('does nothing when the row is not hovered', async () => {
    render(CatalogListItem, { props: { volumes: [localVolume()] } });
    await fireEvent.keyDown(window, { key: 'Delete' });
    expect(promptSeriesRemoval).not.toHaveBeenCalled();
  });

  it('does not fire while a modal is already open', async () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.appendChild(dialog);

    const { container } = render(CatalogListItem, { props: { volumes: [localVolume()] } });
    await fireEvent.mouseEnter(getRow(container));
    await fireEvent.keyDown(window, { key: 'Delete' });

    expect(promptSeriesRemoval).not.toHaveBeenCalled();
  });

  it('ignores key repeats', async () => {
    const { container } = render(CatalogListItem, { props: { volumes: [localVolume()] } });
    await fireEvent.mouseEnter(getRow(container));

    await fireEvent.keyDown(window, { key: 'Delete' });
    await fireEvent.keyDown(window, { key: 'Delete', repeat: true });

    expect(promptSeriesRemoval).toHaveBeenCalledTimes(1);
  });
});
