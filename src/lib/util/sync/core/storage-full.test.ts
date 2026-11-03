import { describe, it, expect } from 'vitest';
import { isStorageFullFailure, storageFullMessage, workerFailureKind } from './storage-full';
import { DriveHttpError, driveRefusal, driveStorageFullError } from './providers/drive-http';
import { oneDriveStorageFullError } from '../providers/onedrive/graph-errors';
import { ProviderError } from '../provider-interface';

describe('workerFailureKind', () => {
  it('is quota for the typed storage-full errors the cores throw', () => {
    expect(workerFailureKind(driveStorageFullError())).toBe('quota');
    expect(workerFailureKind(driveRefusal(new DriveHttpError(403, 'storageQuotaExceeded')))).toBe(
      'quota'
    );
    expect(workerFailureKind(oneDriveStorageFullError())).toBe('quota');
    expect(
      workerFailureKind(new ProviderError('MEGA storage is full', 'mega', 'QUOTA_EXCEEDED'))
    ).toBe('quota');
    // A raw DriveHttpError still says so by its kind.
    expect(workerFailureKind(new DriveHttpError(403, 'storageQuotaExceeded'))).toBe('quota');
  });

  it('reads a full account out of a serialized message', () => {
    expect(workerFailureKind(new Error('Upload init failed: 403 [storageQuotaExceeded]'))).toBe(
      'quota'
    );
    expect(workerFailureKind(new Error('OneDrive storage full (507 insufficientStorage)'))).toBe(
      'quota'
    );
    expect(workerFailureKind(new Error('EOVERQUOTA (-17): Request over quota'))).toBe('quota');
    expect(
      workerFailureKind(
        new Error('Google Drive storage is full — free up space or upgrade your plan')
      )
    ).toBe('quota');
  });

  it('is undefined for anything else, including a Drive rate limit or usage quota', () => {
    expect(workerFailureKind(new DriveHttpError(429, 'storageQuotaExceeded'))).toBeUndefined();
    expect(workerFailureKind(new DriveHttpError(403, 'quotaExceeded'))).toBeUndefined();
    expect(workerFailureKind(new Error('Upload failed: 403 [quotaExceeded]'))).toBeUndefined();
    expect(
      workerFailureKind(new Error('Upload failed: 429 Too Many Requests [storageQuotaExceeded]'))
    ).toBeUndefined();
    expect(workerFailureKind(new DriveHttpError(403, 'numChildrenInNonRootLimitExceeded'))).toBe(
      undefined
    );
    expect(
      workerFailureKind(new ProviderError('Upload failed', 'google-drive', 'UPLOAD_FAILED'))
    ).toBeUndefined();
    expect(workerFailureKind(new Error('Network error during download'))).toBeUndefined();
    expect(workerFailureKind('nope')).toBeUndefined();
    expect(workerFailureKind(undefined)).toBeUndefined();
  });
});

describe('isStorageFullFailure', () => {
  it('trusts the kind, else the message', () => {
    expect(isStorageFullFailure({ kind: 'quota', error: 'anything' })).toBe(true);
    expect(isStorageFullFailure({ error: 'Upload failed: 403 [storageQuotaExceeded]' })).toBe(true);
    expect(isStorageFullFailure({ error: 'Worker pool terminated' })).toBe(false);
    expect(isStorageFullFailure({})).toBe(false);
  });
});

describe('storageFullMessage', () => {
  it("matches the providers' own QUOTA_EXCEEDED wording", () => {
    expect(storageFullMessage('google-drive')).toBe(
      'Google Drive storage is full — free up space or upgrade your plan'
    );
    expect(storageFullMessage('onedrive')).toBe(
      'OneDrive storage is full — free up space or upgrade your plan'
    );
    expect(storageFullMessage('mega')).toBe(
      'MEGA storage is full — free up space or upgrade your plan'
    );
    expect(storageFullMessage('whatever')).toMatch(/^Cloud storage is full/);
  });
});
