# In-reader OCR editor (sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Edit button in the paged reader that lets the user move, resize, add, delete, merge, split and retype OCR blocks in place, with undo/redo, autosave into the primary OCR row, an immutable `original` layer for revert, and a guarantee that edited sidecars reach the cloud.

**Architecture:** Pure `Page → Page` operations (`src/lib/reader/edit/edit-ops.ts`) driven by a runes-class `EditSession` that owns per-page working copies, selection, history, and a debounced persist. An `EditOverlay` mounted inside `MangaPage` renders every raw block as an `EditableBlock` (class `editBlock`, gesture role `'editor'`), and an `EditToolbar` fixed to the viewport exposes the ops. `persistPageEdit` writes the OCR row and char counts in one Dexie transaction, snapshotting the pre-edit pages into a new `volume_ocr_layers` table on the first save. A small hook in `sidecar-backfill.ts` re-uploads the `.mokuro` of an edited volume.

**Tech Stack:** SvelteKit 5 (runes), Dexie 4 over IndexedDB (`fake-indexeddb` in tests), Vitest + @testing-library/svelte (jsdom), Playwright e2e, flowbite-svelte-icons, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-09-15-ocr-editor-layers-engines-design.md` (sub-project A section).

## Global Constraints

- Worktree `/home/nathan/Projects/mokuro-reader-worktrees/feat/ocr-editor`, branch `feat/ocr-editor`. Never touch the main directory or ports 5173/5174.
- Every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Local commits only, no push.
- Edit overlay blocks use class `editBlock`, never `.textBox`. `gestureTargetRole` returns `'editor'` for them, matched before `'textbox'`.
- The overlay renders ALL raw `page.blocks` — no `dedupeBlocks`.
- `.mokuro` stays pure upstream: nothing reader-private is written into `volume_ocr.pages`.
- Dexie schema: `db-schema.ts` is at version 2 today; this plan adds **version 3** (additive).
- The `textEditable` setting is removed entirely.
- Run targeted tests with `npx vitest run <path>`; the whole suite with `npx vitest run`.
- Prettier runs on commit via lint-staged; run `npx prettier --write <files>` before staging to avoid a failed hook.

---

### Task 1: Types and schema version 3 (layer table, `ocr_edited_at` index) + delete paths

**Files:**

- Modify: `src/lib/types/index.ts` (after `VolumeFiles`, ~line 145; and `VolumeMetadata`, ~line 62)
- Modify: `src/lib/catalog/db-schema.ts` (append a version 3 entry to `MOKURO_DB_SCHEMA`)
- Modify: `src/lib/catalog/db-v3.ts` (declare the `volume_ocr_layers` table property)
- Modify: `src/lib/import/database.ts:222-247` (`removeVolumeFiles`, `deleteVolumeCompletely`)
- Modify: `src/lib/components/Settings/CatalogSettings.svelte:96-101`
- Test: `src/lib/catalog/__tests__/volume-ocr-layers.test.ts`

**Interfaces:**

- Produces: `VolumeOcrLayer` type; `db.volume_ocr_layers: Table<VolumeOcrLayer>`; `VolumeMetadata.ocr_edited_at?: string`; index `ocr_edited_at` on `volumes`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/catalog/__tests__/volume-ocr-layers.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));

const DB_NAME = 'mokuro_v3_layers_schema_test';
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_layers_schema_test') };
});

import { db } from '$lib/catalog/db';
import { deleteVolumeCompletely, removeVolumeFiles } from '$lib/import/database';
import { MOKURO_DB_SCHEMA } from '$lib/catalog/db-schema';

afterEach(async () => {
  await Promise.all([
    db.volumes.clear(),
    db.volume_ocr.clear(),
    db.volume_files.clear(),
    db.volume_ocr_layers.clear()
  ]);
});

function row() {
  return {
    volume_uuid: 'v1',
    series_uuid: 's1',
    series_title: 'Series',
    volume_title: 'Vol 1',
    mokuro_version: '0.2.1',
    page_count: 1,
    character_count: 3,
    page_char_counts: [3]
  };
}

describe('volume_ocr_layers schema', () => {
  it('declares version 3 with the layers table and the ocr_edited_at index', () => {
    const v3 = MOKURO_DB_SCHEMA.find((v) => v.version === 3);
    expect(v3?.stores.volume_ocr_layers).toBe('[volume_uuid+layer_id], volume_uuid');
    expect(v3?.stores.volumes).toBe('volume_uuid, series_uuid, series_title, ocr_edited_at');
  });

  it('round-trips a layer row keyed by volume + layer id', async () => {
    await db.volume_ocr_layers.put({
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original',
      created_at: '2026-09-15T00:00:00.000Z',
      updated_at: '2026-09-15T00:00:00.000Z',
      pages: [{ version: '0.2.1', img_width: 10, img_height: 10, img_path: 'p.png', blocks: [] }]
    });
    const back = await db.volume_ocr_layers.get(['v1', 'original']);
    expect(back?.pages[0].img_path).toBe('p.png');
    expect(await db.volume_ocr_layers.where('volume_uuid').equals('v1').count()).toBe(1);
  });

  it('indexes only rows that carry ocr_edited_at', async () => {
    await db.volumes.put(row());
    await db.volumes.put({ ...row(), volume_uuid: 'v2', ocr_edited_at: '2026-09-15T00:00:00Z' });
    const keys = await db.volumes.where('ocr_edited_at').above('').primaryKeys();
    expect(keys).toEqual(['v2']);
  });

  it('deleteVolumeCompletely removes layer rows; removeVolumeFiles keeps them', async () => {
    const layer = {
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original' as const,
      created_at: 'x',
      updated_at: 'x',
      pages: []
    };
    await db.volumes.put(row());
    await db.volume_ocr.put({ volume_uuid: 'v1', pages: [] });
    await db.volume_files.put({ volume_uuid: 'v1', files: {} });
    await db.volume_ocr_layers.put(layer);

    await removeVolumeFiles('v1');
    expect(await db.volume_ocr_layers.get(['v1', 'original'])).toBeDefined();
    expect((await db.volumes.get('v1'))?.metadata_only).toBe(true);

    await deleteVolumeCompletely('v1');
    expect(await db.volume_ocr_layers.get(['v1', 'original'])).toBeUndefined();
    expect(await db.volumes.get('v1')).toBeUndefined();
  });
});

afterEach(async () => {
  // keep the fake database from leaking between files
  if (!db.isOpen()) await Dexie.delete(DB_NAME);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/catalog/__tests__/volume-ocr-layers.test.ts`
Expected: FAIL — `volume_ocr_layers` undefined / version 3 missing.

- [ ] **Step 3: Implement**

`src/lib/types/index.ts` — add to `VolumeMetadata` (near `metadata_only`):

```ts
  /**
   * ISO stamp of the last in-reader OCR edit (`persistPageEdit`). Indexed on
   * `volumes` (schema v3) so the sidecar backfill can find edited volumes
   * keys-only and re-upload their `.mokuro`. Absent until the first edit.
   */
  ocr_edited_at?: string;
```

and after `VolumeFiles`:

```ts
// v3 table: volume_ocr_layers — alternate OCR page sets beside the primary
// `volume_ocr` row. 'original' is the pre-edit snapshot the editor reverts to.
export type VolumeOcrLayerKind = 'original' | 'edit' | 'ocr' | 'translation';

export interface VolumeOcrLayer {
  volume_uuid: string;
  /** slug [a-z0-9-]{1,32}; 'original' is reserved */
  layer_id: string;
  name: string;
  kind: VolumeOcrLayerKind;
  engine?: string;
  created_at: string;
  updated_at: string;
  /** DB-shaped pages (no cumulativeChars), same shape as `volume_ocr.pages` */
  pages: Page[];
  cloud?: { provider: string; size?: number; modified?: number };
}
```

`src/lib/catalog/db-schema.ts` — append after the version 2 entry:

```ts
  // v3: the OCR editor. `volume_ocr_layers` holds alternate page sets per
  // volume (the pre-edit 'original' snapshot first; later engine/translation
  // layers). `ocr_edited_at` on `volumes` is a sparse index — only rows that
  // were edited in the reader carry it — so the sidecar backfill can find
  // volumes whose cloud `.mokuro` is behind the local row without scanning.
  {
    version: 3,
    stores: {
      volumes: 'volume_uuid, series_uuid, series_title, ocr_edited_at',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid',
      series_metadata: 'series_key, folded_key',
      series_index: 'series_key',
      catalog_index: 'id',
      cloud_covers: '[account_scope+path], cached_at',
      volume_ocr_layers: '[volume_uuid+layer_id], volume_uuid'
    }
  }
```

`src/lib/catalog/db-v3.ts` — import `VolumeOcrLayer` from `$lib/types` and add `volume_ocr_layers!: Table<VolumeOcrLayer>;` after `cloud_covers`.

`src/lib/import/database.ts` — `deleteVolumeCompletely` becomes:

```ts
export async function deleteVolumeCompletely(volumeUuid: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.volumes, db.volume_ocr, db.volume_files, db.volume_ocr_layers],
    async () => {
      await db.volumes.delete(volumeUuid);
      await db.volume_ocr.delete(volumeUuid);
      await db.volume_files.delete(volumeUuid);
      // Layers are OCR, not pages: they go only when the volume itself goes.
      await db.volume_ocr_layers.where('volume_uuid').equals(volumeUuid).delete();
    }
  );
}
```

`removeVolumeFiles` is unchanged (add a one-line comment: "Layers stay — see deleteVolumeCompletely").

`CatalogSettings.svelte` `onConfirm` adds `db.volume_ocr_layers.clear();`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/catalog/__tests__/volume-ocr-layers.test.ts src/lib/catalog/db-v3.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types/index.ts src/lib/catalog/db-schema.ts src/lib/catalog/db-v3.ts src/lib/import/database.ts src/lib/components/Settings/CatalogSettings.svelte src/lib/catalog/__tests__/volume-ocr-layers.test.ts
git commit -m "feat(db): schema v3 — volume_ocr_layers table and ocr_edited_at index"
```

---

### Task 2: Block geometry helpers

**Files:**

- Create: `src/lib/reader/edit/block-geometry.ts`
- Test: `src/lib/reader/edit/block-geometry.test.ts`

**Interfaces:**

- Produces:
  - `type Box = [number, number, number, number]` (xmin, ymin, xmax, ymax)
  - `clampBox(box: number[], width: number, height: number): Box` — clamps and re-orders so min ≤ max, keeps ≥ 1px extent.
  - `translateQuads(quads: number[][][] | undefined, dx: number, dy: number)`
  - `scaleQuads(quads, from: Box, to: Box)` — maps each point affinely from `from` to `to`.
  - `unionBox(boxes: number[][]): Box`
  - `splitBoxAtLine(box: Box, vertical: boolean, atLine: number, lineCount: number, quads?: number[][][]): [Box, Box]`
  - `estimateFontSize(box: Box, vertical: boolean, lineCount: number): number` — cross-axis extent / lineCount, clamped to [8, 200].
  - `readingOrder(blocks: {box:number[]}[], vertical: boolean): number[]` — indices sorted right-to-left by xmax for vertical, top-to-bottom by ymin for horizontal.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/reader/edit/block-geometry.test.ts
import { describe, expect, it } from 'vitest';
import {
  clampBox,
  estimateFontSize,
  readingOrder,
  scaleQuads,
  splitBoxAtLine,
  translateQuads,
  unionBox
} from './block-geometry';

describe('clampBox', () => {
  it('clamps to the image and keeps at least 1px extent', () => {
    expect(clampBox([-5, 10, 50, 20], 40, 40)).toEqual([0, 10, 40, 20]);
    expect(clampBox([10, 10, 10, 10], 40, 40)).toEqual([10, 10, 11, 11]);
  });
  it('re-orders inverted corners', () => {
    expect(clampBox([30, 30, 10, 10], 100, 100)).toEqual([10, 10, 30, 30]);
  });
});

describe('quads', () => {
  const quad = [
    [
      [10, 10],
      [20, 10],
      [20, 30],
      [10, 30]
    ]
  ];
  it('translates every point', () => {
    expect(translateQuads(quad, 5, -5)).toEqual([
      [
        [15, 5],
        [25, 5],
        [25, 25],
        [15, 25]
      ]
    ]);
    expect(translateQuads(undefined, 1, 1)).toBeUndefined();
  });
  it('scales points affinely from one box to another', () => {
    expect(scaleQuads(quad, [10, 10, 20, 30], [0, 0, 20, 40])).toEqual([
      [
        [0, 0],
        [20, 0],
        [20, 40],
        [0, 40]
      ]
    ]);
  });
});

describe('unionBox / splitBoxAtLine', () => {
  it('unions', () => {
    expect(
      unionBox([
        [0, 0, 10, 10],
        [5, 5, 20, 8]
      ])
    ).toEqual([0, 0, 20, 10]);
  });
  it('splits a vertical box right-to-left by line count when there are no quads', () => {
    // 4 lines, split after line 1 → first block keeps the RIGHT quarter
    expect(splitBoxAtLine([0, 0, 40, 100], true, 1, 4)).toEqual([
      [30, 0, 40, 100],
      [0, 0, 30, 100]
    ]);
  });
  it('splits a horizontal box top-to-bottom by line count', () => {
    expect(splitBoxAtLine([0, 0, 100, 40], false, 2, 4)).toEqual([
      [0, 0, 100, 20],
      [0, 20, 100, 40]
    ]);
  });
  it('splits at the quad boundary when quads exist', () => {
    const quads = [
      [
        [30, 0],
        [40, 0],
        [40, 100],
        [30, 100]
      ],
      [
        [0, 0],
        [12, 0],
        [12, 100],
        [0, 100]
      ]
    ];
    expect(splitBoxAtLine([0, 0, 40, 100], true, 1, 2, quads)).toEqual([
      [21, 0, 40, 100],
      [0, 0, 21, 100]
    ]);
  });
});

describe('estimateFontSize', () => {
  it('uses the cross-writing axis divided by line count, clamped', () => {
    expect(estimateFontSize([0, 0, 60, 200], true, 2)).toBe(30);
    expect(estimateFontSize([0, 0, 200, 60], false, 3)).toBe(20);
    expect(estimateFontSize([0, 0, 4, 4], true, 1)).toBe(8);
    expect(estimateFontSize([0, 0, 1000, 1000], false, 1)).toBe(200);
  });
});

describe('readingOrder', () => {
  it('orders vertical blocks right-to-left, horizontal top-to-bottom', () => {
    const blocks = [{ box: [0, 0, 10, 10] }, { box: [50, 0, 60, 10] }, { box: [20, 20, 30, 30] }];
    expect(readingOrder(blocks, true)).toEqual([1, 2, 0]);
    expect(readingOrder(blocks, false)).toEqual([0, 1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reader/edit/block-geometry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/reader/edit/block-geometry.ts
/**
 * Geometry helpers shared by the OCR edit operations (`edit-ops.ts`). Pure,
 * image-pixel space, no DOM.
 */
export type Box = [number, number, number, number];

const MIN_FONT = 8;
const MAX_FONT = 200;

export function clampBox(box: number[], width: number, height: number): Box {
  let [x0, y0, x1, y1] = box;
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  x0 = Math.min(Math.max(0, x0), width);
  x1 = Math.min(Math.max(0, x1), width);
  y0 = Math.min(Math.max(0, y0), height);
  y1 = Math.min(Math.max(0, y1), height);
  if (x1 - x0 < 1) x1 = Math.min(width, x0 + 1);
  if (x1 - x0 < 1) x0 = Math.max(0, x1 - 1);
  if (y1 - y0 < 1) y1 = Math.min(height, y0 + 1);
  if (y1 - y0 < 1) y0 = Math.max(0, y1 - 1);
  return [x0, y0, x1, y1];
}

export function translateQuads(
  quads: number[][][] | undefined,
  dx: number,
  dy: number
): number[][][] | undefined {
  if (!quads) return undefined;
  return quads.map((quad) => quad.map(([x, y]) => [x + dx, y + dy]));
}

export function scaleQuads(
  quads: number[][][] | undefined,
  from: Box,
  to: Box
): number[][][] | undefined {
  if (!quads) return undefined;
  const fw = from[2] - from[0] || 1;
  const fh = from[3] - from[1] || 1;
  const sx = (to[2] - to[0]) / fw;
  const sy = (to[3] - to[1]) / fh;
  return quads.map((quad) =>
    quad.map(([x, y]) => [to[0] + (x - from[0]) * sx, to[1] + (y - from[1]) * sy])
  );
}

export function unionBox(boxes: number[][]): Box {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [a, b, c, d] of boxes) {
    x0 = Math.min(x0, a);
    y0 = Math.min(y0, b);
    x1 = Math.max(x1, c);
    y1 = Math.max(y1, d);
  }
  return [x0, y0, x1, y1];
}

function quadBox(quad: number[][]): Box {
  return unionBox(quad.map(([x, y]) => [x, y, x, y]));
}

/**
 * Split `box` between lines `atLine-1` and `atLine`. Vertical text reads
 * right-to-left, so the FIRST group keeps the right side. With quads the cut
 * is midway between the two groups' nearest edges; otherwise proportional to
 * line count.
 */
export function splitBoxAtLine(
  box: Box,
  vertical: boolean,
  atLine: number,
  lineCount: number,
  quads?: number[][][]
): [Box, Box] {
  const [x0, y0, x1, y1] = box;
  if (quads && quads.length === lineCount && atLine > 0 && atLine < lineCount) {
    const first = quads.slice(0, atLine).map(quadBox);
    const second = quads.slice(atLine).map(quadBox);
    if (vertical) {
      const firstMin = Math.min(...first.map((b) => b[0]));
      const secondMax = Math.max(...second.map((b) => b[2]));
      const cut = (firstMin + secondMax) / 2;
      return [
        [cut, y0, x1, y1],
        [x0, y0, cut, y1]
      ];
    }
    const firstMax = Math.max(...first.map((b) => b[3]));
    const secondMin = Math.min(...second.map((b) => b[1]));
    const cut = (firstMax + secondMin) / 2;
    return [
      [x0, y0, x1, cut],
      [x0, cut, x1, y1]
    ];
  }
  const frac = atLine / lineCount;
  if (vertical) {
    const cut = x1 - (x1 - x0) * frac;
    return [
      [cut, y0, x1, y1],
      [x0, y0, cut, y1]
    ];
  }
  const cut = y0 + (y1 - y0) * frac;
  return [
    [x0, y0, x1, cut],
    [x0, cut, x1, y1]
  ];
}

export function estimateFontSize(box: Box, vertical: boolean, lineCount: number): number {
  const cross = vertical ? box[2] - box[0] : box[3] - box[1];
  const size = cross / Math.max(1, lineCount);
  return Math.round(Math.min(MAX_FONT, Math.max(MIN_FONT, size)));
}

export function readingOrder(blocks: { box: number[] }[], vertical: boolean): number[] {
  const idx = blocks.map((_, i) => i);
  return idx.sort((a, b) =>
    vertical
      ? blocks[b].box[2] - blocks[a].box[2] || blocks[a].box[1] - blocks[b].box[1]
      : blocks[a].box[1] - blocks[b].box[1] || blocks[a].box[0] - blocks[b].box[0]
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reader/edit/block-geometry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reader/edit/block-geometry.ts src/lib/reader/edit/block-geometry.test.ts
git commit -m "feat(editor): block geometry helpers"
```

---

### Task 3: Pure edit operations

**Files:**

- Create: `src/lib/reader/edit/edit-ops.ts`
- Test: `src/lib/reader/edit/edit-ops.test.ts`

**Interfaces:**

- Consumes: Task 2 helpers; `Page`, `Block` from `$lib/types`.
- Produces (all return a NEW `Page`, never mutate):
  - `moveBlock(page, index, dx, dy)`
  - `resizeBlock(page, index, box: number[])` — new box in image px; scales quads and font_size.
  - `setBlockLines(page, index, lines: string[])` — drops `lines_coords` when the count changes.
  - `addBlock(page, box: number[], opts?: { vertical?: boolean }): { page: Page; index: number }`
  - `removeBlocks(page, indices: number[])`
  - `mergeBlocks(page, indices: number[]): { page: Page; index: number }`
  - `splitBlock(page, index, atLine: number): { page: Page; indices: [number, number] }`
  - `flipBlock(page, index, swapBox = false)`
  - `pageMajorityVertical(page): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/reader/edit/edit-ops.test.ts
import { describe, expect, it } from 'vitest';
import type { Page } from '$lib/types';
import {
  addBlock,
  flipBlock,
  mergeBlocks,
  moveBlock,
  pageMajorityVertical,
  removeBlocks,
  resizeBlock,
  setBlockLines,
  splitBlock
} from './edit-ops';

const quad = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1]
];

function page(): Page {
  return {
    version: '0.2.1',
    img_width: 200,
    img_height: 300,
    img_path: 'p.png',
    blocks: [
      {
        box: [100, 10, 140, 110],
        vertical: true,
        font_size: 20,
        lines: ['あい', 'うえ'],
        lines_coords: [quad(120, 10, 140, 110), quad(100, 10, 120, 110)]
      },
      { box: [10, 200, 90, 240], vertical: false, font_size: 18, lines: ['ok'] }
    ]
  };
}

describe('moveBlock', () => {
  it('translates box and quads, clamps to the image, and leaves other blocks untouched', () => {
    const p = page();
    const out = moveBlock(p, 0, 70, -20);
    expect(out).not.toBe(p);
    expect(out.blocks[1]).toBe(p.blocks[1]);
    expect(out.blocks[0].box).toEqual([160, 0, 200, 100]);
    expect(out.blocks[0].lines_coords![0][0]).toEqual([180, 0]);
    expect(p.blocks[0].box).toEqual([100, 10, 140, 110]);
  });
});

describe('resizeBlock', () => {
  it('scales quads into the new box and rescales font_size by the cross axis', () => {
    const out = resizeBlock(page(), 0, [100, 10, 180, 110]);
    expect(out.blocks[0].box).toEqual([100, 10, 180, 110]);
    // width doubled → vertical font doubles
    expect(out.blocks[0].font_size).toBe(40);
    expect(out.blocks[0].lines_coords![0]).toEqual(quad(140, 10, 180, 110));
  });
});

describe('setBlockLines', () => {
  it('keeps quads when the line count is unchanged', () => {
    const out = setBlockLines(page(), 0, ['かき', 'くけ']);
    expect(out.blocks[0].lines).toEqual(['かき', 'くけ']);
    expect(out.blocks[0].lines_coords).toHaveLength(2);
  });
  it('drops quads when the line count changes', () => {
    const out = setBlockLines(page(), 0, ['かきくけ']);
    expect(out.blocks[0].lines_coords).toBeUndefined();
  });
});

describe('addBlock / removeBlocks', () => {
  it('adds a block with the page majority writing mode and an estimated size', () => {
    const { page: out, index } = addBlock(page(), [0, 0, 30, 90]);
    expect(index).toBe(2);
    expect(out.blocks[2]).toEqual({
      box: [0, 0, 30, 90],
      vertical: true,
      font_size: 30,
      lines: ['']
    });
  });
  it('removes by index, highest first, without touching survivors', () => {
    const p = page();
    const out = removeBlocks(p, [0]);
    expect(out.blocks).toEqual([p.blocks[1]]);
  });
});

describe('mergeBlocks', () => {
  it("unions boxes, concatenates lines in reading order, keeps the largest block's mode", () => {
    const p = page();
    p.blocks.push({
      box: [60, 10, 95, 110],
      vertical: true,
      font_size: 22,
      lines: ['おか'],
      lines_coords: [quad(60, 10, 95, 110)]
    });
    const { page: out, index } = mergeBlocks(p, [2, 0]);
    expect(index).toBe(0);
    expect(out.blocks).toHaveLength(2);
    expect(out.blocks[0].box).toEqual([60, 10, 140, 110]);
    // vertical: right-to-left → block 0 (xmax 140) before block 2 (xmax 95)
    expect(out.blocks[0].lines).toEqual(['あい', 'うえ', 'おか']);
    expect(out.blocks[0].lines_coords).toHaveLength(3);
    expect(out.blocks[0].font_size).toBe(22);
  });
  it('drops quads if any source lacks them', () => {
    const { page: out } = mergeBlocks(page(), [0, 1]);
    expect(out.blocks[0].lines_coords).toBeUndefined();
  });
});

describe('splitBlock', () => {
  it('produces two blocks with the lines divided and the box cut at the quad boundary', () => {
    const { page: out, indices } = splitBlock(page(), 0, 1);
    expect(indices).toEqual([0, 1]);
    expect(out.blocks[0].lines).toEqual(['あい']);
    expect(out.blocks[1].lines).toEqual(['うえ']);
    expect(out.blocks[0].box).toEqual([120, 10, 140, 110]);
    expect(out.blocks[1].box).toEqual([100, 10, 120, 110]);
    expect(out.blocks[0].lines_coords).toHaveLength(1);
    expect(out.blocks[2].lines).toEqual(['ok']);
  });
});

describe('flipBlock', () => {
  it('toggles vertical and leaves the box alone by default', () => {
    const out = flipBlock(page(), 0);
    expect(out.blocks[0].vertical).toBe(false);
    expect(out.blocks[0].box).toEqual([100, 10, 140, 110]);
  });
  it('swaps the box aspect about its centre when asked', () => {
    const out = flipBlock(page(), 0, true);
    expect(out.blocks[0].box).toEqual([70, 40, 170, 80]);
  });
});

describe('pageMajorityVertical', () => {
  it('is true when at least half the blocks are vertical, true for an empty page', () => {
    expect(pageMajorityVertical(page())).toBe(true);
    expect(pageMajorityVertical({ ...page(), blocks: [] })).toBe(true);
    expect(pageMajorityVertical({ ...page(), blocks: [page().blocks[1]] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reader/edit/edit-ops.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/reader/edit/edit-ops.ts
/**
 * Pure OCR edit operations: every function takes a `Page` and returns a NEW
 * `Page`, replacing only the block objects it changed. `EditSession` layers
 * history and persistence on top; nothing here touches the DOM or Dexie.
 */
import type { Block, Page } from '$lib/types';
import {
  clampBox,
  estimateFontSize,
  readingOrder,
  scaleQuads,
  splitBoxAtLine,
  translateQuads,
  unionBox,
  type Box
} from './block-geometry';

function replaceBlock(page: Page, index: number, block: Block): Page {
  const blocks = page.blocks.slice();
  blocks[index] = block;
  return { ...page, blocks };
}

export function pageMajorityVertical(page: Page): boolean {
  if (page.blocks.length === 0) return true;
  const vertical = page.blocks.filter((b) => b.vertical).length;
  return vertical * 2 >= page.blocks.length;
}

export function moveBlock(page: Page, index: number, dx: number, dy: number): Page {
  const block = page.blocks[index];
  const [x0, y0, x1, y1] = block.box;
  const target = clampBox([x0 + dx, y0 + dy, x1 + dx, y1 + dy], page.img_width, page.img_height);
  // Clamping may have shortened the move; translate quads by the REAL delta.
  const realDx = target[0] - x0;
  const realDy = target[1] - y0;
  return replaceBlock(page, index, {
    ...block,
    box: target,
    lines_coords: translateQuads(block.lines_coords, realDx, realDy)
  });
}

export function resizeBlock(page: Page, index: number, box: number[]): Page {
  const block = page.blocks[index];
  const from = block.box as Box;
  const to = clampBox(box, page.img_width, page.img_height);
  const fromCross = block.vertical ? from[2] - from[0] : from[3] - from[1];
  const toCross = block.vertical ? to[2] - to[0] : to[3] - to[1];
  const ratio = fromCross > 0 ? toCross / fromCross : 1;
  return replaceBlock(page, index, {
    ...block,
    box: to,
    font_size: Math.max(1, Math.round(block.font_size * ratio)),
    lines_coords: scaleQuads(block.lines_coords, from, to)
  });
}

export function setBlockLines(page: Page, index: number, lines: string[]): Page {
  const block = page.blocks[index];
  const keepQuads = block.lines_coords && block.lines_coords.length === lines.length;
  const next: Block = { ...block, lines: lines.slice() };
  if (keepQuads) next.lines_coords = block.lines_coords;
  else delete next.lines_coords;
  return replaceBlock(page, index, next);
}

export function addBlock(
  page: Page,
  box: number[],
  opts: { vertical?: boolean } = {}
): { page: Page; index: number } {
  const clamped = clampBox(box, page.img_width, page.img_height);
  const vertical = opts.vertical ?? pageMajorityVertical(page);
  const block: Block = {
    box: clamped,
    vertical,
    font_size: estimateFontSize(clamped, vertical, 1),
    lines: ['']
  };
  return { page: { ...page, blocks: [...page.blocks, block] }, index: page.blocks.length };
}

export function removeBlocks(page: Page, indices: number[]): Page {
  const drop = new Set(indices);
  return { ...page, blocks: page.blocks.filter((_, i) => !drop.has(i)) };
}

export function mergeBlocks(page: Page, indices: number[]): { page: Page; index: number } {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const sources = sorted.map((i) => page.blocks[i]);
  const largest = sources.reduce((best, b) =>
    (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) >
    (best.box[2] - best.box[0]) * (best.box[3] - best.box[1])
      ? b
      : best
  );
  const vertical = largest.vertical;
  const order = readingOrder(sources, vertical);
  const lines = order.flatMap((i) => sources[i].lines);
  const allQuads = sources.every((b) => b.lines_coords && b.lines_coords.length === b.lines.length);
  const merged: Block = {
    box: unionBox(sources.map((b) => b.box)),
    vertical,
    font_size: largest.font_size,
    lines
  };
  if (allQuads) merged.lines_coords = order.flatMap((i) => sources[i].lines_coords!);
  const blocks = page.blocks.filter((_, i) => !sorted.includes(i));
  blocks.splice(sorted[0], 0, merged);
  return { page: { ...page, blocks }, index: sorted[0] };
}

export function splitBlock(
  page: Page,
  index: number,
  atLine: number
): { page: Page; indices: [number, number] } {
  const block = page.blocks[index];
  const n = block.lines.length;
  if (atLine <= 0 || atLine >= n) return { page, indices: [index, index] };
  const [boxA, boxB] = splitBoxAtLine(
    block.box as Box,
    block.vertical,
    atLine,
    n,
    block.lines_coords
  );
  const a: Block = { ...block, box: boxA, lines: block.lines.slice(0, atLine) };
  const b: Block = { ...block, box: boxB, lines: block.lines.slice(atLine) };
  if (block.lines_coords && block.lines_coords.length === n) {
    a.lines_coords = block.lines_coords.slice(0, atLine);
    b.lines_coords = block.lines_coords.slice(atLine);
  } else {
    delete a.lines_coords;
    delete b.lines_coords;
  }
  const blocks = page.blocks.slice();
  blocks.splice(index, 1, a, b);
  return { page: { ...page, blocks }, indices: [index, index + 1] };
}

export function flipBlock(page: Page, index: number, swapBox = false): Page {
  const block = page.blocks[index];
  const next: Block = { ...block, vertical: !block.vertical };
  if (swapBox) {
    const [x0, y0, x1, y1] = block.box;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const hw = (y1 - y0) / 2;
    const hh = (x1 - x0) / 2;
    next.box = clampBox([cx - hw, cy - hh, cx + hw, cy + hh], page.img_width, page.img_height);
    delete next.lines_coords;
  }
  return replaceBlock(page, index, next);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reader/edit/edit-ops.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reader/edit/edit-ops.ts src/lib/reader/edit/edit-ops.test.ts
git commit -m "feat(editor): pure page edit operations"
```

---

### Task 4: Edit history (undo/redo with drag coalescing)

**Files:**

- Create: `src/lib/reader/edit/edit-history.ts`
- Test: `src/lib/reader/edit/edit-history.test.ts`

**Interfaces:**

- Produces: `class EditHistory<T>` with `constructor(initial: T, now = () => performance.now())`, `get current(): T`, `push(next: T, coalesceKey?: string): void`, `undo(): T | null`, `redo(): T | null`, `canUndo`, `canRedo`, `reset(value: T)`. `COALESCE_WINDOW_MS = 400`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/reader/edit/edit-history.test.ts
import { describe, expect, it } from 'vitest';
import { COALESCE_WINDOW_MS, EditHistory } from './edit-history';

describe('EditHistory', () => {
  it('undoes and redoes in order', () => {
    const h = new EditHistory(0);
    h.push(1);
    h.push(2);
    expect(h.current).toBe(2);
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBe(0);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe(1);
    expect(h.canRedo).toBe(true);
  });

  it('a push after undo discards the redo branch', () => {
    const h = new EditHistory(0);
    h.push(1);
    h.undo();
    h.push(5);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe(0);
  });

  it('coalesces same-key pushes inside the window into one entry', () => {
    let t = 0;
    const h = new EditHistory(0, () => t);
    h.push(1, 'drag:0');
    t += 100;
    h.push(2, 'drag:0');
    t += 100;
    h.push(3, 'drag:0');
    expect(h.current).toBe(3);
    expect(h.undo()).toBe(0);
  });

  it('does not coalesce across the window or across keys', () => {
    let t = 0;
    const h = new EditHistory(0, () => t);
    h.push(1, 'drag:0');
    t += COALESCE_WINDOW_MS + 1;
    h.push(2, 'drag:0');
    h.push(3, 'drag:1');
    expect(h.undo()).toBe(2);
    expect(h.undo()).toBe(1);
  });

  it('reset clears everything', () => {
    const h = new EditHistory(0);
    h.push(1);
    h.reset(9);
    expect(h.current).toBe(9);
    expect(h.canUndo).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reader/edit/edit-history.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/reader/edit/edit-history.ts
/** Snapshot undo/redo stack. A continuous drag pushes many states with one
 * `coalesceKey`; pushes with the same key within the window REPLACE the last
 * entry so one drag is one undo step. */
export const COALESCE_WINDOW_MS = 400;

export class EditHistory<T> {
  private past: T[] = [];
  private future: T[] = [];
  private present: T;
  private lastKey: string | undefined;
  private lastTime = -Infinity;

  constructor(
    initial: T,
    private now: () => number = () => performance.now()
  ) {
    this.present = initial;
  }

  get current(): T {
    return this.present;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  push(next: T, coalesceKey?: string): void {
    const t = this.now();
    const coalesce =
      coalesceKey !== undefined &&
      coalesceKey === this.lastKey &&
      t - this.lastTime <= COALESCE_WINDOW_MS &&
      this.past.length > 0;
    if (!coalesce) this.past.push(this.present);
    this.present = next;
    this.future = [];
    this.lastKey = coalesceKey;
    this.lastTime = coalesceKey === undefined ? -Infinity : t;
  }

  undo(): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.present);
    this.present = prev;
    this.lastKey = undefined;
    return prev;
  }

  redo(): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.present);
    this.present = next;
    this.lastKey = undefined;
    return next;
  }

  reset(value: T): void {
    this.past = [];
    this.future = [];
    this.present = value;
    this.lastKey = undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reader/edit/edit-history.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reader/edit/edit-history.ts src/lib/reader/edit/edit-history.test.ts
git commit -m "feat(editor): undo/redo history with drag coalescing"
```

---

### Task 5: Persistence — `persistPageEdit`, `ensureOriginalLayer`, `loadOriginalPage`

**Files:**

- Create: `src/lib/reader/edit/edit-persist.ts`
- Test: `src/lib/reader/edit/edit-persist.test.ts`

**Interfaces:**

- Consumes: `db` (`$lib/catalog/db`), `buildPageCharCounts` (`$lib/catalog/cloud-ocr-upgrade`), `VolumeOcrLayer`.
- Produces:
  - `persistPageEdit(volumeUuid: string, pageIndex: number, page: Page): Promise<void>` — one `rw` transaction over `volumes`, `volume_ocr`, `volume_ocr_layers`: creates `original` if absent (from the PRE-edit OCR row), writes `pages[pageIndex] = page`, recomputes `page_char_counts` and `character_count`, stamps `ocr_edited_at`. Throws if the OCR row is missing. After commit calls `noteOcrEdited(volumeUuid)` from `$lib/util/sync/sidecar-backfill` (Task 11 — until then a no-op import guarded by try/catch; see Step 3).
  - `loadOriginalPage(volumeUuid, pageIndex): Promise<Page | null>`
  - `hasOriginalLayer(volumeUuid): Promise<boolean>`
  - `ORIGINAL_LAYER_ID = 'original'`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/reader/edit/edit-persist.test.ts
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
  return { db: new CatalogDexieV3('mokuro_v3_edit_persist_test') };
});
const noteOcrEdited = vi.hoisted(() => vi.fn());
vi.mock('$lib/util/sync/sidecar-backfill', () => ({ noteOcrEdited }));

import { db } from '$lib/catalog/db';
import {
  ORIGINAL_LAYER_ID,
  hasOriginalLayer,
  loadOriginalPage,
  persistPageEdit
} from './edit-persist';

function pg(text: string, img_path = 'p.png'): Page {
  return {
    version: '0.2.1',
    img_width: 100,
    img_height: 100,
    img_path,
    blocks: [{ box: [0, 0, 10, 10], vertical: true, font_size: 10, lines: [text] }]
  };
}

beforeEach(async () => {
  noteOcrEdited.mockClear();
  await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), db.volume_ocr_layers.clear()]);
  await db.volumes.put({
    volume_uuid: 'v1',
    series_uuid: 's1',
    series_title: 'S',
    volume_title: 'V',
    mokuro_version: '0.2.1',
    page_count: 2,
    character_count: 4,
    page_char_counts: [2, 4]
  });
  await db.volume_ocr.put({ volume_uuid: 'v1', pages: [pg('あい'), pg('うえ', 'q.png')] });
});

describe('persistPageEdit', () => {
  it('writes the page, recounts chars, stamps ocr_edited_at, and nominates the volume', async () => {
    await persistPageEdit('v1', 1, pg('かきくけこ', 'q.png'));
    const ocr = await db.volume_ocr.get('v1');
    expect(ocr?.pages[1].blocks[0].lines).toEqual(['かきくけこ']);
    expect(ocr?.pages[0].blocks[0].lines).toEqual(['あい']);
    const row = await db.volumes.get('v1');
    expect(row?.page_char_counts).toEqual([2, 7]);
    expect(row?.character_count).toBe(7);
    expect(typeof row?.ocr_edited_at).toBe('string');
    expect(noteOcrEdited).toHaveBeenCalledWith('v1');
  });

  it('snapshots the PRE-edit pages into the original layer exactly once', async () => {
    expect(await hasOriginalLayer('v1')).toBe(false);
    await persistPageEdit('v1', 0, pg('X'));
    await persistPageEdit('v1', 0, pg('Y'));
    const original = await db.volume_ocr_layers.get(['v1', ORIGINAL_LAYER_ID]);
    expect(original?.kind).toBe('original');
    expect(original?.pages[0].blocks[0].lines).toEqual(['あい']);
    expect(await hasOriginalLayer('v1')).toBe(true);
    expect(await loadOriginalPage('v1', 0)).toEqual(pg('あい'));
    expect(await loadOriginalPage('v1', 5)).toBeNull();
  });

  it('rejects when the volume has no OCR row, writing nothing', async () => {
    await db.volume_ocr.delete('v1');
    await expect(persistPageEdit('v1', 0, pg('X'))).rejects.toThrow(/no OCR row/);
    expect(await db.volume_ocr_layers.count()).toBe(0);
    expect((await db.volumes.get('v1'))?.ocr_edited_at).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reader/edit/edit-persist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/reader/edit/edit-persist.ts
/**
 * The editor's one write path. `persistPageEdit` replaces one page of the
 * PRIMARY OCR row (`volume_ocr`) and recounts the volume's characters in a
 * single transaction; the first save for a volume also snapshots the pre-edit
 * pages into the `original` layer, in that same transaction, so a crash can
 * never leave an edited primary without its original.
 *
 * The primary row is what the backup serializes into `.mokuro`
 * (`buildVolumeSidecarsFromData`), so an edit here IS the cloud edit — the
 * `ocr_edited_at` stamp plus `noteOcrEdited` are what get that sidecar
 * re-uploaded (see `sidecar-backfill.ts`).
 */
import { db } from '$lib/catalog/db';
import { buildPageCharCounts } from '$lib/catalog/cloud-ocr-upgrade';
import { noteOcrEdited } from '$lib/util/sync/sidecar-backfill';
import type { Page, VolumeOcrLayer } from '$lib/types';

export const ORIGINAL_LAYER_ID = 'original';

export async function persistPageEdit(
  volumeUuid: string,
  pageIndex: number,
  page: Page
): Promise<void> {
  const editedAt = new Date().toISOString();
  await db.transaction('rw', [db.volumes, db.volume_ocr, db.volume_ocr_layers], async () => {
    const ocr = await db.volume_ocr.get(volumeUuid);
    if (!ocr) throw new Error(`Volume ${volumeUuid} has no OCR row to edit`);

    const existing = await db.volume_ocr_layers.get([volumeUuid, ORIGINAL_LAYER_ID]);
    if (!existing) {
      const layer: VolumeOcrLayer = {
        volume_uuid: volumeUuid,
        layer_id: ORIGINAL_LAYER_ID,
        name: 'Original',
        kind: 'original',
        created_at: editedAt,
        updated_at: editedAt,
        pages: ocr.pages
      };
      await db.volume_ocr_layers.add(layer);
    }

    const pages = ocr.pages.slice();
    pages[pageIndex] = page;
    const { totalChars, cumulative } = buildPageCharCounts(pages);
    await db.volume_ocr.put({ volume_uuid: volumeUuid, pages });
    await db.volumes.update(volumeUuid, {
      page_char_counts: cumulative,
      character_count: totalChars,
      ocr_edited_at: editedAt
    });
  });
  try {
    noteOcrEdited(volumeUuid);
  } catch (error) {
    console.debug('[edit-persist] could not nominate volume for sidecar re-upload:', error);
  }
}

export async function hasOriginalLayer(volumeUuid: string): Promise<boolean> {
  return (await db.volume_ocr_layers.get([volumeUuid, ORIGINAL_LAYER_ID])) !== undefined;
}

export async function loadOriginalPage(
  volumeUuid: string,
  pageIndex: number
): Promise<Page | null> {
  const layer = await db.volume_ocr_layers.get([volumeUuid, ORIGINAL_LAYER_ID]);
  return layer?.pages[pageIndex] ?? null;
}
```

Until Task 11 lands, add a temporary stub export to `src/lib/util/sync/sidecar-backfill.ts` so the import resolves:

```ts
/** OCR edited in the reader — implemented in Task 11. */
export function noteOcrEdited(_volumeUuid: string): void {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reader/edit/edit-persist.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reader/edit/edit-persist.ts src/lib/reader/edit/edit-persist.test.ts src/lib/util/sync/sidecar-backfill.ts
git commit -m "feat(editor): persistPageEdit with original-layer snapshot and char recount"
```

---

### Task 6: Gesture role `'editor'` and the paged surface filter

**Files:**

- Modify: `src/lib/reader/input/gesture-target.ts:29-37`
- Modify: `src/lib/reader/input/gesture-target.test.ts`
- Modify: `src/lib/components/Reader/PagedViewport.svelte:239-246,289-293`
- Modify: `docs/INPUT-CONTRACTS.md` (after the `.textBox` contract section)

**Interfaces:**

- Produces: `GestureTargetRole = 'editor' | 'textbox' | 'interactive' | 'page'`; `.editBlock` and `[data-edit-handle]` classify as `'editor'`.

- [ ] **Step 1: Write the failing test** — append to `gesture-target.test.ts` inside `describe('gestureTargetRole')`:

```ts
it('classifies edit-overlay blocks and handles as editor, ahead of textbox', () => {
  expect(gestureTargetRole(el('<div class="editBlock" data-probe></div>'))).toBe('editor');
  expect(
    gestureTargetRole(el('<div class="editBlock"><span data-edit-handle data-probe></span></div>'))
  ).toBe('editor');
  expect(
    gestureTargetRole(el('<div class="editBlock"><div class="textBox" data-probe></div></div>'))
  ).toBe('editor');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reader/input/gesture-target.test.ts`
Expected: FAIL — got 'page'/'textbox'.

- [ ] **Step 3: Implement**

`gesture-target.ts`:

```ts
export type GestureTargetRole = 'editor' | 'textbox' | 'interactive' | 'page';

export function gestureTargetRole(target: EventTarget | null): GestureTargetRole {
  if (!(target instanceof Element)) return 'page';
  // The OCR edit overlay owns every press on its blocks and handles (move,
  // resize, text editing) — checked first so an editor never pans, taps, or
  // triggers the Anki double-tap. See docs/INPUT-CONTRACTS.md "Edit overlay".
  if (target.closest('.editBlock, [data-edit-handle]')) return 'editor';
  if (target.closest('.textBox')) return 'textbox';
  if (target.closest('button, [role="button"], a')) return 'interactive';
  return 'page';
}
```

Add `'editor'` to the module doc comment's contract list (one paragraph: "**`.editBlock` (role 'editor')** is the OCR edit overlay: the overlay captures its own pointers; surfaces must never pan, tap-toggle, or zoom from a press on one, for any pointer type.").

`PagedViewport.svelte` — `suppressPan` becomes:

```ts
    suppressPan: (e) => {
      const role = gestureTargetRole(e.target);
      // The edit overlay owns its presses outright (all pointer types).
      if (role === 'editor') return true;
      if (role !== 'textbox') return false;
      // Any press on a text box marks the next outside tap as a dismissal.
      taps.noteTextBoxInteraction();
      return e.pointerType !== 'touch';
    },
```

`handleClick` already requires role `'page'`, so editor clicks never tap. No change.

`docs/INPUT-CONTRACTS.md` — insert after the `.textBox` section:

```markdown
### The edit overlay owns its blocks (`.editBlock`, role 'editor')

In OCR edit mode (`EditOverlay.svelte`) every block renders as an
`.editBlock` with `[data-edit-handle]` resize handles. The overlay
`setPointerCapture`s its own presses and stops propagation; surfaces
classify the role first and **never pan, tap-toggle, or zoom from it — for
any pointer type** (unlike `.textBox`, where touch still pans). The page
background keeps its read-mode gestures, so the user can pan and pinch while
editing; with the "draw box" tool armed, the overlay owns the next background
drag instead. Pinch still wins everywhere.
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/reader/input/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reader/input/gesture-target.ts src/lib/reader/input/gesture-target.test.ts src/lib/components/Reader/PagedViewport.svelte docs/INPUT-CONTRACTS.md
git commit -m "feat(reader): 'editor' gesture role owned by the OCR edit overlay"
```

---

### Task 7: Remove the `textEditable` setting

**Files:**

- Modify: `src/lib/settings/settings.ts:148,276`
- Modify: `src/lib/components/Settings/Reader/ReaderToggles.svelte:26`
- Modify: `src/lib/components/Reader/TextBoxes.svelte:148,637`
- Modify: `src/lib/components/Reader/__tests__/TextBoxes.test.ts:17`

- [ ] **Step 1: Write the failing test** — add to `src/lib/components/Reader/__tests__/TextBoxes.test.ts`:

```ts
it('never renders text boxes contenteditable (edit mode is the overlay, not the setting)', () => {
  const { container } = render(TextBoxes, {
    props: { page: pageWith(blockWithCoords), volumeUuid: 'v' }
  });
  const box = container.querySelector('.textBox')!;
  expect(box.getAttribute('contenteditable')).toBeNull();
});
```

(`pageWith` — use whatever helper the file already uses to build a `Page` around a block; if none exists, inline `{ version: '0.2.1', img_width: 1000, img_height: 1400, img_path: 'p', blocks: [blockWithCoords] }`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/components/Reader/__tests__/TextBoxes.test.ts`
Expected: FAIL — attribute is `"false"`.

- [ ] **Step 3: Implement** — delete `textEditable` from the `Settings` type and `defaultSettings`, the ReaderToggles entry, `let contenteditable = $derived($settings.textEditable);` and `{contenteditable}` in TextBoxes, and the mock key in the test. Grep: `grep -rn textEditable src/` must return nothing.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib/components/Reader src/lib/components/Settings && npm run check`
Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/settings/settings.ts src/lib/components/Settings/Reader/ReaderToggles.svelte src/lib/components/Reader/TextBoxes.svelte src/lib/components/Reader/__tests__/TextBoxes.test.ts
git commit -m "refactor(settings): remove the textEditable toggle (superseded by edit mode)"
```

---

### Task 8: `EditSession` (runes class)

**Files:**

- Create: `src/lib/reader/edit/edit-session.svelte.ts`
- Test: `src/lib/reader/edit/edit-session.test.ts`

**Interfaces:**

- Consumes: Tasks 3–5.
- Produces `class EditSession`:

  ```ts
  constructor(opts: {
    volumeUuid: string;
    getPage: (pageIndex: number) => Page | undefined;   // the reader's current pages
    onPersisted?: (pageIndex: number, page: Page) => void; // reader refresh hook
    persist?: typeof persistPageEdit;                     // injectable for tests
    loadOriginal?: typeof loadOriginalPage;
    debounceMs?: number;                                  // default 500
  })
  pageFor(pageIndex): Page                 // working copy (lazily seeded from getPage)
  selection: { pageIndex: number; blockIndex: number }[]   // $state
  tool: 'select' | 'draw'                  // $state
  select(pageIndex, blockIndex, additive = false); clearSelection()
  canUndo(pageIndex); canRedo(pageIndex); undo(pageIndex); redo(pageIndex)
  move(pageIndex, blockIndex, dx, dy, coalesceKey)   // coalesces
  resize(pageIndex, blockIndex, box, coalesceKey)
  setLines(pageIndex, blockIndex, lines)
  add(pageIndex, box): number                 // returns new index, selects it
  deleteSelected(); mergeSelected(); splitSelected(atLine); flipSelected()
  revertPage(pageIndex): Promise<boolean>
  flush(): Promise<void>                       // awaits pending saves
  dirty: boolean                               // $state — any unsaved page
  version: number                              // $state — bumps on every change (render key)
  ```

  Every mutating call pushes into that page's `EditHistory` and schedules the debounced save for that page.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/reader/edit/edit-session.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { Page } from '$lib/types';
import { EditSession } from './edit-session.svelte';

function page(): Page {
  return {
    version: '0.2.1',
    img_width: 200,
    img_height: 200,
    img_path: 'p.png',
    blocks: [
      { box: [10, 10, 50, 100], vertical: true, font_size: 20, lines: ['あ', 'い'] },
      { box: [100, 10, 140, 100], vertical: true, font_size: 20, lines: ['う'] }
    ]
  };
}

function session(overrides: Partial<ConstructorParameters<typeof EditSession>[0]> = {}) {
  const pages = [page()];
  const persist = vi.fn(async () => {});
  const onPersisted = vi.fn();
  const s = new EditSession({
    volumeUuid: 'v1',
    getPage: (i) => pages[i],
    persist,
    onPersisted,
    debounceMs: 0,
    ...overrides
  });
  return { s, persist, onPersisted, pages };
}

describe('EditSession', () => {
  it('seeds a working copy and applies ops without touching the source page', () => {
    const { s, pages } = session();
    s.move(0, 0, 5, 5, 'drag');
    expect(s.pageFor(0).blocks[0].box).toEqual([15, 15, 55, 105]);
    expect(pages[0].blocks[0].box).toEqual([10, 10, 50, 100]);
    expect(s.dirty).toBe(true);
  });

  it('undo/redo per page, and a drag with one coalesce key is one step', () => {
    const { s } = session();
    s.move(0, 0, 1, 0, 'drag:0');
    s.move(0, 0, 1, 0, 'drag:0');
    s.setLines(0, 1, ['え']);
    expect(s.canUndo(0)).toBe(true);
    s.undo(0);
    expect(s.pageFor(0).blocks[1].lines).toEqual(['う']);
    s.undo(0);
    expect(s.pageFor(0).blocks[0].box).toEqual([10, 10, 50, 100]);
    expect(s.canUndo(0)).toBe(false);
    s.redo(0);
    expect(s.pageFor(0).blocks[0].box).toEqual([12, 10, 52, 100]);
  });

  it('persists the page after the debounce and reports it', async () => {
    const { s, persist, onPersisted } = session();
    s.setLines(0, 0, ['か', 'き']);
    await s.flush();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toBe('v1');
    expect(persist.mock.calls[0][1]).toBe(0);
    expect(persist.mock.calls[0][2].blocks[0].lines).toEqual(['か', 'き']);
    expect(onPersisted).toHaveBeenCalledWith(0, expect.objectContaining({ img_path: 'p.png' }));
    expect(s.dirty).toBe(false);
  });

  it('selection-driven ops: delete, merge, split, flip, add', () => {
    const { s } = session();
    s.select(0, 0);
    s.select(0, 1, true);
    expect(s.selection).toHaveLength(2);
    s.mergeSelected();
    expect(s.pageFor(0).blocks).toHaveLength(1);
    expect(s.selection).toEqual([{ pageIndex: 0, blockIndex: 0 }]);
    s.splitSelected(1);
    expect(s.pageFor(0).blocks).toHaveLength(2);
    s.select(0, 0);
    s.flipSelected();
    expect(s.pageFor(0).blocks[0].vertical).toBe(false);
    const idx = s.add(0, [150, 150, 190, 190]);
    expect(idx).toBe(2);
    expect(s.selection).toEqual([{ pageIndex: 0, blockIndex: 2 }]);
    s.deleteSelected();
    expect(s.pageFor(0).blocks).toHaveLength(2);
    expect(s.selection).toEqual([]);
  });

  it('selecting on another page replaces the selection', () => {
    const pages = [page(), page()];
    const { s } = session({ getPage: (i) => pages[i] });
    s.select(0, 0);
    s.select(1, 0, true);
    expect(s.selection).toEqual([{ pageIndex: 1, blockIndex: 0 }]);
  });

  it('revertPage replaces the working page from the original layer', async () => {
    const original = page();
    original.blocks[0].lines = ['元'];
    const { s } = session({ loadOriginal: async () => original });
    s.setLines(0, 0, ['x']);
    expect(await s.revertPage(0)).toBe(true);
    expect(s.pageFor(0).blocks[0].lines).toEqual(['元']);
    s.undo(0);
    expect(s.pageFor(0).blocks[0].lines).toEqual(['x']);
  });

  it('revertPage is a no-op without an original layer', async () => {
    const { s } = session({ loadOriginal: async () => null });
    expect(await s.revertPage(0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/reader/edit/edit-session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/reader/edit/edit-session.svelte.ts
/**
 * The reader's per-volume edit session: working copies of the pages being
 * edited, the selection, the active tool, per-page undo history, and the
 * debounced save. Pure ops live in `edit-ops.ts`; the DOM lives in
 * `EditOverlay.svelte`; this class is the seam between them.
 */
import type { Page } from '$lib/types';
import { EditHistory } from './edit-history';
import {
  addBlock,
  flipBlock,
  mergeBlocks,
  moveBlock,
  removeBlocks,
  resizeBlock,
  setBlockLines,
  splitBlock
} from './edit-ops';
import { loadOriginalPage, persistPageEdit } from './edit-persist';

export interface BlockRef {
  pageIndex: number;
  blockIndex: number;
}

export interface EditSessionOptions {
  volumeUuid: string;
  getPage: (pageIndex: number) => Page | undefined;
  onPersisted?: (pageIndex: number, page: Page) => void;
  persist?: typeof persistPageEdit;
  loadOriginal?: typeof loadOriginalPage;
  debounceMs?: number;
}

export const SAVE_DEBOUNCE_MS = 500;

export class EditSession {
  readonly volumeUuid: string;
  selection = $state<BlockRef[]>([]);
  tool = $state<'select' | 'draw'>('select');
  /** Bumps on every change; components key their render on it. */
  version = $state(0);
  dirty = $state(false);

  private opts: EditSessionOptions;
  private histories = new Map<number, EditHistory<Page>>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private pendingSaves = new Set<Promise<void>>();
  private unsaved = new Set<number>();

  constructor(opts: EditSessionOptions) {
    this.opts = opts;
    this.volumeUuid = opts.volumeUuid;
  }

  private history(pageIndex: number): EditHistory<Page> {
    let h = this.histories.get(pageIndex);
    if (!h) {
      const source = this.opts.getPage(pageIndex);
      if (!source) throw new Error(`EditSession: no page ${pageIndex}`);
      h = new EditHistory<Page>(source);
      this.histories.set(pageIndex, h);
    }
    return h;
  }

  pageFor(pageIndex: number): Page {
    // `version` is read so Svelte re-renders callers after every change.
    void this.version;
    return this.history(pageIndex).current;
  }

  private commit(pageIndex: number, next: Page, coalesceKey?: string): void {
    this.history(pageIndex).push(next, coalesceKey);
    this.touched(pageIndex);
  }

  private touched(pageIndex: number): void {
    this.version++;
    this.dirty = true;
    this.unsaved.add(pageIndex);
    const existing = this.timers.get(pageIndex);
    if (existing) clearTimeout(existing);
    this.timers.set(
      pageIndex,
      setTimeout(() => this.save(pageIndex), this.opts.debounceMs ?? SAVE_DEBOUNCE_MS)
    );
  }

  private save(pageIndex: number): Promise<void> {
    this.timers.delete(pageIndex);
    const page = this.history(pageIndex).current;
    const persist = this.opts.persist ?? persistPageEdit;
    const run = persist(this.volumeUuid, pageIndex, page)
      .then(() => {
        this.unsaved.delete(pageIndex);
        if (this.unsaved.size === 0) this.dirty = false;
        this.opts.onPersisted?.(pageIndex, page);
      })
      .catch((error) => console.error('[edit-session] save failed:', error))
      .finally(() => this.pendingSaves.delete(run));
    this.pendingSaves.add(run);
    return run;
  }

  /** Save everything pending now and wait for it. */
  async flush(): Promise<void> {
    for (const [pageIndex, timer] of [...this.timers]) {
      clearTimeout(timer);
      this.timers.delete(pageIndex);
      this.save(pageIndex);
    }
    await Promise.all([...this.pendingSaves]);
  }

  // ---- selection ----
  select(pageIndex: number, blockIndex: number, additive = false): void {
    const ref = { pageIndex, blockIndex };
    if (!additive || this.selection.some((r) => r.pageIndex !== pageIndex)) {
      this.selection = [ref];
      return;
    }
    if (this.selection.some((r) => r.blockIndex === blockIndex)) {
      this.selection = this.selection.filter((r) => r.blockIndex !== blockIndex);
    } else {
      this.selection = [...this.selection, ref];
    }
  }
  clearSelection(): void {
    this.selection = [];
  }
  isSelected(pageIndex: number, blockIndex: number): boolean {
    return this.selection.some((r) => r.pageIndex === pageIndex && r.blockIndex === blockIndex);
  }

  // ---- history ----
  canUndo(pageIndex: number): boolean {
    void this.version;
    return this.histories.get(pageIndex)?.canUndo ?? false;
  }
  canRedo(pageIndex: number): boolean {
    void this.version;
    return this.histories.get(pageIndex)?.canRedo ?? false;
  }
  undo(pageIndex: number): void {
    if (this.histories.get(pageIndex)?.undo() !== null) {
      this.selection = [];
      this.touched(pageIndex);
    }
  }
  redo(pageIndex: number): void {
    if (this.histories.get(pageIndex)?.redo() !== null) {
      this.selection = [];
      this.touched(pageIndex);
    }
  }

  // ---- ops ----
  move(pageIndex: number, blockIndex: number, dx: number, dy: number, coalesceKey?: string): void {
    this.commit(pageIndex, moveBlock(this.pageFor(pageIndex), blockIndex, dx, dy), coalesceKey);
  }
  resize(pageIndex: number, blockIndex: number, box: number[], coalesceKey?: string): void {
    this.commit(pageIndex, resizeBlock(this.pageFor(pageIndex), blockIndex, box), coalesceKey);
  }
  setLines(pageIndex: number, blockIndex: number, lines: string[]): void {
    this.commit(pageIndex, setBlockLines(this.pageFor(pageIndex), blockIndex, lines));
  }
  add(pageIndex: number, box: number[]): number {
    const { page, index } = addBlock(this.pageFor(pageIndex), box);
    this.commit(pageIndex, page);
    this.selection = [{ pageIndex, blockIndex: index }];
    return index;
  }
  private selectedOn(): { pageIndex: number; indices: number[] } | null {
    if (this.selection.length === 0) return null;
    const pageIndex = this.selection[0].pageIndex;
    return { pageIndex, indices: this.selection.map((r) => r.blockIndex) };
  }
  deleteSelected(): void {
    const sel = this.selectedOn();
    if (!sel) return;
    this.commit(sel.pageIndex, removeBlocks(this.pageFor(sel.pageIndex), sel.indices));
    this.selection = [];
  }
  mergeSelected(): void {
    const sel = this.selectedOn();
    if (!sel || sel.indices.length < 2) return;
    const { page, index } = mergeBlocks(this.pageFor(sel.pageIndex), sel.indices);
    this.commit(sel.pageIndex, page);
    this.selection = [{ pageIndex: sel.pageIndex, blockIndex: index }];
  }
  splitSelected(atLine: number): void {
    const sel = this.selectedOn();
    if (!sel || sel.indices.length !== 1) return;
    const { page, indices } = splitBlock(this.pageFor(sel.pageIndex), sel.indices[0], atLine);
    if (indices[0] === indices[1]) return;
    this.commit(sel.pageIndex, page);
    this.selection = [{ pageIndex: sel.pageIndex, blockIndex: indices[0] }];
  }
  flipSelected(swapBox = false): void {
    const sel = this.selectedOn();
    if (!sel) return;
    let page = this.pageFor(sel.pageIndex);
    for (const i of sel.indices) page = flipBlock(page, i, swapBox);
    this.commit(sel.pageIndex, page);
  }

  async revertPage(pageIndex: number): Promise<boolean> {
    const load = this.opts.loadOriginal ?? loadOriginalPage;
    const original = await load(this.volumeUuid, pageIndex);
    if (!original) return false;
    this.commit(pageIndex, original);
    this.selection = [];
    return true;
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/reader/edit/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reader/edit/edit-session.svelte.ts src/lib/reader/edit/edit-session.test.ts
git commit -m "feat(editor): EditSession — working copies, selection, history, debounced save"
```

---

### Task 9: `EditableBlock` + `EditOverlay` components, mounted in `MangaPage`

**Files:**

- Create: `src/lib/components/Reader/Edit/EditableBlock.svelte`
- Create: `src/lib/components/Reader/Edit/EditOverlay.svelte`
- Create: `src/lib/reader/edit/edit-context.ts`
- Modify: `src/lib/components/Reader/MangaPage.svelte`
- Test: `src/lib/components/Reader/Edit/__tests__/EditOverlay.test.ts`

**Interfaces:**

- `edit-context.ts`: `const EDIT_SESSION = Symbol('edit-session')`; `setEditSession(session: EditSession | null)` / `getEditSession(): EditSession | null` wrappers over Svelte `setContext`/`getContext`, plus `pageScaleOf(el: HTMLElement, page: Page): number` = `el.getBoundingClientRect().width / page.img_width` (screen px per image px, zoom-aware).
- `EditOverlay` props: `{ page: Page; pageIndex: number; session: EditSession }`. Renders `session.pageFor(pageIndex).blocks` as `EditableBlock`s. Handles the draw tool (pointerdown on the overlay's own background when `session.tool === 'draw'`).
- `EditableBlock` props: `{ block: Block; index: number; pageIndex: number; selected: boolean; session: EditSession; scale: () => number }`. Emits nothing; calls the session directly.
- `MangaPage` gets an optional `editSession?: EditSession | null` prop; when set it renders `EditOverlay` and skips `TextBoxes`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/components/Reader/Edit/__tests__/EditOverlay.test.ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Page } from '$lib/types';

vi.mock('$lib/settings', async () => {
  const { writable } = await import('svelte/store');
  return { settings: writable({ fontSize: 'auto', boldFont: false }) };
});

import EditOverlay from '../EditOverlay.svelte';
import { EditSession } from '$lib/reader/edit/edit-session.svelte';

function page(): Page {
  return {
    version: '0.2.1',
    img_width: 400,
    img_height: 400,
    img_path: 'p.png',
    blocks: [
      { box: [10, 10, 50, 100], vertical: true, font_size: 20, lines: ['あ', 'い'] },
      // exact duplicate of block 0 — read mode hides it; edit mode must show it
      { box: [10, 10, 50, 100], vertical: true, font_size: 20, lines: ['あい'] }
    ]
  };
}

function mount() {
  const p = page();
  const session = new EditSession({
    volumeUuid: 'v1',
    getPage: () => p,
    persist: async () => {},
    debounceMs: 100000
  });
  const utils = render(EditOverlay, { props: { page: p, pageIndex: 0, session } });
  return { ...utils, session };
}

afterEach(cleanup);

describe('EditOverlay', () => {
  it('renders every raw block as an editBlock, duplicates included', () => {
    const { container } = mount();
    expect(container.querySelectorAll('.editBlock')).toHaveLength(2);
    expect(container.querySelector('.textBox')).toBeNull();
  });

  it('click selects; shift+click adds; handles appear only on selected blocks', async () => {
    const { container, session } = mount();
    const blocks = container.querySelectorAll<HTMLElement>('.editBlock');
    await fireEvent.pointerDown(blocks[0], { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    await fireEvent.pointerUp(blocks[0], { pointerId: 1 });
    expect(session.selection).toEqual([{ pageIndex: 0, blockIndex: 0 }]);
    await tick();
    expect(blocks[0].querySelectorAll('[data-edit-handle]')).toHaveLength(8);
    expect(blocks[1].querySelectorAll('[data-edit-handle]')).toHaveLength(0);
    await fireEvent.pointerDown(blocks[1], { button: 0, shiftKey: true, pointerId: 2 });
    await fireEvent.pointerUp(blocks[1], { pointerId: 2 });
    expect(session.selection).toHaveLength(2);
  });

  it('double click opens one contenteditable line per OCR line; Enter adds, Backspace on empty removes', async () => {
    const { container, session } = mount();
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    await fireEvent.dblClick(block);
    await tick();
    let lines = block.querySelectorAll<HTMLElement>('[contenteditable]');
    expect(lines).toHaveLength(2);
    lines[1].textContent = 'いい';
    await fireEvent.input(lines[1]);
    await fireEvent.keyDown(lines[1], { key: 'Enter' });
    await tick();
    lines = block.querySelectorAll<HTMLElement>('[contenteditable]');
    expect(lines).toHaveLength(3);
    lines[2].textContent = '';
    await fireEvent.keyDown(lines[2], { key: 'Backspace' });
    await tick();
    lines = block.querySelectorAll<HTMLElement>('[contenteditable]');
    expect(lines).toHaveLength(2);
    await fireEvent.keyDown(lines[1], { key: 'Escape' });
    await tick();
    expect(block.querySelectorAll('[contenteditable]')).toHaveLength(0);
    expect(session.pageFor(0).blocks[0].lines).toEqual(['あ', 'いい']);
  });

  it('a drag on a block body moves it (pointer capture, no bubbling to the page)', async () => {
    const { container, session } = mount();
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    block.setPointerCapture = vi.fn();
    block.releasePointerCapture = vi.fn();
    const stop = vi.fn();
    container.parentElement!.addEventListener('pointerdown', stop);
    await fireEvent.pointerDown(block, { button: 0, clientX: 100, clientY: 100, pointerId: 3 });
    expect(stop).not.toHaveBeenCalled();
    await fireEvent.pointerMove(block, { clientX: 130, clientY: 110, pointerId: 3 });
    await fireEvent.pointerUp(block, { clientX: 130, clientY: 110, pointerId: 3 });
    // jsdom has no layout: scale() falls back to 1 → 30px right, 10px down
    expect(session.pageFor(0).blocks[0].box).toEqual([40, 20, 80, 110]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/components/Reader/Edit/__tests__/EditOverlay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/reader/edit/edit-context.ts`:

```ts
import { getContext, setContext } from 'svelte';
import type { Page } from '$lib/types';
import type { EditSession } from './edit-session.svelte';

const KEY = Symbol('mokuro-edit-session');

export function setEditSession(session: () => EditSession | null): void {
  setContext(KEY, session);
}
export function getEditSession(): (() => EditSession | null) | undefined {
  return getContext(KEY);
}

/** Screen px per image px for a page element (zoom-aware). 1 when unmeasurable (jsdom). */
export function pageScaleOf(el: HTMLElement | null | undefined, page: Page): number {
  if (!el || !page.img_width) return 1;
  const w = el.getBoundingClientRect().width;
  return w > 0 ? w / page.img_width : 1;
}
```

`EditableBlock.svelte`:

```svelte
<script lang="ts">
  import type { Block } from '$lib/types';
  import type { EditSession } from '$lib/reader/edit/edit-session.svelte';
  import { layoutLines, getDefaultMeasurer } from '$lib/reader/line-coords-layout';
  import { settings } from '$lib/settings';
  import { tick } from 'svelte';

  interface Props {
    block: Block;
    index: number;
    pageIndex: number;
    selected: boolean;
    session: EditSession;
    scale: () => number;
  }
  let { block, index, pageIndex, selected, session, scale }: Props = $props();

  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
  type Handle = (typeof HANDLES)[number];

  let editing = $state(false);
  let draftLines = $state<string[]>([]);
  let root: HTMLDivElement | undefined = $state();

  let left = $derived(block.box[0]);
  let top = $derived(block.box[1]);
  let width = $derived(block.box[2] - block.box[0]);
  let height = $derived(block.box[3] - block.box[1]);
  let writingMode = $derived(block.vertical ? 'vertical-rl' : 'horizontal-tb');
  let fontSize = $derived(
    $settings.fontSize === 'auto' || $settings.fontSize === 'original'
      ? `${block.font_size}px`
      : `${$settings.fontSize}pt`
  );
  // Per-line quads → absolute positions (edit mode needs no Yomitan continuity).
  let lineLayouts = $derived(
    $settings.fontSize === 'auto' && !editing
      ? layoutLines(block, block.lines, getDefaultMeasurer())
      : null
  );

  // ---- pointer: click/select, drag-move, handle-resize ----
  let drag: {
    id: number;
    kind: 'move' | Handle;
    startX: number;
    startY: number;
    box: number[];
    moved: boolean;
    key: string;
  } | null = null;

  function onPointerDown(e: PointerEvent, kind: 'move' | Handle) {
    if (e.button !== 0 || editing) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    drag = {
      id: e.pointerId,
      kind,
      startX: e.clientX,
      startY: e.clientY,
      box: block.box.slice(),
      moved: false,
      key: `${kind}:${pageIndex}:${index}:${e.pointerId}`
    };
  }

  function onPointerMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const s = scale() || 1;
    const dx = (e.clientX - drag.startX) / s;
    const dy = (e.clientY - drag.startY) / s;
    if (!drag.moved && Math.hypot(dx, dy) * s < 3) return;
    drag.moved = true;
    if (!selected) session.select(pageIndex, index);
    const [x0, y0, x1, y1] = drag.box;
    if (drag.kind === 'move') {
      const cur = session.pageFor(pageIndex).blocks[index].box;
      session.move(pageIndex, index, x0 + dx - cur[0], y0 + dy - cur[1], drag.key);
      return;
    }
    const k = drag.kind;
    const nx0 = k.includes('w') ? x0 + dx : x0;
    const nx1 = k.includes('e') ? x1 + dx : x1;
    const ny0 = k.includes('n') ? y0 + dy : y0;
    const ny1 = k.includes('s') ? y1 + dy : y1;
    session.resize(pageIndex, index, [nx0, ny0, nx1, ny1], drag.key);
  }

  function onPointerUp(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (!drag.moved) session.select(pageIndex, index, e.shiftKey);
    drag = null;
  }

  // ---- text editing ----
  async function openEditor(e: MouseEvent) {
    e.stopPropagation();
    draftLines = block.lines.slice();
    editing = true;
    session.select(pageIndex, index);
    await tick();
    root?.querySelector<HTMLElement>('[contenteditable]')?.focus();
  }

  function commitEditor() {
    if (!editing) return;
    editing = false;
    const lines = draftLines.map((l) => l.replace(/\n/g, ''));
    const changed =
      lines.length !== block.lines.length || lines.some((l, i) => l !== block.lines[i]);
    if (changed) session.setLines(pageIndex, index, lines);
  }

  function onLineInput(i: number, e: Event) {
    draftLines[i] = (e.currentTarget as HTMLElement).textContent ?? '';
  }

  async function onLineKeyDown(i: number, e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      draftLines.splice(i + 1, 0, '');
      await tick();
      focusLine(i + 1);
    } else if (e.key === 'Backspace' && draftLines[i] === '' && draftLines.length > 1) {
      e.preventDefault();
      draftLines.splice(i, 1);
      await tick();
      focusLine(Math.max(0, i - 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      commitEditor();
    }
  }

  function focusLine(i: number) {
    root?.querySelectorAll<HTMLElement>('[contenteditable]')[i]?.focus();
  }

  function onFocusOut(e: FocusEvent) {
    if (!editing) return;
    const next = e.relatedTarget as Node | null;
    if (next && root?.contains(next)) return;
    commitEditor();
  }
</script>

<div
  bind:this={root}
  class="editBlock"
  class:selected
  class:editing
  role="none"
  style:left={`${left}px`}
  style:top={`${top}px`}
  style:width={`${width}px`}
  style:height={`${height}px`}
  style:font-size={fontSize}
  style:writing-mode={writingMode}
  onpointerdown={(e) => onPointerDown(e, 'move')}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  ondblclick={openEditor}
  onfocusout={onFocusOut}
>
  {#if editing}
    <div class="lines">
      {#each draftLines as line, i (i)}
        <div
          class="line"
          contenteditable="true"
          role="textbox"
          tabindex="0"
          oninput={(e) => onLineInput(i, e)}
          onkeydown={(e) => onLineKeyDown(i, e)}
        >
          {line}
        </div>
      {/each}
    </div>
  {:else if lineLayouts}
    {#each block.lines as line, i}
      {#if !lineLayouts[i].hidden}
        <span
          class="line positioned"
          style:left={`${lineLayouts[i].left}px`}
          style:top={`${lineLayouts[i].top}px`}
          style:font-size={`${lineLayouts[i].fontSize}px`}>{line}</span
        >
      {/if}
    {/each}
  {:else}
    <div class="lines">
      {#each block.lines as line}<span class="line">{line}</span>{/each}
    </div>
  {/if}
  {#if selected && !editing}
    {#each HANDLES as h}
      <span
        data-edit-handle={h}
        class={`handle handle-${h}`}
        role="none"
        onpointerdown={(e) => onPointerDown(e, h)}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      ></span>
    {/each}
  {/if}
</div>

<style>
  .editBlock {
    position: absolute;
    box-sizing: border-box;
    border: 1px dashed rgba(220, 38, 38, 0.8);
    background: rgba(255, 255, 255, 0.85);
    color: black;
    font-family: 'Noto Sans JP', sans-serif;
    line-height: 1.1em;
    z-index: 12;
    cursor: move;
    user-select: none;
    touch-action: none;
  }
  .editBlock.selected {
    border: 2px solid rgb(37, 99, 235);
    z-index: 13;
  }
  .editBlock.editing {
    cursor: text;
    user-select: text;
  }
  .lines {
    width: 100%;
    height: 100%;
    overflow: hidden;
    letter-spacing: 0.1em;
  }
  .line {
    display: block;
    white-space: nowrap;
    outline: none;
    min-width: 1em;
    min-height: 1em;
  }
  .line.positioned {
    position: absolute;
    line-height: 1;
    letter-spacing: 0;
  }
  .editing .line {
    border-bottom: 1px dotted rgba(37, 99, 235, 0.6);
  }
  .handle {
    position: absolute;
    width: 10px;
    height: 10px;
    background: rgb(37, 99, 235);
    border: 1px solid white;
    border-radius: 2px;
    z-index: 14;
    touch-action: none;
  }
  .handle-nw {
    left: -6px;
    top: -6px;
    cursor: nwse-resize;
  }
  .handle-n {
    left: calc(50% - 5px);
    top: -6px;
    cursor: ns-resize;
  }
  .handle-ne {
    right: -6px;
    top: -6px;
    cursor: nesw-resize;
  }
  .handle-e {
    right: -6px;
    top: calc(50% - 5px);
    cursor: ew-resize;
  }
  .handle-se {
    right: -6px;
    bottom: -6px;
    cursor: nwse-resize;
  }
  .handle-s {
    left: calc(50% - 5px);
    bottom: -6px;
    cursor: ns-resize;
  }
  .handle-sw {
    left: -6px;
    bottom: -6px;
    cursor: nesw-resize;
  }
  .handle-w {
    left: -6px;
    top: calc(50% - 5px);
    cursor: ew-resize;
  }
</style>
```

`EditOverlay.svelte`:

```svelte
<script lang="ts">
  import type { Page } from '$lib/types';
  import type { EditSession } from '$lib/reader/edit/edit-session.svelte';
  import { pageScaleOf } from '$lib/reader/edit/edit-context';
  import EditableBlock from './EditableBlock.svelte';

  interface Props {
    page: Page;
    pageIndex: number;
    session: EditSession;
  }
  let { page, pageIndex, session }: Props = $props();

  let root: HTMLDivElement | undefined = $state();
  let working = $derived(session.pageFor(pageIndex));
  const scale = () => pageScaleOf(root, page);

  // Draw tool: a drag on the overlay background draws a new box.
  let draw = $state<{ id: number; x0: number; y0: number; x1: number; y1: number } | null>(null);

  function toImage(e: PointerEvent): [number, number] {
    const rect = root!.getBoundingClientRect();
    const s = scale() || 1;
    return [(e.clientX - rect.left) / s, (e.clientY - rect.top) / s];
  }

  function onBackgroundDown(e: PointerEvent) {
    if (e.target !== root) return; // a block handled it
    if (session.tool !== 'draw' || e.button !== 0) {
      // plain click on the background clears the selection; the surface pans
      session.clearSelection();
      return;
    }
    e.stopPropagation();
    root!.setPointerCapture?.(e.pointerId);
    const [x, y] = toImage(e);
    draw = { id: e.pointerId, x0: x, y0: y, x1: x, y1: y };
  }
  function onBackgroundMove(e: PointerEvent) {
    if (!draw || e.pointerId !== draw.id) return;
    const [x, y] = toImage(e);
    draw = { ...draw, x1: x, y1: y };
  }
  function onBackgroundUp(e: PointerEvent) {
    if (!draw || e.pointerId !== draw.id) return;
    e.stopPropagation();
    root!.releasePointerCapture?.(e.pointerId);
    const { x0, y0, x1, y1 } = draw;
    draw = null;
    if (Math.abs(x1 - x0) >= 8 && Math.abs(y1 - y0) >= 8) {
      session.add(pageIndex, [
        Math.min(x0, x1),
        Math.min(y0, y1),
        Math.max(x0, x1),
        Math.max(y0, y1)
      ]);
      session.tool = 'select';
    }
  }
</script>

<div
  bind:this={root}
  class="editOverlay"
  class:drawing={session.tool === 'draw'}
  data-edit-overlay
  role="none"
  onpointerdown={onBackgroundDown}
  onpointermove={onBackgroundMove}
  onpointerup={onBackgroundUp}
  onpointercancel={onBackgroundUp}
>
  {#each working.blocks as block, index (`${pageIndex}-${index}`)}
    <EditableBlock
      {block}
      {index}
      {pageIndex}
      {session}
      {scale}
      selected={session.isSelected(pageIndex, index)}
    />
  {/each}
  {#if draw}
    <div
      class="draft"
      style:left={`${Math.min(draw.x0, draw.x1)}px`}
      style:top={`${Math.min(draw.y0, draw.y1)}px`}
      style:width={`${Math.abs(draw.x1 - draw.x0)}px`}
      style:height={`${Math.abs(draw.y1 - draw.y0)}px`}
    ></div>
  {/if}
</div>

<style>
  .editOverlay {
    position: absolute;
    inset: 0;
    z-index: 11;
  }
  .editOverlay.drawing {
    cursor: crosshair;
  }
  .draft {
    position: absolute;
    border: 2px dashed rgb(37, 99, 235);
    background: rgba(37, 99, 235, 0.1);
    pointer-events: none;
  }
</style>
```

Note on `session.isSelected` in the `{#each}`: it reads `session.selection` ($state) so it re-renders on selection change.

`MangaPage.svelte` — add prop `editSession?: EditSession | null` (import type from `$lib/reader/edit/edit-session.svelte`, import `EditOverlay`), and in the template:

```svelte
{#if editSession && pageIndex !== undefined}
  <EditOverlay {page} {pageIndex} session={editSession} />
{:else}
  <TextBoxes
    {page}
    src={src ?? undefined}
    {volumeUuid}
    {pageIndex}
    {forceVisible}
    {onContextMenu}
  />
{/if}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/components/Reader/Edit/ && npm run check`
Expected: PASS; 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/Reader/Edit src/lib/reader/edit/edit-context.ts src/lib/components/Reader/MangaPage.svelte
git commit -m "feat(editor): EditOverlay/EditableBlock — move, resize, select, inline line editing"
```

---

### Task 10: `EditToolbar`, the QuickActions Edit item, and Reader wiring

**Files:**

- Create: `src/lib/components/Reader/Edit/EditToolbar.svelte`
- Modify: `src/lib/components/Reader/QuickActions.svelte` (props + one button)
- Modify: `src/lib/components/Reader/Reader.svelte` (session state, keyboard, MangaPage props, toolbar mount, pages refresh)
- Test: `src/lib/components/Reader/Edit/__tests__/EditToolbar.test.ts`

**Interfaces:**

- `EditToolbar` props: `{ session: EditSession; pageIndex: number; hasOriginal: boolean; onExit: () => void; onRevert: () => void }`. Buttons with `aria-label`s: `Draw new box`, `Delete`, `Merge`, `Split`, `Flip writing mode`, `Undo`, `Redo`, `Revert page`, `Exit edit mode`. Split shows a `<select aria-label="Split after line">` when exactly one block with ≥ 2 lines is selected.
- `QuickActions` gains props `onEdit?: () => void; editEnabled?: boolean; editing?: boolean`; the button is `aria-label="Edit OCR"` (or `"Exit edit mode"` when editing), `disabled={!editEnabled}` with `title="Edit is available in paged mode only"` when disabled.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/components/Reader/Edit/__tests__/EditToolbar.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Page } from '$lib/types';
import EditToolbar from '../EditToolbar.svelte';
import { EditSession } from '$lib/reader/edit/edit-session.svelte';

afterEach(cleanup);

function page(): Page {
  return {
    version: '0.2.1',
    img_width: 200,
    img_height: 200,
    img_path: 'p.png',
    blocks: [
      { box: [10, 10, 50, 100], vertical: true, font_size: 20, lines: ['あ', 'い'] },
      { box: [100, 10, 140, 100], vertical: true, font_size: 20, lines: ['う'] }
    ]
  };
}

function mount(hasOriginal = true) {
  const p = page();
  const session = new EditSession({
    volumeUuid: 'v',
    getPage: () => p,
    persist: async () => {},
    debounceMs: 1e6
  });
  const onExit = vi.fn();
  const onRevert = vi.fn();
  const utils = render(EditToolbar, {
    props: { session, pageIndex: 0, hasOriginal, onExit, onRevert }
  });
  const btn = (label: string) => utils.getByLabelText(label) as HTMLButtonElement;
  return { ...utils, session, onExit, onRevert, btn };
}

describe('EditToolbar', () => {
  it('disables ops whose preconditions do not hold', async () => {
    const { btn, session } = mount(false);
    expect(btn('Delete').disabled).toBe(true);
    expect(btn('Merge').disabled).toBe(true);
    expect(btn('Split').disabled).toBe(true);
    expect(btn('Undo').disabled).toBe(true);
    expect(btn('Redo').disabled).toBe(true);
    expect(btn('Revert page').disabled).toBe(true);
    session.select(0, 0);
    await tick();
    expect(btn('Delete').disabled).toBe(false);
    expect(btn('Split').disabled).toBe(false);
    expect(btn('Merge').disabled).toBe(true);
    session.select(0, 1, true);
    await tick();
    expect(btn('Merge').disabled).toBe(false);
    expect(btn('Split').disabled).toBe(true);
  });

  it('drives the session', async () => {
    const { btn, session, onExit, onRevert, getByLabelText } = mount(true);
    await fireEvent.click(btn('Draw new box'));
    expect(session.tool).toBe('draw');
    session.select(0, 0);
    await tick();
    await fireEvent.change(getByLabelText('Split after line'), { target: { value: '1' } });
    await fireEvent.click(btn('Split'));
    expect(session.pageFor(0).blocks).toHaveLength(3);
    await fireEvent.click(btn('Undo'));
    expect(session.pageFor(0).blocks).toHaveLength(2);
    await fireEvent.click(btn('Redo'));
    expect(session.pageFor(0).blocks).toHaveLength(3);
    session.select(0, 0);
    await fireEvent.click(btn('Flip writing mode'));
    expect(session.pageFor(0).blocks[0].vertical).toBe(false);
    await fireEvent.click(btn('Delete'));
    expect(session.pageFor(0).blocks).toHaveLength(2);
    await fireEvent.click(btn('Revert page'));
    expect(onRevert).toHaveBeenCalled();
    await fireEvent.click(btn('Exit edit mode'));
    expect(onExit).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/components/Reader/Edit/__tests__/EditToolbar.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`EditToolbar.svelte`:

```svelte
<script lang="ts">
  import type { EditSession } from '$lib/reader/edit/edit-session.svelte';
  import {
    CloseOutline,
    GridPlusOutline,
    ObjectsColumnOutline,
    RedoOutline,
    RefreshOutline,
    TextSizeOutline,
    TrashBinOutline,
    UndoOutline
  } from 'flowbite-svelte-icons';

  interface Props {
    session: EditSession;
    pageIndex: number;
    hasOriginal: boolean;
    onExit: () => void;
    onRevert: () => void;
  }
  let { session, pageIndex, hasOriginal, onExit, onRevert }: Props = $props();

  let selected = $derived(session.selection);
  let single = $derived(
    selected.length === 1
      ? session.pageFor(selected[0].pageIndex).blocks[selected[0].blockIndex]
      : null
  );
  let canSplit = $derived(!!single && single.lines.length >= 2);
  let splitAt = $state(1);
  $effect(() => {
    if (single) splitAt = Math.min(Math.max(1, splitAt), Math.max(1, single.lines.length - 1));
  });

  const btn =
    'flex h-10 w-10 items-center justify-center rounded-full bg-gray-700 text-gray-200 shadow hover:bg-gray-600 disabled:opacity-40 disabled:hover:bg-gray-700';
</script>

<div
  class="fixed top-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-gray-900/90 px-3 py-2 shadow-lg"
  data-edit-toolbar
  role="toolbar"
  aria-label="OCR edit tools"
>
  <button
    class={btn}
    class:ring-2={session.tool === 'draw'}
    aria-label="Draw new box"
    aria-pressed={session.tool === 'draw'}
    onclick={() => (session.tool = session.tool === 'draw' ? 'select' : 'draw')}
  >
    <GridPlusOutline />
  </button>
  <button
    class={btn}
    aria-label="Delete"
    disabled={selected.length === 0}
    onclick={() => session.deleteSelected()}
  >
    <TrashBinOutline />
  </button>
  <button
    class={btn}
    aria-label="Merge"
    disabled={selected.length < 2}
    onclick={() => session.mergeSelected()}
  >
    <ObjectsColumnOutline />
  </button>
  {#if canSplit && single}
    <select
      aria-label="Split after line"
      class="rounded bg-gray-700 px-1 py-1 text-sm text-gray-200"
      bind:value={splitAt}
    >
      {#each Array.from({ length: single.lines.length - 1 }, (_, i) => i + 1) as n}
        <option value={n}>{n}</option>
      {/each}
    </select>
  {/if}
  <button
    class={btn}
    aria-label="Split"
    disabled={!canSplit}
    onclick={() => session.splitSelected(Number(splitAt))}
  >
    <span class="text-xs font-bold">S</span>
  </button>
  <button
    class={btn}
    aria-label="Flip writing mode"
    disabled={selected.length === 0}
    onclick={() => session.flipSelected()}
  >
    <TextSizeOutline />
  </button>
  <span class="mx-1 h-6 w-px bg-gray-600"></span>
  <button
    class={btn}
    aria-label="Undo"
    disabled={!session.canUndo(pageIndex)}
    onclick={() => session.undo(pageIndex)}
  >
    <UndoOutline />
  </button>
  <button
    class={btn}
    aria-label="Redo"
    disabled={!session.canRedo(pageIndex)}
    onclick={() => session.redo(pageIndex)}
  >
    <RedoOutline />
  </button>
  <button class={btn} aria-label="Revert page" disabled={!hasOriginal} onclick={onRevert}>
    <RefreshOutline />
  </button>
  <span class="mx-1 h-6 w-px bg-gray-600"></span>
  <button class={btn} aria-label="Exit edit mode" onclick={onExit}>
    <CloseOutline />
  </button>
</div>
```

(If an icon name above does not exist in `node_modules/flowbite-svelte-icons/dist/`, substitute a listed one — the test asserts labels, not icons.)

`QuickActions.svelte` — add to `Props`: `onEdit?: () => void; editEnabled?: boolean; editing?: boolean;` (destructure with defaults `editEnabled = false, editing = false`), import `EditOutline`, and add this button as the FIRST entry inside the `{#if open}` column:

```svelte
<button
  onclick={() => {
    onEdit?.();
    open = false;
  }}
  disabled={!editEnabled}
  title={editEnabled ? undefined : 'Edit is available in paged mode only'}
  class="flex h-12 w-12 items-center justify-center rounded-full bg-gray-700 text-gray-300 shadow-lg hover:bg-gray-600 focus:outline-none disabled:opacity-40 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
  aria-label={editing ? 'Exit edit mode' : 'Edit OCR'}
>
  <EditOutline size="xl" />
</button>
```

`Reader.svelte` wiring:

1. Imports:

```ts
import { EditSession } from '$lib/reader/edit/edit-session.svelte';
import { hasOriginalLayer } from '$lib/reader/edit/edit-persist';
import EditToolbar from './Edit/EditToolbar.svelte';
```

2. State (next to `pageDirection`):

```ts
let editSession = $state<EditSession | null>(null);
let editHasOriginal = $state(false);
// Bumped when an edit is persisted so `pages` re-derives from the patched data.
let pagesRevision = $state(0);
```

3. Replace `let pages = $derived(volumeData?.pages || []);` with:

```ts
let pages = $derived.by(() => {
  void pagesRevision;
  return volumeData?.pages || [];
});
```

4. Functions:

```ts
function enterEditMode() {
  if (!volume || !volumeData || $settings.continuousScroll || editSession) return;
  const uuid = volume.volume_uuid;
  editSession = new EditSession({
    volumeUuid: uuid,
    getPage: (i) => volumeData?.pages[i],
    onPersisted: (i, page) => {
      // Keep the in-memory volume data (charDisplay, next open of the
      // page) in step with what was written; `pages` re-derives.
      if (volumeData?.pages) volumeData.pages[i] = page;
      pagesRevision++;
      editHasOriginal = true;
    }
  });
  hasOriginalLayer(uuid).then((v) => (editHasOriginal = v));
  overlaysVisible = true;
}

async function exitEditMode() {
  const s = editSession;
  if (!s) return;
  editSession = null;
  s.dispose();
  await s.flush();
  pagesRevision++;
}

async function revertCurrentPage() {
  if (!editSession) return;
  const ok = await editSession.revertPage(index);
  if (!ok) showSnackbar('No original to revert to');
}

function toggleEditMode() {
  if (editSession) void exitEditMode();
  else enterEditMode();
}
```

5. In `handleShortcuts`, BEFORE the `keyboardShouldIgnore` check add nothing; AFTER it (still before the modifier early-return) add:

```ts
if (editSession) {
  const s = editSession;
  const ctrl = event.ctrlKey || event.metaKey;
  if (ctrl && event.code === 'KeyZ' && event.shiftKey) {
    event.preventDefault();
    s.redo(index);
    return;
  }
  if (ctrl && event.code === 'KeyZ') {
    event.preventDefault();
    s.undo(index);
    return;
  }
  if (ctrl && event.code === 'KeyY') {
    event.preventDefault();
    s.redo(index);
    return;
  }
  if ((event.code === 'Delete' || event.code === 'Backspace') && s.selection.length > 0) {
    event.preventDefault();
    s.deleteSelected();
    return;
  }
  if (event.code === 'Escape') {
    event.preventDefault();
    if (s.tool === 'draw') s.tool = 'select';
    else if (s.selection.length > 0) s.clearSelection();
    else void exitEditMode();
    return;
  }
}
```

6. Leaving the volume / unmount: in `onDestroy` add `if (editSession) { const s = editSession; editSession = null; s.dispose(); void s.flush(); }`. Also an `$effect` that exits edit mode when `volume?.volume_uuid` changes or `$settings.continuousScroll` becomes true:

```ts
$effect(() => {
  const uuid = volume?.volume_uuid;
  const continuous = $settings.continuousScroll;
  if (editSession && (continuous || uuid !== editSession.volumeUuid)) void exitEditMode();
});
```

7. Template: pass to `<QuickActions ... onEdit={toggleEditMode} editEnabled={!$settings.continuousScroll} editing={!!editSession} />`; after `<SettingsButton .../>` add

```svelte
{#if editSession}
  <EditToolbar
    session={editSession}
    pageIndex={index}
    hasOriginal={editHasOriginal}
    onExit={exitEditMode}
    onRevert={revertCurrentPage}
  />
{/if}
```

and pass `editSession={editSession}` to BOTH `<MangaPage>` instances in the paged branch (the scroll readers keep read mode).

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib/components/Reader && npm run check`
Expected: PASS; 0 errors. Then open `http://localhost:5176` (dev server, see Task 12) and confirm the Edit button appears in quick actions in paged mode and is disabled in continuous mode.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/Reader/Edit/EditToolbar.svelte src/lib/components/Reader/Edit/__tests__/EditToolbar.test.ts src/lib/components/Reader/QuickActions.svelte src/lib/components/Reader/Reader.svelte
git commit -m "feat(reader): edit mode — toolbar, quick-actions entry, keyboard, session lifecycle"
```

---

### Task 11: Cloud re-upload of an edited `.mokuro` (sidecar-backfill hook)

**Finding to record in the report:** the backup UI refuses an already-backed-up volume ("Volume already backed up" / the button becomes _Delete from cloud_), and `sidecar-backfill.ts` only uploads sidecars that are MISSING from the listing. So without a hook an edit never reaches the cloud. The hook: `persistPageEdit` stamps `ocr_edited_at` (Task 5) and calls `noteOcrEdited`; the backfill treats a listed `.mokuro` older than that stamp as a gap, nominates the volume immediately, and the sweep also nominates every stamped volume (keys-only via the new index) so a later session converges too.

**Files:**

- Modify: `src/lib/util/sync/sidecar-backfill.ts` (replace the Task 5 stub; `deriveSidecarGap`; `sweepInstalledVolumesForSidecarBackfill`)
- Test: `src/lib/util/sync/sidecar-backfill.test.ts` (new describe block)

**Interfaces:**

- Produces: `noteOcrEdited(volumeUuid: string): void` — clears the volume's attempted-mark for the active account and nominates it (TRIGGER 3).
- `mokuroSidecarBehindEdit(entry: CloudFileMetadata | undefined, volume: VolumeMetadata): boolean` (internal) — true when `volume.ocr_edited_at` is set and the listed file's `modifiedTime` is absent or older than it.

- [ ] **Step 1: Write the failing test** — append to `sidecar-backfill.test.ts`:

```ts
describe('sidecar backfill — OCR edits re-upload the .mokuro (TRIGGER 3)', () => {
  it('an edited volume whose listed .mokuro predates the edit re-uploads ONLY the .mokuro', async () => {
    await withOcr(installedVolume({ ocr_edited_at: '2026-09-15T12:00:00Z' }));
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));
    cloud.state.files.push(listed('Legacy Series/Volume 01.mokuro')); // modified 2026-08-01
    cloud.state.files.push(listed('Legacy Series/Volume 01.webp'));

    noteOcrEdited('uuid-1');
    await settle();

    expect(uploadedPaths()).toEqual(['Legacy Series/Volume 01.mokuro']);
  });

  it('a listed .mokuro newer than the edit is left alone', async () => {
    await withOcr(installedVolume({ ocr_edited_at: '2026-07-01T00:00:00Z' }));
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));
    cloud.state.files.push(listed('Legacy Series/Volume 01.mokuro'));
    cloud.state.files.push(listed('Legacy Series/Volume 01.webp'));

    noteOcrEdited('uuid-1');
    await settle();
    expect(uploadedPaths()).toEqual([]);
  });

  it('a second edit in the same session re-uploads again (the attempted-mark is cleared)', async () => {
    await withOcr(installedVolume({ ocr_edited_at: '2026-09-15T12:00:00Z' }));
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));
    cloud.state.files.push(listed('Legacy Series/Volume 01.mokuro'));
    cloud.state.files.push(listed('Legacy Series/Volume 01.webp'));
    noteOcrEdited('uuid-1');
    await settle();
    expect(uploadedPaths()).toHaveLength(1);

    // The upload landed in the cache with a "now" mtime; a LATER edit is newer.
    await db.volumes.update('uuid-1', { ocr_edited_at: new Date(Date.now() + 5000).toISOString() });
    noteOcrEdited('uuid-1');
    await settle();
    expect(uploadedPaths()).toHaveLength(2);
  });

  it('the sweep nominates stamped volumes even when the listing shows no sidecar gap', async () => {
    await withOcr(installedVolume({ ocr_edited_at: '2026-09-15T12:00:00Z' }));
    cloud.state.files.push(listed('Legacy Series/Volume 01.cbz'));
    cloud.state.files.push(listed('Legacy Series/Volume 01.mokuro'));
    cloud.state.files.push(listed('Legacy Series/Volume 01.webp'));

    await sweepInstalledVolumesForSidecarBackfill();
    await settle();
    expect(uploadedPaths()).toEqual(['Legacy Series/Volume 01.mokuro']);
  });
});
```

Add `noteOcrEdited` to the module's import list at the top of the test file.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/util/sync/sidecar-backfill.test.ts`
Expected: the 4 new tests FAIL (nothing uploaded).

- [ ] **Step 3: Implement**

Replace the Task 5 stub with:

```ts
/**
 * TRIGGER 3 — the reader's OCR editor just wrote `volume_ocr` and stamped
 * `ocr_edited_at` on the row (`persistPageEdit`). The cloud `.mokuro` is now
 * behind the local row, which no "missing sidecar" check would ever notice:
 * {@link deriveSidecarGap} therefore also compares the listed `.mokuro`'s
 * mtime against the stamp, and this trigger nominates the volume right away.
 * The attempted-mark is cleared first — an edit is new information, so the
 * once-per-session rule restarts for this volume.
 */
export function noteOcrEdited(volumeUuid: string): void {
  try {
    if (!volumeUuid || !backfillReady()) return;
    const key = attemptKey(volumeUuid);
    if (key) attemptedThisSession.delete(key);
    pending.add(volumeUuid);
    kickDrain();
  } catch (error) {
    console.debug('[sidecar-backfill] could not queue edited volume:', error);
  }
}

/** The listed `.mokuro` predates this device's last OCR edit (or has no mtime to prove otherwise). */
function mokuroSidecarBehindEdit(
  entry: CloudFileMetadata | undefined,
  volume: VolumeMetadata
): boolean {
  if (!entry || !volume.ocr_edited_at) return false;
  const edited = Date.parse(volume.ocr_edited_at);
  if (!Number.isFinite(edited)) return false;
  const listed = entry.modifiedTime ? Date.parse(entry.modifiedTime) : NaN;
  return !Number.isFinite(listed) || listed < edited;
}
```

In `deriveSidecarGap`, change the mokuro line to:

```ts
const wantsMokuro =
  hasMokuroVersion(volume) && (!entry?.mokuro || mokuroSidecarBehindEdit(entry.mokuro, volume));
```

In `sweepInstalledVolumesForSidecarBackfill`, after `if (folderFiles.size === 0) return;` and BEFORE the `gapFolderKeys` early return, gather edited volumes keys-only and merge them into the candidate set. Restructure the tail so it reads:

```ts
    // Edited volumes (sparse `ocr_edited_at` index — keys-only, empty for a
    // library never edited in the reader). Their listed `.mokuro` may be
    // behind the row even when the listing shows no sidecar MISSING.
    const editedUuids = (await db.volumes.where('ocr_edited_at').above('').primaryKeys()) as string[];

    if (gapFolderKeys.size === 0 && editedUuids.length === 0) return;

    let gapUuids: string[] = [];
    if (gapFolderKeys.size > 0) {
      const literalTitles = ...;           // existing code, unchanged
      const matchingLiterals = ...;
      if (matchingLiterals.length > 0) {
        gapUuids = (await db.volumes.where('series_title').anyOf(matchingLiterals).primaryKeys()) as string[];
      }
    }
    const candidateUuids = [...new Set([...gapUuids, ...editedUuids])];
    if (candidateUuids.length === 0) return;
    const candidates = (await db.volumes.bulkGet(candidateUuids)) as Array<VolumeMetadata | undefined>;
```

and in the per-candidate loop replace `const wantsMokuro = !entry?.mokuro && hasMokuroVersion(volume);` with `const wantsMokuro = hasMokuroVersion(volume) && (!entry?.mokuro || mokuroSidecarBehindEdit(entry.mokuro, volume));`.

Update the module doc's "Finding 2" note: the steady state still never reads rows UNLESS the volume was edited in the reader, in which case its one row is read per listing (bounded by the number of edited volumes).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/util/sync/sidecar-backfill.test.ts src/lib/reader/edit/edit-persist.test.ts`
Expected: PASS (all pre-existing backfill tests still green — the `countIdbOps` steady-state test must still pass: the index read is keys-only).

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/sync/sidecar-backfill.ts src/lib/util/sync/sidecar-backfill.test.ts
git commit -m "feat(sync): re-upload an edited volume's .mokuro sidecar (ocr_edited_at trigger)"
```

---

### Task 12: Playwright e2e — edits survive a reload; revert restores the original

**Files:**

- Create: `e2e/ocr-editor.spec.ts`

**Interfaces:** consumes the real app through the dev server. Seeds a one-page volume (a 400×600 PNG drawn on a canvas, one vertical block) directly into Dexie, opens `#/reader/<series_uuid>/<volume_uuid>`, and drives the overlay with real mouse events.

- [ ] **Step 1: Write the spec**

```ts
// e2e/ocr-editor.spec.ts
import { test, expect, type Page } from '@playwright/test';

/**
 * The in-reader OCR editor against the REAL app: a seeded one-page volume is
 * opened in the paged reader, edited through the overlay (move, resize, text),
 * reloaded, and the persisted OCR row is asserted on; then "Revert page"
 * restores the original layer.
 */

const SERIES = 'Editor Series';
const SERIES_UUID = 'e2e-editor-series';
const VOLUME_UUID = 'e2e-editor-volume';

async function seedVolume(page: Page) {
  await page.goto('/');
  await page.waitForTimeout(800);
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOLUME_UUID }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      await Promise.all([
        db.volumes.clear(),
        db.volume_ocr.clear(),
        db.volume_files.clear(),
        db.volume_ocr_layers.clear()
      ]);
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 600;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 400, 600);
      ctx.fillStyle = '#ccc';
      ctx.fillRect(250, 50, 60, 200);
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      const file = new File([blob], '001.png', { type: 'image/png' });
      await db.volumes.put({
        volume_uuid: VOLUME_UUID,
        series_uuid: SERIES_UUID,
        series_title: SERIES,
        volume_title: 'Vol 1',
        mokuro_version: '0.2.1',
        page_count: 1,
        character_count: 2,
        page_char_counts: [2]
      });
      await db.volume_ocr.put({
        volume_uuid: VOLUME_UUID,
        pages: [
          {
            version: '0.2.1',
            img_width: 400,
            img_height: 600,
            img_path: '001.png',
            blocks: [{ box: [250, 50, 310, 250], vertical: true, font_size: 30, lines: ['あい'] }]
          }
        ]
      });
      await db.volume_files.put({ volume_uuid: VOLUME_UUID, files: { '001.png': file } });
      window.localStorage.setItem(
        'volumes',
        JSON.stringify({
          [VOLUME_UUID]: {
            progress: 1,
            chars: 0,
            completed: false,
            timeReadInMinutes: 0,
            lastProgressUpdate: new Date().toISOString()
          }
        })
      );
    },
    { SERIES, SERIES_UUID, VOLUME_UUID }
  );
}

async function openReader(page: Page) {
  await page.evaluate(
    ({ SERIES_UUID, VOLUME_UUID }) => {
      window.location.hash = `#/reader/${SERIES_UUID}/${VOLUME_UUID}`;
    },
    { SERIES_UUID, VOLUME_UUID }
  );
  await expect(page.locator('[data-page-index="0"]')).toBeVisible({ timeout: 20000 });
  // paged mode, no continuous scroll
  await page.evaluate(async () => {
    const { updateSetting } = await import('/src/lib/settings/index.ts');
    updateSetting('continuousScroll', false);
    updateSetting('quickActions', true);
  });
}

async function enterEditMode(page: Page) {
  await page.getByLabel('Quick actions menu').click();
  await page.getByLabel('Edit OCR').click();
  await expect(page.locator('[data-edit-toolbar]')).toBeVisible();
}

async function readOcr(page: Page) {
  return page.evaluate(async (uuid) => {
    const { db } = await import('/src/lib/catalog/db.ts');
    const ocr = await db.volume_ocr.get(uuid);
    const row = await db.volumes.get(uuid);
    const original = await db.volume_ocr_layers.get([uuid, 'original']);
    return {
      block: ocr?.pages[0].blocks[0],
      chars: row?.character_count,
      edited: row?.ocr_edited_at,
      original: original?.pages[0].blocks[0]
    };
  }, VOLUME_UUID);
}

test.describe('OCR editor', () => {
  test('move, resize and a text edit persist across a reload; revert restores the original', async ({
    page
  }) => {
    await seedVolume(page);
    await openReader(page);
    await enterEditMode(page);

    const block = page.locator('.editBlock').first();
    await expect(block).toBeVisible();

    // Move: drag the body 40px right, 20px down (screen px; the page is
    // rendered at some zoom, so we compute the delta in image px afterwards).
    const before = await block.boundingBox();
    const scale = before!.width / 60; // box is 60 image px wide
    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
    await page.mouse.down();
    await page.mouse.move(before!.x + before!.width / 2 + 40, before!.y + before!.height / 2 + 20, {
      steps: 5
    });
    await page.mouse.up();

    // Resize: drag the south-east handle 20px right.
    const se = block.locator('[data-edit-handle="se"]');
    const seBox = await se.boundingBox();
    await page.mouse.move(seBox!.x + 5, seBox!.y + 5);
    await page.mouse.down();
    await page.mouse.move(seBox!.x + 25, seBox!.y + 5, { steps: 5 });
    await page.mouse.up();

    // Text: double click, replace the one line, Escape commits.
    await block.dblclick();
    const line = block.locator('[contenteditable]').first();
    await line.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('かきく');
    await page.keyboard.press('Escape');

    // Autosave (500 ms debounce)
    await page.waitForTimeout(900);
    const saved = await readOcr(page);
    const dx = 40 / scale;
    const dy = 20 / scale;
    expect(saved.block!.lines).toEqual(['かきく']);
    expect(saved.block!.box[0]).toBeCloseTo(250 + dx, 0);
    expect(saved.block!.box[1]).toBeCloseTo(50 + dy, 0);
    expect(saved.block!.box[2]).toBeCloseTo(310 + dx + 20 / scale, 0);
    expect(saved.chars).toBe(3);
    expect(typeof saved.edited).toBe('string');
    expect(saved.original).toEqual({
      box: [250, 50, 310, 250],
      vertical: true,
      font_size: 30,
      lines: ['あい']
    });

    await page.reload();
    await openReader(page);
    const after = await readOcr(page);
    expect(after.block).toEqual(saved.block);

    await enterEditMode(page);
    await page.getByLabel('Revert page').click();
    await page.waitForTimeout(900);
    const reverted = await readOcr(page);
    expect(reverted.block).toEqual(after.original);
  });
});
```

- [ ] **Step 2: Run it**

Run (dedicated port, existing Chromium):
`E2E_PORT=5177 E2E_CHROMIUM=/usr/bin/chromium npx playwright test e2e/ocr-editor.spec.ts`
Expected: PASS. If the reader route or settings import path differs from what the spec assumes, fix the SPEC to match the real app (grep `hash-router.ts` and `src/lib/settings/index.ts`), not the app.

- [ ] **Step 3: Commit**

```bash
git add e2e/ocr-editor.spec.ts
git commit -m "test(e2e): OCR editor edits persist across reload; revert restores original"
```

---

### Task 13: Full verification

- [ ] `npx vitest run` — all green (note the count).
- [ ] `npm run check` — 0 errors.
- [ ] `npm run lint` — clean for changed files (pre-existing failures on develop, if any, documented with evidence: run the same command on the develop worktree's HEAD via `git stash`-free means, i.e. `git -C ../develop status` and `npm run lint` there is NOT allowed — instead compare against the list of files this branch touched).
- [ ] `E2E_PORT=5177 E2E_CHROMIUM=/usr/bin/chromium npx playwright test e2e/ocr-editor.spec.ts` — green.
- [ ] Start the review server in the background: `npm run dev -- --port 5176 --strictPort` and leave it running.
- [ ] Manual smoke in a browser at `http://localhost:5176`: open a volume, quick actions → Edit OCR, move/resize/edit, page turn keeps working, Escape exits; with continuous scroll on, the Edit button is disabled.
