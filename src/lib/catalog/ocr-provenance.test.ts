import { describe, expect, it } from 'vitest';
import {
  addProvenance,
  canonicalJson,
  carriedOcrEngine,
  carriedProvenance,
  contentDigest,
  isOcrProvenance,
  provenanceFromParsed,
  provenanceOfFile,
  sealInput,
  sealOf,
  type OcrProvenance
} from './ocr-provenance';
import {
  RUNNER_OUTPUT_DOCUMENT,
  RUNNER_OUTPUT_SEAL,
  RUNNER_OUTPUT_SEAL_INPUT
} from './__fixtures__/seal-vector';

function runnerOutput(): { ocr_engine: Record<string, unknown>; pages: unknown[] } {
  return JSON.parse(RUNNER_OUTPUT_DOCUMENT);
}

/** Every object's keys in reverse order, at every level: the same JSON value. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)])
    );
  }
  return value;
}

describe('canonicalJson (RFC 8785)', () => {
  it('spells numbers the ECMAScript way', () => {
    expect(canonicalJson([1.0, 1e-7, 1e21, -0, 24.5, 0.1 + 0.2])).toBe(
      '[1,1e-7,1e+21,0,24.5,0.30000000000000004]'
    );
  });

  it('sorts keys by UTF-16 code units, non-ASCII and astral keys included', () => {
    expect(canonicalJson({ '｡': 1, '😀': 2, é: 3, a: 4, B: 5, '': 6 })).toBe(
      '{"":6,"B":5,"a":4,"é":3,"😀":2,"｡":1}'
    );
  });

  it('escapes C0 controls and leaves other characters literal', () => {
    expect(canonicalJson('\u001f\u2028\u007f/"\\')).toBe('"\\u001f\u2028\u007f/\\"\\\\"');
  });

  it('drops undefined members and writes undefined array slots as null', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1], c: () => 1 })).toBe('{"b":[null,1]}');
  });

  it('refuses non-finite numbers', () => {
    expect(() => canonicalJson({ a: [Number.NaN] })).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('seal v1', () => {
  it('builds the same seal input as bunko for its runner-output vector', () => {
    const doc = runnerOutput();
    expect(sealInput(doc.ocr_engine, canonicalJson(doc.pages))).toBe(RUNNER_OUTPUT_SEAL_INPUT);
  });

  it('contentDigest equals the vector bunko blessed', async () => {
    const doc = runnerOutput();
    expect(await contentDigest(doc.ocr_engine, doc.pages)).toBe(RUNNER_OUTPUT_SEAL);
  });

  it('leaves seal and the old content_sha256 out of its input', async () => {
    const doc = runnerOutput();
    const engine = { ...doc.ocr_engine, content_sha256: 'f'.repeat(64), seal: 'v1:junk' };
    expect(await contentDigest(engine, doc.pages)).toBe(RUNNER_OUTPUT_SEAL);
  });

  it('gives no digest for a non-finite number (a 1e400 read as Infinity)', async () => {
    const doc = JSON.parse(
      RUNNER_OUTPUT_DOCUMENT.replace('"font_size": 31.5', '"font_size": 1e400')
    );
    expect(await contentDigest(doc.ocr_engine, doc.pages)).toBeUndefined();
  });

  it('sealOf takes only a well-formed lowercase v1 seal', () => {
    expect(sealOf(runnerOutput().ocr_engine)).toBe(RUNNER_OUTPUT_SEAL);
    expect(sealOf({ seal: RUNNER_OUTPUT_SEAL.toUpperCase() })).toBeUndefined();
    expect(sealOf({ seal: 'v1:abc' })).toBeUndefined();
    expect(sealOf(undefined)).toBeUndefined();
  });
});

describe('provenanceFromParsed', () => {
  it('keeps the block verbatim with the digest of the file pages', async () => {
    const doc = runnerOutput();
    const p = await provenanceFromParsed(doc.ocr_engine, doc.pages);
    expect(p).toEqual({ engine: doc.ocr_engine, digest: RUNNER_OUTPUT_SEAL });
    expect(isOcrProvenance(p)).toBe(true);
  });

  it('ignores arrays, non-objects and blocks without a string id', async () => {
    const { pages } = runnerOutput();
    expect(await provenanceFromParsed([{ id: 'x' }], pages)).toBeUndefined();
    expect(await provenanceFromParsed('hayai-nova', pages)).toBeUndefined();
    expect(await provenanceFromParsed({ id: 3 }, pages)).toBeUndefined();
    expect(await provenanceFromParsed({ detector: 'x' }, pages)).toBeUndefined();
    expect(await provenanceFromParsed(undefined, pages)).toBeUndefined();
  });

  it('a 0.7.3 block with no seal still gets the reader’s own digest', async () => {
    const { pages } = runnerOutput();
    const p = await provenanceFromParsed({ id: 'hayai-nova' }, pages);
    expect(p?.digest).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(sealOf(p?.engine)).toBeUndefined();
  });
});

describe('carriedOcrEngine', () => {
  async function installed(): Promise<{ list: OcrProvenance[]; pages: any[] }> {
    const doc = runnerOutput();
    const p = (await provenanceFromParsed(doc.ocr_engine, doc.pages))!;
    return { list: [p], pages: doc.pages };
  }

  it('returns the block verbatim for the same pages with keys reordered', async () => {
    const { list, pages } = await installed();
    const carried = await carriedOcrEngine(list, reverseKeys(pages) as unknown[]);
    expect(carried).toBe(list[0].engine);
    expect(sealOf(carried)).toBe(RUNNER_OUTPUT_SEAL);
  });

  it('carries nothing once one line is edited', async () => {
    const { list, pages } = await installed();
    const edited = structuredClone(pages);
    edited[0].blocks[0].lines[0] = '橋を渡った';
    expect(await carriedOcrEngine(list, edited)).toBeUndefined();
  });

  it('carries nothing when an img_path changed', async () => {
    const { list, pages } = await installed();
    const moved = structuredClone(pages);
    moved[1].img_path = 'images/002.jpg';
    expect(await carriedOcrEngine(list, moved)).toBeUndefined();
  });

  it('picks the entry whose digest matches the pages', async () => {
    const { list, pages } = await installed();
    const other = structuredClone(pages);
    other[0].blocks = [];
    const otherP = (await provenanceFromParsed({ id: 'paddle-manga', revision: 1 }, other))!;
    const both = addProvenance(list, otherP);
    expect(both[0]).toBe(otherP);
    expect(await carriedOcrEngine(both, pages)).toBe(list[0].engine);
    expect(await carriedOcrEngine(both, other)).toBe(otherP.engine);
  });

  it('nothing to carry from no list or a malformed row', async () => {
    const { pages } = await installed();
    expect(await carriedOcrEngine(undefined, pages)).toBeUndefined();
    expect(await carriedOcrEngine([], pages)).toBeUndefined();
    expect(
      await carriedOcrEngine([{ engine: 'x', digest: 1 } as unknown as OcrProvenance], pages)
    ).toBeUndefined();
  });
});

describe('addProvenance', () => {
  const p = (n: number): OcrProvenance => ({
    engine: { id: `e${n}` },
    digest: `v1:${String(n).repeat(64).slice(0, 64)}`
  });

  it('puts the newest first, drops an older entry with the same digest, caps the list', () => {
    let list = addProvenance(undefined, p(1));
    list = addProvenance(list, p(2));
    list = addProvenance(list, p(1));
    expect(list.map((e) => e.engine?.id)).toEqual(['e1', 'e2']);
    for (const n of [3, 4, 5, 6]) list = addProvenance(list, p(n));
    expect(list.map((e) => e.engine?.id)).toEqual(['e6', 'e5', 'e4', 'e3']);
  });

  it('adds nothing for an undefined entry and drops malformed rows', () => {
    expect(addProvenance(undefined, undefined)).toEqual([]);
    expect(addProvenance([{ bad: true } as unknown as OcrProvenance, p(1)], undefined)).toEqual([
      p(1)
    ]);
  });
});

describe('provenanceOfFile (bunko precedence: edited, ocr_engine, legacy)', () => {
  const EDITED = {
    by: 'mokuro-reader',
    at: '2026-10-01T00:00:00.000Z',
    base_sha256: 'a'.repeat(64),
    base_seal: null
  };

  it('a GENERATED file gives the same entry as provenanceFromParsed', async () => {
    const doc = runnerOutput();
    expect(await provenanceOfFile({ ocrEngine: doc.ocr_engine }, doc.pages)).toEqual({
      engine: doc.ocr_engine,
      digest: RUNNER_OUTPUT_SEAL
    });
  });

  it('an EDITED file keeps its `edited` block, never the `ocr_engine` left beside it', async () => {
    const doc = runnerOutput();
    const p = await provenanceOfFile({ ocrEngine: doc.ocr_engine, edited: EDITED }, doc.pages);
    expect(p?.edited).toEqual(EDITED);
    expect(p && 'engine' in p).toBe(false);
    expect(p?.digest).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(isOcrProvenance(p)).toBe(true);
  });

  // `preserved` (a 0.8 pre-release keepsake block) is no longer part of the
  // precedence: a file still carrying one is read by its other blocks.
  it('a stray `preserved` block changes nothing: the `ocr_engine` still counts', async () => {
    const doc = runnerOutput();
    const preserved = { by: 'mokuro-bunko', reason: 'generation-upgrade' };
    const blocks = { ocrEngine: doc.ocr_engine, preserved } as Parameters<
      typeof provenanceOfFile
    >[0];
    expect(await provenanceOfFile(blocks, doc.pages)).toEqual({
      engine: doc.ocr_engine,
      digest: RUNNER_OUTPUT_SEAL
    });
  });

  it('a stray `preserved` block beside `edited` changes nothing: the file is EDITED', async () => {
    const doc = runnerOutput();
    const preserved = { by: 'mokuro-bunko', reason: 'generation-upgrade' };
    const blocks = { ocrEngine: doc.ocr_engine, edited: EDITED, preserved } as Parameters<
      typeof provenanceOfFile
    >[0];
    const p = await provenanceOfFile(blocks, doc.pages);
    expect(p?.edited).toEqual(EDITED);
    expect(p && 'engine' in p).toBe(false);
  });

  it('a stray `preserved` block alone is legacy OCR: nothing is recorded', async () => {
    const doc = runnerOutput();
    const preserved = { by: 'mokuro-bunko', reason: 'generation-upgrade' };
    expect(
      await provenanceOfFile({ preserved } as Parameters<typeof provenanceOfFile>[0], doc.pages)
    ).toBeUndefined();
  });

  it('an `edited` that is not an object does not count', async () => {
    const doc = runnerOutput();
    expect(await provenanceOfFile({ ocrEngine: doc.ocr_engine, edited: 'yes' }, doc.pages)).toEqual(
      { engine: doc.ocr_engine, digest: RUNNER_OUTPUT_SEAL }
    );
  });

  it('an entry is one block or the other, never both', () => {
    expect(
      isOcrProvenance({ engine: { id: 'x' }, edited: EDITED, digest: RUNNER_OUTPUT_SEAL })
    ).toBe(false);
    expect(isOcrProvenance({ digest: RUNNER_OUTPUT_SEAL })).toBe(false);
  });

  it('carries the `edited` block for the same pages, keys reordered; nothing once they change', async () => {
    const doc = runnerOutput();
    const p = (await provenanceOfFile({ edited: EDITED }, doc.pages))!;
    expect(await carriedProvenance([p], reverseKeys(doc.pages) as unknown[])).toBe(p);
    expect(await carriedOcrEngine([p], doc.pages)).toBeUndefined();
    const changed = structuredClone(doc.pages) as any[];
    changed[0].blocks[0].lines[0] = '橋を渡った';
    expect(await carriedProvenance([p], changed)).toBeUndefined();
  });

  it('the newest entry for the pages wins between an `edited` and an `ocr_engine` file', async () => {
    const doc = runnerOutput();
    const gen = (await provenanceOfFile({ ocrEngine: doc.ocr_engine }, doc.pages))!;
    const ed = (await provenanceOfFile({ edited: EDITED }, doc.pages))!;
    expect(await carriedProvenance(addProvenance([gen], ed), doc.pages)).toBe(ed);
    // The edited block was removed and the sealed file installed since.
    expect(await carriedProvenance(addProvenance([ed], gen), doc.pages)).toBe(gen);
  });
});
