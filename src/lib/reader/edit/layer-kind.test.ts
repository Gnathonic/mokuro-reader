import { describe, expect, it } from 'vitest';
import {
  PRIMARY_LAYER_ACTION_BLOCKED,
  TRANSLATION_PROMOTE_BLOCKED,
  forksOnEdit,
  layerActionAvailable,
  layerRowActions,
  type LayerCommand
} from './layer-kind';

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

describe('layerActionAvailable: one answer for the picker rows and the layer keys', () => {
  const ALL: LayerCommand[] = [
    'new',
    'rename',
    'promote',
    'publish',
    'unpublish',
    'copy-to-edit',
    'export',
    'delete'
  ];
  type Layer = Parameters<typeof layerActionAvailable>[1];
  const available = (layer: Layer, canPublish = true, status: typeof BUNKO | null = BUNKO) =>
    ALL.filter((a) => layerActionAvailable(a, layer, { canPublish, status }).available);
  const reason = (action: LayerCommand, layer: Layer, canPublish = true) => {
    const r = layerActionAvailable(action, layer, { canPublish, status: BUNKO });
    return r.available ? null : r.reason;
  };

  it('the primary: New only, and every other action says so', () => {
    expect(available(null)).toEqual(['new']);
    for (const action of ALL.filter((a) => a !== 'new')) {
      expect(reason(action, null), action).toBe(PRIMARY_LAYER_ACTION_BLOCKED);
    }
  });

  it('New needs no layer and no right: it is offered on every layer too', () => {
    for (const layer_id of ['original', 'curated', 'edit', 'fix', 'tr-en']) {
      expect(
        layerActionAvailable('new', { layer_id }, { canPublish: false, status: null })
      ).toEqual({ available: true });
    }
  });

  it('a hand-made layer: rename, promote, export, delete', () => {
    expect(available({ layer_id: 'fix', kind: 'edit' })).toEqual([
      'new',
      'rename',
      'promote',
      'export',
      'delete'
    ]);
    expect(reason('copy-to-edit', { layer_id: 'fix', kind: 'edit' })).toMatch(/edited in place/);
    expect(reason('publish', { layer_id: 'fix', kind: 'edit' })).toBe(
      'Only your corrections layer can be published'
    );
    expect(reason('unpublish', { layer_id: 'fix', kind: 'edit' })).toBe(
      'Only the shared corrections can be unpublished'
    );
  });

  it('the original snapshot: export only (and New)', () => {
    const original = { layer_id: 'original', kind: 'original' as const };
    expect(available(original)).toEqual(['new', 'export']);
    expect(reason('rename', original)).toBe('The original layer cannot be renamed');
    expect(reason('promote', original)).toBe('The original layer cannot be promoted');
    expect(reason('delete', original)).toBe('The original layer cannot be deleted');
    // Hidden in the picker, not drawn disabled.
    expect(
      layerActionAvailable('promote', original, { canPublish: true, status: BUNKO })
    ).not.toHaveProperty('shown');
  });

  it('a translation, by kind or by its tr-<lang> id: never promoted, the button shown disabled', () => {
    for (const layer of [
      { layer_id: 'english', kind: 'translation' as const },
      { layer_id: 'tr-en', kind: 'edit' as const },
      { layer_id: 'tr-pt-br' }
    ]) {
      expect(
        layerActionAvailable('promote', layer, { canPublish: true, status: BUNKO }),
        layer.layer_id
      ).toEqual({ available: false, reason: TRANSLATION_PROMOTE_BLOCKED, shown: true });
      expect(available(layer)).toEqual(['new', 'rename', 'export', 'delete']);
    }
  });

  it("the account's edit layer: Publish with the right to, refused without it", () => {
    const edit = { layer_id: 'edit', kind: 'edit' as const };
    expect(available(edit, true)).toEqual([
      'new',
      'rename',
      'promote',
      'publish',
      'export',
      'delete'
    ]);
    expect(available(edit, false)).toEqual(['new', 'rename', 'promote', 'export', 'delete']);
    expect(reason('publish', edit, false)).toMatch(/can't publish shared corrections/);
    // A second personal layer is not the one Publish reads.
    expect(reason('publish', { layer_id: 'edit-2', kind: 'edit' })).toBe(
      'Only your corrections layer can be published'
    );
  });

  it('the shared curated layer: Unpublish with the right, Copy always, never Delete', () => {
    const curated = { layer_id: 'curated', kind: 'edit' as const, cloud: CLOUD };
    expect(available(curated, true)).toEqual([
      'new',
      'rename',
      'promote',
      'unpublish',
      'copy-to-edit',
      'export'
    ]);
    expect(available(curated, false)).toEqual([
      'new',
      'rename',
      'promote',
      'copy-to-edit',
      'export'
    ]);
    expect(reason('unpublish', curated, false)).toMatch(/can't publish shared corrections/);
    expect(reason('delete', curated)).toBe('The shared corrections are removed with Unpublish');
  });

  it("a server's OCR layer: Copy to your corrections on a server that compiles, not on plain storage", () => {
    const hayai = { layer_id: 'hayai', kind: 'ocr' as const, engine: 'hayai', cloud: CLOUD };
    expect(available(hayai, false, BUNKO)).toContain('copy-to-edit');
    expect(available(hayai, false, DRIVE)).not.toContain('copy-to-edit');
    expect(available(hayai, false, null)).not.toContain('copy-to-edit');
  });

  it('agrees with layerRowActions on every id-dependent action', () => {
    const layers: NonNullable<Layer>[] = [
      { layer_id: 'original', kind: 'original' },
      { layer_id: 'curated', kind: 'edit', cloud: CLOUD },
      { layer_id: 'curated-2', kind: 'edit', cloud: CLOUD },
      { layer_id: 'edit', kind: 'edit' },
      { layer_id: 'edit-2', kind: 'edit' },
      { layer_id: 'fix', kind: 'edit' },
      { layer_id: 'tr-en', kind: 'translation' },
      { layer_id: 'hayai', kind: 'ocr', engine: 'hayai', cloud: CLOUD }
    ];
    for (const layer of layers) {
      for (const canPublish of [true, false]) {
        for (const status of [BUNKO, DRIVE, null]) {
          const row = layerRowActions(layer, { canPublish, status });
          const is = (a: LayerCommand) =>
            layerActionAvailable(a, layer, { canPublish, status }).available;
          const where = `${layer.layer_id} ${canPublish} ${JSON.stringify(status)}`;
          expect(is('publish'), where).toBe(row.publish);
          expect(is('unpublish'), where).toBe(row.unpublish);
          expect(is('copy-to-edit'), where).toBe(row.copyToEdit);
          expect(is('delete'), where).toBe(row.delete);
        }
      }
    }
  });
});
