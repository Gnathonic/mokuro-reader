import { describe, expect, it } from 'vitest';
import { buildMokuroMetadata, buildPrimaryMokuroMetadata } from './mokuro-metadata';
import { contentDigest, provenanceOfFile, sealOf } from '$lib/catalog/ocr-provenance';
import { RUNNER_OUTPUT_DOCUMENT, RUNNER_OUTPUT_SEAL } from '$lib/catalog/__fixtures__/seal-vector';
import type { VolumeMetadata } from '$lib/types';

const volume: VolumeMetadata = {
  mokuro_version: '0.2.1',
  series_title: 'One Piece',
  series_uuid: 'series-uuid',
  volume_title: 'Vol 1',
  volume_uuid: 'vol-uuid',
  page_count: 2,
  character_count: 123,
  page_char_counts: [60, 123],
  spine_width: 17
};

const pages = [
  { img_path: '1.jpg', blocks: [] },
  { img_path: '2.jpg', blocks: [] }
];

describe('buildMokuroMetadata', () => {
  it('builds the classic mokuro shape from volume + pages, including spine_width', () => {
    const meta = buildMokuroMetadata(volume, pages);
    expect(meta).toEqual({
      version: '0.2.1',
      title: 'One Piece',
      title_uuid: 'series-uuid',
      volume: 'Vol 1',
      volume_uuid: 'vol-uuid',
      pages,
      chars: 123,
      spine_width: 17
    });
    // Series facts live in the per-series series.json sidecar, never in a .mokuro.
    expect('series_metadata' in meta).toBe(false);
  });

  it('omits spine_width when the volume has none', () => {
    const { spine_width: _omit, ...noSpine } = volume;
    expect('spine_width' in buildMokuroMetadata(noSpine, pages)).toBe(false);
  });

  it('applies title overrides (rename regeneration) without touching uuids', () => {
    const meta = buildMokuroMetadata(volume, pages, { seriesTitle: 'New', volumeTitle: 'V2' });
    expect(meta.title).toBe('New');
    expect(meta.volume).toBe('V2');
    expect(meta.title_uuid).toBe('series-uuid');
    expect(meta.volume_uuid).toBe('vol-uuid');
  });

  it('the output is byte-identical to today', () => {
    const meta = buildMokuroMetadata(volume, pages);
    expect(JSON.stringify(meta)).toBe(
      JSON.stringify({
        version: '0.2.1',
        title: 'One Piece',
        title_uuid: 'series-uuid',
        volume: 'Vol 1',
        volume_uuid: 'vol-uuid',
        pages,
        chars: 123,
        spine_width: 17
      })
    );
  });
});

describe('buildPrimaryMokuroMetadata (provenance)', () => {
  const doc = JSON.parse(RUNNER_OUTPUT_DOCUMENT);
  const installed: VolumeMetadata = {
    ...volume,
    mokuro_sha256: 'a'.repeat(64),
    ocr_provenance: [{ engine: doc.ocr_engine, digest: RUNNER_OUTPUT_SEAL }]
  };

  it('carries the installed block verbatim, in Bunko key order, when the pages match', async () => {
    const meta = await buildPrimaryMokuroMetadata(installed, structuredClone(doc.pages), {
      seriesTitle: 'New',
      volumeTitle: 'V2'
    });
    expect(Object.keys(meta)).toEqual([
      'version',
      'title',
      'title_uuid',
      'volume',
      'volume_uuid',
      'ocr_engine',
      'pages',
      'chars',
      'spine_width'
    ]);
    expect(meta.ocr_engine).toEqual(doc.ocr_engine);
    expect(meta.title).toBe('New');
    expect(meta.volume).toBe('V2');
    // Still sealed: the seal is over the block and pages only.
    const written = JSON.parse(JSON.stringify(meta));
    expect(await contentDigest(written.ocr_engine, written.pages)).toBe(sealOf(written.ocr_engine));
  });

  it('carries nothing over edited pages, and stays the plain shape for a volume with no block', async () => {
    const edited = structuredClone(doc.pages);
    edited[0].blocks[0].lines[0] = '橋を渡った';
    expect('ocr_engine' in (await buildPrimaryMokuroMetadata(installed, edited))).toBe(false);
    expect(JSON.stringify(await buildPrimaryMokuroMetadata(volume, pages))).toBe(
      JSON.stringify(buildMokuroMetadata(volume, pages))
    );
  });

  it('marks an export of an edited primary `edited`, never with a block', async () => {
    const editedVolume = { ...installed, ocr_edited_at: '2026-10-01T00:00:00.000Z' };
    const edited = structuredClone(doc.pages);
    edited[0].blocks[0].lines[0] = '橋を渡った';
    const meta = await buildPrimaryMokuroMetadata(editedVolume, edited, { markEdited: true });
    expect(meta.edited).toEqual({
      by: 'mokuro-reader',
      at: '2026-10-01T00:00:00.000Z',
      base_sha256: 'a'.repeat(64),
      base_seal: null
    });
    expect('ocr_engine' in meta).toBe(false);
    expect(Object.keys(meta).indexOf('edited')).toBe(5);
  });

  it('no `edited` when not asked, when the volume is unedited, or when the pages are generated', async () => {
    const editedVolume = { ...installed, ocr_edited_at: '2026-10-01T00:00:00.000Z' };
    const edited = structuredClone(doc.pages);
    edited[0].blocks = [];
    expect('edited' in (await buildPrimaryMokuroMetadata(editedVolume, edited))).toBe(false);
    expect(
      'edited' in (await buildPrimaryMokuroMetadata(installed, edited, { markEdited: true }))
    ).toBe(false);
    // Edits undone: the pages ARE the generated file again, so the block rides.
    const reverted = await buildPrimaryMokuroMetadata(editedVolume, doc.pages, {
      markEdited: true
    });
    expect(reverted.ocr_engine).toEqual(doc.ocr_engine);
    expect('edited' in reverted).toBe(false);
  });

  it('a volume installed from an EDITED main writes that `edited` block back, verbatim', async () => {
    const block = {
      by: 'mokuro-reader',
      at: '2026-09-01T00:00:00.000Z',
      base_sha256: 'b'.repeat(64),
      base_seal: RUNNER_OUTPUT_SEAL
    };
    const fromEdited: VolumeMetadata = {
      ...volume,
      mokuro_sha256: 'a'.repeat(64),
      ocr_provenance: [
        (await provenanceOfFile({ ocrEngine: doc.ocr_engine, edited: block }, doc.pages))!
      ]
    };
    // A rename (no markEdited, no local edit): the file's own block, in the block slot.
    const meta = await buildPrimaryMokuroMetadata(fromEdited, structuredClone(doc.pages), {
      seriesTitle: 'New'
    });
    expect(meta.edited).toEqual(block);
    expect('ocr_engine' in meta).toBe(false);
    expect(Object.keys(meta).indexOf('edited')).toBe(5);
    // A local edit on top: the pages are no longer that file's — a fresh block.
    const changed = structuredClone(doc.pages);
    changed[0].blocks[0].lines[0] = '橋を渡った';
    const local = await buildPrimaryMokuroMetadata(
      { ...fromEdited, ocr_edited_at: '2026-10-01T00:00:00.000Z' },
      changed,
      { markEdited: true }
    );
    expect(local.edited?.at).toBe('2026-10-01T00:00:00.000Z');
    expect('ocr_engine' in local).toBe(false);
  });
});
