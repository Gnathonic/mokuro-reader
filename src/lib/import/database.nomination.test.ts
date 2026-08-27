import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { ProcessedVolume } from './types';

// The nomination is loaded dynamically by `saveVolume`, so mocking the module
// intercepts that import; the mock must exist before `saveVolume` runs.
const queueSidecarBackfillForVolume = vi.fn();
vi.mock('$lib/util/sync/sidecar-backfill', () => ({
  queueSidecarBackfillForVolume: (uuid: string) => queueSidecarBackfillForVolume(uuid)
}));

import { saveVolume } from './database';
import { db } from '$lib/catalog/db';

function processedVolume(uuid: string): ProcessedVolume {
  return {
    metadata: {
      volumeUuid: uuid,
      seriesUuid: `series-${uuid}`,
      series: 'One Piece',
      volume: `Volume ${uuid}`,
      mokuroVersion: '0.4.11',
      pageCount: 1,
      chars: 10,
      thumbnail: null,
      thumbnailWidth: 0,
      thumbnailHeight: 0
    },
    ocrData: {
      volume_uuid: uuid,
      pages: [{ blocks: [], img_width: 100, img_height: 100, img_path: 'p1.jpg' }]
    },
    fileData: {
      volume_uuid: uuid,
      files: { 'p1.jpg': new File(['x'], 'p1.jpg', { type: 'image/jpeg' }) }
    },
    nestedSources: []
  } as unknown as ProcessedVolume;
}

describe('a LOCAL import nominates for the lazy sidecar backfill', () => {
  beforeEach(async () => {
    queueSidecarBackfillForVolume.mockClear();
    await db.volumes.clear();
    await db.volume_ocr.clear();
    await db.volume_files.clear();
  });

  it('nominates the imported volume, exactly like a cloud download does', async () => {
    await saveVolume(processedVolume('local-import-1'));
    // The nomination rides a dynamic import — give it one macrotask to land.
    await new Promise((r) => setTimeout(r, 0));
    expect(queueSidecarBackfillForVolume).toHaveBeenCalledWith('local-import-1');
  });

  it('does not nominate when the save itself fails (duplicate install)', async () => {
    await saveVolume(processedVolume('local-import-2'));
    await new Promise((r) => setTimeout(r, 0));
    queueSidecarBackfillForVolume.mockClear();
    await expect(saveVolume(processedVolume('local-import-2'))).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(queueSidecarBackfillForVolume).not.toHaveBeenCalled();
  });
});
