/**
 * Seal v1 against every vector Bunko blessed (`interop/contract/seal/*.json`,
 * written by its `seal_vectors` test): the reader computes the seal Bunko
 * would set, tells a sealed file from one whose seal no longer checks, and a
 * sidecar installed here keeps its block through a rename, its seal checking
 * exactly when it did on the file that was installed.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

// The main thread's connection on the database the export Worker's own
// connection (`compress-volume.ts`) opens: an install here is what a rename
// there regenerates from.
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  const db = new CatalogDexieV3();
  (db as unknown as { processThumbnails: () => Promise<void> }).processThumbnails = async () =>
    undefined;
  return { db };
});
vi.mock('$lib/catalog/thumbnails', () => ({
  generateThumbnail: async () => ({
    file: new File([new Uint8Array([1])], 'thumb.webp', { type: 'image/webp' }),
    width: 10,
    height: 14
  })
}));

import { describeContractFile, sealVectors, type SealVector } from './contract';
import { canonicalJson, contentDigest, sealInput, sealOf } from '$lib/catalog/ocr-provenance';
import {
  RUNNER_OUTPUT_DOCUMENT,
  RUNNER_OUTPUT_SEAL,
  RUNNER_OUTPUT_SEAL_INPUT
} from '$lib/catalog/__fixtures__/seal-vector';
import { processVolume } from '$lib/import/processing';
import { saveVolume } from '$lib/import/database';
import { generateVolumeSidecarsFromDb } from '$lib/util/compress-volume';
import { db } from '$lib/catalog/db';

const vectors = sealVectors();

/**
 * The document as the reader reads a file (UTF-8 decoded, which drops a
 * leading BOM), parsed; undefined when it is not JSON at all (a bare NaN).
 */
function parsed(v: SealVector): any {
  try {
    return JSON.parse(new TextDecoder().decode(new TextEncoder().encode(v.document)));
  } catch {
    return undefined;
  }
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);

/** Its block's own seal is a well-formed v1 seal, and the one its content gives. */
async function sealChecks(doc: any): Promise<boolean> {
  const own = sealOf(doc?.ocr_engine);
  return !!own && own === (await contentDigest(doc.ocr_engine, doc.pages));
}

/** Every field `parseMokuroFile` requires: a sidecar the reader installs. */
const REQUIRED = ['version', 'title', 'title_uuid', 'volume', 'volume_uuid', 'pages'];
const installable = vectors.filter((v) => {
  const doc = parsed(v);
  return isObject(doc) && REQUIRED.every((k) => k in doc);
});

describeContractFile('seal', 'seal v1 against Bunko’s vectors', () => {
  beforeEach(async () => {
    await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), db.volume_files.clear()]);
  });

  it('the vectors include installable sidecars, sealed and not', () => {
    expect(installable.some((v) => v.is_sealed)).toBe(true);
    expect(installable.some((v) => !v.is_sealed)).toBe(true);
  });

  it('the reader’s own copy of runner-output is Bunko’s', () => {
    const v = vectors.find((x) => x.name === 'runner-output')!;
    expect(RUNNER_OUTPUT_DOCUMENT).toBe(v.document);
    expect(RUNNER_OUTPUT_SEAL_INPUT).toBe(v.seal_input);
    expect(RUNNER_OUTPUT_SEAL).toBe(v.seal);
  });

  it.each(vectors)('$name: the seal Bunko would set, and whether its own checks', async (v) => {
    const doc = parsed(v);
    const engine: unknown = doc?.ocr_engine;
    const sealable = isObject(engine) && Array.isArray(doc.pages);
    if (v.seal_input !== null) {
      expect(sealInput(doc.ocr_engine, canonicalJson(doc.pages))).toBe(v.seal_input);
    }
    const digest = sealable ? await contentDigest(engine, doc.pages) : undefined;
    expect(digest ?? null).toBe(v.seal);
    expect(await sealChecks(doc)).toBe(v.is_sealed);
  });

  it.each(installable)(
    '$name: installed, then renamed, carries its block, sealed only as it was',
    async (v) => {
      const doc = parsed(v);
      const imageFiles = new Map<string, File>(
        doc.pages.map((p: { img_path: string }) => [
          p.img_path,
          new File([], p.img_path, { type: 'image/jpeg' })
        ])
      );
      const processed = await processVolume({
        mokuroFile: new File([v.document], `${doc.volume}.mokuro`, { type: 'application/json' }),
        imageFiles,
        basePath: doc.title,
        sourceType: 'cloud',
        nestedArchives: []
      });
      const saved = await saveVolume(processed, { preserveTitles: true });

      // A rename regenerates the main sidecar under the new names (the cloud
      // rename's path, `unified-cloud-manager.ts`).
      const sidecars = await generateVolumeSidecarsFromDb(
        saved.metadata.volume_uuid,
        { seriesTitle: 'Renamed', volumeTitle: 'Renamed 01' },
        { cloud: true, editedFallbackToPrimary: true }
      );
      const written = JSON.parse(await sidecars.mokuro!.blob.text());
      expect(written).toMatchObject({ title: 'Renamed', volume: 'Renamed 01' });
      if (v.seal === null) {
        // No digest to carry the block by (a number past the double range).
        expect(written).not.toHaveProperty('ocr_engine');
      } else {
        // Verbatim, a stale or malformed seal included: never re-sealed here.
        expect(written.ocr_engine).toEqual(doc.ocr_engine);
        expect(await contentDigest(written.ocr_engine, written.pages)).toBe(v.seal);
      }
      expect(await sealChecks(written)).toBe(v.is_sealed);
    }
  );
});
