/**
 * Sidecar names rule v1 as Bunko's vectors state it
 * (`interop/contract/sidecar-names.json`; Bunko's `bunko_core::sidecar_names`
 * runs the same file): what a listed `.mokuro` is beside the archives of its
 * folder, and which layer ids Bunko keeps per account, shares as curated, or
 * reserves — and that the reader never pushes one it refuses. The reader's hand copy (`syncable-file.test.ts`) runs
 * without a Bunko checkout; this runs Bunko's own.
 */
import { expect, it } from 'vitest';
import { describeContractFile, sidecarNameVectors } from './contract';
import { cbzStemsOf, classifyMokuroSidecar } from '$lib/util/sync/syncable-file';
import { layerIdStaysLocal } from '$lib/catalog/mokuro-hash';
import {
  isCuratedLayerId,
  isPersonalLayerId,
  isReservedLayerId,
  isServerKeepsakeLayerId
} from '$lib/reader/edit/layer-names';

const vectors = sidecarNameVectors();

describeContractFile('sidecar-names.json', 'sidecar names rule v1 as Bunko states it', () => {
  it('is rule 1', () => {
    expect(vectors!.rule).toBe(1);
  });

  it.each(vectors?.classify ?? [])(
    '$name beside $folder ($why)',
    ({ name, folder, expect: want }) => {
      const got = classifyMokuroSidecar(name, cbzStemsOf(folder));
      expect(got.kind).toBe(want.kind);
      if (got.kind === 'orphan' || want.kind === 'orphan') return;
      // Both spell the stem as the name does: the reader builds names from it.
      expect(got.stem).toBe(want.stem);
      expect(got.gz).toBe(want.gz);
      if (want.kind === 'layer') expect(got).toMatchObject({ kind: 'layer', layerId: want.layer });
    }
  );

  it.each(vectors?.layer_class ?? [])('layer id $id is $class', ({ id, class: cls }) => {
    expect(isPersonalLayerId(id)).toBe(cls === 'personal');
    expect(isCuratedLayerId(id)).toBe(cls === 'curated');
    // The reader's server keepsakes are the copies only Bunko writes (a case
    // merge's `curated-<n>`), which Bunko classes Reserved.
    if (isServerKeepsakeLayerId(id)) expect(cls).toBe('reserved');
    // What Bunko refuses a client PUT of (or shares as curated) is never pushed
    // to it, and its cloud copy never deleted from here; an account's own goes up.
    const bunko = { serverCompilesMetadata: true, editLayerSync: 'push' as const };
    if (cls === 'curated' || cls === 'reserved') {
      expect(layerIdStaysLocal(id, bunko)).toBe(true);
    }
    if (cls === 'personal') expect(layerIdStaysLocal(id, bunko)).toBe(false);
    // An id Bunko gives a meaning of its own is one the reader never mints by
    // name (`slugifyLayerId`). The reader reserves more than these (`gcv`,
    // `tr-*`, … are `other` to Bunko), so only this direction holds.
    if (cls !== 'other') expect(isReservedLayerId(id)).toBe(true);
  });
});
