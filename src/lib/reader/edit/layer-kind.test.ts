import { describe, expect, it } from 'vitest';
import { forksOnEdit, layerRowActions } from './layer-kind';

const BUNKO = { serverCompilesMetadata: true };
const DRIVE = { serverCompilesMetadata: false };
const CLOUD = { provider: 'webdav', synced_at: '2026-10-01T00:00:00.000Z' };

describe('forksOnEdit: which layers an edit leaves alone and copies into `edit`', () => {
  it('the shared curated layer, on any provider and with none', () => {
    const curated = { layer_id: 'curated', kind: 'edit' as const, cloud: CLOUD };
    expect(forksOnEdit(curated, BUNKO)).toBe(true);
    expect(forksOnEdit(curated, DRIVE)).toBe(true);
    expect(forksOnEdit(curated, null)).toBe(true);
  });

  it('on bunko: a case merge’s curated-<n> and the OCR layers a server stamped', () => {
    // A case merge's keepsake of a second curated file: as shared as curated itself.
    expect(forksOnEdit({ layer_id: 'curated-2', kind: 'edit', cloud: CLOUD }, BUNKO)).toBe(true);
    const hayai = { layer_id: 'hayai', kind: 'ocr' as const, engine: 'hayai', cloud: CLOUD };
    expect(forksOnEdit(hayai, BUNKO)).toBe(true);
  });

  it('the same layers on plain storage are the user’s own files: edited in place', () => {
    const hayai = { layer_id: 'hayai', kind: 'ocr' as const, engine: 'hayai', cloud: CLOUD };
    expect(forksOnEdit(hayai, DRIVE)).toBe(false);
    expect(forksOnEdit(hayai, null)).toBe(false);
    expect(forksOnEdit({ layer_id: 'curated-2', kind: 'edit', cloud: CLOUD }, DRIVE)).toBe(false);
  });

  it('never a layer of this device’s own, a hand-made one, or the account’s own edit', () => {
    // An OCR layer no cloud vouches for (a local engine run, an untouched upgrade mirror).
    expect(forksOnEdit({ layer_id: 'hayai', kind: 'ocr', engine: 'hayai' }, BUNKO)).toBe(false);
    expect(forksOnEdit({ layer_id: 'my-fixes', kind: 'edit', cloud: CLOUD }, BUNKO)).toBe(false);
    expect(forksOnEdit({ layer_id: 'edit', kind: 'edit', cloud: CLOUD }, BUNKO)).toBe(false);
    expect(forksOnEdit({ layer_id: 'edit-2', kind: 'edit', cloud: CLOUD }, BUNKO)).toBe(false);
  });

  it('pre-upgrade / previous-ocr are hand-made layers on bunko too: edited in place', () => {
    for (const layer_id of ['pre-upgrade', 'pre-upgrade-2', 'previous-ocr', 'previous-ocr-2']) {
      expect(forksOnEdit({ layer_id, kind: 'edit', cloud: CLOUD }, BUNKO)).toBe(false);
      expect(forksOnEdit({ layer_id, kind: 'edit' }, BUNKO)).toBe(false);
    }
  });
});

describe('layerRowActions: what the layer menu offers on a row', () => {
  const at = (layer_id: string, canPublish: boolean, kind = 'edit' as const) =>
    layerRowActions({ layer_id, kind }, { canPublish, status: { serverCompilesMetadata: true } });

  it('Publish on the account’s edit layer and Unpublish on curated, only with the right', () => {
    expect(at('edit', true)).toMatchObject({ publish: true, unpublish: false, delete: true });
    expect(at('curated', true)).toMatchObject({ publish: false, unpublish: true });
    expect(at('edit', false)).toMatchObject({ publish: false, unpublish: false });
    expect(at('curated', false)).toMatchObject({ publish: false, unpublish: false });
    expect(at('edit-2', true).publish).toBe(false);
  });

  it('never Delete on curated (it would only hide the shared file here) or original', () => {
    expect(at('curated', true).delete).toBe(false);
    expect(at('curated', false).delete).toBe(false);
    expect(at('original', true, 'original' as never).delete).toBe(false);
    expect(at('fix', false).delete).toBe(true);
  });

  it('Copy to your corrections on every layer an edit forks from', () => {
    expect(at('curated', false).copyToEdit).toBe(true);
    expect(at('curated-2', false).copyToEdit).toBe(true);
    expect(at('pre-upgrade', false).copyToEdit).toBe(false);
    expect(at('fix', true).copyToEdit).toBe(false);
    expect(at('edit', true).copyToEdit).toBe(false);
  });
});
