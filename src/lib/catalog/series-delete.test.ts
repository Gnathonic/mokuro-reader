import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  promptConfirmation,
  showSnackbar,
  removeVolumeFiles,
  deleteVolumeCompletely,
  deleteVolumeStats,
  existsInCloud,
  deleteSeriesFolder,
  fetchAllCloudVolumes,
  getCloudVolumesBySeries,
  resolveCloudFolderTitle,
  providerStatus
} = vi.hoisted(() => ({
  promptConfirmation: vi.fn(),
  showSnackbar: vi.fn(),
  removeVolumeFiles: vi.fn(async () => {}),
  deleteVolumeCompletely: vi.fn(async () => {}),
  deleteVolumeStats: vi.fn(),
  existsInCloud: vi.fn((_series: string, _title: string) => false),
  deleteSeriesFolder: vi.fn(async () => ({ succeeded: 2, failed: 0 })),
  fetchAllCloudVolumes: vi.fn(async () => {}),
  getCloudVolumesBySeries: vi.fn((_series: string) => [] as unknown[]),
  resolveCloudFolderTitle: vi.fn((series: string) => series),
  providerStatus: {
    value: {
      hasAnyAuthenticated: false,
      currentProviderType: null as string | null,
      providers: {} as Record<string, { isReadOnly?: boolean } | null>
    }
  }
}));

vi.mock('$lib/util/modals', () => ({ promptConfirmation }));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar }));
vi.mock('$lib/import', () => ({ removeVolumeFiles, deleteVolumeCompletely }));
vi.mock('$lib/settings', () => ({ deleteVolume: deleteVolumeStats }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    existsInCloud,
    deleteSeriesFolder,
    fetchAllCloudVolumes,
    getCloudVolumesBySeries,
    resolveCloudFolderTitle,
    getActiveProvider: () => ({ name: 'Drive' })
  }
}));
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: {
    status: {
      subscribe: (fn: (v: unknown) => void) => {
        fn(providerStatus.value);
        return () => {};
      }
    }
  }
}));

import { promptSeriesRemoval } from './series-delete';
import { normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import type { VolumeMetadata } from '$lib/types';

function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
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

/** Run the confirm callback the dialog was opened with. */
async function confirm(forget?: boolean, deleteCloud?: boolean) {
  const [, onConfirm] = promptConfirmation.mock.calls.at(-1) as unknown as [
    string,
    (forget?: boolean, deleteCloud?: boolean) => Promise<void>
  ];
  await onConfirm(forget, deleteCloud);
}

describe('promptSeriesRemoval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsInCloud.mockReturnValue(false);
    getCloudVolumesBySeries.mockReturnValue([]);
    resolveCloudFolderTitle.mockImplementation((series: string) => series);
    providerStatus.value = {
      hasAnyAuthenticated: false,
      currentProviderType: null,
      providers: {}
    };
  });

  it('asks the "remove from this device" question for installed volumes', async () => {
    expect(await promptSeriesRemoval([volume()])).toBe(true);

    const [message, , , checkbox] = promptConfirmation.mock.calls[0];
    expect(message).toBe(
      'Remove this manga from this device? Stats, progress and covers are kept.'
    );
    expect(checkbox).toEqual({
      label: 'Also forget stats, progress and covers?',
      storageKey: 'forgetVolumePreference',
      defaultValue: false
    });
  });

  it('strips the files but keeps the rows by default', async () => {
    await promptSeriesRemoval([volume(), volume({ volume_uuid: 'uuid-2' })]);
    await confirm();

    expect(removeVolumeFiles).toHaveBeenCalledTimes(2);
    expect(deleteVolumeCompletely).not.toHaveBeenCalled();
    expect(deleteVolumeStats).not.toHaveBeenCalled();
  });

  it('forgets the rows, stats and covers when the box is ticked', async () => {
    await promptSeriesRemoval([volume()]);
    await confirm(true);

    expect(deleteVolumeCompletely).toHaveBeenCalledWith('uuid-1');
    expect(deleteVolumeStats).toHaveBeenCalledWith('uuid-1');
    expect(removeVolumeFiles).not.toHaveBeenCalled();
  });

  it('asks the forget question with no checkbox once every volume is already removed', async () => {
    await promptSeriesRemoval([volume({ metadata_only: true })]);

    const [message, , , checkbox] = promptConfirmation.mock.calls[0];
    expect(message).toBe('Forget this manga? Its stats, progress and covers will be deleted.');
    expect(checkbox).toBeUndefined();

    await confirm();
    expect(deleteVolumeCompletely).toHaveBeenCalledWith('uuid-1');
    expect(deleteVolumeStats).toHaveBeenCalledWith('uuid-1');
  });

  it('offers the cloud delete only when volumes are backed up and the provider is writable', async () => {
    existsInCloud.mockReturnValue(true);
    providerStatus.value = {
      hasAnyAuthenticated: true,
      currentProviderType: 'google-drive',
      providers: {}
    };

    await promptSeriesRemoval([volume()]);
    const [, , , , cloudCheckbox] = promptConfirmation.mock.calls[0];
    expect(cloudCheckbox).toEqual({
      label: 'Also delete from Drive?',
      storageKey: 'deleteCloudPreference',
      defaultValue: false
    });
  });

  it('hides the cloud delete on a read-only WebDAV provider', async () => {
    existsInCloud.mockReturnValue(true);
    providerStatus.value = {
      hasAnyAuthenticated: true,
      currentProviderType: 'webdav',
      providers: { webdav: { isReadOnly: true } }
    };

    await promptSeriesRemoval([volume()]);
    expect(promptConfirmation.mock.calls[0][4]).toBeUndefined();
  });

  it('deletes the cloud folder when that box is ticked', async () => {
    existsInCloud.mockReturnValue(true);
    getCloudVolumesBySeries.mockReturnValue([{ path: 'One Piece/Vol 1.cbz' }]);
    providerStatus.value = {
      hasAnyAuthenticated: true,
      currentProviderType: 'google-drive',
      providers: {}
    };

    await promptSeriesRemoval([volume()]);
    await confirm(false, true);

    expect(deleteSeriesFolder).toHaveBeenCalledWith('One Piece');
    expect(showSnackbar).toHaveBeenCalledWith('Deleted 2 volume(s) from Drive');
  });

  it('deletes a folder the cloud spells differently — the one the dialog offered', async () => {
    // A server that merged `one piece/` into `One Piece/`, before this device
    // adopted the spelling (or plain storage, which never adopts). The dialog's
    // "backed up?" check and the delete path must resolve the folder the same
    // way: offering the box and then answering "No volumes found" is a lie.
    const listing = [{ path: 'One Piece/Vol 1.cbz' }];
    getCloudVolumesBySeries.mockImplementation((series: string) =>
      listing.filter((file) => file.path.startsWith(`${series}/`))
    );
    resolveCloudFolderTitle.mockImplementation((series: string) =>
      listing.some((file) => file.path.startsWith(`${series}/`))
        ? series
        : (listing
            .map((file) => file.path.split('/')[0])
            .find(
              (folder) => normalizeVolumeTitleKey(folder) === normalizeVolumeTitleKey(series)
            ) ?? series)
    );
    existsInCloud.mockImplementation((series: string, title: string) =>
      getCloudVolumesBySeries(resolveCloudFolderTitle(series)).some((file) =>
        (file as { path: string }).path.endsWith(`/${title}.cbz`)
      )
    );
    providerStatus.value = {
      hasAnyAuthenticated: true,
      currentProviderType: 'google-drive',
      providers: {}
    };

    await promptSeriesRemoval([volume({ series_title: 'one piece' })]);
    expect(promptConfirmation.mock.calls[0][4]).toMatchObject({ label: 'Also delete from Drive?' });
    await confirm(false, true);

    expect(showSnackbar).not.toHaveBeenCalledWith('No volumes found in Drive');
    expect(deleteSeriesFolder).toHaveBeenCalledWith('one piece');
    expect(showSnackbar).toHaveBeenCalledWith('Deleted 2 volume(s) from Drive');
  });

  it('leaves the cloud alone when the box is not ticked', async () => {
    existsInCloud.mockReturnValue(true);
    providerStatus.value = {
      hasAnyAuthenticated: true,
      currentProviderType: 'google-drive',
      providers: {}
    };

    await promptSeriesRemoval([volume()]);
    await confirm();

    expect(deleteSeriesFolder).not.toHaveBeenCalled();
  });

  it('runs the caller’s callback once the rows are gone', async () => {
    const onRemoved = vi.fn();
    await promptSeriesRemoval([volume()], { onRemoved });
    await confirm();
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it('ignores placeholders: a cloud-only series has nothing here to remove', async () => {
    expect(await promptSeriesRemoval([volume({ isPlaceholder: true })])).toBe(false);
    expect(promptConfirmation).not.toHaveBeenCalled();
  });

  it('removes only the real rows when a series mixes rows and placeholders', async () => {
    await promptSeriesRemoval([volume(), volume({ volume_uuid: 'cloud-1', isPlaceholder: true })]);
    await confirm();

    expect(removeVolumeFiles).toHaveBeenCalledTimes(1);
    expect(removeVolumeFiles).toHaveBeenCalledWith('uuid-1');
  });

  it('does nothing at all for an empty series', async () => {
    expect(await promptSeriesRemoval([])).toBe(false);
    expect(promptConfirmation).not.toHaveBeenCalled();
  });
});

describe('promptSeriesRemoval never stacks two dialogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsInCloud.mockReturnValue(false);
    getCloudVolumesBySeries.mockReturnValue([]);
    resolveCloudFolderTitle.mockImplementation((series: string) => series);
    providerStatus.value = {
      hasAnyAuthenticated: false,
      currentProviderType: null,
      providers: {}
    };
  });

  it('ignores a second press that lands while the first is still gathering', async () => {
    // Both calls are made before either has crossed its cloud-context await, which is
    // exactly what two quick Delete presses do (`anyModalOpen` cannot see a dialog yet).
    const [first, second] = await Promise.all([
      promptSeriesRemoval([volume()]),
      promptSeriesRemoval([volume()])
    ]);

    expect([first, second]).toEqual([true, false]);
    expect(promptConfirmation).toHaveBeenCalledTimes(1);
  });

  it('is ready again for the next press', async () => {
    await promptSeriesRemoval([volume()]);
    expect(await promptSeriesRemoval([volume()])).toBe(true);
    expect(promptConfirmation).toHaveBeenCalledTimes(2);
  });
});
