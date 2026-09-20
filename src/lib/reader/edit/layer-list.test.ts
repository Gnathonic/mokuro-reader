import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/catalog/db', () => ({ db: {} }));

import { summarizeLayers, nextLayerId, prevLayerId, primaryLayerName } from './layer-list';
import type { VolumeOcrLayer } from '$lib/types';

describe('summarizeLayers', () => {
  it('keeps only what the picker shows, puts original first, then by created_at', () => {
    const rows: VolumeOcrLayer[] = [
      {
        volume_uuid: 'v',
        layer_id: 'b',
        name: 'B',
        kind: 'edit',
        created_at: '2026-02-01',
        updated_at: 'x'
      },
      {
        volume_uuid: 'v',
        layer_id: 'original',
        name: 'Original',
        kind: 'original',
        created_at: '2026-03-01',
        updated_at: 'x'
      },
      {
        volume_uuid: 'v',
        layer_id: 'a',
        name: 'A',
        kind: 'ocr',
        engine: 'gcv',
        created_at: '2026-01-01',
        updated_at: 'x'
      }
    ];
    const out = summarizeLayers(rows);
    expect(out.map((l) => l.layer_id)).toEqual(['original', 'a', 'b']);
    expect(out[1]).toEqual({
      layer_id: 'a',
      name: 'A',
      kind: 'ocr',
      engine: 'gcv',
      updated_at: 'x'
    });
    expect(Object.keys(out[0]).sort()).toEqual(['kind', 'layer_id', 'name', 'updated_at']);
  });
});

describe('nextLayerId', () => {
  const layers = [
    { layer_id: 'original', name: 'Original', kind: 'original', updated_at: '' },
    { layer_id: 'fix', name: 'Fix', kind: 'edit', updated_at: '' },
    { layer_id: 'gcv', name: 'GCV', kind: 'ocr', updated_at: '' }
  ] as Parameters<typeof nextLayerId>[1];

  it('cycles Primary → each layer in list order → Primary', () => {
    expect(nextLayerId(null, layers)).toBe('original');
    expect(nextLayerId('original', layers)).toBe('fix');
    expect(nextLayerId('fix', layers)).toBe('gcv');
    expect(nextLayerId('gcv', layers)).toBe(null);
  });

  it('prevLayerId walks the same cycle backwards', () => {
    expect(prevLayerId(null, layers)).toBe('gcv');
    expect(prevLayerId('gcv', layers)).toBe('fix');
    expect(prevLayerId('fix', layers)).toBe('original');
    expect(prevLayerId('original', layers)).toBe(null);
    expect(prevLayerId('gone', layers)).toBe('gcv');
    expect(prevLayerId(null, [])).toBe(null);
  });

  it('a displayed id no longer in the list restarts from the first layer; no layers → stays Primary', () => {
    expect(nextLayerId('gone', layers)).toBe('original');
    expect(nextLayerId(null, [])).toBe(null);
    expect(nextLayerId('fix', [])).toBe(null);
  });
});

describe('primaryLayerName', () => {
  it('names the primary row after the mokuro version, plain mokuro when image-only', () => {
    expect(primaryLayerName('0.2.2')).toBe('mokuro 0.2.2');
    expect(primaryLayerName(' 0.1.8 ')).toBe('mokuro 0.1.8');
    expect(primaryLayerName('')).toBe('mokuro');
    expect(primaryLayerName(undefined)).toBe('mokuro');
  });
});
