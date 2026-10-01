import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const { declareMokuroSchema } = await import('$lib/catalog/db-schema');
  const db: any = new Dexie('mokuro-upload-record-test');
  declareMokuroSchema(db);
  return { db };
});

import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { sha256Hex } from './mokuro-hash';
import {
  UPLOAD_RECORD_FLUSH_MS,
  _resetUploadRecordsForTests,
  flushUploadRecords,
  noteUploadedPrimarySidecar,
  recordUploadedPrimarySidecar,
  recordUploadedPrimarySidecarBlob
} from './mokuro-upload-record';

function row(partial: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'vol-1',
    series_uuid: 's',
    series_title: 'S',
    volume_title: 'Vol 1',
    mokuro_version: '0.2.1',
    page_count: 1,
    character_count: 1,
    page_char_counts: [1],
    mokuro_sha256: 'f'.repeat(64),
    ...partial
  };
}

const H = 'a'.repeat(64);

beforeEach(async () => {
  _resetUploadRecordsForTests();
  await db.volumes.clear();
});

describe('recording this device’s own primary sidecar upload', () => {
  it('makes the uploaded bytes the volume’s hash, attested with the provider, size and server mtime', async () => {
    await db.volumes.put(row());
    await recordUploadedPrimarySidecar('vol-1', {
      sha256: H,
      provider: 'webdav',
      size: 120,
      modifiedTime: '2026-09-30T10:00:00Z'
    });
    expect(await db.volumes.get('vol-1')).toMatchObject({
      mokuro_sha256: H,
      mokuro_sha256_cloud: {
        provider: 'webdav',
        size: 120,
        modified: Date.parse('2026-09-30T10:00:00Z') / 1000
      }
    });
  });

  it('hashes exactly the blob that was sent, and ignores a provisional mtime', async () => {
    await db.volumes.put(row());
    const blob = new Blob(['{"version":"0.2.1"}']);
    await recordUploadedPrimarySidecarBlob('vol-1', 'mega', blob, {
      modifiedTime: '2026-09-30T10:00:00Z',
      modifiedTimeProvisional: true
    });
    const stored = (await db.volumes.get('vol-1'))!;
    expect(stored.mokuro_sha256).toBe(await sha256Hex(blob));
    expect(stored.mokuro_sha256_cloud).toEqual({ provider: 'mega', size: blob.size });
  });

  it('touches only an installed row', async () => {
    await db.volumes.put(row({ metadata_only: true }));
    await recordUploadedPrimarySidecar('vol-1', { sha256: H, provider: 'webdav', size: 1 });
    expect((await db.volumes.get('vol-1'))!.mokuro_sha256).toBe('f'.repeat(64));
    await expect(
      recordUploadedPrimarySidecar('missing', { sha256: H, provider: 'webdav', size: 1 })
    ).resolves.toBeUndefined();
  });

  it('the backfill’s batched variant writes nothing until the burst is over, then all at once', async () => {
    await db.volumes.bulkPut([row(), row({ volume_uuid: 'vol-2', volume_title: 'Vol 2' })]);
    noteUploadedPrimarySidecar('vol-1', { sha256: H, provider: 'webdav', size: 1 });
    noteUploadedPrimarySidecar('vol-2', { sha256: 'b'.repeat(64), provider: 'webdav', size: 2 });
    expect((await db.volumes.get('vol-1'))!.mokuro_sha256).toBe('f'.repeat(64));
    await vi.waitFor(
      async () => {
        expect((await db.volumes.get('vol-1'))!.mokuro_sha256).toBe(H);
        expect((await db.volumes.get('vol-2'))!.mokuro_sha256).toBe('b'.repeat(64));
      },
      { timeout: UPLOAD_RECORD_FLUSH_MS * 4 }
    );
  });

  it('flushUploadRecords writes the queue at once', async () => {
    await db.volumes.put(row());
    noteUploadedPrimarySidecar('vol-1', { sha256: H, provider: 'webdav', size: 1 });
    await flushUploadRecords();
    expect((await db.volumes.get('vol-1'))!.mokuro_sha256).toBe(H);
  });
});
