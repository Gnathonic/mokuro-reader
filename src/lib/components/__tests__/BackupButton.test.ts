import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';

function readable<T>(value: T) {
  return {
    subscribe(fn: (v: T) => void) {
      fn(value);
      return () => {};
    }
  };
}

const { queueVolumeForBackup, getCloudFile } = vi.hoisted(() => ({
  queueVolumeForBackup: vi.fn(),
  getCloudFile: vi.fn((_series: string, _title: string): unknown => null)
}));
const showSnackbar = vi.hoisted(() => vi.fn());
const promptConfirmation = vi.hoisted(() =>
  vi.fn((_message: string, _onConfirm?: () => unknown) => {})
);
const deleteFile = vi.hoisted(() => vi.fn(async (_file: unknown) => {}));
const deleteManagedVolume = vi.hoisted(() =>
  vi.fn(async (_series: string, _volume: string, _uuid?: string) => {})
);
const canDeleteSeriesOnServer = vi.hoisted(() =>
  vi.fn((_series: string): { allowed: boolean; reason?: string } => ({ allowed: true }))
);
vi.mock('$lib/util/sync/metadata-permissions', () => ({ canDeleteSeriesOnServer }));
vi.mock('$lib/util', () => ({ showSnackbar, promptConfirmation }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    cloudFiles: readable(new Map()),
    getCloudFile: (series: string, title: string) => getCloudFile(series, title),
    isFetching: readable(false),
    getDefaultProvider: () => ({ type: 'webdav', name: 'WebDAV' }),
    getActiveProvider: () => ({ type: 'webdav', name: 'WebDAV' }),
    deleteFile: (file: unknown) => deleteFile(file),
    deleteManagedVolume: (series: string, title: string, uuid?: string) =>
      deleteManagedVolume(series, title, uuid)
  }
}));
vi.mock('$lib/util/sync', () => ({
  providerManager: {
    status: readable({
      hasAnyAuthenticated: true,
      currentProviderType: 'webdav',
      providers: { webdav: { isAuthenticated: true, isReadOnly: false } },
      needsAttention: false
    })
  }
}));
vi.mock('$lib/util/backup-queue', () => ({
  backupQueue: { subscribe: readable([]).subscribe, queueVolumeForBackup },
  isVolumeInBackupQueue: () => false
}));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: readable({ processes: [] })
}));

import BackupButton from '../BackupButton.svelte';
import { recordUploadFailure, resetUploadFailuresForTest } from '$lib/util/upload-failures';
import type { VolumeMetadata } from '$lib/types';

const volume = {
  volume_uuid: 'v9',
  series_uuid: 's',
  series_title: 'One Piece',
  volume_title: 'Volume 9',
  mokuro_version: '0.4.11',
  page_count: 1,
  character_count: 1,
  page_char_counts: [1]
} as VolumeMetadata;

beforeEach(() => {
  localStorage.clear();
  resetUploadFailuresForTest();
  queueVolumeForBackup.mockReset();
  showSnackbar.mockReset();
  promptConfirmation.mockReset();
  deleteFile.mockReset();
  deleteManagedVolume.mockReset();
  canDeleteSeriesOnServer.mockReset();
  canDeleteSeriesOnServer.mockImplementation(() => ({ allowed: true }));
  getCloudFile.mockReset();
  getCloudFile.mockImplementation(() => null);
});
afterEach(() => cleanup());

describe('BackupButton', () => {
  it('offers a plain backup when nothing failed', () => {
    const { getByText, queryByTestId } = render(BackupButton, { props: { volume } });
    expect(getByText(/Backup to WebDAV/)).toBeTruthy();
    expect(queryByTestId('upload-failed')).toBeNull();
  });

  it('shows a failed upload with its reason and a Retry, until it succeeds', async () => {
    recordUploadFailure({
      volume_uuid: 'v9',
      volume_title: 'Volume 9',
      series_title: 'One Piece',
      provider: 'webdav',
      reason: 'Member 003.jpg failed its CRC check'
    });
    const { getByTestId, getByRole } = render(BackupButton, { props: { volume } });
    expect(getByTestId('upload-failed').textContent).toContain(
      'Upload failed: Member 003.jpg failed its CRC check'
    );
    await fireEvent.click(getByRole('button', { name: /Retry/ }));
    expect(queueVolumeForBackup).toHaveBeenCalledWith(volume);
  });

  it('announces a queued volume as added', async () => {
    queueVolumeForBackup.mockReturnValue('added');
    const { getByRole } = render(BackupButton, { props: { volume } });
    await fireEvent.click(getByRole('button', { name: /Backup to WebDAV/ }));
    expect(showSnackbar).toHaveBeenCalledWith('Added Volume 9 to backup queue');
  });

  // The snackbar has one slot: the queue's own skip notice (a series another
  // account owns, bunko 0.8) must not be overwritten by a false "Added".
  it('says nothing over the notice of a volume the queue skipped', async () => {
    queueVolumeForBackup.mockReturnValue('refused');
    const { getByRole } = render(BackupButton, { props: { volume } });
    await fireEvent.click(getByRole('button', { name: /Backup to WebDAV/ }));
    expect(queueVolumeForBackup).toHaveBeenCalledWith(volume);
    expect(showSnackbar).not.toHaveBeenCalled();
  });

  it('a volume the queue already held is not announced as added', async () => {
    queueVolumeForBackup.mockReturnValue('already-queued');
    const { getByRole } = render(BackupButton, { props: { volume } });
    await fireEvent.click(getByRole('button', { name: /Backup to WebDAV/ }));
    expect(showSnackbar).toHaveBeenCalledWith('Volume already in backup queue');
  });

  it('reads a volume the cloud holds under its own spelling of the folder as backed up', () => {
    // `cloudFiles` is keyed by the exact folder, so there is nothing under the
    // local `one piece`. The backup queue uploads into the cloud's `One Piece/`
    // (resolveCloudFolderTitle); the "is it backed up" check must resolve the
    // same way — through the manager's selector — or every click re-uploads
    // the archive over itself.
    getCloudFile.mockImplementation((series, title) =>
      series === 'one piece' && title === 'Volume 9'
        ? {
            provider: 'webdav',
            fileId: 'f',
            path: 'One Piece/Volume 9.cbz',
            modifiedTime: 't',
            size: 1
          }
        : null
    );
    const { getByText, queryByText } = render(BackupButton, {
      props: { volume: { ...volume, series_title: 'one piece' } }
    });
    expect(getByText(/Delete from WebDAV/)).toBeTruthy();
    expect(queryByText(/Backup to WebDAV/)).toBeNull();
    expect(getCloudFile).toHaveBeenCalledWith('one piece', 'Volume 9');
  });

  describe('deleting the cloud copy', () => {
    const backedUp = {
      provider: 'webdav',
      fileId: 'f9',
      path: 'One Piece/Volume 9.cbz',
      modifiedTime: 't',
      size: 1
    };
    beforeEach(() => getCloudFile.mockImplementation(() => backedUp));

    it('asks first, naming the volume and the provider, and deletes nothing on the click', async () => {
      const { getByRole } = render(BackupButton, { props: { volume } });
      await fireEvent.click(getByRole('button', { name: /Delete from WebDAV/ }));
      expect(promptConfirmation).toHaveBeenCalledTimes(1);
      expect(promptConfirmation.mock.calls[0][0]).toBe('Delete Volume 9 from WebDAV?');
      expect(deleteFile).not.toHaveBeenCalled();
      expect(deleteManagedVolume).not.toHaveBeenCalled();
    });

    it('deletes the volume with its sidecars once the user says yes', async () => {
      const { getByRole } = render(BackupButton, { props: { volume } });
      await fireEvent.click(getByRole('button', { name: /Delete from WebDAV/ }));
      await promptConfirmation.mock.calls[0][1]?.();
      expect(deleteManagedVolume).toHaveBeenCalledWith('One Piece', 'Volume 9', 'v9');
      // Never the archive node alone: that orphans the .mokuro and cover.
      expect(deleteFile).not.toHaveBeenCalled();
      expect(showSnackbar).toHaveBeenCalledWith('Deleted from WebDAV');
    });

    it('asks nothing and deletes nothing where the server would refuse this account', async () => {
      canDeleteSeriesOnServer.mockImplementation(() => ({
        allowed: false,
        reason: 'Only the uploader can delete this series'
      }));
      const { getByRole } = render(BackupButton, { props: { volume } });
      await fireEvent.click(getByRole('button', { name: /Delete from WebDAV/ }));
      expect(canDeleteSeriesOnServer).toHaveBeenCalledWith('One Piece');
      expect(promptConfirmation).not.toHaveBeenCalled();
      expect(deleteManagedVolume).not.toHaveBeenCalled();
      expect(showSnackbar).toHaveBeenCalledWith('Only the uploader can delete this series');
    });
  });
});
