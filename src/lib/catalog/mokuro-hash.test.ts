import { describe, expect, it } from 'vitest';
import {
  isMokuroCloudAttestation,
  isMokuroSha256,
  isUntouchedUpgradeLayer,
  layerStaysLocal,
  sha256Hex,
  type LayerTarget
} from './mokuro-hash';

describe('sha256Hex', () => {
  // FIPS 180-2 test vector: SHA-256("abc").
  const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

  it('hashes a Blob, an ArrayBuffer and a Uint8Array to the same lowercase hex', async () => {
    const bytes = new TextEncoder().encode('abc');
    expect(await sha256Hex(new Blob([bytes]))).toBe(ABC);
    expect(await sha256Hex(bytes)).toBe(ABC);
    expect(await sha256Hex(bytes.buffer.slice(0) as ArrayBuffer)).toBe(ABC);
  });

  it('hashes the JSON bytes exactly — no normalisation of whitespace or key order', async () => {
    const a = await sha256Hex(new Blob(['{"a":1,"b":2}']));
    const b = await sha256Hex(new Blob(['{"b":2,"a":1}']));
    const c = await sha256Hex(new Blob(['{"a": 1,"b":2}']));
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('isMokuroSha256', () => {
  it('accepts exactly 64 lowercase hex digits', () => {
    expect(isMokuroSha256('a'.repeat(64))).toBe(true);
    expect(isMokuroSha256('A'.repeat(64))).toBe(false);
    expect(isMokuroSha256('a'.repeat(63))).toBe(false);
    expect(isMokuroSha256('g'.repeat(64))).toBe(false);
    expect(isMokuroSha256(undefined)).toBe(false);
    expect(isMokuroSha256(42)).toBe(false);
  });
});

describe('isMokuroCloudAttestation', () => {
  it('wants a provider and a positive whole size; the mtime is optional', () => {
    expect(isMokuroCloudAttestation({ provider: 'webdav', size: 10 })).toBe(true);
    expect(isMokuroCloudAttestation({ provider: 'webdav', size: 10, modified: 5 })).toBe(true);
    expect(isMokuroCloudAttestation({ provider: 'webdav', size: 0 })).toBe(false);
    expect(isMokuroCloudAttestation({ size: 10 })).toBe(false);
    expect(isMokuroCloudAttestation({ provider: 'webdav', size: 10, modified: -1 })).toBe(false);
    expect(isMokuroCloudAttestation(undefined)).toBe(false);
  });
});

describe('isUntouchedUpgradeLayer', () => {
  it('holds while source_at equals updated_at, and dies with the first edit', () => {
    const row = { source_sha256: 'a'.repeat(64), source_at: 't1', updated_at: 't1' };
    expect(isUntouchedUpgradeLayer(row)).toBe(true);
    expect(isUntouchedUpgradeLayer({ ...row, updated_at: 't2' })).toBe(false);
    expect(isUntouchedUpgradeLayer({ updated_at: 't1' })).toBe(false);
    expect(isUntouchedUpgradeLayer(undefined)).toBe(false);
  });

  it('also holds for a previous-ocr keepsake with no source hash (a legacy primary had none)', () => {
    expect(isUntouchedUpgradeLayer({ source_at: 't1', updated_at: 't1' })).toBe(true);
    expect(isUntouchedUpgradeLayer({ source_at: 't1', updated_at: 't2' })).toBe(false);
  });
});

describe('layerStaysLocal', () => {
  const PLAIN: LayerTarget = { serverCompilesMetadata: false };
  const BUNKO_08: LayerTarget = { serverCompilesMetadata: true, editLayerSync: 'push' };
  const BUNKO_07: LayerTarget = { serverCompilesMetadata: true, editLayerSync: 'local' };
  const row = (layer_id: string) => ({ layer_id, updated_at: 't1' });

  it.each([
    // id, plain storage, bunko 0.8 (per-account edit), bunko 0.7 (shared edit)
    ['curated', true, true, true],
    ['edit', false, false, true],
    ['edit-2', false, false, true],
    ['pre-upgrade', false, true, true],
    ['pre-upgrade-3', false, true, true],
    // What bunko reserves and refuses a client PUT of (its `layer_class`
    // Reserved): a case merge's `curated-<n>`, the rest of the pre-upgrade
    // family, and this reader's own previous-ocr keepsake once edited.
    ['curated-2', false, true, true],
    ['pre-upgrade-x', false, true, true],
    ['previous-ocr', false, true, true],
    ['previous-ocr-2', false, true, true],
    ['original', false, true, true],
    ['my-fixes', false, false, false],
    ['hayai-nova', false, false, false],
    ['curated-x', false, false, false],
    ['editorial', false, false, false]
  ])('%s: plain %s, bunko 0.8 %s, bunko 0.7 %s', (id, plain, bunko08, bunko07) => {
    expect(layerStaysLocal(row(id), PLAIN)).toBe(plain);
    expect(layerStaysLocal(row(id), BUNKO_08)).toBe(bunko08);
    expect(layerStaysLocal(row(id), BUNKO_07)).toBe(bunko07);
  });

  it('a personal layer on storage that reports no gate (Drive, cloud-direct) goes up', () => {
    expect(layerStaysLocal(row('edit'), { serverCompilesMetadata: true })).toBe(false);
  });

  it('an untouched upgrade layer stays local everywhere', () => {
    const untouched = { layer_id: 'updated-ocr', source_at: 't1', updated_at: 't1' };
    for (const target of [PLAIN, BUNKO_08, BUNKO_07]) {
      expect(layerStaysLocal(untouched, target)).toBe(true);
    }
    expect(layerStaysLocal({ ...untouched, updated_at: 't2' }, PLAIN)).toBe(false);
  });
});
