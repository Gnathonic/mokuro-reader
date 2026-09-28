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
vi.mock('$lib/util', () => ({ showSnackbar: vi.fn() }));
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
});
