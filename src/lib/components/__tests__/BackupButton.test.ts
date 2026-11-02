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

const queueVolumeForBackup = vi.hoisted(() => vi.fn());
const showSnackbar = vi.hoisted(() => vi.fn());
vi.mock('$lib/util', () => ({ showSnackbar }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    cloudFiles: readable(new Map()),
    isFetching: readable(false),
    getDefaultProvider: () => ({ type: 'webdav', name: 'WebDAV' }),
    getActiveProvider: () => ({ type: 'webdav', name: 'WebDAV' }),
    deleteFile: vi.fn()
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
});
