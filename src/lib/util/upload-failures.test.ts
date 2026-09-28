import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  clearUploadFailure,
  recordUploadFailure,
  resetUploadFailuresForTest,
  uploadFailures
} from './upload-failures';

const failure = {
  volume_uuid: 'v1',
  volume_title: 'Vol 1',
  series_title: 'S',
  provider: 'webdav',
  reason: 'Member 003.jpg failed its CRC check'
};

beforeEach(() => {
  localStorage.clear();
  resetUploadFailuresForTest();
});

describe('upload failures', () => {
  it('records a failure per volume, persisted', () => {
    recordUploadFailure(failure, new Date('2026-09-27T20:00:00Z'));
    expect(get(uploadFailures).v1).toEqual({ ...failure, at: '2026-09-27T20:00:00.000Z' });
    expect(JSON.parse(localStorage.getItem('upload-failures:v1')!)).toHaveProperty('v1');
  });

  it('survives a reload', () => {
    recordUploadFailure(failure);
    resetUploadFailuresForTest({ keepStorage: true });
    expect(get(uploadFailures).v1?.reason).toBe(failure.reason);
  });

  it('clears on success', () => {
    recordUploadFailure(failure);
    clearUploadFailure('v1');
    expect(get(uploadFailures)).toEqual({});
    expect(localStorage.getItem('upload-failures:v1')).toBeNull();
  });

  it('ignores junk in storage', () => {
    localStorage.setItem('upload-failures:v1', '{"v1": {"nope": 1}, "v2": 3}');
    resetUploadFailuresForTest({ keepStorage: true });
    expect(get(uploadFailures)).toEqual({});
  });
});
