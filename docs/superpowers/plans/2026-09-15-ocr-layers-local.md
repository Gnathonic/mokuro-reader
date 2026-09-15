# OCR Layers (local half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the reader display, create, edit, rename, promote, export and delete named OCR layers beside the primary OCR row, all local to this device.

**Architecture:** The `volume_ocr_layers` Dexie table (schema v3, from sub-project A) is the store; a new `src/lib/reader/edit/layers.ts` module owns every read and write of it. The reader derives its `pages` from the displayed layer (chosen per volume in `VolumeSettings.ocrLayer`) instead of only `volume_ocr`; edit mode persists to whichever row is displayed. UI is a `LayerPicker` reachable from the quick actions menu plus an "OCR layers" block in the per-volume section of the reader settings panel, both driving one `layer-actions.ts` orchestrator.

**Tech Stack:** SvelteKit 5 runes, Dexie 4 (`liveQuery`), flowbite-svelte, Vitest + `fake-indexeddb`, @testing-library/svelte, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-15-ocr-editor-layers-engines-design.md`, "Sub-project B — OCR layers", sections _Model_ and _UI_ only. Cloud sidecars, ZIP export inclusion and the bunko patch are OUT of this plan (they follow the engines PR).

## Global Constraints

- `layer_id` is a slug matching `/^[a-z0-9-]{1,32}$/`; `original` is reserved (never renamed, edited or deleted).
- The primary OCR row (`volume_ocr`) stays what every existing consumer reads; nothing here changes its shape.
- `.mokuro` files stay pure upstream format: an exported layer file is `buildMokuroMetadata(volume, layer.pages)` and nothing else.
- Layer sidecar name: `<Volume Title>.layer.<layer-id>.mokuro` (the `.layer.` token is reserved).
- No layer file is ever uploaded, listed or backed up by this PR.
- Editing while viewing `original` is DISABLED with a hint (decision: simpler than auto-copy; the user creates a copy from the picker).
- All commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. No pushes.

---

### Task 1: Layer sidecar name parser

**Files:**

- Modify: `src/lib/util/sync/syncable-file.ts`
- Test: `src/lib/util/sync/syncable-file.test.ts`

**Interfaces:**

- Produces: `LAYER_ID_RE: RegExp`, `isLayerSidecar(basename: string): boolean`, `parseLayerSidecarName(basename: string): { volumeTitle: string; layerId: string; gz: boolean } | null`, `layerSidecarName(volumeTitle: string, layerId: string): string`.

- [ ] **Step 1: Write the failing tests** (append to the existing `describe('syncable-file')`)

```ts
describe('layer sidecars', () => {
  it('parses <title>.layer.<id>.mokuro and the .gz form', () => {
    expect(parseLayerSidecarName('Vol 1.layer.translation.mokuro')).toEqual({
      volumeTitle: 'Vol 1',
      layerId: 'translation',
      gz: false
    });
    expect(parseLayerSidecarName('Vol 1.layer.gcv-2.mokuro.gz')).toEqual({
      volumeTitle: 'Vol 1',
      layerId: 'gcv-2',
      gz: true
    });
    expect(isLayerSidecar('Vol 1.layer.translation.mokuro')).toBe(true);
  });
  it('never mistakes a plain sidecar or an invalid id for a layer file', () => {
    expect(parseLayerSidecarName('Vol 1.mokuro')).toBeNull();
    expect(parseLayerSidecarName('Vol 1.layer.Bad_Id.mokuro')).toBeNull();
    expect(parseLayerSidecarName('Vol 1.layer..mokuro')).toBeNull();
    expect(isLayerSidecar('Vol 1.mokuro')).toBe(false);
  });
  it('builds the name the parser accepts (round trip)', () => {
    const name = layerSidecarName('Vol 1', 'gcv');
    expect(name).toBe('Vol 1.layer.gcv.mokuro');
    expect(parseLayerSidecarName(name)).toEqual({
      volumeTitle: 'Vol 1',
      layerId: 'gcv',
      gz: false
    });
  });
  it('a layer file is still a syncable sidecar (listings will route it later)', () => {
    expect(isSidecarFile('Vol 1.layer.gcv.mokuro')).toBe(true);
  });
});
```

Add `isLayerSidecar, parseLayerSidecarName, layerSidecarName` to the test's import.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/util/sync/syncable-file.test.ts`
Expected: FAIL — `parseLayerSidecarName` is not exported.

- [ ] **Step 3: Implement** (append to `syncable-file.ts`)

```ts
/**
 * Alternate OCR layers ride beside a volume as `<Volume Title>.layer.<id>.mokuro`
 * (optionally `.gz`). The `.layer.` token is reserved: `layerId` is a slug of
 * `[a-z0-9-]`, so the pattern can never be confused with a volume whose
 * title happens to contain a dot. Listings do NOT route these yet — the
 * cloud half of the layers work does that; this PR only names export files.
 */
export const LAYER_ID_RE = /^[a-z0-9-]{1,32}$/;
const LAYER_SIDECAR_RE = /^(.+)\.layer\.([a-z0-9-]{1,32})\.mokuro(\.gz)?$/i;

export function parseLayerSidecarName(
  basename: string
): { volumeTitle: string; layerId: string; gz: boolean } | null {
  const m = LAYER_SIDECAR_RE.exec(basename);
  if (!m) return null;
  const layerId = m[2].toLowerCase();
  if (!LAYER_ID_RE.test(layerId)) return null;
  return { volumeTitle: m[1], layerId, gz: m[3] !== undefined };
}

export function isLayerSidecar(basename: string): boolean {
  return parseLayerSidecarName(basename) !== null;
}

export function layerSidecarName(volumeTitle: string, layerId: string): string {
  return `${volumeTitle}.layer.${layerId}.mokuro`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/util/sync/syncable-file.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/sync/syncable-file.ts src/lib/util/sync/syncable-file.test.ts
git commit -m "feat(sync): name parser for <title>.layer.<id>.mokuro layer sidecars"
```

---

### Task 2: `VolumeSettings.ocrLayer`

**Files:**

- Modify: `src/lib/settings/volume-data.ts` (type at ~line 30, constructor ~line 171, `toJSON` ~line 209)
- Test: `src/lib/settings/volume-data.test.ts`

**Interfaces:**

- Produces: `VolumeSettings.ocrLayer?: string` — the displayed layer id; absent = primary. Round-trips through `VolumeData` and syncs like `rightToLeft`. Callers use the existing `updateVolumeSetting(uuid, 'ocrLayer', id | undefined)`.

- [ ] **Step 1: Write the failing test**

```ts
describe('VolumeData.settings.ocrLayer', () => {
  it('round-trips a string layer id and drops anything else', () => {
    const v = new VolumeData({ settings: { ocrLayer: 'gcv' } });
    expect(v.settings.ocrLayer).toBe('gcv');
    expect(VolumeData.fromJSON(JSON.stringify(v)).settings.ocrLayer).toBe('gcv');
    expect(
      new VolumeData({ settings: { ocrLayer: 3 as unknown as string } }).settings.ocrLayer
    ).toBeUndefined();
    expect(new VolumeData({}).toJSON().settings).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/settings/volume-data.test.ts` — Expected: FAIL (`ocrLayer` undefined after round trip).

- [ ] **Step 3: Implement**

In the type:

```ts
export type VolumeSettings = {
  rightToLeft?: boolean;
  hasCover?: boolean;
  spreadBreakpoints?: number[];
  /** Displayed OCR layer id (`volume_ocr_layers.layer_id`); absent = primary. */
  ocrLayer?: string;
};
```

In the constructor, after the `hasCover` block:

```ts
if (typeof data.settings?.ocrLayer === 'string' && data.settings.ocrLayer) {
  this.settings.ocrLayer = data.settings.ocrLayer;
}
```

In `toJSON`, after the `hasCover` block:

```ts
if (typeof this.settings.ocrLayer === 'string' && this.settings.ocrLayer) {
  syncableSettings.ocrLayer = this.settings.ocrLayer;
}
```

- [ ] **Step 4: Run** the file — Expected: PASS. Also `npx vitest run src/lib/settings` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings/volume-data.ts src/lib/settings/volume-data.test.ts
git commit -m "feat(settings): VolumeSettings.ocrLayer — the displayed OCR layer per volume"
```

---

### Task 3: `layers.ts` — list, slug, create, rename, delete, edit-persist

**Files:**

- Create: `src/lib/reader/edit/layers.ts`
- Test: `src/lib/reader/edit/layers.test.ts` (mirror the `fake-indexeddb` + `CatalogDexieV3` setup of `edit-persist.test.ts`)

**Interfaces:**

- Consumes: `ORIGINAL_LAYER_ID` from `edit-persist.ts`, `LAYER_ID_RE` from Task 1.
- Produces:
  - `slugifyLayerId(name: string, taken: Iterable<string>): string` — lower-case, non `[a-z0-9]` runs → `-`, trimmed, ≤ 24 chars, `layer` if empty; suffix `-2`, `-3`… until unique and never `original`.
  - `listLayers(volumeUuid: string): Promise<VolumeOcrLayer[]>` — `original` first, then by `created_at`.
  - `loadLayerPages(volumeUuid, layerId): Promise<Page[] | null>`.
  - `createLayer(volumeUuid, opts: { name: string; kind?: VolumeOcrLayerKind; pages: Page[] | 'empty'; sourcePages?: Page[] }): Promise<VolumeOcrLayer>` — `'empty'` copies `sourcePages` with `blocks: []` on every page (keeps `img_*`); kind defaults `'edit'`.
  - `renameLayer(volumeUuid, layerId, name): Promise<void>` — throws on `original`.
  - `deleteLayer(volumeUuid, layerId): Promise<void>` — throws on `original`.
  - `persistLayerPageEdit(volumeUuid, layerId, pageIndex, page): Promise<void>` — replaces one page, bumps `updated_at`; throws on `original` or a missing row.
  - `LAYER_KIND_LABEL: Record<VolumeOcrLayerKind, string>` = `{ original: 'Original', edit: 'Edit', ocr: 'OCR', translation: 'Translation' }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Page } from '$lib/types';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_layers_test') };
});
const noteOcrEdited = vi.hoisted(() => vi.fn());
vi.mock('$lib/util/sync/sidecar-backfill', () => ({ noteOcrEdited }));

import { db } from '$lib/catalog/db';
import {
  createLayer,
  deleteLayer,
  listLayers,
  loadLayerPages,
  persistLayerPageEdit,
  renameLayer,
  slugifyLayerId
} from './layers';

function pg(text: string, img_path = 'p.png'): Page {
  return {
    version: '0.2.1',
    img_width: 100,
    img_height: 100,
    img_path,
    blocks: [{ box: [0, 0, 10, 10], vertical: true, font_size: 10, lines: [text] }]
  };
}
const PAGES = [pg('あい'), pg('うえ', 'q.png')];

beforeEach(async () => {
  noteOcrEdited.mockClear();
  await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), db.volume_ocr_layers.clear()]);
  await db.volumes.put({
    volume_uuid: 'v1',
    series_uuid: 's1',
    series_title: 'S',
    volume_title: 'Vol 1',
    mokuro_version: '0.2.1',
    page_count: 2,
    character_count: 4,
    page_char_counts: [2, 4]
  });
  await db.volume_ocr.put({ volume_uuid: 'v1', pages: PAGES });
});

describe('slugifyLayerId', () => {
  it('slugs, truncates, and de-duplicates; never yields "original"', () => {
    expect(slugifyLayerId('My Translation!', [])).toBe('my-translation');
    expect(slugifyLayerId('Original', [])).toBe('original-2');
    expect(slugifyLayerId('gcv', ['gcv', 'gcv-2'])).toBe('gcv-3');
    expect(slugifyLayerId('', [])).toBe('layer');
    expect(slugifyLayerId('a'.repeat(40), [])).toHaveLength(24);
  });
});

describe('layers store', () => {
  it('creates a copy layer and an empty layer, lists original first, loads pages', async () => {
    await db.volume_ocr_layers.add({
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      pages: PAGES
    });
    const copy = await createLayer('v1', { name: 'Fix ups', pages: PAGES });
    const empty = await createLayer('v1', {
      name: 'English',
      kind: 'translation',
      pages: 'empty',
      sourcePages: PAGES
    });
    expect(copy.layer_id).toBe('fix-ups');
    expect(empty.pages[0].blocks).toEqual([]);
    expect(empty.pages[1].img_path).toBe('q.png');
    const ids = (await listLayers('v1')).map((l) => l.layer_id);
    expect(ids).toEqual(['original', 'fix-ups', 'english']);
    expect((await loadLayerPages('v1', 'fix-ups'))?.[0].blocks[0].lines).toEqual(['あい']);
    expect(await loadLayerPages('v1', 'nope')).toBeNull();
  });

  it('renames and deletes, but never the original', async () => {
    await createLayer('v1', { name: 'A', pages: PAGES });
    await db.volume_ocr_layers.add({
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original',
      created_at: 'x',
      updated_at: 'x',
      pages: PAGES
    });
    await renameLayer('v1', 'a', 'B');
    expect((await db.volume_ocr_layers.get(['v1', 'a']))?.name).toBe('B');
    await expect(renameLayer('v1', 'original', 'X')).rejects.toThrow();
    await expect(deleteLayer('v1', 'original')).rejects.toThrow();
    await deleteLayer('v1', 'a');
    expect(await db.volume_ocr_layers.get(['v1', 'a'])).toBeUndefined();
  });

  it('persistLayerPageEdit replaces one page and bumps updated_at; original is read-only', async () => {
    const l = await createLayer('v1', { name: 'A', pages: PAGES });
    await new Promise((r) => setTimeout(r, 2));
    await persistLayerPageEdit('v1', 'a', 1, pg('かきく', 'q.png'));
    const row = await db.volume_ocr_layers.get(['v1', 'a']);
    expect(row?.pages[1].blocks[0].lines).toEqual(['かきく']);
    expect(row?.pages[0].blocks[0].lines).toEqual(['あい']);
    expect(row!.updated_at > l.updated_at).toBe(true);
    expect((await db.volume_ocr.get('v1'))?.pages[1].blocks[0].lines).toEqual(['うえ']);
    await expect(persistLayerPageEdit('v1', 'original', 0, pg('x'))).rejects.toThrow();
    await expect(persistLayerPageEdit('v1', 'missing', 0, pg('x'))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/reader/edit/layers.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement `layers.ts`**

```ts
/**
 * Every read and write of `volume_ocr_layers` — the alternate page sets that
 * sit beside a volume's PRIMARY OCR row. The primary row stays what every
 * existing consumer reads; a layer is only ever shown by the reader (when the
 * volume's `ocrLayer` setting names it), edited in place, exported, or
 * PROMOTED into the primary row. `original` is the pre-edit snapshot and is
 * read-only. Cloud sync of layers lives in a later PR.
 */
import { db } from '$lib/catalog/db';
import type { Page, VolumeOcrLayer, VolumeOcrLayerKind } from '$lib/types';
import { LAYER_ID_RE } from '$lib/util/sync/syncable-file';
import { ORIGINAL_LAYER_ID } from './edit-persist';

export const LAYER_KIND_LABEL: Record<VolumeOcrLayerKind, string> = {
  original: 'Original',
  edit: 'Edit',
  ocr: 'OCR',
  translation: 'Translation'
};

const MAX_SLUG = 24;

export function slugifyLayerId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG);
  base = base.replace(/-+$/g, '');
  if (!base) base = 'layer';
  let candidate = base;
  let n = 2;
  while (candidate === ORIGINAL_LAYER_ID || used.has(candidate) || !LAYER_ID_RE.test(candidate)) {
    candidate = `${base.slice(0, MAX_SLUG - 3)}-${n++}`;
  }
  return candidate;
}

function assertEditable(layerId: string): void {
  if (layerId === ORIGINAL_LAYER_ID) throw new Error('The original layer is read-only');
}

export async function listLayers(volumeUuid: string): Promise<VolumeOcrLayer[]> {
  const rows = await db.volume_ocr_layers.where('volume_uuid').equals(volumeUuid).toArray();
  return rows.sort((a, b) => {
    if (a.layer_id === ORIGINAL_LAYER_ID) return -1;
    if (b.layer_id === ORIGINAL_LAYER_ID) return 1;
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  });
}

export async function loadLayerPages(volumeUuid: string, layerId: string): Promise<Page[] | null> {
  const row = await db.volume_ocr_layers.get([volumeUuid, layerId]);
  return row?.pages ?? null;
}

export interface CreateLayerOptions {
  name: string;
  kind?: VolumeOcrLayerKind;
  engine?: string;
  /** Pages to copy, or 'empty' to keep only each page's image facts. */
  pages: Page[] | 'empty';
  sourcePages?: Page[];
}

export async function createLayer(
  volumeUuid: string,
  opts: CreateLayerOptions
): Promise<VolumeOcrLayer> {
  const now = new Date().toISOString();
  return db.transaction('rw', db.volume_ocr_layers, async () => {
    const taken = (
      await db.volume_ocr_layers.where('volume_uuid').equals(volumeUuid).primaryKeys()
    ).map((k) => (k as [string, string])[1]);
    const source = opts.pages === 'empty' ? (opts.sourcePages ?? []) : opts.pages;
    const pages: Page[] =
      opts.pages === 'empty' ? source.map((p) => ({ ...p, blocks: [] })) : structuredClone(source);
    const layer: VolumeOcrLayer = {
      volume_uuid: volumeUuid,
      layer_id: slugifyLayerId(opts.name, taken),
      name: opts.name.trim() || 'Layer',
      kind: opts.kind ?? 'edit',
      ...(opts.engine ? { engine: opts.engine } : {}),
      created_at: now,
      updated_at: now,
      pages
    };
    await db.volume_ocr_layers.add(layer);
    return layer;
  });
}

export async function renameLayer(
  volumeUuid: string,
  layerId: string,
  name: string
): Promise<void> {
  assertEditable(layerId);
  const n = await db.volume_ocr_layers.update([volumeUuid, layerId], {
    name: name.trim() || 'Layer'
  });
  if (!n) throw new Error(`Layer ${layerId} not found`);
}

export async function deleteLayer(volumeUuid: string, layerId: string): Promise<void> {
  assertEditable(layerId);
  await db.volume_ocr_layers.delete([volumeUuid, layerId]);
}

export async function persistLayerPageEdit(
  volumeUuid: string,
  layerId: string,
  pageIndex: number,
  page: Page
): Promise<void> {
  assertEditable(layerId);
  await db.transaction('rw', db.volume_ocr_layers, async () => {
    const row = await db.volume_ocr_layers.get([volumeUuid, layerId]);
    if (!row) throw new Error(`Layer ${layerId} not found`);
    const pages = row.pages.slice();
    pages[pageIndex] = page;
    await db.volume_ocr_layers.put({ ...row, pages, updated_at: new Date().toISOString() });
  });
}
```

`structuredClone` exists in Node 17+ and browsers; jsdom tests run on Node.

- [ ] **Step 4: Run** the test file — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reader/edit/layers.ts src/lib/reader/edit/layers.test.ts
git commit -m "feat(layers): layer store — list, create (copy/empty), rename, delete, edit-persist"
```

---

### Task 4: Promote and export

**Files:**

- Modify: `src/lib/reader/edit/layers.ts`
- Test: `src/lib/reader/edit/layers.test.ts`

**Interfaces:**

- Consumes: `buildPageCharCounts` (`$lib/catalog/cloud-ocr-upgrade`), `noteOcrEdited` (`$lib/util/sync/sidecar-backfill`), `buildMokuroMetadata` (`$lib/util/mokuro-metadata`), `layerSidecarName` (Task 1).
- Produces:
  - `promoteLayer(volumeUuid, layerId): Promise<{ replacedLayerId: string | null }>` — copies the layer's pages into `volume_ocr`, recounts chars, stamps `ocr_edited_at`, creates `original` if missing (from the pre-promote primary), saves the pre-promote primary as `replaced-<yyyymmdd-hhmm>` (kind `edit`) unless its pages are JSON-equal to `original`'s, then `noteOcrEdited`.
  - `buildLayerExportFile(volumeUuid, layerId): Promise<File>` — `<Volume Title>.layer.<id>.mokuro`, JSON of `buildMokuroMetadata({...volume, character_count: <layer total>}, layer.pages)`.
  - `replacedLayerId(date: Date): string` — `replaced-YYYYMMDD-HHMM` (UTC); appends `-2`… if taken (via `slugifyLayerId`).

- [ ] **Step 1: Failing tests** (append)

```ts
describe('promoteLayer', () => {
  it('copies the layer into primary, recounts, stamps, snapshots the previous primary, nominates', async () => {
    await createLayer('v1', { name: 'A', pages: [pg('かきくけこ'), pg('さ', 'q.png')] });
    const { replacedLayerId } = await promoteLayer('v1', 'a');
    expect((await db.volume_ocr.get('v1'))?.pages[0].blocks[0].lines).toEqual(['かきくけこ']);
    const row = await db.volumes.get('v1');
    expect(row?.page_char_counts).toEqual([5, 6]);
    expect(row?.character_count).toBe(6);
    expect(typeof row?.ocr_edited_at).toBe('string');
    // No original existed: the pre-promote primary became it, and no replaced-… duplicate was made.
    expect((await db.volume_ocr_layers.get(['v1', 'original']))?.pages[0].blocks[0].lines).toEqual([
      'あい'
    ]);
    expect(replacedLayerId).toBeNull();
    expect(noteOcrEdited).toHaveBeenCalledWith('v1');
  });
  it('keeps a replaced-… snapshot when the previous primary differs from the original', async () => {
    await db.volume_ocr_layers.add({
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original',
      created_at: 'x',
      updated_at: 'x',
      pages: [pg('ORIG'), pg('ORIG2', 'q.png')]
    });
    await createLayer('v1', { name: 'A', pages: [pg('new'), pg('new2', 'q.png')] });
    const { replacedLayerId } = await promoteLayer('v1', 'a');
    expect(replacedLayerId).toMatch(/^replaced-\d{8}-\d{4}$/);
    expect(
      (await db.volume_ocr_layers.get(['v1', replacedLayerId!]))?.pages[0].blocks[0].lines
    ).toEqual(['あい']);
    expect((await db.volume_ocr_layers.get(['v1', 'original']))?.pages[0].blocks[0].lines).toEqual([
      'ORIG'
    ]);
  });
  it('refuses a missing layer and leaves primary untouched', async () => {
    await expect(promoteLayer('v1', 'nope')).rejects.toThrow();
    expect((await db.volume_ocr.get('v1'))?.pages[0].blocks[0].lines).toEqual(['あい']);
  });
});

describe('buildLayerExportFile', () => {
  it('names the file <title>.layer.<id>.mokuro and writes upstream mokuro JSON with the layer chars', async () => {
    await createLayer('v1', {
      name: 'English',
      kind: 'translation',
      pages: [pg('abc'), pg('あ', 'q.png')]
    });
    const file = await buildLayerExportFile('v1', 'english');
    expect(file.name).toBe('Vol 1.layer.english.mokuro');
    const json = JSON.parse(await file.text());
    expect(json.volume_uuid).toBe('v1');
    expect(json.title).toBe('S');
    expect(json.pages[0].blocks[0].lines).toEqual(['abc']);
    expect(json.chars).toBe(1);
    expect(Object.keys(json).sort()).toEqual([
      'chars',
      'pages',
      'title',
      'title_uuid',
      'version',
      'volume',
      'volume_uuid'
    ]);
  });
});
```

Add `promoteLayer, buildLayerExportFile` to the import.

- [ ] **Step 2: Run** — Expected: FAIL (not exported).

- [ ] **Step 3: Implement** (append to `layers.ts`; add imports for `buildPageCharCounts`, `noteOcrEdited`, `buildMokuroMetadata`, `layerSidecarName`)

```ts
export function replacedLayerId(date: Date, taken: Iterable<string> = []): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
  return slugifyLayerId(`replaced-${stamp}`, taken);
}

function samePages(a: Page[], b: Page[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function promoteLayer(
  volumeUuid: string,
  layerId: string
): Promise<{ replacedLayerId: string | null }> {
  const now = new Date();
  const editedAt = now.toISOString();
  const result = await db.transaction(
    'rw',
    [db.volumes, db.volume_ocr, db.volume_ocr_layers],
    async () => {
      const layer = await db.volume_ocr_layers.get([volumeUuid, layerId]);
      if (!layer) throw new Error(`Layer ${layerId} not found`);
      const ocr = await db.volume_ocr.get(volumeUuid);
      if (!ocr) throw new Error(`Volume ${volumeUuid} has no OCR row to promote into`);

      let original = await db.volume_ocr_layers.get([volumeUuid, ORIGINAL_LAYER_ID]);
      let replaced: string | null = null;
      if (!original) {
        original = {
          volume_uuid: volumeUuid,
          layer_id: ORIGINAL_LAYER_ID,
          name: 'Original',
          kind: 'original',
          created_at: editedAt,
          updated_at: editedAt,
          pages: ocr.pages
        };
        await db.volume_ocr_layers.add(original);
      } else if (!samePages(ocr.pages, original.pages)) {
        const taken = (
          await db.volume_ocr_layers.where('volume_uuid').equals(volumeUuid).primaryKeys()
        ).map((k) => (k as [string, string])[1]);
        replaced = replacedLayerId(now, taken);
        await db.volume_ocr_layers.add({
          volume_uuid: volumeUuid,
          layer_id: replaced,
          name: `Previous primary (${editedAt.slice(0, 16).replace('T', ' ')})`,
          kind: 'edit',
          created_at: editedAt,
          updated_at: editedAt,
          pages: ocr.pages
        });
      }

      const pages = structuredClone(layer.pages);
      const { totalChars, cumulative } = buildPageCharCounts(pages);
      await db.volume_ocr.put({ volume_uuid: volumeUuid, pages });
      await db.volumes.update(volumeUuid, {
        page_char_counts: cumulative,
        character_count: totalChars,
        ocr_edited_at: editedAt
      });
      return { replacedLayerId: replaced };
    }
  );
  try {
    noteOcrEdited(volumeUuid);
  } catch (error) {
    console.debug('[layers] could not nominate volume for sidecar re-upload:', error);
  }
  return result;
}

export async function buildLayerExportFile(volumeUuid: string, layerId: string): Promise<File> {
  const [volume, layer] = await Promise.all([
    db.volumes.get(volumeUuid),
    db.volume_ocr_layers.get([volumeUuid, layerId])
  ]);
  if (!volume) throw new Error(`Volume ${volumeUuid} not found`);
  if (!layer) throw new Error(`Layer ${layerId} not found`);
  const { totalChars } = buildPageCharCounts(layer.pages);
  const meta = buildMokuroMetadata({ ...volume, character_count: totalChars }, layer.pages);
  return new File([JSON.stringify(meta)], layerSidecarName(volume.volume_title, layerId), {
    type: 'application/json'
  });
}
```

Note `buildMokuroMetadata` adds `spine_width` only when set; the seed has none, so the key list in the test holds.

- [ ] **Step 4: Run** the test file — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reader/edit/layers.ts src/lib/reader/edit/layers.test.ts
git commit -m "feat(layers): promote a layer to primary (with replaced-… snapshot) and export as .layer.<id>.mokuro"
```

---

### Task 5: The reader renders and edits the displayed layer

**Files:**

- Create: `src/lib/reader/edit/layer-list.ts` — reactive layer summaries per volume.
- Modify: `src/lib/components/Reader/Reader.svelte` (~lines 499–560: `pages`, `enterEditMode`, session options; ~line 1269: QuickActions props)
- Test: `src/lib/reader/edit/layer-list.test.ts`; `src/lib/reader/edit/edit-session.test.ts` (one test: a session whose `persist` is the layer persist — already injectable, no code change needed; assert it is called with the page).

**Interfaces:**

- Produces:
  - `export interface LayerSummary { layer_id: string; name: string; kind: VolumeOcrLayerKind; engine?: string; updated_at: string }`
  - `layerSummaries(volumeUuid: string): Readable<LayerSummary[]>` — Dexie `liveQuery` over `where('volume_uuid').equals(uuid)`, mapped to summaries, `original` first then `created_at`; emits `[]` before the first result and on error.
  - `summarizeLayers(rows: VolumeOcrLayer[]): LayerSummary[]` (pure, tested).
- Reader state: `displayedLayerId: string | null` (from `$volumes[uuid]?.settings?.ocrLayer`), `layerPages: Page[] | null`, `pages = layerPages ?? volumeData.pages`, `editingBlocked = displayedLayerId === 'original'`.

- [ ] **Step 1: Failing test for `summarizeLayers`**

```ts
import { describe, expect, it } from 'vitest';
import { summarizeLayers } from './layer-list';
describe('summarizeLayers', () => {
  it('drops pages, puts original first, then by created_at', () => {
    const rows = [
      {
        volume_uuid: 'v',
        layer_id: 'b',
        name: 'B',
        kind: 'edit',
        created_at: '2026-02-01',
        updated_at: 'x',
        pages: []
      },
      {
        volume_uuid: 'v',
        layer_id: 'original',
        name: 'Original',
        kind: 'original',
        created_at: '2026-03-01',
        updated_at: 'x',
        pages: []
      },
      {
        volume_uuid: 'v',
        layer_id: 'a',
        name: 'A',
        kind: 'ocr',
        engine: 'gcv',
        created_at: '2026-01-01',
        updated_at: 'x',
        pages: []
      }
    ] as const;
    const out = summarizeLayers([...rows] as never);
    expect(out.map((l) => l.layer_id)).toEqual(['original', 'a', 'b']);
    expect(out[1]).toEqual({
      layer_id: 'a',
      name: 'A',
      kind: 'ocr',
      engine: 'gcv',
      updated_at: 'x'
    });
    expect('pages' in out[0]).toBe(false);
  });
});
```

- [ ] **Step 2: Run** — FAIL (module missing).

- [ ] **Step 3: Implement `layer-list.ts`**

```ts
/**
 * Reactive list of a volume's layers WITHOUT their pages — the picker and the
 * settings panel only need names and kinds, and a layer's pages can be
 * megabytes. Backed by a Dexie liveQuery so a create/rename/delete anywhere
 * re-renders every picker.
 */
import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import { db } from '$lib/catalog/db';
import type { VolumeOcrLayer, VolumeOcrLayerKind } from '$lib/types';
import { ORIGINAL_LAYER_ID } from './edit-persist';

export interface LayerSummary {
  layer_id: string;
  name: string;
  kind: VolumeOcrLayerKind;
  engine?: string;
  updated_at: string;
}

export function summarizeLayers(rows: VolumeOcrLayer[]): LayerSummary[] {
  return [...rows]
    .sort((a, b) => {
      if (a.layer_id === ORIGINAL_LAYER_ID) return -1;
      if (b.layer_id === ORIGINAL_LAYER_ID) return 1;
      return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    })
    .map(({ layer_id, name, kind, engine, updated_at }) => ({
      layer_id,
      name,
      kind,
      ...(engine ? { engine } : {}),
      updated_at
    }));
}

export function layerSummaries(volumeUuid: string): Readable<LayerSummary[]> {
  return readable<LayerSummary[]>([], (set) => {
    const sub = liveQuery(() =>
      db.volume_ocr_layers.where('volume_uuid').equals(volumeUuid).toArray()
    ).subscribe({
      next: (rows) => set(summarizeLayers(rows)),
      error: (error) => {
        console.debug('[layer-list] liveQuery failed:', error);
        set([]);
      }
    });
    return () => sub.unsubscribe();
  });
}
```

- [ ] **Step 4: Wire the reader** (`Reader.svelte`)

Imports to add:

```ts
import { layerSummaries, type LayerSummary } from '$lib/reader/edit/layer-list';
import { loadLayerPages, persistLayerPageEdit } from '$lib/reader/edit/layers';
import { ORIGINAL_LAYER_ID } from '$lib/reader/edit/edit-persist';
```

Replace the `pages` derivation (~line 501):

```ts
// `pagesRevision` bumps when the OCR editor persists a page, so the array
// re-derives from the patched in-memory data (see `onPersisted` below).
let pagesRevision = $state(0);

// ---- OCR layers: which page set the reader shows ----
// The per-volume `ocrLayer` setting names an alternate layer; absent (or a
// layer this device does not have) means the primary row. Layer pages are
// loaded once per (volume, layer) and patched in place by the editor.
let displayedLayerId = $derived(
  (volume && $volumes[volume.volume_uuid]?.settings?.ocrLayer) || null
);
let layerPages = $state<Page[] | null>(null);
let loadedLayerKey = $state<string | null>(null);
$effect(() => {
  const uuid = volume?.volume_uuid;
  const id = displayedLayerId;
  const key = uuid && id ? `${uuid}:${id}` : null;
  if (key === loadedLayerKey) return;
  loadedLayerKey = key;
  if (!uuid || !id) {
    layerPages = null;
    return;
  }
  let cancelled = false;
  loadLayerPages(uuid, id)
    .then((p) => {
      if (cancelled) return;
      layerPages = p; // null → primary (silent fallback, setting untouched)
    })
    .catch(() => {
      if (!cancelled) layerPages = null;
    });
  return () => {
    cancelled = true;
  };
});
let layersStore = $derived(volume ? layerSummaries(volume.volume_uuid) : null);
let layers = $state<LayerSummary[]>([]);
$effect(() => {
  const s = layersStore;
  if (!s) {
    layers = [];
    return;
  }
  return s.subscribe((v) => (layers = v));
});
/** The layer actually on screen (null when the setting names a missing layer). */
let activeLayerId = $derived(layerPages ? displayedLayerId : null);
let editingBlocked = $derived(activeLayerId === ORIGINAL_LAYER_ID);

let pages = $derived.by(() => {
  void pagesRevision;
  return layerPages ?? volumeData?.pages ?? [];
});
```

In `enterEditMode`, gate and route persistence:

```ts
  function enterEditMode(focus?: LineRef) {
    if (!volume || !volumeData || $settings.continuousScroll) return;
    if (editingBlocked) {
      showSnackbar('The original layer is read-only — pick another layer or create a copy');
      return;
    }
    ...
    const uuid = volume.volume_uuid;
    const data = volumeData;
    const layerId = activeLayerId;
    const layerPagesAtEntry = layerPages;
    editSession = new EditSession({
      volumeUuid: uuid,
      getPage: (i) => (layerPagesAtEntry ?? data.pages)[i],
      persist: layerId
        ? (v, i, page) => persistLayerPageEdit(v, layerId, i, page)
        : undefined,
      onPersisted: (i, page) => {
        if (layerPagesAtEntry) layerPagesAtEntry[i] = page;
        else data.pages[i] = page;
        pagesRevision++;
        if (!layerId) editHasOriginal = true;
      }
    });
```

`editHasOriginal` when editing a layer: `hasOriginalLayer(uuid)` still answers (original exists once the primary was ever edited or promoted). Keep the existing call.

Switching layers while editing must end the session first: add

```ts
async function selectLayer(layerId: string | null) {
  if (!volume) return;
  if (editSession) await exitEditMode();
  updateVolumeSetting(volume.volume_uuid, 'ocrLayer', layerId ?? undefined);
}
```

(`updateVolumeSetting` is already imported from `$lib/settings` in Reader? If not, add it.) Note `updateVolumeSetting(uuid, 'ocrLayer', undefined)` leaves an `ocrLayer: undefined` key; `VolumeData`'s constructor drops it on the next rebuild and `toJSON` skips it — acceptable.

Pass to QuickActions (Task 7 adds the props): `layers={layers}`, `currentLayer={activeLayerId}`, `onSelectLayer={selectLayer}`, `onLayerAction={(a, id) => runLayerAction(a, id)}` (Task 6 provides `runLayerAction`), and `editEnabled={!$settings.continuousScroll && !editingBlocked}` with the QuickActions title reading "The original layer is read-only" when blocked (add an `editBlockedReason?: string` prop).

Also the `E` key and `requestEditMode` paths go through `enterEditMode`, which already shows the snackbar when blocked.

- [ ] **Step 5: Run** `npx vitest run src/lib/reader/edit src/lib/components/Reader` and `npm run check` — Expected: PASS / 0 errors (QuickActions props arrive in Task 7; until then do NOT pass them — wire the reader props in Task 7).

- [ ] **Step 6: Commit**

```bash
git add src/lib/reader/edit/layer-list.ts src/lib/reader/edit/layer-list.test.ts src/lib/components/Reader/Reader.svelte
git commit -m "feat(reader): render and edit the displayed OCR layer; original is read-only"
```

---

### Task 6: Layer actions orchestrator + name modal

**Files:**

- Create: `src/lib/components/Reader/Layers/layer-actions.ts`
- Create: `src/lib/components/Reader/Layers/LayerNameModal.svelte`
- Test: `src/lib/components/Reader/Layers/__tests__/layer-actions.test.ts`, `src/lib/components/Reader/Layers/__tests__/LayerNameModal.test.ts`

**Interfaces:**

- `layer-actions.ts`:
  - `export type LayerAction = 'new' | 'rename' | 'promote' | 'export' | 'delete'`
  - `export interface LayerNamePrompt { title: string; initialName: string; askSource: boolean; resolve: (r: { name: string; source: 'copy' | 'empty' } | null) => void }`
  - `export const layerNamePrompt: Readable<LayerNamePrompt | null>` + `promptLayerName(opts: { title; initialName?; askSource? }): Promise<{ name; source } | null>` (one modal at a time; a second prompt resolves the first with null).
  - `export async function runLayerAction(action: LayerAction, ctx: { volumeUuid: string; layerId: string | null; displayedPages: Page[]; onSelectLayer: (id: string | null) => Promise<void> | void; deps?: Partial<Deps> }): Promise<void>` where `Deps = { createLayer, renameLayer, deleteLayer, promoteLayer, buildLayerExportFile, download: (f: File) => void, confirm: (msg: string) => Promise<boolean>, notify: (msg: string) => void }` defaulting to the real modules, `downloadFileBlob`, a `promptConfirmation` wrapper and `showSnackbar`.
  - Behaviour: `new` → prompt (askSource) → `createLayer` (copy of `displayedPages` or empty) → select it → notify "Layer created". `rename` → prompt with current name → `renameLayer`. `promote` → confirm "Replace this volume's primary OCR with '<name>'? The current primary is kept as a layer." → `promoteLayer` → select primary → notify. `export` → `buildLayerExportFile` → `download`. `delete` → confirm → if it is the displayed layer select primary first → `deleteLayer` → notify. Any thrown error → `notify(error.message)`.
- `LayerNameModal.svelte`: subscribes to `layerNamePrompt`; flowbite `Modal` with an `Input` (aria-label "Layer name"), when `askSource` two radios "Copy of the current layer" (default) / "Empty", buttons Cancel / OK (aria-label "Confirm layer name"); Enter submits; OK disabled when the name is blank. Mounted once in `Reader.svelte` next to `RereadPromptModal`.

- [ ] **Step 1: Failing tests**

`layer-actions.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { layerNamePrompt, promptLayerName, runLayerAction } from '../layer-actions';
import type { Page } from '$lib/types';

const page: Page = { version: '0.2.1', img_width: 1, img_height: 1, img_path: 'p', blocks: [] };

function deps(over: Record<string, unknown> = {}) {
  return {
    createLayer: vi.fn(async (_v: string, o: { name: string }) => ({
      layer_id: 'copy-1',
      name: o.name
    })),
    renameLayer: vi.fn(async () => {}),
    deleteLayer: vi.fn(async () => {}),
    promoteLayer: vi.fn(async () => ({ replacedLayerId: null })),
    buildLayerExportFile: vi.fn(async () => new File(['{}'], 'Vol.layer.x.mokuro')),
    download: vi.fn(),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
    ...over
  };
}

describe('promptLayerName', () => {
  it('publishes a prompt and resolves with the modal answer; a second prompt cancels the first', async () => {
    const p1 = promptLayerName({ title: 'New layer', askSource: true });
    expect(get(layerNamePrompt)?.title).toBe('New layer');
    const p2 = promptLayerName({ title: 'Rename' });
    expect(await p1).toBeNull();
    get(layerNamePrompt)!.resolve({ name: 'X', source: 'copy' });
    expect(await p2).toEqual({ name: 'X', source: 'copy' });
    expect(get(layerNamePrompt)).toBeNull();
  });
});

describe('runLayerAction', () => {
  it('new: copy of the displayed pages, then selects the new layer', async () => {
    const d = deps();
    const onSelectLayer = vi.fn();
    const run = runLayerAction('new', {
      volumeUuid: 'v',
      layerId: null,
      displayedPages: [page],
      onSelectLayer,
      deps: d
    });
    get(layerNamePrompt)!.resolve({ name: 'Fix', source: 'copy' });
    await run;
    expect(d.createLayer).toHaveBeenCalledWith('v', {
      name: 'Fix',
      pages: [page],
      sourcePages: [page]
    });
    expect(onSelectLayer).toHaveBeenCalledWith('copy-1');
  });
  it('new: empty keeps only image facts', async () => {
    const d = deps();
    const run = runLayerAction('new', {
      volumeUuid: 'v',
      layerId: null,
      displayedPages: [page],
      onSelectLayer: vi.fn(),
      deps: d
    });
    get(layerNamePrompt)!.resolve({ name: 'T', source: 'empty' });
    await run;
    expect(d.createLayer).toHaveBeenCalledWith('v', {
      name: 'T',
      pages: 'empty',
      sourcePages: [page]
    });
  });
  it('promote asks first, then selects primary; a declined confirm does nothing', async () => {
    const d = deps();
    const onSelectLayer = vi.fn();
    await runLayerAction('promote', {
      volumeUuid: 'v',
      layerId: 'a',
      displayedPages: [],
      onSelectLayer,
      deps: d
    });
    expect(d.promoteLayer).toHaveBeenCalledWith('v', 'a');
    expect(onSelectLayer).toHaveBeenCalledWith(null);
    const d2 = deps({ confirm: vi.fn(async () => false) });
    await runLayerAction('promote', {
      volumeUuid: 'v',
      layerId: 'a',
      displayedPages: [],
      onSelectLayer: vi.fn(),
      deps: d2
    });
    expect(d2.promoteLayer).not.toHaveBeenCalled();
  });
  it('delete of the displayed layer switches to primary first; export downloads; errors notify', async () => {
    const d = deps();
    const onSelectLayer = vi.fn();
    await runLayerAction('delete', {
      volumeUuid: 'v',
      layerId: 'a',
      displayedPages: [],
      onSelectLayer,
      deps: d
    });
    expect(onSelectLayer).toHaveBeenCalledWith(null);
    expect(d.deleteLayer).toHaveBeenCalledWith('v', 'a');
    await runLayerAction('export', {
      volumeUuid: 'v',
      layerId: 'a',
      displayedPages: [],
      onSelectLayer,
      deps: d
    });
    expect(d.download).toHaveBeenCalled();
    const d3 = deps({
      renameLayer: vi.fn(async () => {
        throw new Error('boom');
      })
    });
    const run = runLayerAction('rename', {
      volumeUuid: 'v',
      layerId: 'a',
      displayedPages: [],
      onSelectLayer,
      deps: d3
    });
    get(layerNamePrompt)!.resolve({ name: 'N', source: 'copy' });
    await run;
    expect(d3.notify).toHaveBeenCalledWith('boom');
  });
  it('rename/promote/export/delete without a layer id are no-ops', async () => {
    const d = deps();
    for (const a of ['rename', 'promote', 'export', 'delete'] as const) {
      await runLayerAction(a, {
        volumeUuid: 'v',
        layerId: null,
        displayedPages: [],
        onSelectLayer: vi.fn(),
        deps: d
      });
    }
    expect(d.renameLayer).not.toHaveBeenCalled();
    expect(d.promoteLayer).not.toHaveBeenCalled();
    expect(d.download).not.toHaveBeenCalled();
    expect(d.deleteLayer).not.toHaveBeenCalled();
  });
});
```

`LayerNameModal.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import LayerNameModal from '../LayerNameModal.svelte';
import { promptLayerName } from '../layer-actions';

afterEach(cleanup);

describe('LayerNameModal', () => {
  it('shows the prompt, disables OK on a blank name, and resolves name + source', async () => {
    const { getByLabelText, getByText } = render(LayerNameModal);
    const p = promptLayerName({ title: 'New layer', askSource: true });
    await tick();
    const ok = getByLabelText('Confirm layer name') as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    await fireEvent.input(getByLabelText('Layer name'), { target: { value: 'English' } });
    await fireEvent.click(getByText('Empty'));
    await fireEvent.click(ok);
    expect(await p).toEqual({ name: 'English', source: 'empty' });
  });
  it('Cancel resolves null', async () => {
    const { getByText } = render(LayerNameModal);
    const p = promptLayerName({ title: 'Rename', initialName: 'A' });
    await tick();
    await fireEvent.click(getByText('Cancel'));
    expect(await p).toBeNull();
  });
});
```

- [ ] **Step 2: Run both** — FAIL (modules missing).

- [ ] **Step 3: Implement `layer-actions.ts`**

```ts
/**
 * One orchestrator for every layer action the UI offers, so the quick-actions
 * picker and the settings panel cannot drift: prompt, confirm, call the store,
 * switch the displayed layer, notify. The name prompt is a store the
 * `LayerNameModal` (mounted once by the reader) renders.
 */
import { readonly, writable } from 'svelte/store';
import type { Page } from '$lib/types';
import {
  buildLayerExportFile as realBuildLayerExportFile,
  createLayer as realCreateLayer,
  deleteLayer as realDeleteLayer,
  promoteLayer as realPromoteLayer,
  renameLayer as realRenameLayer
} from '$lib/reader/edit/layers';
import { downloadFileBlob } from '$lib/util/volume-sidecars';
import { promptConfirmation } from '$lib/util/modals';
import { showSnackbar } from '$lib/util/snackbar';

export type LayerAction = 'new' | 'rename' | 'promote' | 'export' | 'delete';
export type LayerSource = 'copy' | 'empty';

export interface LayerNamePrompt {
  title: string;
  initialName: string;
  askSource: boolean;
  resolve: (r: { name: string; source: LayerSource } | null) => void;
}

const prompt = writable<LayerNamePrompt | null>(null);
export const layerNamePrompt = readonly(prompt);

export function promptLayerName(opts: {
  title: string;
  initialName?: string;
  askSource?: boolean;
}): Promise<{ name: string; source: LayerSource } | null> {
  return new Promise((resolve) => {
    let current: LayerNamePrompt | null = null;
    prompt.update((prev) => {
      prev?.resolve(null);
      current = {
        title: opts.title,
        initialName: opts.initialName ?? '',
        askSource: opts.askSource ?? false,
        resolve: (r) => {
          prompt.update((p) => (p === current ? null : p));
          resolve(r);
        }
      };
      return current;
    });
  });
}

export interface LayerActionDeps {
  createLayer: typeof realCreateLayer;
  renameLayer: typeof realRenameLayer;
  deleteLayer: typeof realDeleteLayer;
  promoteLayer: typeof realPromoteLayer;
  buildLayerExportFile: typeof realBuildLayerExportFile;
  download: (file: File) => void;
  confirm: (message: string) => Promise<boolean>;
  notify: (message: string) => void;
}

const defaultDeps: LayerActionDeps = {
  createLayer: realCreateLayer,
  renameLayer: realRenameLayer,
  deleteLayer: realDeleteLayer,
  promoteLayer: realPromoteLayer,
  buildLayerExportFile: realBuildLayerExportFile,
  download: downloadFileBlob,
  confirm: (message) =>
    new Promise((resolve) =>
      promptConfirmation(
        message,
        () => resolve(true),
        () => resolve(false)
      )
    ),
  notify: (message) => showSnackbar(message)
};

export interface LayerActionContext {
  volumeUuid: string;
  /** The layer the action targets (the displayed one); null = primary. */
  layerId: string | null;
  layerName?: string;
  /** What is on screen now — the source for "copy" / "empty". */
  displayedPages: Page[];
  onSelectLayer: (layerId: string | null) => Promise<void> | void;
  deps?: Partial<LayerActionDeps>;
}

export async function runLayerAction(action: LayerAction, ctx: LayerActionContext): Promise<void> {
  const d: LayerActionDeps = { ...defaultDeps, ...ctx.deps };
  const { volumeUuid, layerId } = ctx;
  try {
    switch (action) {
      case 'new': {
        const r = await promptLayerName({ title: 'New layer', askSource: true });
        if (!r) return;
        const layer = await d.createLayer(volumeUuid, {
          name: r.name,
          pages: r.source === 'empty' ? 'empty' : ctx.displayedPages,
          sourcePages: ctx.displayedPages
        });
        await ctx.onSelectLayer(layer.layer_id);
        d.notify(`Layer "${layer.name}" created`);
        return;
      }
      case 'rename': {
        if (!layerId) return;
        const r = await promptLayerName({
          title: 'Rename layer',
          initialName: ctx.layerName ?? ''
        });
        if (!r) return;
        await d.renameLayer(volumeUuid, layerId, r.name);
        return;
      }
      case 'promote': {
        if (!layerId) return;
        const ok = await d.confirm(
          `Replace this volume's primary OCR with "${ctx.layerName ?? layerId}"? The current primary is kept as a layer.`
        );
        if (!ok) return;
        await d.promoteLayer(volumeUuid, layerId);
        await ctx.onSelectLayer(null);
        d.notify('Layer promoted to primary');
        return;
      }
      case 'export': {
        if (!layerId) return;
        d.download(await d.buildLayerExportFile(volumeUuid, layerId));
        return;
      }
      case 'delete': {
        if (!layerId) return;
        const ok = await d.confirm(
          `Delete layer "${ctx.layerName ?? layerId}"? This cannot be undone.`
        );
        if (!ok) return;
        await ctx.onSelectLayer(null);
        await d.deleteLayer(volumeUuid, layerId);
        d.notify('Layer deleted');
        return;
      }
    }
  } catch (error) {
    d.notify(error instanceof Error ? error.message : String(error));
  }
}
```

Check the exact `promptConfirmation` signature in `src/lib/util/modals.ts` (message, onConfirm, onCancel) before relying on it.

- [ ] **Step 4: Implement `LayerNameModal.svelte`**

```svelte
<script lang="ts">
  import { Button, Input, Label, Modal, Radio } from 'flowbite-svelte';
  import { layerNamePrompt, type LayerSource } from './layer-actions';

  let name = $state('');
  let source = $state<LayerSource>('copy');
  let open = $derived($layerNamePrompt !== null);
  $effect(() => {
    const p = $layerNamePrompt;
    if (p) {
      name = p.initialName;
      source = 'copy';
    }
  });
  function cancel() {
    $layerNamePrompt?.resolve(null);
  }
  function confirm() {
    const p = $layerNamePrompt;
    if (!p || !name.trim()) return;
    p.resolve({ name: name.trim(), source });
  }
</script>

{#if $layerNamePrompt}
  <Modal {open} size="xs" onclose={cancel} dismissable>
    <form
      class="flex flex-col gap-4 p-2"
      onsubmit={(e) => {
        e.preventDefault();
        confirm();
      }}
    >
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">{$layerNamePrompt.title}</h3>
      <Label>
        Name
        <Input class="mt-1" aria-label="Layer name" bind:value={name} autofocus />
      </Label>
      {#if $layerNamePrompt.askSource}
        <div class="flex flex-col gap-1">
          <Radio name="layer-source" value="copy" bind:group={source}
            >Copy of the current layer</Radio
          >
          <Radio name="layer-source" value="empty" bind:group={source}>Empty</Radio>
        </div>
      {/if}
      <div class="relative z-10 flex justify-end gap-2">
        <Button color="alternative" type="button" onclick={cancel}>Cancel</Button>
        <Button
          color="primary"
          type="submit"
          aria-label="Confirm layer name"
          disabled={!name.trim()}>OK</Button
        >
      </div>
    </form>
  </Modal>
{/if}
```

(`relative z-10` on the button row per CLAUDE.md's night-mode rule.) Mount `<LayerNameModal />` in `Reader.svelte` beside `RereadPromptModal`.

- [ ] **Step 5: Run both tests** — PASS. If flowbite's `Modal` does not render children in jsdom under the test, render `LayerNameModal` and query by label as written; adjust only the selectors, never the behaviour.

- [ ] **Step 6: Commit**

```bash
git add src/lib/components/Reader/Layers src/lib/components/Reader/Reader.svelte
git commit -m "feat(layers): layer actions orchestrator (new/rename/promote/export/delete) and name modal"
```

---

### Task 7: LayerPicker in the quick actions menu

**Files:**

- Create: `src/lib/components/Reader/Layers/LayerPicker.svelte`
- Modify: `src/lib/components/Reader/QuickActions.svelte` (props + a "Layers" button that opens the picker), `src/lib/components/Reader/Reader.svelte` (pass the props from Task 5 and `runLayerAction`)
- Test: `src/lib/components/Reader/Layers/__tests__/LayerPicker.test.ts`

**Interfaces:**

- `LayerPicker` props: `layers: LayerSummary[]`, `current: string | null`, `onSelect: (id: string | null) => void`, `onAction: (action: LayerAction, layerId: string | null) => void`, `onClose: () => void`.
- Markup: a panel (`role="dialog"`, `aria-label="OCR layers"`, fixed bottom-right above the quick actions) listing a "Primary" row plus one row per layer (`role="radio"` buttons, `aria-checked`), each with a kind badge (`LAYER_KIND_LABEL`) and, for non-original layers, an overflow row of icon buttons: Rename, Promote, Export, Delete (aria-labels `Rename layer <name>` etc.). `original` shows only Export. A "New layer…" button (aria-label "New layer") at the bottom.
- QuickActions: new props `layers?: LayerSummary[]`, `currentLayer?: string | null`, `onSelectLayer?: (id) => void`, `onLayerAction?: (action, id) => void`, `editBlockedReason?: string`. Shows a "Layers" button (`aria-label="OCR layers"`, icon `LayersOutline` if it exists in flowbite-svelte-icons, else `ListOutline`) when `layers.length > 0 || editing`; clicking toggles the picker.

- [ ] **Step 1: Failing test**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import LayerPicker from '../LayerPicker.svelte';

afterEach(cleanup);
const layers = [
  { layer_id: 'original', name: 'Original', kind: 'original' as const, updated_at: 'x' },
  { layer_id: 'english', name: 'English', kind: 'translation' as const, updated_at: 'x' }
];

describe('LayerPicker', () => {
  it('lists Primary and every layer with its kind, marks the current one, and selects', async () => {
    const onSelect = vi.fn();
    const { getByRole, getAllByRole, getByText } = render(LayerPicker, {
      props: { layers, current: 'english', onSelect, onAction: vi.fn(), onClose: vi.fn() }
    });
    const radios = getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
    expect(getByText('Translation')).toBeTruthy();
    await fireEvent.click(getByRole('radio', { name: /Primary/ }));
    expect(onSelect).toHaveBeenCalledWith(null);
    await fireEvent.click(getByRole('radio', { name: /Original/ }));
    expect(onSelect).toHaveBeenCalledWith('original');
  });
  it('offers rename/promote/export/delete on a layer, only export on original, and New layer', async () => {
    const onAction = vi.fn();
    const { getByLabelText, queryByLabelText } = render(LayerPicker, {
      props: { layers, current: null, onSelect: vi.fn(), onAction, onClose: vi.fn() }
    });
    await fireEvent.click(getByLabelText('Promote layer English'));
    expect(onAction).toHaveBeenCalledWith('promote', 'english');
    expect(queryByLabelText('Rename layer Original')).toBeNull();
    expect(queryByLabelText('Delete layer Original')).toBeNull();
    expect(getByLabelText('Export layer Original')).toBeTruthy();
    await fireEvent.click(getByLabelText('New layer'));
    expect(onAction).toHaveBeenCalledWith('new', null);
  });
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement `LayerPicker.svelte`**

```svelte
<script lang="ts">
  import type { LayerSummary } from '$lib/reader/edit/layer-list';
  import { LAYER_KIND_LABEL } from '$lib/reader/edit/layers';
  import { ORIGINAL_LAYER_ID } from '$lib/reader/edit/edit-persist';
  import type { LayerAction } from './layer-actions';
  import {
    CloseOutline,
    DownloadOutline,
    EditOutline,
    TrashBinOutline,
    ArrowUpOutline,
    PlusOutline
  } from 'flowbite-svelte-icons';

  interface Props {
    layers: LayerSummary[];
    current: string | null;
    onSelect: (layerId: string | null) => void;
    onAction: (action: LayerAction, layerId: string | null) => void;
    onClose: () => void;
  }
  let { layers, current, onSelect, onAction, onClose }: Props = $props();

  const row =
    'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-gray-600 aria-checked:bg-gray-600';
  const icon = 'rounded p-1 text-gray-300 hover:bg-gray-500 hover:text-white';
</script>

<div
  role="dialog"
  aria-label="OCR layers"
  class="fixed end-3 bottom-20 z-50 w-72 rounded-lg bg-gray-700 p-2 text-gray-100 shadow-xl"
>
  <div class="mb-1 flex items-center justify-between px-1">
    <span class="text-xs font-semibold tracking-wide text-gray-300 uppercase">OCR layers</span>
    <button class={icon} aria-label="Close layers" onclick={onClose}
      ><CloseOutline size="sm" /></button
    >
  </div>
  <button role="radio" aria-checked={current === null} class={row} onclick={() => onSelect(null)}>
    <span class="flex-1">Primary</span>
    <span class="rounded bg-gray-800 px-1 text-[10px]">Primary</span>
  </button>
  {#each layers as layer (layer.layer_id)}
    <div class="flex items-center">
      <button
        role="radio"
        aria-checked={current === layer.layer_id}
        class={row}
        onclick={() => onSelect(layer.layer_id)}
      >
        <span class="flex-1 truncate">{layer.name}</span>
        <span class="rounded bg-gray-800 px-1 text-[10px]">{LAYER_KIND_LABEL[layer.kind]}</span>
      </button>
      <div class="flex shrink-0">
        {#if layer.layer_id !== ORIGINAL_LAYER_ID}
          <button
            class={icon}
            aria-label={`Rename layer ${layer.name}`}
            onclick={() => onAction('rename', layer.layer_id)}><EditOutline size="sm" /></button
          >
          <button
            class={icon}
            aria-label={`Promote layer ${layer.name}`}
            title="Promote to primary"
            onclick={() => onAction('promote', layer.layer_id)}><ArrowUpOutline size="sm" /></button
          >
        {/if}
        <button
          class={icon}
          aria-label={`Export layer ${layer.name}`}
          onclick={() => onAction('export', layer.layer_id)}><DownloadOutline size="sm" /></button
        >
        {#if layer.layer_id !== ORIGINAL_LAYER_ID}
          <button
            class={icon}
            aria-label={`Delete layer ${layer.name}`}
            onclick={() => onAction('delete', layer.layer_id)}><TrashBinOutline size="sm" /></button
          >
        {/if}
      </div>
    </div>
  {/each}
  <button
    class="{row} mt-1 border-t border-gray-600 pt-2"
    aria-label="New layer"
    onclick={() => onAction('new', null)}
  >
    <PlusOutline size="sm" /><span>New layer…</span>
  </button>
</div>
```

Verify each icon name exists (`grep -c "export.*ArrowUpOutline" node_modules/flowbite-svelte-icons/dist/index.d.ts`) and substitute if not.

- [ ] **Step 4: QuickActions + Reader wiring**

QuickActions: add the props listed above; `let layersOpen = $state(false)`; in the open menu add, above the Edit button:

```svelte
{#if (layers?.length ?? 0) > 0 || editing}
  <button
    onclick={() => {
      layersOpen = !layersOpen;
    }}
    class="…same button classes…"
    aria-label="OCR layers"><LayersOutline size="xl" /></button
  >
{/if}
```

and after the menu `{/if}`:

```svelte
{#if layersOpen}
  <LayerPicker
    layers={layers ?? []}
    current={currentLayer ?? null}
    onSelect={(id) => {
      onSelectLayer?.(id);
      layersOpen = false;
    }}
    onAction={(a, id) => {
      onLayerAction?.(a, id);
      layersOpen = false;
    }}
    onClose={() => (layersOpen = false)}
  />
{/if}
```

The Edit button's `title` uses `editBlockedReason` when set.

Reader: pass `layers`, `currentLayer={activeLayerId}`, `onSelectLayer={selectLayer}`, `onLayerAction={runLayerActionFromReader}`, `editEnabled={!$settings.continuousScroll && !editingBlocked}`, `editBlockedReason={editingBlocked ? 'The original layer is read-only' : undefined}` where

```ts
function runLayerActionFromReader(action: LayerAction, layerId: string | null) {
  if (!volume) return;
  const target = layerId ?? activeLayerId;
  void runLayerAction(action, {
    volumeUuid: volume.volume_uuid,
    layerId: target,
    layerName: layers.find((l) => l.layer_id === target)?.name,
    displayedPages: pages,
    onSelectLayer: selectLayer
  });
}
```

- [ ] **Step 5: Run** `npx vitest run src/lib/components/Reader` + `npm run check` — PASS / 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/components/Reader/Layers/LayerPicker.svelte src/lib/components/Reader/Layers/__tests__/LayerPicker.test.ts src/lib/components/Reader/QuickActions.svelte src/lib/components/Reader/Reader.svelte
git commit -m "feat(reader): OCR layer picker in the quick actions menu"
```

---

### Task 8: "OCR layers" in the reader settings panel

**Files:**

- Modify: `src/lib/components/Settings/Reader/ReaderSettings.svelte` (per-volume section, after "First page is cover")
- Test: `src/lib/components/Settings/Reader/__tests__/ReaderSettings.layers.test.ts` (mock `$lib/settings` like `ReaderToggles.editmode.test.ts`, mock `$lib/util` `isReader` → true, mock `$lib/util/hash-router` `routeParams` → `{ volume: 'v1' }`, mock `$lib/reader/edit/layer-list` `layerSummaries` → a readable of two layers, mock `$lib/components/Reader/Layers/layer-actions` `runLayerAction`).

**Interfaces:**

- Consumes: `layerSummaries`, `runLayerAction`, `updateVolumeSetting`, `$volumes[volumeId]?.settings?.ocrLayer`, `LAYER_KIND_LABEL`.
- Markup: `<Select aria-label="OCR layer">` with `Primary` + each layer `"<name> (<kind>)"`, `onchange` → `updateVolumeSetting(volumeId, 'ocrLayer', value || undefined)`; a button row: "New layer…" (aria-label "New layer"), and when a non-primary layer is selected: Rename, Promote, Export, Delete (aria-labels "Rename layer", "Promote layer", "Export layer", "Delete layer"; Rename/Delete/Promote hidden for `original`). Actions call `runLayerAction(action, { volumeUuid, layerId, layerName, displayedPages: [], onSelectLayer })` — `displayedPages` for "new" from the settings panel: load them via `loadLayerPages(volumeId, current)` or `db.volume_ocr.get(volumeId)` (primary) at click time; if neither loads, notify and stop.

- [ ] **Step 1: Failing test**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { readable, writable } from 'svelte/store';

const updateVolumeSetting = vi.hoisted(() => vi.fn());
const runLayerAction = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$lib/settings', async () => {
  const { writable, readable } = await import('svelte/store');
  return {
    settings: writable({
      continuousScroll: false,
      singlePageView: 'dual',
      scrollMode: 'auto',
      swipeThreshold: 50,
      edgeButtonWidth: 10,
      showTimer: false,
      quickActions: true,
      disableAnimations: false,
      inactivityTimeoutMinutes: 5
    }),
    updateSetting: vi.fn(),
    effectiveVolumeSettings: readable({ v1: { rightToLeft: true, hasCover: true } }),
    updateProgress: vi.fn(),
    updateVolumeSetting,
    volumes: readable({ v1: { progress: 1, settings: { ocrLayer: 'english' } } }),
    nightModeActive: readable(false)
  };
});
vi.mock('$lib/util', () => ({ isReader: () => true, showSnackbar: vi.fn() }));
vi.mock('$lib/util/hash-router', () => ({ routeParams: readable({ volume: 'v1' }) }));
vi.mock('$lib/reader/edit/layer-list', () => ({
  layerSummaries: () =>
    readable([
      { layer_id: 'original', name: 'Original', kind: 'original', updated_at: 'x' },
      { layer_id: 'english', name: 'English', kind: 'translation', updated_at: 'x' }
    ])
}));
vi.mock('$lib/components/Reader/Layers/layer-actions', () => ({ runLayerAction }));
vi.mock('./ReaderSelects.svelte', async () => ({
  default: (await import('./__tests__/Stub.svelte')).default
}));
vi.mock('./ReaderToggles.svelte', async () => ({
  default: (await import('./__tests__/Stub.svelte')).default
}));

import ReaderSettings from '../ReaderSettings.svelte';
afterEach(cleanup);

describe('ReaderSettings — OCR layers', () => {
  it('lists layers in a select bound to the volume setting and exposes the actions', async () => {
    const { getByLabelText, queryByLabelText } = render(ReaderSettings);
    const select = getByLabelText('OCR layer') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
      'Primary',
      'Original (Original)',
      'English (Translation)'
    ]);
    expect(select.value).toBe('english');
    await fireEvent.change(select, { target: { value: '' } });
    expect(updateVolumeSetting).toHaveBeenCalledWith('v1', 'ocrLayer', undefined);
    await fireEvent.click(getByLabelText('Promote layer'));
    expect(runLayerAction).toHaveBeenCalledWith(
      'promote',
      expect.objectContaining({ volumeUuid: 'v1', layerId: 'english' })
    );
    expect(queryByLabelText('New layer')).toBeTruthy();
  });
});
```

Check whether a `Stub.svelte` exists in `src/lib/components/Settings/Reader/__tests__/` (the edit-mode test used one for `ScheduledFilterCard`); create a one-line empty component if not. Adjust the mocked module paths to what `ReaderSettings.svelte` actually imports (`./ReaderSelects.svelte`, `./ReaderToggles.svelte` relative to the component — vitest mocks resolve by absolute id, so mock with the same specifier the component uses, i.e. `$lib/components/Settings/Reader/ReaderSelects.svelte` form if the relative one does not match).

- [ ] **Step 2: Run** — FAIL (no "OCR layer" select).

- [ ] **Step 3: Implement** in `ReaderSettings.svelte`

Script additions:

```ts
import { layerSummaries, type LayerSummary } from '$lib/reader/edit/layer-list';
import { LAYER_KIND_LABEL, loadLayerPages } from '$lib/reader/edit/layers';
import { ORIGINAL_LAYER_ID } from '$lib/reader/edit/edit-persist';
import { runLayerAction, type LayerAction } from '$lib/components/Reader/Layers/layer-actions';
import { db } from '$lib/catalog/db';

let layersStore = $derived(inReader && volumeId ? layerSummaries(volumeId) : null);
let layers = $state<LayerSummary[]>([]);
$effect(() => {
  const s = layersStore;
  if (!s) {
    layers = [];
    return;
  }
  return s.subscribe((v) => (layers = v));
});
let currentLayer = $derived((volumeId && $volumes[volumeId]?.settings?.ocrLayer) || '');
let currentLayerName = $derived(layers.find((l) => l.layer_id === currentLayer)?.name);

function onLayerChange(e: Event) {
  if (!volumeId) return;
  const value = (e.target as HTMLSelectElement).value;
  updateVolumeSetting(volumeId, 'ocrLayer', value || undefined);
}
async function layerAction(action: LayerAction) {
  if (!volumeId) return;
  const uuid = volumeId;
  const layerId = currentLayer || null;
  let displayedPages: Page[] = [];
  if (action === 'new') {
    displayedPages =
      (layerId ? await loadLayerPages(uuid, layerId) : (await db.volume_ocr.get(uuid))?.pages) ??
      [];
  }
  await runLayerAction(action, {
    volumeUuid: uuid,
    layerId,
    layerName: currentLayerName,
    displayedPages,
    onSelectLayer: (id) => updateVolumeSetting(uuid, 'ocrLayer', id ?? undefined)
  });
}
```

(`import type { Page } from '$lib/types'`.)

Markup, after the "First page is cover" toggle block and before "Offset spreads":

```svelte
<!-- 8b. OCR layers -->
<div class="flex flex-col gap-2">
  <Label>
    OCR layer
    <Select aria-label="OCR layer" class="mt-1" value={currentLayer} onchange={onLayerChange}>
      <option value="">Primary</option>
      {#each layers as layer (layer.layer_id)}
        <option value={layer.layer_id}>{layer.name} ({LAYER_KIND_LABEL[layer.kind]})</option>
      {/each}
    </Select>
  </Label>
  <div class="flex flex-wrap gap-1">
    <Button size="xs" color="alternative" aria-label="New layer" onclick={() => layerAction('new')}
      >New layer…</Button
    >
    {#if currentLayer}
      {#if currentLayer !== ORIGINAL_LAYER_ID}
        <Button
          size="xs"
          color="alternative"
          aria-label="Rename layer"
          onclick={() => layerAction('rename')}>Rename</Button
        >
        <Button
          size="xs"
          color="alternative"
          aria-label="Promote layer"
          onclick={() => layerAction('promote')}>Promote to primary</Button
        >
      {/if}
      <Button
        size="xs"
        color="alternative"
        aria-label="Export layer"
        onclick={() => layerAction('export')}>Export</Button
      >
      {#if currentLayer !== ORIGINAL_LAYER_ID}
        <Button
          size="xs"
          color="red"
          outline
          aria-label="Delete layer"
          onclick={() => layerAction('delete')}>Delete</Button
        >
      {/if}
    {/if}
  </div>
</div>
```

Note: the settings panel is not a child of the reader, so a running edit session is not flushed by a select change here. The reader's `$effect` on `displayedLayerId` swaps pages; make the reader ALSO exit edit mode when `displayedLayerId` changes while a session is open (add to the existing "leaving the volume / continuous" effect: `|| editSession.layerId !== (activeLayerId ?? null)` — store the session's layer id on the `EditSession` via a public readonly field set from the options: add `readonly layerId: string | null` to `EditSessionOptions`/class, default `null`).

- [ ] **Step 4: Run** the test + `npm run check` — PASS / 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/Settings/Reader/ReaderSettings.svelte src/lib/components/Settings/Reader/__tests__ src/lib/reader/edit/edit-session.svelte.ts src/lib/components/Reader/Reader.svelte
git commit -m "feat(settings): OCR layer select and actions in the per-volume reader settings"
```

---

### Task 9: End-to-end

**Files:**

- Create: `e2e/ocr-layers.spec.ts` (copy the `seedVolume`, `openReader`, `enterEditMode` helpers from `e2e/ocr-editor.spec.ts`; one page, single view)

**Cases:**

1. Open the reader; the quick actions menu has no "OCR layers" button (no layers yet). Enter edit mode → the button appears. Click it → the picker lists "Primary" only (no `original` yet: nothing was edited). Click "New layer" → modal → type "Fix" → OK. Expect the picker's current layer to be `fix` (the volume setting `ocrLayer === 'fix'` read via `localStorage` `volumes` JSON or the settings store) and `db.volume_ocr_layers.get([uuid,'fix'])` to exist with the copied block.
2. Edit the block's text while `fix` is displayed (double-click, type, Escape, wait 1200 ms): the layer row's page has the new text; `db.volume_ocr` is untouched.
3. Open the picker → "Promote layer Fix" → confirm dialog (click its confirm button; find its label in `ConfirmationPopup.svelte`) → `db.volume_ocr` now has the edited text; an `original` layer exists with the original text; no `replaced-…` layer (primary equalled original); the displayed layer is Primary.
4. Export: open the picker → "Export layer Fix" → `page.waitForEvent('download')` → `suggestedFilename() === 'Vol 1.layer.fix.mokuro'`; read the download and check `JSON.parse(...).pages[0].blocks[0].lines`.
5. Switching to `original` disables the Edit quick action (its `disabled` attribute) and the toolbar never appears; switching back to Primary re-enables it.

- [ ] **Step 1: Write the spec** with the five cases as separate `test()`s (each seeds fresh).
- [ ] **Step 2: Run** `E2E_PORT=5179 npx playwright test e2e/ocr-layers.spec.ts` — Expected: 5 passed. Fix selectors as needed; never weaken an assertion.
- [ ] **Step 3: Commit**

```bash
git add e2e/ocr-layers.spec.ts
git commit -m "test(e2e): OCR layers — create, switch, edit, promote, export, original read-only"
```

---

### Task 10: Full verification + review server

- [ ] `npx vitest run` — all green (the catalog-index-sync IndexedDB-refusal test is a known full-suite flake; report if it fires).
- [ ] `npm run check` — 0 errors.
- [ ] `npm run lint` — 0 errors; warnings ≤ develop's 272 baseline plus none in touched files.
- [ ] `E2E_PORT=5179 npx playwright test e2e/ocr-editor.spec.ts e2e/ocr-layers.spec.ts` — all pass.
- [ ] `npm run dev -- --port 5180 --strictPort` in the background; confirm `curl -s -o /dev/null -w '%{http_code}' http://localhost:5180/` is 200.

## Self-review notes

- Spec coverage: Model (`ocrLayer` setting, fallback to primary) → Tasks 2, 5. Picker → 7. Edit displayed layer → 5. Revert from original → unchanged (`loadOriginalPage`). New/Rename/Promote (+replaced snapshot)/Export/Delete → 3, 4, 6, 7, 8. Volume settings modal actions → 8 (the per-volume section of the settings panel is where hasCover/RTL live; the spec's "volume settings modal" is read as that panel). ZIP export inclusion and cloud → out of scope by directive.
- Placeholder scan: none.
- Type consistency: `LayerSummary`, `LayerAction`, `runLayerAction(action, ctx)`, `createLayer(uuid, { name, kind?, pages, sourcePages? })`, `promoteLayer → { replacedLayerId }`, `buildLayerExportFile → File`, `persistLayerPageEdit(uuid, layerId, i, page)` used identically across tasks.
