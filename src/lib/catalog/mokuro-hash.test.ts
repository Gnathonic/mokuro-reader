import { describe, expect, it } from 'vitest';
import {
  isMokuroCloudAttestation,
  isMokuroSha256,
  isUntouchedUpgradeLayer,
  layerStaysLocal,
  personalLayerAccount,
  sha256Hex,
  syncedForOtherAccount,
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

  it('needs no source hash, only the two stamps', () => {
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
    // bunko's one server keepsake (sidecar names rule v1 ServerKeepsake): a
    // case merge's `curated-<n>`, which only the server writes.
    ['curated-2', false, true, true],
    // Ordinary hand-made ids: bunko neither writes nor reserves them any more.
    ['pre-upgrade', false, false, false],
    ['pre-upgrade-3', false, false, false],
    ['pre-upgrade-x', false, false, false],
    ['previous-ocr', false, false, false],
    ['previous-ocr-2', false, false, false],
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

  it("a server's own OCR, edited here anyway, never goes up to that server", () => {
    // Pulled with an engine stamp: on bunko an edit forks into `edit`
    // (`forksOnEdit`), but one begun before the provider said it was bunko
    // edits the row in place, and must not overwrite the model output.
    const cloud = { provider: 'webdav', synced_at: 't0' };
    const hayai = {
      layer_id: 'hayai',
      kind: 'ocr' as const,
      engine: 'hayai',
      cloud,
      updated_at: 't1'
    };
    expect(layerStaysLocal(hayai, BUNKO_08)).toBe(true);
    expect(layerStaysLocal(hayai, BUNKO_07)).toBe(true);
    // Plain storage: the user's own file, edited in place.
    expect(layerStaysLocal(hayai, PLAIN)).toBe(false);
    // An OCR layer no cloud vouches for is this device's own run.
    expect(layerStaysLocal({ ...hayai, cloud: undefined }, BUNKO_08)).toBe(false);
    expect(layerStaysLocal({ ...hayai, engine: undefined }, BUNKO_08)).toBe(false);
  });

  it("a server's OCR pulled from bunko stays off that provider only, under a stale status too", () => {
    // Pulled while the provider said the server compiles its metadata, then
    // edited in place: the mark protects bunko's file from the corrections
    // even once the status reads plain storage again, but only for the
    // provider it came from. An export, a file and every other provider get
    // the layer like any other.
    const pulled = {
      layer_id: 'gcv',
      kind: 'ocr' as const,
      engine: 'gcv',
      cloud: { provider: 'webdav', server_compiled: true as const, synced_at: 't0' },
      updated_at: 't1'
    };
    expect(layerStaysLocal(pulled, { serverCompilesMetadata: false, provider: 'webdav' })).toBe(
      true
    );
    expect(layerStaysLocal(pulled, PLAIN)).toBe(false);
    for (const provider of ['google-drive', 'mega', 'onedrive', 'filesystem']) {
      expect(layerStaysLocal(pulled, { serverCompilesMetadata: false, provider })).toBe(false);
    }
  });

  it('an untouched upgrade layer stays local everywhere', () => {
    const untouched = { layer_id: 'updated-ocr', source_at: 't1', updated_at: 't1' };
    for (const target of [PLAIN, BUNKO_08, BUNKO_07]) {
      expect(layerStaysLocal(untouched, target)).toBe(true);
    }
    expect(layerStaysLocal({ ...untouched, updated_at: 't2' }, PLAIN)).toBe(false);
  });
});

describe('personalLayerAccount', () => {
  it('is the accountScope only on a bunko that keeps the edit layer per account', () => {
    const scope = { accountScope: 'webdav:https://host|alice' };
    expect(
      personalLayerAccount({ ...scope, serverCompilesMetadata: true, editLayerSync: 'push' })
    ).toBe('webdav:https://host|alice');
    expect(personalLayerAccount(scope)).toBeUndefined();
    // Drive's scope moves within one account (`default`, then its folder id).
    expect(personalLayerAccount({ accountScope: 'google-drive:default' })).toBeUndefined();
  });

  it('is the accountScope on any WebDAV bunko, also one whose identity fell back (local)', () => {
    // A 0.8 bunko whose /me answered 'unsupported' once reads `local`; the
    // account behind the path is still this one, and a later 'push' session
    // (or another account) must be able to tell its rows apart.
    const scope = { accountScope: 'webdav:https://host|alice' };
    expect(
      personalLayerAccount({ ...scope, serverCompilesMetadata: true, editLayerSync: 'local' })
    ).toBe('webdav:https://host|alice');
  });

  it('is never stamped on Drive, not even under a fresh cloud-direct bunko marker', () => {
    // withCloudBunkoStatus makes serverCompilesMetadata true on Drive; it
    // never reports editLayerSync there.
    expect(
      personalLayerAccount({ accountScope: 'google-drive:default', serverCompilesMetadata: true })
    ).toBeUndefined();
    expect(
      personalLayerAccount({ accountScope: 'google-drive:folder', serverCompilesMetadata: true })
    ).toBeUndefined();
  });
});

describe('syncedForOtherAccount', () => {
  const cloud = (account?: string) => ({
    provider: 'webdav',
    synced_at: 't',
    ...(account ? { account } : {})
  });

  it('is a personal layer stamped under another account than the active one', () => {
    expect(syncedForOtherAccount({ layer_id: 'edit', cloud: cloud('bob') }, 'alice')).toBe(true);
    expect(syncedForOtherAccount({ layer_id: 'edit-2', cloud: cloud('bob') }, 'alice')).toBe(true);
  });

  it('never a shared layer, a row of this account, an unstamped row, or with no account', () => {
    expect(syncedForOtherAccount({ layer_id: 'curated', cloud: cloud('bob') }, 'alice')).toBe(
      false
    );
    expect(syncedForOtherAccount({ layer_id: 'edit', cloud: cloud('alice') }, 'alice')).toBe(false);
    // Stamped before accounts were recorded: counts as this account's.
    expect(syncedForOtherAccount({ layer_id: 'edit', cloud: cloud() }, 'alice')).toBe(false);
    expect(syncedForOtherAccount({ layer_id: 'edit' }, 'alice')).toBe(false);
    expect(syncedForOtherAccount({ layer_id: 'edit', cloud: cloud('bob') }, undefined)).toBe(false);
  });
});
