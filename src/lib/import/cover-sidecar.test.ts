import { describe, expect, it } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
import { installedUuids, pickCoverTarget } from './cover-sidecar';

function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'uuid-1',
    series_uuid: 'series-1',
    series_title: 'One Piece',
    volume_title: 'Volume 1',
    mokuro_version: '0.4.11',
    page_count: 200,
    character_count: 5000,
    page_char_counts: [],
    ...overrides
  };
}

describe('the cover sidecar of a cross-site import', () => {
  it('goes to the volume the request named', () => {
    const volumes = [volume(), volume({ volume_uuid: 'uuid-2', volume_title: 'Volume 2' })];

    const target = pickCoverTarget(volumes, new Set(), 'Volume 2');

    expect(target?.volume_uuid).toBe('uuid-2');
  });

  it('goes to a filled metadata-only row — the import DID bring that volume in', () => {
    // Its uuid existed before, so a plain "uuid I have not seen" snapshot would
    // drop the cover, or hand it to the unrelated volume next in the list.
    const before = installedUuids([
      volume({ volume_uuid: 'uuid-filled', metadata_only: true }),
      volume({ volume_uuid: 'uuid-other', volume_title: 'Volume 9' })
    ]);
    const after = [
      volume({ volume_uuid: 'uuid-filled' }),
      volume({ volume_uuid: 'uuid-other', volume_title: 'Volume 9' })
    ];

    const target = pickCoverTarget(after, before, 'Volume 1');

    expect(target?.volume_uuid).toBe('uuid-filled');
  });

  it('ignores a metadata-only row this import did not fill', () => {
    const before = installedUuids([volume({ volume_uuid: 'uuid-stripped', metadata_only: true })]);
    const after = [
      volume({ volume_uuid: 'uuid-stripped', metadata_only: true }),
      volume({ volume_uuid: 'uuid-new', volume_title: 'Volume 5' })
    ];

    const target = pickCoverTarget(after, before, 'Volume 5');

    expect(target?.volume_uuid).toBe('uuid-new');
  });

  it('picks nothing when the import installed nothing', () => {
    const volumes = [volume()];

    expect(pickCoverTarget(volumes, installedUuids(volumes), 'Volume 1')).toBeUndefined();
  });
});
