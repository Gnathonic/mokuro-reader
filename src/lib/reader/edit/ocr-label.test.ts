import { describe, expect, it } from 'vitest';
import {
  autoLayerName,
  isSetAsideLayerId,
  layerDisplayName,
  layerFileMaker,
  mainMakerOfFile,
  mainMakerOfLayer,
  layerNameOnWrite,
  makerFieldsOnWrite,
  ocrFileLabel,
  ocrPartsOf,
  primaryLayerName
} from './ocr-label';

const DIGEST = `v1:${'0'.repeat(64)}`;
const NOVA_ON_PPOCR = [
  { role: 'recognizer', name: 'Hayai Nova', version: '2.5' },
  { role: 'detector', name: 'PP-OCR Manga', version: '0.3' }
];

/** A volume row whose primary was installed from a file stamped with this `ocr_engine`. */
const served = (engine: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  mokuro_version: '0.2.5',
  ocr_provenance: [{ engine, digest: DIGEST }],
  ...extra
});

describe('ocrPartsOf', () => {
  it('reads parts in order, a part without a version as its name alone', () => {
    expect(ocrPartsOf({ id: 'x', parts: NOVA_ON_PPOCR })).toEqual(NOVA_ON_PPOCR);
    expect(
      ocrPartsOf({ id: 'x', parts: [{ role: 'recognizer', name: 'Charspot Small' }] })
    ).toEqual([{ role: 'recognizer', name: 'Charspot Small' }]);
    // A version that is not a non-blank string is dropped, not the part.
    expect(
      ocrPartsOf({
        parts: [
          { name: 'A', version: 3 },
          { name: 'B', version: ' ' }
        ]
      })
    ).toEqual([{ name: 'A' }, { name: 'B' }]);
  });

  it('ignores parts that are not an array of objects with a string name', () => {
    for (const parts of [
      undefined,
      null,
      'Hayai Nova',
      {},
      [],
      ['Hayai Nova'],
      [{ name: 'Hayai Nova' }, { version: '0.3' }],
      [{ name: 7 }],
      [{ name: '  ' }],
      [null]
    ]) {
      expect(ocrPartsOf({ id: 'hayai-nova', parts })).toBeUndefined();
    }
    expect(ocrPartsOf(null)).toBeUndefined();
    expect(ocrPartsOf([])).toBeUndefined();
  });
});

describe('ocrFileLabel', () => {
  it('parts joined by a middle dot, each name and version', () => {
    expect(ocrFileLabel({ engine: 'hayai-nova', parts: NOVA_ON_PPOCR })).toBe(
      'Hayai Nova 2.5 · PP-OCR Manga 0.3'
    );
  });

  it('an engine that is its own detector: one part', () => {
    expect(
      ocrFileLabel({ engine: 'ppocr-manga', parts: [{ name: 'PP-OCR Manga', version: '0.3' }] })
    ).toBe('PP-OCR Manga 0.3');
  });

  it('a part with no version reads as its name; names are rendered as given', () => {
    expect(
      ocrFileLabel({
        engine: 'charspot-small',
        parts: [{ name: 'Charspot Small' }, { name: 'AnimeText', version: '12x' }]
      })
    ).toBe('Charspot Small · AnimeText 12x');
    expect(ocrFileLabel({ engine: 'x', parts: [{ name: 'ppocr manga' }] })).toBe('ppocr manga');
  });

  it('no usable parts: the engine display name, else mokuro and its version', () => {
    expect(ocrFileLabel({ engine: 'hayai-nova' })).toBe('Hayai Nova');
    expect(ocrFileLabel({ engine: 'ppocr-manga', parts: [] })).toBe('PP-OCR Manga');
    expect(ocrFileLabel({ version: '0.2.2' })).toBe('mokuro 0.2.2');
    expect(ocrFileLabel({})).toBe('mokuro');
  });
});

describe('primaryLayerName', () => {
  it('a main file a server made: by its parts', () => {
    expect(primaryLayerName(served({ id: 'hayai-nova', parts: NOVA_ON_PPOCR }))).toBe(
      'Hayai Nova 2.5 · PP-OCR Manga 0.3'
    );
    expect(
      primaryLayerName(
        served({ id: 'ppocr-manga', parts: [{ name: 'PP-OCR Manga', version: '0.3' }] })
      )
    ).toBe('PP-OCR Manga 0.3');
  });

  it('a main file a server made without parts (older sidecars): the engine display name', () => {
    expect(primaryLayerName(served({ id: 'hayai-nova', revision: 2 }))).toBe('Hayai Nova');
    expect(primaryLayerName(served({ id: 'ppocr-manga' }))).toBe('PP-OCR Manga');
    expect(primaryLayerName(served({ id: 'charspot-small' }))).toBe('Charspot Small');
    // Malformed parts → the same fallback.
    expect(primaryLayerName(served({ id: 'nar-small', parts: [{ version: '1' }] }))).toBe(
      'Nar Small'
    );
  });

  it('a main file mokuro wrote (no engine in its provenance): mokuro and its version', () => {
    expect(primaryLayerName({ mokuro_version: '0.2.5' })).toBe('mokuro 0.2.5');
    expect(primaryLayerName({ mokuro_version: '0.2.5', ocr_provenance: [] })).toBe('mokuro 0.2.5');
  });

  it('an image-only volume: plain mokuro', () => {
    expect(primaryLayerName({ mokuro_version: '' })).toBe('mokuro');
    expect(primaryLayerName(null)).toBe('mokuro');
  });

  it('an installed EDITED main (maker unknown): mokuro and the version', () => {
    expect(
      primaryLayerName({
        mokuro_version: '0.2.5',
        ocr_provenance: [{ edited: { by: 'mokuro-reader' }, digest: DIGEST }]
      })
    ).toBe('mokuro 0.2.5');
    // A row from before the maker was recorded, edited here: as before.
    expect(
      primaryLayerName(
        served(
          { id: 'hayai-nova', parts: NOVA_ON_PPOCR },
          { ocr_edited_at: '2026-11-10T00:00:00Z' }
        )
      )
    ).toBe('mokuro 0.2.5');
  });

  it('the recorded maker of the CURRENT main wins over any provenance entry', () => {
    const maker = mainMakerOfFile(
      { engine: { id: 'hayai-nova', parts: NOVA_ON_PPOCR }, digest: DIGEST },
      '0.2.5'
    );
    // An edited main keeps its maker's name.
    expect(
      primaryLayerName({
        mokuro_version: '0.2.5',
        ocr_edited_at: '2026-11-10T00:00:00Z',
        ocr_maker: maker
      })
    ).toBe('Hayai Nova 2.5 · PP-OCR Manga 0.3');
    // A legacy file replaced the Bunko main: the stale entry still leads the
    // provenance list, but the maker says mokuro.
    expect(
      primaryLayerName(
        served(
          { id: 'hayai-nova', parts: NOVA_ON_PPOCR },
          { mokuro_version: '0.2.2', ocr_maker: mainMakerOfFile(undefined, '0.2.2') }
        )
      )
    ).toBe('mokuro 0.2.2');
    // Image-only: mokuro with no version.
    expect(
      primaryLayerName({ mokuro_version: '', ocr_maker: mainMakerOfFile(undefined, '') })
    ).toBe('mokuro');
    // Malformed stored maker fields are ignored field by field.
    expect(
      primaryLayerName({ mokuro_version: '0.2.2', ocr_maker: { engine: 7, parts: 'x' } as never })
    ).toBe('mokuro 0.2.2');
  });

  it('mainMakerOfFile: engine and parts, mokuro, or unknown for an EDITED file', () => {
    expect(mainMakerOfFile({ engine: { id: 'ppocr-manga' }, digest: DIGEST }, '0.2.5')).toEqual({
      engine: 'ppocr-manga',
      mokuro_version: '0.2.5'
    });
    expect(mainMakerOfFile(undefined, ' 0.2.2 ')).toEqual({ mokuro_version: '0.2.2' });
    expect(mainMakerOfFile({ edited: { by: 'mokuro-reader' }, digest: DIGEST }, '0.2.5')).toBe(
      undefined
    );
  });

  it('a promoted layer brings its maker; one that knows none leaves the main its own', () => {
    expect(
      mainMakerOfLayer({
        engine: 'ppocr-manga',
        ocr_parts: [{ name: 'PP-OCR Manga', version: '0.3' }]
      })
    ).toEqual({ engine: 'ppocr-manga', parts: [{ name: 'PP-OCR Manga', version: '0.3' }] });
    expect(mainMakerOfLayer({ mokuro_version: '0.2.2' })).toEqual({ mokuro_version: '0.2.2' });
    expect(mainMakerOfLayer({ maker_engine: 'hayai-nova' })).toEqual({ engine: 'hayai-nova' });
    expect(mainMakerOfLayer({})).toBeUndefined();
  });
});

describe('layer names', () => {
  it('the set-aside family: pre-upgrade / previous-ocr and their -<n>, nothing else', () => {
    for (const id of ['pre-upgrade', 'pre-upgrade-2', 'previous-ocr', 'previous-ocr-13']) {
      expect(isSetAsideLayerId(id)).toBe(true);
    }
    for (const id of ['pre-upgrade-x', 'previous', 'my-pre-upgrade', 'updated-ocr', 'edit']) {
      expect(isSetAsideLayerId(id)).toBe(false);
    }
  });

  it('a set-aside main sidecar mokuro wrote: mokuro and ITS version', () => {
    expect(autoLayerName({ layer_id: 'pre-upgrade', mokuro_version: '0.2.2' })).toBe(
      'mokuro 0.2.2'
    );
    expect(autoLayerName({ layer_id: 'previous-ocr-2', mokuro_version: '0.2.1' })).toBe(
      'mokuro 0.2.1'
    );
    // A row from before versions were kept.
    expect(autoLayerName({ layer_id: 'pre-upgrade' })).toBe('mokuro');
  });

  it('a set-aside main sidecar an engine made: its parts, else the engine name', () => {
    expect(
      autoLayerName({
        layer_id: 'pre-upgrade',
        engine: 'hayai-nova',
        ocr_parts: NOVA_ON_PPOCR,
        mokuro_version: '0.2.5'
      })
    ).toBe('Hayai Nova 2.5 · PP-OCR Manga 0.3');
    expect(
      autoLayerName({ layer_id: 'pre-upgrade', engine: 'hayai-nova', mokuro_version: '0.2.5' })
    ).toBe('Hayai Nova');
  });

  it('an engine layer: its parts when the file had them, else by id as before', () => {
    expect(
      autoLayerName({
        layer_id: 'ppocr-manga',
        engine: 'ppocr-manga',
        ocr_parts: [{ name: 'PP-OCR Manga', version: '0.3' }]
      })
    ).toBe('PP-OCR Manga 0.3');
    expect(
      autoLayerName({
        layer_id: 'charspot-small',
        engine: 'charspot-small',
        ocr_parts: [
          { name: 'Charspot Small', role: 'recognizer' },
          { name: 'PP-OCR Manga', version: '0.3', role: 'detector' }
        ]
      })
    ).toBe('Charspot Small · PP-OCR Manga 0.3');
    expect(autoLayerName({ layer_id: 'ppocr-manga', engine: 'ppocr-manga' })).toBe('PP-OCR Manga');
    expect(autoLayerName({ layer_id: 'charspot-small', engine: 'charspot-small' })).toBe(
      'Charspot Small'
    );
    // Malformed stored parts (user data) → by id.
    expect(
      autoLayerName({
        layer_id: 'hayai-nova',
        engine: 'hayai-nova',
        ocr_parts: [{ name: 3 }] as never
      })
    ).toBe('Hayai Nova');
  });

  it('corrections and hand-made layers: by id, whatever their file said', () => {
    expect(autoLayerName({ layer_id: 'edit', ocr_parts: NOVA_ON_PPOCR })).toBe('Your corrections');
    expect(autoLayerName({ layer_id: 'curated', mokuro_version: '0.2.2' })).toBe(
      'Shared corrections'
    );
    expect(autoLayerName({ layer_id: 'my-notes', mokuro_version: '0.2.2' })).toBe('My Notes');
  });

  it('v1.10.0\'s "Previous OCR" names and "Updated OCR" are the reader\'s, not the user\'s', () => {
    const keepsake = { source_at: 'x', mokuro_version: '0.2.2' };
    expect(layerDisplayName({ layer_id: 'previous-ocr', name: 'Previous OCR', ...keepsake })).toBe(
      'mokuro 0.2.2'
    );
    expect(
      layerDisplayName({ layer_id: 'previous-ocr-2', name: 'Previous OCR (2)', ...keepsake })
    ).toBe('mokuro 0.2.2');
    expect(
      layerDisplayName({
        layer_id: 'updated-ocr',
        name: 'Updated OCR',
        source_at: 'x',
        maker_engine: 'hayai-nova',
        ocr_parts: NOVA_ON_PPOCR
      })
    ).toBe('Hayai Nova 2.5 · PP-OCR Manga 0.3');
    expect(
      layerDisplayName({
        layer_id: 'updated-ocr',
        name: 'Updated OCR',
        source_at: 'x',
        maker_engine: 'hayai-nova'
      })
    ).toBe('Hayai Nova');
    // The name only counts for its own id.
    expect(layerDisplayName({ layer_id: 'pre-upgrade', name: 'Previous OCR', ...keepsake })).toBe(
      'Previous OCR'
    );
  });

  it('a name the user typed is never relabelled, even one that reads like the reader’s', () => {
    // Renamed by hand (the rename path sets `named_by_user`).
    expect(
      layerDisplayName({
        layer_id: 'pre-upgrade',
        name: 'Pre Upgrade',
        mokuro_version: '0.2.2',
        cloud: {},
        named_by_user: true
      })
    ).toBe('Pre Upgrade');
    expect(
      layerDisplayName({
        layer_id: 'hayai-nova',
        name: 'Hayai Nova',
        engine: 'hayai-nova',
        ocr_parts: NOVA_ON_PPOCR,
        named_by_user: true
      })
    ).toBe('Hayai Nova');
    // Made here by hand (no file, no cloud stamp): its name is whatever was
    // typed, even a slug's title case.
    expect(layerDisplayName({ layer_id: 'pre-upgrade', name: 'Pre Upgrade' })).toBe('Pre Upgrade');
    expect(layerDisplayName({ layer_id: 'previous-ocr-2', name: 'Previous Ocr 2' })).toBe(
      'Previous Ocr 2'
    );
    // ...and a rewrite from a file keeps it.
    expect(
      layerNameOnWrite(
        { layer_id: 'pre-upgrade', name: 'Pre Upgrade', cloud: {}, named_by_user: true },
        { layer_id: 'pre-upgrade', mokuro_version: '0.2.2' }
      )
    ).toBe('Pre Upgrade');
  });

  it('a row never renamed shows its new label; a name the user typed is kept', () => {
    // Stored by an older reader: the title-cased slug.
    expect(
      layerDisplayName({ layer_id: 'pre-upgrade', name: 'Pre Upgrade', mokuro_version: '0.2.2' })
    ).toBe('mokuro 0.2.2');
    expect(
      layerDisplayName({
        layer_id: 'ppocr-manga',
        name: 'PP-OCR Manga',
        engine: 'ppocr-manga',
        ocr_parts: [{ name: 'PP-OCR Manga', version: '0.3' }]
      })
    ).toBe('PP-OCR Manga 0.3');
    // Hand-renamed.
    expect(
      layerDisplayName({ layer_id: 'pre-upgrade', name: 'Old scan', mokuro_version: '0.2.2' })
    ).toBe('Old scan');
    expect(
      layerDisplayName({
        layer_id: 'ppocr-manga',
        name: 'Paddle run',
        engine: 'ppocr-manga',
        ocr_parts: [{ name: 'PP-OCR Manga', version: '0.3' }]
      })
    ).toBe('Paddle run');
  });

  it('a rewrite from a newer file renames an auto-named row, never a hand-renamed one', () => {
    const v3 = {
      layer_id: 'ppocr-manga',
      engine: 'ppocr-manga',
      ocr_parts: [{ name: 'PP-OCR Manga', version: '0.3' }]
    };
    const v4 = { ...v3, ocr_parts: [{ name: 'PP-OCR Manga', version: '0.4' }] };
    expect(layerNameOnWrite({ ...v3, name: 'PP-OCR Manga 0.3' }, v4)).toBe('PP-OCR Manga 0.4');
    expect(layerNameOnWrite({ ...v3, name: 'Paddle run' }, v4)).toBe('Paddle run');
    expect(layerNameOnWrite(undefined, { layer_id: 'pre-upgrade', mokuro_version: '0.2.2' })).toBe(
      'mokuro 0.2.2'
    );
  });
});

describe('layerFileMaker / makerFieldsOnWrite', () => {
  it('reads the parts a file carries, and the version its pages (else the file) name', () => {
    expect(
      layerFileMaker({
        version: '0.2.5',
        ocr_engine: { id: 'hayai-nova', parts: NOVA_ON_PPOCR }
      })
    ).toEqual({ fields: { ocr_parts: NOVA_ON_PPOCR, mokuro_version: '0.2.5' }, stamped: true });
    expect(layerFileMaker({ version: '0.2.2', pages: [] })).toEqual({
      fields: { mokuro_version: '0.2.2' },
      stamped: false
    });
    // The pages' own version wins: a file the reader wrote carries the
    // volume's top-level version over pages another mokuro made.
    expect(
      layerFileMaker({ version: '0.2.5', pages: [{ version: '' }, { version: '0.2.2' }] })
    ).toEqual({ fields: { mokuro_version: '0.2.2' }, stamped: false });
    expect(layerFileMaker({ ocr_engine: { id: 'x', parts: 'nope' } })).toEqual({
      fields: {},
      stamped: true
    });
  });

  it('an edited file says nothing of its maker: the row keeps what it knew', () => {
    const edited = { version: '0.2.5', edited: { by: 'mokuro-reader' } };
    expect(layerFileMaker(edited)).toBeUndefined();
    expect(makerFieldsOnWrite({ mokuro_version: '0.2.2' }, layerFileMaker(edited))).toEqual({
      mokuro_version: '0.2.2'
    });
  });

  it('a file with no ocr_engine (one the reader wrote) never overwrites a known maker', () => {
    const readerWritten = layerFileMaker({ version: '0.2.5', pages: [] });
    expect(
      makerFieldsOnWrite({ mokuro_version: '0.2.2', ocr_parts: NOVA_ON_PPOCR }, readerWritten)
    ).toEqual({ mokuro_version: '0.2.2', ocr_parts: NOVA_ON_PPOCR });
    // A row that knew nothing takes what the file says.
    expect(makerFieldsOnWrite({}, readerWritten)).toEqual({ mokuro_version: '0.2.5' });
    // A stamped file replaces what the row knew, absent fields included.
    expect(
      makerFieldsOnWrite(
        { mokuro_version: '0.2.2', ocr_parts: NOVA_ON_PPOCR },
        layerFileMaker({ version: '0.2.6', ocr_engine: { id: 'hayai-nova' } })
      )
    ).toEqual({ mokuro_version: '0.2.6' });
  });
});
