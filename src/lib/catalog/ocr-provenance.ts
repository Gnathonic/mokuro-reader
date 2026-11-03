/**
 * The provenance of a volume's primary OCR: the `ocr_engine` block a server
 * (mokuro-bunko) stamps on the `.mokuro` it generated, and the content seal
 * that block carries. The normative description is bunko's
 * `docs/design/sidecar-provenance.md`; its executable form is the vectors in
 * bunko's `interop/contract/seal/*.json`.
 *
 * Seal v1 = `"v1:"` + hex sha256 of the RFC 8785 (JCS) text of
 * `{"ocr_engine": <block without seal/content_sha256>, "pages": <pages>}`.
 * Names, uuids, chars, spine_width, `version` and key order are outside it, so
 * a rename or a re-serialization keeps it; any page edit breaks it.
 *
 * The reader never mints a block. It stores each installed file's block
 * verbatim with a v1 digest over THAT FILE's pages
 * (`VolumeMetadata.ocr_provenance`), and writes the block back onto a primary
 * it regenerates only when the pages written digest the same — so a carried
 * block is always true of the file it rides on. The block is the one bunko's
 * precedence reads (`edited`, then `ocr_engine`, else legacy): an
 * installed EDITED main keeps its `edited` block through a rename here, or a
 * reader on another device would turn a person's text back into LEGACY OCR
 * that a server upgrade replaces.
 *
 * Pure and worker-safe: the backup Worker builds primaries too.
 */
import type Dexie from 'dexie';
import type { Page } from '$lib/types';
import { sha256Hex } from './mokuro-hash';
import { getLayerPages } from './layer-store';

/**
 * One installed file's block and the digest of its pages (`v1:<hex>`): a
 * GENERATED file's `engine`, or an EDITED file's `edited` — never both.
 */
export type OcrProvenance = GeneratedProvenance | EditedProvenance;

export interface GeneratedProvenance {
  /** The file's `ocr_engine`, verbatim (seal included when it had one). */
  engine: Record<string, unknown>;
  edited?: never;
  /**
   * Seal v1 recomputed by this reader over the installed file's pages. Equal
   * to `engine.seal` for a sealed block whose seal still checks; otherwise
   * only this reader's reference for the carry check.
   */
  digest: string;
}

export interface EditedProvenance {
  /** The file's `edited` block, verbatim. */
  edited: Record<string, unknown>;
  engine?: never;
  /** `v1:` + sha256 of `{"pages": <JCS pages>}` — this reader's reference only. */
  digest: string;
}

/** How many installed files a volume remembers (newest first). */
export const MAX_OCR_PROVENANCE = 4;

const SEAL_RE = /^v1:[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A usable row entry (rows are user data in IndexedDB: shape-checked). */
export function isOcrProvenance(value: unknown): value is OcrProvenance {
  return (
    isPlainObject(value) &&
    isPlainObject(value.engine) !== isPlainObject(value.edited) &&
    typeof value.digest === 'string' &&
    SEAL_RE.test(value.digest)
  );
}

/**
 * RFC 8785 canonical JSON: object keys sorted by UTF-16 code units (the
 * default string sort), no whitespace, numbers and strings as
 * `JSON.stringify` spells them (which is ECMAScript's, as JCS requires).
 * Undefined and function members are dropped, undefined array slots are
 * `null` — as `JSON.stringify` does. Throws on a non-finite number: it has no
 * JSON form, so no seal can be made from it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new Error('non-finite number has no JSON form');
      return JSON.stringify(value);
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
    case 'bigint':
      throw new Error('bigint has no JSON form');
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const member = obj[key];
    if (member === undefined || typeof member === 'function' || typeof member === 'symbol') {
      continue;
    }
    members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
  }
  return `{${members.join(',')}}`;
}

/** The text seal v1 hashes, given the pages already canonicalized. */
export function sealInput(engine: Record<string, unknown>, pagesJcs: string): string {
  const { seal: _seal, content_sha256: _legacy, ...recipe } = engine;
  return `{"ocr_engine":${canonicalJson(recipe)},"pages":${pagesJcs}}`;
}

async function digestOf(input: string): Promise<string | undefined> {
  const hex = await sha256Hex(new TextEncoder().encode(input));
  return hex ? `v1:${hex}` : undefined;
}

/** An EDITED entry's digest: the pages alone (an `edited` block is outside any seal). */
function editedDigestInput(pagesJcs: string): string {
  return `{"pages":${pagesJcs}}`;
}

/**
 * Seal v1 of this block over these pages, or undefined when it cannot be
 * computed (no `crypto.subtle`, a non-finite number).
 */
export async function contentDigest(
  engine: Record<string, unknown>,
  pages: unknown[]
): Promise<string | undefined> {
  try {
    return await digestOf(sealInput(engine, canonicalJson(pages)));
  } catch {
    return undefined;
  }
}

/** The block's own seal, when it is a well-formed v1 seal. */
export function sealOf(engine: unknown): string | undefined {
  if (!isPlainObject(engine)) return undefined;
  const seal = engine.seal;
  return typeof seal === 'string' && SEAL_RE.test(seal) ? seal : undefined;
}

/**
 * What an installed file says about its OCR: its `ocr_engine` (a plain object
 * with a string `id`, else nothing) and the digest of the FILE's pages — before
 * the import remaps any `img_path`, so the digest describes the file as stored.
 */
export async function provenanceFromParsed(
  engine: unknown,
  pages: unknown[]
): Promise<GeneratedProvenance | undefined> {
  if (!isPlainObject(engine) || typeof engine.id !== 'string') return undefined;
  if (!Array.isArray(pages)) return undefined;
  const digest = await contentDigest(engine, pages);
  return digest ? { engine, digest } : undefined;
}

/**
 * The entry an installed file gives, by bunko's precedence: an `edited` object
 * makes it EDITED (any `ocr_engine` left beside it is ignored, as bunko does —
 * carrying it alone would pass a person's text off as model output); else
 * its `ocr_engine` (`provenanceFromParsed`); else nothing (legacy OCR). Any
 * other block a file carries is not part of the precedence and is ignored.
 * Every primary install goes through here.
 */
export async function provenanceOfFile(
  blocks: { ocrEngine?: unknown; edited?: unknown },
  pages: unknown[]
): Promise<OcrProvenance | undefined> {
  if (!Array.isArray(pages)) return undefined;
  if (isPlainObject(blocks.edited)) {
    let digest: string | undefined;
    try {
      digest = await digestOf(editedDigestInput(canonicalJson(pages)));
    } catch {
      return undefined;
    }
    return digest ? { edited: blocks.edited, digest } : undefined;
  }
  return provenanceFromParsed(blocks.ocrEngine, pages);
}

/**
 * The entry whose block goes on a primary built from these pages: the first
 * (newest) whose digest the pages reproduce — else undefined (the pages are
 * not any installed file's, e.g. a person edited them). The pages are
 * canonicalized once; each entry costs one hash.
 */
export async function carriedProvenance(
  list: readonly OcrProvenance[] | undefined,
  pages: unknown[]
): Promise<OcrProvenance | undefined> {
  const entries = (list ?? []).filter(isOcrProvenance);
  if (entries.length === 0 || !Array.isArray(pages)) return undefined;
  let pagesJcs: string;
  try {
    pagesJcs = canonicalJson(pages);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    let digest: string | undefined;
    try {
      digest = await digestOf(
        entry.engine ? sealInput(entry.engine, pagesJcs) : editedDigestInput(pagesJcs)
      );
    } catch {
      continue;
    }
    if (digest === entry.digest) return entry;
  }
  return undefined;
}

/** The `ocr_engine` a primary built from these pages carries, if any (`carriedProvenance`). */
export async function carriedOcrEngine(
  list: readonly OcrProvenance[] | undefined,
  pages: unknown[]
): Promise<Record<string, unknown> | undefined> {
  return (await carriedProvenance(list, pages))?.engine;
}

/**
 * `list` with `p` in front (newest first), an older entry for the same pages
 * dropped, capped at `max`. Malformed entries are dropped too.
 */
export function addProvenance(
  list: readonly OcrProvenance[] | undefined,
  p: OcrProvenance | undefined,
  max = MAX_OCR_PROVENANCE
): OcrProvenance[] {
  const rest = (list ?? []).filter(isOcrProvenance);
  if (!p) return rest.slice(0, max);
  return [p, ...rest.filter((e) => e.digest !== p.digest)].slice(0, max);
}

/** The editor's pre-edit snapshot (`edit-persist.ts`'s `ORIGINAL_LAYER_ID`). */
const ORIGINAL_LAYER = 'original';

/**
 * `edited.base_seal` for an edit-kind layer file: the seal of the generated
 * main sidecar the edits sit on — the `original` snapshot's pages for an
 * edited primary, else the primary's own — when those pages are an installed
 * sealed file's (`carriedProvenance`) AND that seal checks over them. Null
 * when the base was never sealed (a 0.7.x file, a local import), carries a
 * stale seal (a line corrected and the seal kept), is an EDITED file, or is
 * not known: a stale seal named here could match a main carrying the same
 * stale seal and pass for an unchanged base. Worker-safe: takes the
 * connection; reads nothing when the row records no sealed block.
 */
export async function editBaseSeal(
  db: Dexie,
  volume: { volume_uuid: string; ocr_edited_at?: string; ocr_provenance?: OcrProvenance[] }
): Promise<string | null> {
  if (!(volume.ocr_provenance ?? []).some((e) => isOcrProvenance(e) && sealOf(e.engine))) {
    return null;
  }
  const pages: Page[] | null | undefined = volume.ocr_edited_at
    ? await getLayerPages(db, volume.volume_uuid, ORIGINAL_LAYER)
    : (await db.table('volume_ocr').get(volume.volume_uuid))?.pages;
  if (!pages) return null;
  const entry = await carriedProvenance(volume.ocr_provenance, pages);
  // The digest is this reader's own over the base pages: the seal is true of
  // them only when the two agree.
  const seal = sealOf(entry?.engine);
  return seal && seal === entry?.digest ? seal : null;
}
