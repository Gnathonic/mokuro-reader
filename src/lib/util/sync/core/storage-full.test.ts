import { describe, it, expect } from 'vitest';
import { isStorageFullFailure, storageFullMessage, workerFailureKind } from './storage-full';
import { DriveHttpError } from './providers/drive-http';
import { GraphQuotaError } from '../providers/onedrive/graph-errors';

describe('workerFailureKind', () => {
  it('is quota for the typed Drive and Graph errors', () => {
    expect(workerFailureKind(new DriveHttpError(403, 'storageQuotaExceeded'))).toBe('quota');
    expect(workerFailureKind(new GraphQuotaError(507, 'insufficientStorage'))).toBe('quota');
  });

  it('reads a full account out of a serialized message', () => {
    expect(workerFailureKind(new Error('Upload init failed: 403 [storageQuotaExceeded]'))).toBe(
      'quota'
    );
    expect(workerFailureKind(new Error('OneDrive storage full (507 insufficientStorage)'))).toBe(
      'quota'
    );
    expect(workerFailureKind(new Error('EOVERQUOTA (-17): Request over quota'))).toBe('quota');
  });

  it('is undefined for anything else, including a Drive rate limit or usage quota', () => {
    expect(workerFailureKind(new DriveHttpError(429, 'storageQuotaExceeded'))).toBeUndefined();
    expect(workerFailureKind(new DriveHttpError(403, 'quotaExceeded'))).toBeUndefined();
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
