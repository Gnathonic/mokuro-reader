# OCR & Translation Engines (sub-project C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user run Google Cloud Vision OCR and LLM translation (Gemini / Anthropic / OpenAI-compatible) on one page or a whole volume, with results landing in OCR layers (`gcv`, `tr-<lang>`), keys kept in localStorage only.

**Architecture:** A new `src/lib/engines/` module owns credentials (localStorage stores, never synced), a shared run queue (concurrency 2, retry with backoff, cancel, progress), the Vision client + response→mokuro converter, the translation adapters + prompt/parser + line wrapper, and one orchestrator (`engine-runs.ts`) that the reader calls for "page"/"volume" runs. Results are written into `volume_ocr_layers` through a new `upsertLayerPages` in `layers.ts`; the reader switches the displayed layer when a run completes. UI: an "OCR & translation engines (experimental)" settings card, buttons in the edit toolbar / quick actions / layer picker / per-volume settings, and a small run banner with Cancel.

**Tech Stack:** SvelteKit 5 runes, Dexie (`volume_ocr_layers`), flowbite-svelte, Vitest + fake-indexeddb + @testing-library/svelte, Playwright (`page.route` stubs for the HTTP APIs).

**Spec:** `docs/superpowers/specs/2026-09-15-ocr-editor-layers-engines-design.md`, "Sub-project C — Engines (experimental)".

## Global Constraints

- Keys live ONLY in localStorage under `engine_google_key`, `engine_anthropic_key`, `engine_openai_base_url`, `engine_openai_key`, `engine_openai_model`. Never in `profiles`, `miscSettings`, `volume-data`, or any synced payload.
- Non-secret preferences in `miscSettings`: `translationEngine: 'gemini' | 'anthropic' | 'openai'` (default `'gemini'`), `translationModel: string` (`''` = adapter default), `translationLanguage: string` (default `'en'`).
- Vision: `POST https://vision.googleapis.com/v1/images:annotate?key=…`, feature `DOCUMENT_TEXT_DETECTION`, `imageContext.languageHints: ['ja']`; images over 4 MP downscaled on a canvas, coordinates rescaled back.
- Results: OCR → layer `gcv` (kind `ocr`, engine `gcv`); translation → layer `tr-<lang>` (kind `translation`, engine `<adapter>:<model>`). Only the pages that ran are overwritten; a new layer's other pages carry the source's image facts with empty `blocks`.
- Translated blocks keep the source `box`, drop `lines_coords`, set `vertical: false`, wrap by `chars per line = max(1, floor(box width / (font_size × 0.55)))`, shrinking `font_size` by 10 % steps while the wrapped text overflows the box height, down to the size at which 3 lines fit.
- Reading order sent to the translator: RTL pages sort blocks by `xmax` desc then `ymin` asc; LTR by `ymin` asc then `xmin` asc.
- Queue: concurrency 2, retry on HTTP 429/5xx with backoff 1 s, 2 s, 4 s (3 retries), cancel via `AbortController`, progress through `progressTrackerStore`.
- Whole-volume runs confirm first with the page count and the cost note: OCR "about $1.50 per 1000 pages after the free monthly 1000"; translation "a few cents per volume on Flash-class models".
- Everything user-facing carries the word "experimental" in the settings card header and the whole-volume confirm.
- All commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. No pushes.

---

### Task 1: Credentials store and translation preferences

**Files:**

- Create: `src/lib/engines/credentials.ts`
- Modify: `src/lib/settings/misc.ts` (add three keys + defaults)
- Test: `src/lib/engines/credentials.test.ts`

**Interfaces:**

- Produces: `engineCredentials: Readable<EngineCredentials>` where `EngineCredentials = { googleKey: string; anthropicKey: string; openaiBaseUrl: string; openaiKey: string; openaiModel: string }`; `setEngineCredential(key: keyof EngineCredentials, value: string): void`; `hasGoogleKey: Readable<boolean>`; `hasTranslationKey: Readable<boolean>` (true when the engine chosen in `miscSettings.translationEngine` has its key); `ENGINE_STORAGE_KEYS` constant map.
- `MiscSettings` gains `translationEngine`, `translationModel`, `translationLanguage`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/engines/credentials.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';

describe('engine credentials', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reads and writes each key through localStorage only', async () => {
    const { engineCredentials, setEngineCredential, ENGINE_STORAGE_KEYS } = await import(
      './credentials'
    );
    setEngineCredential('googleKey', 'g-123');
    setEngineCredential('openaiBaseUrl', 'https://api.example.com/v1');
    expect(get(engineCredentials).googleKey).toBe('g-123');
    expect(localStorage.getItem(ENGINE_STORAGE_KEYS.googleKey)).toBe('g-123');
    expect(localStorage.getItem(ENGINE_STORAGE_KEYS.openaiBaseUrl)).toBe(
      'https://api.example.com/v1'
    );
  });

  it('hasGoogleKey / hasTranslationKey follow the keys and the chosen engine', async () => {
    const { hasGoogleKey, hasTranslationKey, setEngineCredential } = await import('./credentials');
    const { updateMiscSetting } = await import('$lib/settings/misc');
    expect(get(hasGoogleKey)).toBe(false);
    setEngineCredential('googleKey', 'g');
    expect(get(hasGoogleKey)).toBe(true);
    // gemini is the default engine: the Google key is its key
    expect(get(hasTranslationKey)).toBe(true);
    updateMiscSetting('translationEngine', 'anthropic');
    expect(get(hasTranslationKey)).toBe(false);
    setEngineCredential('anthropicKey', 'a');
    expect(get(hasTranslationKey)).toBe(true);
    updateMiscSetting('translationEngine', 'openai');
    expect(get(hasTranslationKey)).toBe(false);
    setEngineCredential('openaiKey', 'o');
    expect(get(hasTranslationKey)).toBe(true);
  });

  it('never leaks a key into the profiles store or its persisted JSON', async () => {
    const { setEngineCredential } = await import('./credentials');
    const { profilesWithTrash, updateSetting } = await import('$lib/settings/settings');
    const { miscSettings } = await import('$lib/settings/misc');
    setEngineCredential('googleKey', 'SECRET-GOOGLE');
    setEngineCredential('anthropicKey', 'SECRET-ANTHROPIC');
    setEngineCredential('openaiKey', 'SECRET-OPENAI');
    updateSetting('boldFont', true); // force a profiles write
    const persisted = localStorage.getItem('profiles') ?? '';
    const inMemory = JSON.stringify(get(profilesWithTrash));
    const misc = JSON.stringify(get(miscSettings)) + (localStorage.getItem('miscSettings') ?? '');
    for (const blob of [persisted, inMemory, misc]) {
      expect(blob).not.toContain('SECRET-GOOGLE');
      expect(blob).not.toContain('SECRET-ANTHROPIC');
      expect(blob).not.toContain('SECRET-OPENAI');
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/engines/credentials.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/lib/engines/credentials.ts
/**
 * API keys for the experimental OCR / translation engines. localStorage ONLY:
 * these never enter `profiles`, `miscSettings` or any synced file — a key in
 * `profiles.json` would ride to every device and every cloud folder.
 */
import { browser } from '$app/environment';
import { derived, writable, type Readable } from 'svelte/store';
import { miscSettings } from '$lib/settings/misc';

export interface EngineCredentials {
  googleKey: string;
  anthropicKey: string;
  openaiBaseUrl: string;
  openaiKey: string;
  openaiModel: string;
}

export const ENGINE_STORAGE_KEYS: Record<keyof EngineCredentials, string> = {
  googleKey: 'engine_google_key',
  anthropicKey: 'engine_anthropic_key',
  openaiBaseUrl: 'engine_openai_base_url',
  openaiKey: 'engine_openai_key',
  openaiModel: 'engine_openai_model'
};

function read(): EngineCredentials {
  const get = (k: keyof EngineCredentials) =>
    (browser ? window.localStorage.getItem(ENGINE_STORAGE_KEYS[k]) : null) ?? '';
  return {
    googleKey: get('googleKey'),
    anthropicKey: get('anthropicKey'),
    openaiBaseUrl: get('openaiBaseUrl'),
    openaiKey: get('openaiKey'),
    openaiModel: get('openaiModel')
  };
}

const store = writable<EngineCredentials>(read());
export const engineCredentials: Readable<EngineCredentials> = { subscribe: store.subscribe };

export function setEngineCredential(key: keyof EngineCredentials, value: string): void {
  const v = value.trim();
  if (browser) {
    if (v) window.localStorage.setItem(ENGINE_STORAGE_KEYS[key], v);
    else window.localStorage.removeItem(ENGINE_STORAGE_KEYS[key]);
  }
  store.update((c) => ({ ...c, [key]: v }));
}

export const hasGoogleKey = derived(engineCredentials, ($c) => $c.googleKey !== '');

/** Whether the engine chosen in `miscSettings.translationEngine` has its key. */
export const hasTranslationKey = derived([engineCredentials, miscSettings], ([$c, $m]) => {
  switch ($m.translationEngine) {
    case 'anthropic':
      return $c.anthropicKey !== '';
    case 'openai':
      return $c.openaiKey !== '';
    default:
      return $c.googleKey !== '';
  }
});
```

In `src/lib/settings/misc.ts` add to `MiscSettings`:

```ts
/** Experimental translation engine preferences (keys live in engines/credentials.ts). */
translationEngine: 'gemini' | 'anthropic' | 'openai';
translationModel: string; // '' = the adapter's default model
translationLanguage: string; // BCP-47-ish, default 'en'
```

and to `defaultSettings`:

```ts
  translationEngine: 'gemini',
  translationModel: '',
  translationLanguage: 'en'
```

- [ ] **Step 4: Run to verify it passes**: `npx vitest run src/lib/engines/credentials.test.ts src/lib/settings` → PASS.
- [ ] **Step 5: Commit** `feat(engines): localStorage-only engine credentials + translation preferences`

---

### Task 2: Run queue

**Files:**

- Create: `src/lib/engines/run-queue.ts`
- Test: `src/lib/engines/run-queue.test.ts`

**Interfaces:**

- Produces: `class RetryableError extends Error { status: number }`; `isRetryableStatus(status: number): boolean` (429 or 500–599); `runQueue<T>(items: T[], worker: (item: T, signal: AbortSignal) => Promise<void>, opts: { concurrency?: number; retries?: number; backoffMs?: number[]; signal: AbortSignal; onProgress?: (done: number, total: number, failed: number) => void; sleep?: (ms: number) => Promise<void> }): Promise<{ done: number; failed: number; errors: { item: T; error: unknown }[]; cancelled: boolean }>`.

- [ ] **Step 1: Failing tests**

```ts
// src/lib/engines/run-queue.test.ts
import { describe, expect, it, vi } from 'vitest';
import { RetryableError, isRetryableStatus, runQueue } from './run-queue';

const noSleep = async () => {};

describe('runQueue', () => {
  it('runs at most `concurrency` workers at once and reports progress', async () => {
    let active = 0;
    let peak = 0;
    const onProgress = vi.fn();
    const r = await runQueue(
      [1, 2, 3, 4, 5],
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((res) => setTimeout(res, 5));
        active--;
      },
      { concurrency: 2, signal: new AbortController().signal, onProgress, sleep: noSleep }
    );
    expect(peak).toBe(2);
    expect(r).toMatchObject({ done: 5, failed: 0, cancelled: false });
    expect(onProgress).toHaveBeenLastCalledWith(5, 5, 0);
  });

  it('retries retryable errors with backoff, then fails the item and continues', async () => {
    const calls: number[] = [];
    const sleeps: number[] = [];
    const r = await runQueue(
      [1, 2],
      async (item) => {
        calls.push(item);
        if (item === 1) throw new RetryableError('rate limited', 429);
      },
      {
        concurrency: 1,
        retries: 2,
        backoffMs: [10, 20],
        signal: new AbortController().signal,
        sleep: async (ms) => {
          sleeps.push(ms);
        }
      }
    );
    expect(calls).toEqual([1, 1, 1, 2]);
    expect(sleeps).toEqual([10, 20]);
    expect(r.done).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.errors[0].item).toBe(1);
  });

  it('does not retry non-retryable errors', async () => {
    const worker = vi.fn(async () => {
      throw new Error('bad key');
    });
    const r = await runQueue([1], worker, { signal: new AbortController().signal, sleep: noSleep });
    expect(worker).toHaveBeenCalledTimes(1);
    expect(r.failed).toBe(1);
  });

  it('stops starting new items once aborted', async () => {
    const ac = new AbortController();
    const started: number[] = [];
    const r = await runQueue(
      [1, 2, 3, 4],
      async (item) => {
        started.push(item);
        if (item === 1) ac.abort();
      },
      { concurrency: 1, signal: ac.signal, sleep: noSleep }
    );
    expect(started).toEqual([1]);
    expect(r.cancelled).toBe(true);
  });

  it('classifies statuses', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement**

```ts
// src/lib/engines/run-queue.ts
/**
 * The one page/volume run loop both engines share: a bounded worker pool with
 * retry-on-transient (429 / 5xx) and cooperative cancel. Pure of any UI —
 * callers report `onProgress` wherever they like.
 */
export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export interface RunQueueOptions {
  concurrency?: number;
  retries?: number;
  backoffMs?: number[];
  signal: AbortSignal;
  onProgress?: (done: number, total: number, failed: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunQueueResult<T> {
  done: number;
  failed: number;
  errors: { item: T; error: unknown }[];
  cancelled: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runQueue<T>(
  items: T[],
  worker: (item: T, signal: AbortSignal) => Promise<void>,
  opts: RunQueueOptions
): Promise<RunQueueResult<T>> {
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? [1000, 2000, 4000];
  const sleep = opts.sleep ?? defaultSleep;
  const result: RunQueueResult<T> = { done: 0, failed: 0, errors: [], cancelled: false };
  let next = 0;

  const report = () => opts.onProgress?.(result.done, items.length, result.failed);

  async function runOne(item: T): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (opts.signal.aborted) return;
      try {
        await worker(item, opts.signal);
        result.done++;
        return;
      } catch (error) {
        const retryable = error instanceof RetryableError && attempt < retries;
        if (!retryable || opts.signal.aborted) {
          result.failed++;
          result.errors.push({ item, error });
          return;
        }
        await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
      }
    }
  }

  async function lane(): Promise<void> {
    while (next < items.length && !opts.signal.aborted) {
      const item = items[next++];
      await runOne(item);
      report();
    }
  }

  report();
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  result.cancelled = opts.signal.aborted && result.done + result.failed < items.length;
  return result;
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(engines): shared run queue with retry, backoff and cancel`

---

### Task 3: Layer upsert for engine results

**Files:**

- Modify: `src/lib/reader/edit/layers.ts`
- Test: `src/lib/reader/edit/layers.test.ts` (append)

**Interfaces:**

- Produces: `upsertLayerPages(volumeUuid: string, layerId: string, opts: { name: string; kind: VolumeOcrLayerKind; engine: string; sourcePages: Page[]; pages: Map<number, Page> }): Promise<VolumeOcrLayer>` — creates the layer on first use (every page = source image facts, `blocks: []`), overwrites only `pages` given, bumps `updated_at`, updates `engine`.

- [ ] **Step 1: Failing test** (append to layers.test.ts)

```ts
describe('upsertLayerPages', () => {
  it('creates the layer with empty pages on first use, then overwrites only the pages given', async () => {
    const { upsertLayerPages } = await import('./layers');
    const ran = pg('OCR結果');
    const layer = await upsertLayerPages('v-up', 'gcv', {
      name: 'Cloud Vision',
      kind: 'ocr',
      engine: 'gcv',
      sourcePages: PAGES,
      pages: new Map([[1, ran]])
    });
    expect(layer.layer_id).toBe('gcv');
    expect(layer.pages[0].blocks).toEqual([]);
    expect(layer.pages[0].img_path).toBe('p.png');
    expect(layer.pages[1].blocks[0].lines).toEqual(['OCR結果']);

    const again = await upsertLayerPages('v-up', 'gcv', {
      name: 'Cloud Vision',
      kind: 'ocr',
      engine: 'gcv',
      sourcePages: PAGES,
      pages: new Map([[0, pg('二回目')]])
    });
    expect(again.pages[0].blocks[0].lines).toEqual(['二回目']);
    expect(again.pages[1].blocks[0].lines).toEqual(['OCR結果']);
    expect(again.updated_at >= layer.updated_at).toBe(true);
  });

  it('refuses the original layer', async () => {
    const { upsertLayerPages } = await import('./layers');
    await expect(
      upsertLayerPages('v-up', 'original', {
        name: 'x',
        kind: 'ocr',
        engine: 'gcv',
        sourcePages: PAGES,
        pages: new Map()
      })
    ).rejects.toThrow(/read-only/);
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (append to layers.ts)

```ts
export interface UpsertLayerPagesOptions {
  name: string;
  kind: VolumeOcrLayerKind;
  engine: string;
  /** The pages whose image facts a NEW layer's untouched pages keep. */
  sourcePages: Page[];
  /** pageIndex → the page to write. */
  pages: Map<number, Page>;
}

/** Engine results: create the layer on first use, overwrite only the pages that ran. */
export async function upsertLayerPages(
  volumeUuid: string,
  layerId: string,
  opts: UpsertLayerPagesOptions
): Promise<VolumeOcrLayer> {
  assertEditable(layerId);
  const now = new Date().toISOString();
  return db.transaction('rw', db.volume_ocr_layers, async () => {
    const existing = await db.volume_ocr_layers.get([volumeUuid, layerId]);
    const base: Page[] = existing
      ? existing.pages.slice()
      : opts.sourcePages.map((p) => ({ ...p, blocks: [] }));
    for (const [i, page] of opts.pages) base[i] = page;
    const layer: VolumeOcrLayer = {
      volume_uuid: volumeUuid,
      layer_id: layerId,
      name: existing?.name ?? opts.name,
      kind: existing?.kind ?? opts.kind,
      engine: opts.engine,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      pages: base
    };
    await db.volume_ocr_layers.put(layer);
    return layer;
  });
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(layers): upsertLayerPages for engine results`

---

### Task 4: Cloud Vision converter

**Files:**

- Create: `src/lib/engines/gcv-convert.ts`, `src/lib/engines/__fixtures__/gcv-vertical.json`, `src/lib/engines/__fixtures__/gcv-horizontal.json`
- Test: `src/lib/engines/gcv-convert.test.ts`

**Interfaces:**

- Produces: `gcvToPage(response: GcvAnnotateResponse, page: Page, scale = 1): Page` — `scale` is image-px per request-px (downscale factor; coordinates are divided by it, i.e. multiplied by `1/scale`… define precisely: `imageCoord = requestCoord / scale` where `scale = requestWidth / imageWidth`). Types `GcvAnnotateResponse`, `GcvBlock`, `GcvSymbol` (minimal shapes).

Fixtures are hand-built in the recorded SHAPE of `fullTextAnnotation` (vertices `{x,y}`, `property.detectedBreak.type`): the vertical fixture has one block with two vertical lines "こんにちは" (5 symbols stacked, 20 px wide, 22 px tall each) and "せかい" (3 symbols) plus a furigana line of 3 symbols 8 px wide beside the first; the horizontal fixture has one block, one paragraph, words "ＣＯＮＴＥＮＴＳ" with an `EOL_SURE_SPACE` break then "２０１７".

- [ ] **Step 1: Failing tests**

```ts
// src/lib/engines/gcv-convert.test.ts
import { describe, expect, it } from 'vitest';
import type { Page } from '$lib/types';
import { gcvToPage, type GcvAnnotateResponse } from './gcv-convert';
import vertical from './__fixtures__/gcv-vertical.json';
import horizontal from './__fixtures__/gcv-horizontal.json';

const page = (w = 400, h = 600): Page => ({
  version: '0.2.1',
  img_width: w,
  img_height: h,
  img_path: '001.png',
  blocks: [{ box: [0, 0, 1, 1], vertical: true, font_size: 1, lines: ['old'] }]
});

describe('gcvToPage', () => {
  it('vertical bubble: two lines, vertical, font from symbol width, furigana dropped, quads per line', () => {
    const out = gcvToPage(vertical as GcvAnnotateResponse, page());
    expect(out.blocks).toHaveLength(1);
    const b = out.blocks[0];
    expect(b.vertical).toBe(true);
    expect(b.lines).toEqual(['こんにちは', 'せかい']);
    expect(b.font_size).toBe(20);
    expect(b.lines_coords).toHaveLength(2);
    expect(b.lines_coords![0]).toEqual([
      [300, 40],
      [320, 40],
      [320, 150],
      [300, 150]
    ]);
    expect(b.box).toEqual([260, 40, 320, 150]);
    // image facts kept, old blocks replaced
    expect(out.img_path).toBe('001.png');
  });

  it('horizontal block: lines split on EOL_SURE_SPACE/LINE_BREAK, spaces on SPACE breaks', () => {
    const out = gcvToPage(horizontal as GcvAnnotateResponse, page());
    const b = out.blocks[0];
    expect(b.vertical).toBe(false);
    expect(b.lines).toEqual(['ＣＯＮＴＥＮＴＳ', '２０１７ ８']);
    expect(b.font_size).toBe(30);
  });

  it('rescales coordinates when the request image was downscaled', () => {
    const out = gcvToPage(vertical as GcvAnnotateResponse, page(800, 1200), 0.5);
    expect(out.blocks[0].box).toEqual([520, 80, 640, 300]);
    expect(out.blocks[0].font_size).toBe(40);
  });

  it('an empty response yields a page with no blocks', () => {
    expect(gcvToPage({ responses: [{}] }, page()).blocks).toEqual([]);
  });
});
```

Fixture `gcv-vertical.json` (symbols listed top→bottom; line 1 at x 300–320, y 40–150; furigana at x 290–298; line 2 at x 260–280, y 40–106):

```json
{
  "responses": [
    {
      "fullTextAnnotation": {
        "pages": [
          {
            "blocks": [
              {
                "boundingBox": {
                  "vertices": [
                    { "x": 260, "y": 40 },
                    { "x": 320, "y": 40 },
                    { "x": 320, "y": 150 },
                    { "x": 260, "y": 150 }
                  ]
                },
                "paragraphs": [
                  {
                    "words": [
                      {
                        "symbols": [
                          {
                            "text": "こ",
                            "boundingBox": {
                              "vertices": [
                                { "x": 300, "y": 40 },
                                { "x": 320, "y": 40 },
                                { "x": 320, "y": 62 },
                                { "x": 300, "y": 62 }
                              ]
                            }
                          },
                          {
                            "text": "ん",
                            "boundingBox": {
                              "vertices": [
                                { "x": 300, "y": 62 },
                                { "x": 320, "y": 62 },
                                { "x": 320, "y": 84 },
                                { "x": 300, "y": 84 }
                              ]
                            }
                          },
                          {
                            "text": "に",
                            "boundingBox": {
                              "vertices": [
                                { "x": 300, "y": 84 },
                                { "x": 320, "y": 84 },
                                { "x": 320, "y": 106 },
                                { "x": 300, "y": 106 }
                              ]
                            }
                          },
                          {
                            "text": "ち",
                            "boundingBox": {
                              "vertices": [
                                { "x": 300, "y": 106 },
                                { "x": 320, "y": 106 },
                                { "x": 320, "y": 128 },
                                { "x": 300, "y": 128 }
                              ]
                            }
                          },
                          {
                            "text": "は",
                            "boundingBox": {
                              "vertices": [
                                { "x": 300, "y": 128 },
                                { "x": 320, "y": 128 },
                                { "x": 320, "y": 150 },
                                { "x": 300, "y": 150 }
                              ]
                            },
                            "property": { "detectedBreak": { "type": "LINE_BREAK" } }
                          }
                        ]
                      },
                      {
                        "symbols": [
                          {
                            "text": "ふ",
                            "boundingBox": {
                              "vertices": [
                                { "x": 290, "y": 40 },
                                { "x": 298, "y": 40 },
                                { "x": 298, "y": 50 },
                                { "x": 290, "y": 50 }
                              ]
                            }
                          },
                          {
                            "text": "り",
                            "boundingBox": {
                              "vertices": [
                                { "x": 290, "y": 50 },
                                { "x": 298, "y": 50 },
                                { "x": 298, "y": 60 },
                                { "x": 290, "y": 60 }
                              ]
                            }
                          },
                          {
                            "text": "が",
                            "boundingBox": {
                              "vertices": [
                                { "x": 290, "y": 60 },
                                { "x": 298, "y": 60 },
                                { "x": 298, "y": 70 },
                                { "x": 290, "y": 70 }
                              ]
                            },
                            "property": { "detectedBreak": { "type": "LINE_BREAK" } }
                          }
                        ]
                      },
                      {
                        "symbols": [
                          {
                            "text": "せ",
                            "boundingBox": {
                              "vertices": [
                                { "x": 260, "y": 40 },
                                { "x": 280, "y": 40 },
                                { "x": 280, "y": 62 },
                                { "x": 260, "y": 62 }
                              ]
                            }
                          },
                          {
                            "text": "か",
                            "boundingBox": {
                              "vertices": [
                                { "x": 260, "y": 62 },
                                { "x": 280, "y": 62 },
                                { "x": 280, "y": 84 },
                                { "x": 260, "y": 84 }
                              ]
                            }
                          },
                          {
                            "text": "い",
                            "boundingBox": {
                              "vertices": [
                                { "x": 260, "y": 84 },
                                { "x": 280, "y": 84 },
                                { "x": 280, "y": 106 },
                                { "x": 260, "y": 106 }
                              ]
                            },
                            "property": { "detectedBreak": { "type": "EOL_SURE_SPACE" } }
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    }
  ]
}
```

Fixture `gcv-horizontal.json`: one block box [100,100,340,170]; paragraph 1 words: "ＣＯＮＴＥＮＴＳ" as 8 symbols each 30×30 from x 100 stepping 30 at y 100–130, last symbol break `EOL_SURE_SPACE`; then "２０１７" 4 symbols at y 140–170 x from 100, last break `SPACE`; then "８" one symbol at x 250–280 y 140–170 with break `LINE_BREAK`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**

```ts
// src/lib/engines/gcv-convert.ts
/**
 * Google Cloud Vision `DOCUMENT_TEXT_DETECTION` → a mokuro page. Vision gives
 * blocks → paragraphs → words → symbols with boxes and break hints; mokuro
 * wants blocks with `lines`, a writing direction, one font size, and a quad
 * per line. Furigana comes back as its own tiny lines beside the big ones —
 * mokuro drops them, so we do too.
 */
import type { Block, Page } from '$lib/types';

export interface GcvVertex {
  x?: number;
  y?: number;
}
export interface GcvSymbol {
  text?: string;
  boundingBox?: { vertices?: GcvVertex[] };
  property?: { detectedBreak?: { type?: string; isPrefix?: boolean } };
}
export interface GcvWord {
  symbols?: GcvSymbol[];
}
export interface GcvParagraph {
  words?: GcvWord[];
}
export interface GcvBlock {
  boundingBox?: { vertices?: GcvVertex[] };
  paragraphs?: GcvParagraph[];
}
export interface GcvAnnotateResponse {
  responses?: {
    fullTextAnnotation?: { pages?: { blocks?: GcvBlock[] }[] };
    error?: { code?: number; message?: string };
  }[];
}

type Box = [number, number, number, number];

const FURIGANA_RATIO = 0.55;
const LINE_BREAKS = new Set(['LINE_BREAK', 'EOL_SURE_SPACE']);
const SPACE_BREAKS = new Set(['SPACE', 'SURE_SPACE']);

function bounds(vertices: GcvVertex[] | undefined): Box | null {
  if (!vertices || vertices.length === 0) return null;
  const xs = vertices.map((v) => v.x ?? 0);
  const ys = vertices.map((v) => v.y ?? 0);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function union(boxes: Box[]): Box {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3]))
  ];
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface SymbolGeom {
  text: string;
  box: Box;
}
interface LineGeom {
  text: string;
  symbols: SymbolGeom[];
  box: Box;
  vertical: boolean;
}

/** Symbols advance mostly in y with a vertical line; box aspect decides for 1 symbol. */
function lineIsVertical(symbols: SymbolGeom[], box: Box): boolean {
  if (symbols.length >= 2) {
    const first = symbols[0].box;
    const last = symbols[symbols.length - 1].box;
    const dx = Math.abs((last[0] + last[2]) / 2 - (first[0] + first[2]) / 2);
    const dy = Math.abs((last[1] + last[3]) / 2 - (first[1] + first[3]) / 2);
    return dy > dx;
  }
  return box[3] - box[1] > box[2] - box[0];
}

function collectLines(block: GcvBlock): LineGeom[] {
  const lines: LineGeom[] = [];
  let text = '';
  let symbols: SymbolGeom[] = [];
  const flush = () => {
    const clean = text.trim();
    if (clean && symbols.length) {
      const box = union(symbols.map((s) => s.box));
      lines.push({ text: clean, symbols, box, vertical: lineIsVertical(symbols, box) });
    }
    text = '';
    symbols = [];
  };
  for (const paragraph of block.paragraphs ?? []) {
    for (const word of paragraph.words ?? []) {
      for (const symbol of word.symbols ?? []) {
        const box = bounds(symbol.boundingBox?.vertices);
        if (!box) continue;
        text += symbol.text ?? '';
        symbols.push({ text: symbol.text ?? '', box });
        const brk = symbol.property?.detectedBreak?.type;
        if (brk && LINE_BREAKS.has(brk)) flush();
        else if (brk && SPACE_BREAKS.has(brk)) text += ' ';
      }
    }
    flush();
  }
  flush();
  return lines;
}

function symbolExtent(s: SymbolGeom, vertical: boolean): number {
  return vertical ? s.box[2] - s.box[0] : s.box[3] - s.box[1];
}

function convertBlock(block: GcvBlock): Block | null {
  const lines = collectLines(block);
  if (lines.length === 0) return null;
  const symbolCount = (v: boolean) =>
    lines.filter((l) => l.vertical === v).reduce((n, l) => n + l.symbols.length, 0);
  const vertical = symbolCount(true) >= symbolCount(false);

  const extents = lines.map((l) => median(l.symbols.map((s) => symbolExtent(s, l.vertical))));
  const blockMedian = median(extents);
  const kept = lines.filter(
    (_, i) => lines.length < 2 || extents[i] >= FURIGANA_RATIO * blockMedian
  );
  if (kept.length === 0) return null;

  const fontSize = Math.round(
    median(kept.flatMap((l) => l.symbols.map((s) => symbolExtent(s, l.vertical))))
  );
  const box = bounds(block.boundingBox?.vertices) ?? union(kept.map((l) => l.box));
  return {
    box: [box[0], box[1], box[2], box[3]],
    vertical,
    font_size: Math.max(1, fontSize),
    lines: kept.map((l) => l.text),
    lines_coords: kept.map((l) => [
      [l.box[0], l.box[1]],
      [l.box[2], l.box[1]],
      [l.box[2], l.box[3]],
      [l.box[0], l.box[3]]
    ])
  };
}

function scaleBlock(block: Block, factor: number): Block {
  if (factor === 1) return block;
  const r = (n: number) => Math.round(n * factor);
  return {
    ...block,
    box: block.box.map(r),
    font_size: Math.max(1, r(block.font_size)),
    lines_coords: block.lines_coords?.map((q) => q.map(([x, y]) => [r(x), r(y)]))
  };
}

/**
 * @param scale request-px per image-px (1 when the image was sent as-is;
 *   0.5 when it was halved before upload). Output is in image px.
 */
export function gcvToPage(response: GcvAnnotateResponse, page: Page, scale = 1): Page {
  const blocks: Block[] = [];
  const factor = 1 / scale;
  for (const gcvPage of response.responses?.[0]?.fullTextAnnotation?.pages ?? []) {
    for (const gcvBlock of gcvPage.blocks ?? []) {
      const block = convertBlock(gcvBlock);
      if (block) blocks.push(scaleBlock(block, factor));
    }
  }
  return {
    version: page.version,
    img_width: page.img_width,
    img_height: page.img_height,
    img_path: page.img_path,
    blocks
  };
}
```

Note for the horizontal fixture expectation `'２０１７ ８'`: the `SPACE` break after "７" appends a space, the next symbol "８" joins the same line, its `LINE_BREAK` flushes. The vertical test's `box` expectation `[260,40,320,150]` is the block poly.

- [ ] **Step 4: Run** → PASS (adjust fixture numbers only if a computed median differs from the stated ones; the vertical line symbols are 20 wide → font 20; the horizontal symbols 30 tall → 30). **Step 5: Commit** `feat(engines): Cloud Vision response → mokuro page converter`

---

### Task 5: Cloud Vision client (image prep + request)

**Files:**

- Create: `src/lib/engines/gcv.ts`
- Test: `src/lib/engines/gcv.test.ts`

**Interfaces:**

- Produces: `prepareImage(file: Blob, maxPixels = 4_000_000): Promise<{ base64: string; scale: number }>` (canvas downscale; in jsdom the canvas path is unavailable, so the function takes an injectable `decode?: (file: Blob) => Promise<{ width: number; height: number; draw: (w: number, h: number) => Promise<Blob> }>`); `annotateImage(base64: string, key: string, opts: { fetch?: typeof fetch; signal?: AbortSignal }): Promise<GcvAnnotateResponse>` — throws `RetryableError` on 429/5xx, `Error(message)` on other non-OK (message from the JSON error if any); `VISION_ENDPOINT`; `testGoogleVision(key, fetchImpl?)`: annotates a 1×1 PNG and resolves `{ ok: true } | { ok: false; error: string }`.

- [ ] **Step 1: Failing tests**

```ts
// src/lib/engines/gcv.test.ts
import { describe, expect, it, vi } from 'vitest';
import { RetryableError } from './run-queue';
import { annotateImage, prepareImage, testGoogleVision, VISION_ENDPOINT } from './gcv';

function fetchOk(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('annotateImage', () => {
  it('posts DOCUMENT_TEXT_DETECTION with ja hints to the keyed endpoint', async () => {
    const f = fetchOk({ responses: [{}] });
    await annotateImage('AAAA', 'k-1', { fetch: f as unknown as typeof fetch });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${VISION_ENDPOINT}?key=k-1`);
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].image.content).toBe('AAAA');
    expect(body.requests[0].features).toEqual([{ type: 'DOCUMENT_TEXT_DETECTION' }]);
    expect(body.requests[0].imageContext.languageHints).toEqual(['ja']);
  });

  it('maps 429/5xx to RetryableError and other failures to Error with the API message', async () => {
    await expect(
      annotateImage('A', 'k', { fetch: fetchOk({}, 429) as unknown as typeof fetch })
    ).rejects.toBeInstanceOf(RetryableError);
    await expect(
      annotateImage('A', 'k', {
        fetch: fetchOk({ error: { message: 'API key not valid' } }, 400) as unknown as typeof fetch
      })
    ).rejects.toThrow('API key not valid');
    // a per-response error inside a 200 is an error too
    await expect(
      annotateImage('A', 'k', {
        fetch: fetchOk({
          responses: [{ error: { message: 'bad image' } }]
        }) as unknown as typeof fetch
      })
    ).rejects.toThrow('bad image');
  });
});

describe('prepareImage', () => {
  it('sends the image as-is under 4 MP and halves a 16 MP one (scale 0.5)', async () => {
    const draw = vi.fn(async () => new Blob(['x']));
    const decode = vi.fn(async () => ({ width: 4000, height: 4000, draw }));
    const r = await prepareImage(new Blob(['png']), 4_000_000, decode);
    expect(r.scale).toBe(0.5);
    expect(draw).toHaveBeenCalledWith(2000, 2000);

    const small = vi.fn(async () => ({ width: 1000, height: 1000, draw }));
    const r2 = await prepareImage(new Blob(['png']), 4_000_000, small);
    expect(r2.scale).toBe(1);
    expect(typeof r2.base64).toBe('string');
  });
});

describe('testGoogleVision', () => {
  it('reports ok / the error message', async () => {
    expect(
      await testGoogleVision('k', fetchOk({ responses: [{}] }) as unknown as typeof fetch)
    ).toEqual({ ok: true });
    expect(
      await testGoogleVision(
        'k',
        fetchOk({ error: { message: 'nope' } }, 403) as unknown as typeof fetch
      )
    ).toEqual({ ok: false, error: 'nope' });
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**

```ts
// src/lib/engines/gcv.ts
import { RetryableError, isRetryableStatus } from './run-queue';
import type { GcvAnnotateResponse } from './gcv-convert';

export const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';
export const VISION_MAX_PIXELS = 4_000_000;

/** 1×1 transparent PNG — the cheapest possible "is this key good" probe. */
const PROBE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export interface DecodedImage {
  width: number;
  height: number;
  draw: (width: number, height: number) => Promise<Blob>;
}

async function decodeWithCanvas(file: Blob): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(file);
  return {
    width: bitmap.width,
    height: bitmap.height,
    draw: async (width, height) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
      return new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))),
          'image/jpeg',
          0.92
        )
      );
    }
  };
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Base64 of the image, downscaled to at most `maxPixels`; `scale` = sent/original. */
export async function prepareImage(
  file: Blob,
  maxPixels = VISION_MAX_PIXELS,
  decode: (file: Blob) => Promise<DecodedImage> = decodeWithCanvas
): Promise<{ base64: string; scale: number }> {
  const img = await decode(file);
  const pixels = img.width * img.height;
  if (pixels <= maxPixels) return { base64: await toBase64(file), scale: 1 };
  const scale = Math.sqrt(maxPixels / pixels);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const blob = await img.draw(w, h);
  return { base64: await toBase64(blob), scale: w / img.width };
}

export async function annotateImage(
  base64: string,
  key: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}
): Promise<GcvAnnotateResponse> {
  const f = opts.fetch ?? fetch;
  const res = await f(`${VISION_ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      requests: [
        {
          image: { content: base64 },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          imageContext: { languageHints: ['ja'] }
        }
      ]
    })
  });
  const json = (await res.json().catch(() => ({}))) as GcvAnnotateResponse & {
    error?: { message?: string };
  };
  if (!res.ok) {
    const message = json.error?.message ?? `Cloud Vision request failed (${res.status})`;
    if (isRetryableStatus(res.status)) throw new RetryableError(message, res.status);
    throw new Error(message);
  }
  const inner = json.responses?.[0]?.error;
  if (inner?.message) throw new Error(inner.message);
  return json;
}

export async function testGoogleVision(
  key: string,
  fetchImpl?: typeof fetch
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await annotateImage(PROBE_PNG, key, { fetch: fetchImpl });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(engines): Cloud Vision client with image downscale and key probe`

---

### Task 6: Translation prompt, parser, reading order, wrapping

**Files:**

- Create: `src/lib/engines/translate/types.ts`, `src/lib/engines/translate/prompt.ts`, `src/lib/engines/translate/wrap.ts`
- Test: `src/lib/engines/translate/prompt.test.ts`, `src/lib/engines/translate/wrap.test.ts`

**Interfaces:**

```ts
// types.ts
export interface TranslationBlockInput {
  index: number;
  text: string;
}
export interface TranslationInput {
  seriesTitle: string;
  volumeTitle: string;
  target: string;
  blocks: TranslationBlockInput[];
}
export interface TranslationAdapter {
  id: 'gemini' | 'anthropic' | 'openai';
  model: string;
  translatePage(
    input: TranslationInput,
    signal?: AbortSignal
  ): Promise<{ index: number; text: string }[]>;
}
```

- `prompt.ts`: `readingOrder(blocks: { box: number[] }[], rtl: boolean): number[]`; `buildSystemPrompt(target: string): string`; `buildUserPrompt(input: TranslationInput): string`; `parseTranslation(raw: string, expectedIndices: number[]): { index: number; text: string }[]` (throws `MalformedTranslationError` on bad JSON / missing index / non-string text; tolerates a fenced ```json block and an object `{ "translations": [...] }` wrapper).
- `wrap.ts`: `wrapTranslatedBlock(block: Block, text: string): Block` (keeps `box`, `vertical:false`, drops `lines_coords`, `lines` wrapped, `font_size` shrunk per the Global Constraints rule).

- [ ] **Step 1: Failing tests**

````ts
// prompt.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildUserPrompt,
  MalformedTranslationError,
  parseTranslation,
  readingOrder
} from './prompt';

describe('readingOrder', () => {
  const blocks = [
    { box: [10, 10, 50, 50] }, // left top
    { box: [200, 10, 240, 50] }, // right top
    { box: [200, 100, 240, 140] } // right lower
  ];
  it('RTL: right column first (xmax desc), then top to bottom', () => {
    expect(readingOrder(blocks, true)).toEqual([1, 2, 0]);
  });
  it('LTR: top to bottom, then left to right', () => {
    expect(readingOrder(blocks, false)).toEqual([0, 1, 2]);
  });
});

describe('parseTranslation', () => {
  it('accepts a bare array, a fenced block, and a {translations} wrapper', () => {
    const want = [
      { index: 0, text: 'Hi' },
      { index: 2, text: 'Bye' }
    ];
    expect(parseTranslation(JSON.stringify(want), [0, 2])).toEqual(want);
    expect(parseTranslation('```json\n' + JSON.stringify(want) + '\n```', [0, 2])).toEqual(want);
    expect(parseTranslation(JSON.stringify({ translations: want }), [0, 2])).toEqual(want);
  });
  it('throws MalformedTranslationError on bad JSON, a missing index, or a non-string', () => {
    expect(() => parseTranslation('not json', [0])).toThrow(MalformedTranslationError);
    expect(() => parseTranslation('[{"index":1,"text":"x"}]', [0])).toThrow(
      MalformedTranslationError
    );
    expect(() => parseTranslation('[{"index":0,"text":5}]', [0])).toThrow(
      MalformedTranslationError
    );
  });
});

describe('buildUserPrompt', () => {
  it('names the series and volume and lists blocks by index', () => {
    const p = buildUserPrompt({
      seriesTitle: 'Chainsaw Man',
      volumeTitle: 'Vol 2',
      target: 'en',
      blocks: [{ index: 3, text: 'こんにちは' }]
    });
    expect(p).toContain('Chainsaw Man');
    expect(p).toContain('Vol 2');
    expect(p).toContain('"index": 3');
    expect(p).toContain('こんにちは');
  });
});
````

```ts
// wrap.test.ts
import { describe, expect, it } from 'vitest';
import { wrapTranslatedBlock } from './wrap';

describe('wrapTranslatedBlock', () => {
  const block = {
    box: [0, 0, 110, 200],
    vertical: true,
    font_size: 20,
    lines: ['あ'],
    lines_coords: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1]
      ]
    ]
  };
  it('keeps the box, goes horizontal, drops quads, wraps at floor(width / (fs*0.55)) chars', () => {
    // 110 / (20*0.55) = 10 chars per line
    const out = wrapTranslatedBlock(block, 'hello brave new world');
    expect(out.box).toEqual([0, 0, 110, 200]);
    expect(out.vertical).toBe(false);
    expect(out.lines_coords).toBeUndefined();
    expect(out.font_size).toBe(20);
    expect(out.lines).toEqual(['hello', 'brave new', 'world']);
  });
  it('shrinks the font until the lines fit the height, stopping where 3 lines fit', () => {
    // box 100×48: at fs 20 → 9 chars/line, 4 lines × 24 = 96 > 48 → shrink
    const out = wrapTranslatedBlock(
      { ...block, box: [0, 0, 100, 48] },
      'one two three four five six'
    );
    expect(out.font_size).toBeLessThan(20);
    expect(out.font_size).toBeGreaterThanOrEqual(Math.floor(48 / 3 / 1.2));
  });
  it('a word longer than the line is hard-split', () => {
    const out = wrapTranslatedBlock({ ...block, box: [0, 0, 55, 200] }, 'abcdefghij');
    expect(out.lines).toEqual(['abcde', 'fghij']);
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**

````ts
// prompt.ts
import type { TranslationInput } from './types';

export class MalformedTranslationError extends Error {
  name = 'MalformedTranslationError';
}

export function readingOrder(blocks: { box: number[] }[], rtl: boolean): number[] {
  const idx = blocks.map((_, i) => i);
  if (rtl)
    return idx.sort(
      (a, b) => blocks[b].box[2] - blocks[a].box[2] || blocks[a].box[1] - blocks[b].box[1]
    );
  return idx.sort(
    (a, b) => blocks[a].box[1] - blocks[b].box[1] || blocks[a].box[0] - blocks[b].box[0]
  );
}

export function buildSystemPrompt(target: string): string {
  return [
    `You translate Japanese manga dialogue into ${target}.`,
    'Keep honorifics and names, match the register and tone of each speaker, keep sound effects short.',
    'Blocks are given in reading order with an index; translate each block on its own but use the others as context.',
    'Reply with JSON only: an array of {"index": number, "text": string}, one entry per input index, nothing else.'
  ].join(' ');
}

export function buildUserPrompt(input: TranslationInput): string {
  return [
    `Series: ${input.seriesTitle}`,
    `Volume: ${input.volumeTitle}`,
    `Target language: ${input.target}`,
    'Blocks:',
    JSON.stringify(input.blocks, null, 2)
  ].join('\n');
}

export function parseTranslation(
  raw: string,
  expectedIndices: number[]
): { index: number; text: string }[] {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MalformedTranslationError('translation reply was not JSON');
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'translations' in parsed) {
    parsed = (parsed as { translations: unknown }).translations;
  }
  if (!Array.isArray(parsed))
    throw new MalformedTranslationError('translation reply was not an array');
  const byIndex = new Map<number, string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const { index, text: t } = entry as { index?: unknown; text?: unknown };
    if (typeof index !== 'number' || typeof t !== 'string') {
      throw new MalformedTranslationError('translation entry malformed');
    }
    byIndex.set(index, t);
  }
  return expectedIndices.map((index) => {
    const t = byIndex.get(index);
    if (t === undefined)
      throw new MalformedTranslationError(`missing translation for block ${index}`);
    return { index, text: t };
  });
}
````

```ts
// wrap.ts
import type { Block } from '$lib/types';

const CHAR_WIDTH_EM = 0.55;
const LINE_HEIGHT_EM = 1.2;

export function wrapText(text: string, charsPerLine: number): string[] {
  const max = Math.max(1, charsPerLine);
  const lines: string[] = [];
  let line = '';
  for (const rawWord of text.split(/\s+/).filter(Boolean)) {
    let word = rawWord;
    while (word.length > max) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= max) line += ' ' + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** Translated text into the source block's box: horizontal, no quads, wrapped, shrunk to fit. */
export function wrapTranslatedBlock(block: Block, text: string): Block {
  const [x0, y0, x1, y1] = block.box;
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  let fontSize = Math.max(1, block.font_size);
  const floor = Math.max(1, Math.floor(height / 3 / LINE_HEIGHT_EM));
  let lines = wrapText(text, Math.floor(width / (fontSize * CHAR_WIDTH_EM)));
  while (lines.length * fontSize * LINE_HEIGHT_EM > height && fontSize > floor) {
    fontSize = Math.max(floor, Math.floor(fontSize * 0.9));
    lines = wrapText(text, Math.floor(width / (fontSize * CHAR_WIDTH_EM)));
  }
  const { lines_coords: _dropped, ...rest } = block;
  void _dropped;
  return { ...rest, box: [...block.box], vertical: false, font_size: fontSize, lines };
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(engines): translation prompt, parser, reading order and block wrapping`

---

### Task 7: Translation adapters

**Files:**

- Create: `src/lib/engines/translate/gemini.ts`, `anthropic.ts`, `openai.ts`, `index.ts`
- Test: `src/lib/engines/translate/adapters.test.ts`

**Interfaces:**

- Each adapter file exports `createXAdapter(opts: { key: string; model?: string; baseUrl?: string; fetch?: typeof fetch }): TranslationAdapter` and `testX(...)` → `{ ok: true } | { ok: false; error }`. Defaults: `GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash'`, `ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5'`, `OPENAI_DEFAULT_MODEL = 'gpt-4.1-mini'`.
- `index.ts`: `getTranslationAdapter(creds: EngineCredentials, prefs: { translationEngine; translationModel }): TranslationAdapter | null` (null when the key is missing); `translateBlocks(adapter, input, signal)` = call + `parseTranslation`, retrying ONCE on `MalformedTranslationError`.
- All adapters throw `RetryableError` on 429/5xx, `Error` with the provider message otherwise.

- [ ] **Step 1: Failing tests** (one describe per adapter asserting URL, headers, body shape, extraction of the reply text; plus `translateBlocks` retry-once on malformed then throw)

```ts
// adapters.test.ts (excerpt — write all three)
import { describe, expect, it, vi } from 'vitest';
import { createGeminiAdapter } from './gemini';
import { createAnthropicAdapter } from './anthropic';
import { createOpenAIAdapter } from './openai';
import { translateBlocks } from './index';
import { MalformedTranslationError } from './prompt';
import { RetryableError } from '../run-queue';

const input = {
  seriesTitle: 'S',
  volumeTitle: 'V',
  target: 'en',
  blocks: [{ index: 0, text: 'こんにちは' }]
};
const reply = JSON.stringify([{ index: 0, text: 'Hello' }]);
const okFetch = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('gemini adapter', () => {
  it('posts to generateContent with the key, JSON mode, and returns the raw text', async () => {
    const f = okFetch({ candidates: [{ content: { parts: [{ text: reply }] } }] });
    const a = createGeminiAdapter({ key: 'g', fetch: f as unknown as typeof fetch });
    expect(a.model).toBe('gemini-2.5-flash');
    const out = await a.translatePage(input);
    expect(out).toEqual([{ index: 0, text: 'Hello' }]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=g'
    );
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.systemInstruction.parts[0].text).toContain('en');
    expect(body.contents[0].parts[0].text).toContain('こんにちは');
  });
  it('429 → RetryableError', async () => {
    const a = createGeminiAdapter({ key: 'g', fetch: okFetch({}, 429) as unknown as typeof fetch });
    await expect(a.translatePage(input)).rejects.toBeInstanceOf(RetryableError);
  });
});

describe('anthropic adapter', () => {
  it('posts to /v1/messages with the browser header and extracts content[0].text', async () => {
    const f = okFetch({ content: [{ type: 'text', text: reply }] });
    const a = createAnthropicAdapter({ key: 'a', fetch: f as unknown as typeof fetch });
    expect(a.model).toBe('claude-haiku-4-5');
    await a.translatePage(input);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const h = init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('a');
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(h['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.messages[0].role).toBe('user');
  });
});

describe('openai adapter', () => {
  it('posts chat completions to the configured base URL with a bearer token', async () => {
    const f = okFetch({ choices: [{ message: { content: reply } }] });
    const a = createOpenAIAdapter({
      key: 'o',
      baseUrl: 'https://api.deepseek.com/v1/',
      model: 'deepseek-chat',
      fetch: f as unknown as typeof fetch
    });
    await a.translatePage(input);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer o');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('deepseek-chat');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('translateBlocks', () => {
  it('retries once on a malformed reply, then throws', async () => {
    const calls: string[] = ['garbage', reply];
    const adapter = {
      id: 'gemini' as const,
      model: 'm',
      translatePage: vi.fn(async () => {
        throw new Error('unused');
      }),
      raw: vi.fn(async () => calls.shift()!)
    };
    // adapters expose `raw(input, signal)` (the un-parsed reply) so the shared retry lives in one place
    const out = await translateBlocks(adapter as never, input);
    expect(out).toEqual([{ index: 0, text: 'Hello' }]);
    expect(adapter.raw).toHaveBeenCalledTimes(2);
    const bad = { ...adapter, raw: vi.fn(async () => 'nope') };
    await expect(translateBlocks(bad as never, input)).rejects.toBeInstanceOf(
      MalformedTranslationError
    );
  });
});
```

Design note the tests encode: the `TranslationAdapter` gains `raw(input, signal): Promise<string>` (the provider's reply text) and `translatePage` = `parseTranslation(await raw(...))`; `translateBlocks` calls `raw` twice at most. Put `raw` in the interface in `types.ts`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the three adapters with a shared helper in `index.ts`:

```ts
// index.ts
import type { EngineCredentials } from '../credentials';
import { RetryableError, isRetryableStatus } from '../run-queue';
import { MalformedTranslationError, parseTranslation } from './prompt';
import type { TranslationAdapter, TranslationInput } from './types';
import { createGeminiAdapter } from './gemini';
import { createAnthropicAdapter } from './anthropic';
import { createOpenAIAdapter } from './openai';

/** Shared POST-JSON with the provider's error message and 429/5xx → RetryableError. */
export async function postJson(
  f: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal
): Promise<unknown> {
  const res = await f(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
  if (!res.ok) {
    const e = json.error;
    const message = (typeof e === 'string' ? e : e?.message) ?? `request failed (${res.status})`;
    if (isRetryableStatus(res.status)) throw new RetryableError(message, res.status);
    throw new Error(message);
  }
  return json;
}

export function getTranslationAdapter(
  creds: EngineCredentials,
  prefs: { translationEngine: 'gemini' | 'anthropic' | 'openai'; translationModel: string },
  fetchImpl?: typeof fetch
): TranslationAdapter | null {
  const model = prefs.translationModel || undefined;
  switch (prefs.translationEngine) {
    case 'anthropic':
      return creds.anthropicKey
        ? createAnthropicAdapter({ key: creds.anthropicKey, model, fetch: fetchImpl })
        : null;
    case 'openai':
      return creds.openaiKey
        ? createOpenAIAdapter({
            key: creds.openaiKey,
            baseUrl: creds.openaiBaseUrl || undefined,
            model: model ?? (creds.openaiModel || undefined),
            fetch: fetchImpl
          })
        : null;
    default:
      return creds.googleKey
        ? createGeminiAdapter({ key: creds.googleKey, model, fetch: fetchImpl })
        : null;
  }
}

/** One page through an adapter; a malformed reply is retried exactly once. */
export async function translateBlocks(
  adapter: TranslationAdapter,
  input: TranslationInput,
  signal?: AbortSignal
): Promise<{ index: number; text: string }[]> {
  const expected = input.blocks.map((b) => b.index);
  for (let attempt = 0; ; attempt++) {
    const raw = await adapter.raw(input, signal);
    try {
      return parseTranslation(raw, expected);
    } catch (error) {
      if (!(error instanceof MalformedTranslationError) || attempt >= 1) throw error;
    }
  }
}
```

Gemini adapter body: `{ systemInstruction: { parts: [{ text: buildSystemPrompt(target) }] }, contents: [{ role: 'user', parts: [{ text: buildUserPrompt(input) }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }`; reply text = `candidates[0].content.parts.map(p => p.text).join('')`. `testGemini(key, model, fetch)` = same call with a one-block input "こんにちは".

Anthropic body: `{ model, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] }`; reply = `content.filter(c => c.type === 'text').map(c => c.text).join('')`. Headers: `x-api-key`, `anthropic-version: '2023-06-01'`, `anthropic-dangerous-direct-browser-access: 'true'`. `testAnthropic` uses `max_tokens: 8`.

OpenAI body: `{ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0.2 }`; reply = `choices[0].message.content`; URL = `baseUrl.replace(/\/+$/, '') + '/chat/completions'`, default base `https://api.openai.com/v1`. `testOpenAI` = `GET {base}/models` with the bearer.

Note: with `json_object` mode OpenAI requires the prompt to mention JSON (it does) and returns an object; the parser accepts `{ translations: [...] }` — instruct in the system prompt for OpenAI: append `Wrap the array as {"translations": [...]}`.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(engines): Gemini, Anthropic and OpenAI-compatible translation adapters`

---

### Task 8: Engine run orchestrator

**Files:**

- Create: `src/lib/engines/engine-runs.ts`
- Test: `src/lib/engines/engine-runs.test.ts`

**Interfaces:**

```ts
export type EngineKind = 'ocr' | 'translate';
export interface EngineRunContext {
  volumeUuid: string;
  volumeTitle: string;
  seriesTitle: string;
  rtl: boolean;
  /** The displayed page set (source for translation; image facts for OCR). */
  sourcePages: Page[];
  getImage: (pageIndex: number) => Promise<Blob | null>;
  pageIndices: number[]; // one page or all
  deps?: Partial<EngineRunDeps>; // fetch, decode, credentials, prefs, confirm, notify, tracker
}
export interface EngineRunResult {
  layerId: string;
  done: number;
  failed: number;
  cancelled: boolean;
}
export function startEngineRun(
  kind: EngineKind,
  ctx: EngineRunContext
): Promise<EngineRunResult | null>;
export const activeEngineRun: Readable<{
  kind: EngineKind;
  volumeUuid: string;
  done: number;
  total: number;
  cancel: () => void;
} | null>;
export const OCR_LAYER_ID = 'gcv';
export function translationLayerId(lang: string): string; // `tr-${slug}`
```

Behaviour: returns null when the key is missing (notify), when a run is already active (notify), or when the whole-volume confirm is declined. Whole-volume (`pageIndices.length > 1`) confirms with the count + cost note. Per page: OCR = `getImage` → `prepareImage` → `annotateImage` → `gcvToPage` → collect; translate = skip pages with no blocks (count as done), else `readingOrder` → `translateBlocks` → `wrapTranslatedBlock` per block → collect. Collected pages are written in ONE `upsertLayerPages` at the end (and also every 10 pages so a cancel keeps progress). Progress: `progressTrackerStore.addProcess({ id: 'engine-<kind>-<uuid>', description, progress })`, removed 3 s after the end. Notifies "OCR done: N pages (F failed)" etc.

- [ ] **Step 1: Failing tests** — mock `$lib/catalog/db` with fake-indexeddb like layers.test.ts; inject `fetch` that returns the vertical fixture for Vision and a Gemini reply; assert the `gcv` row exists with the converted block, the `tr-en` row has wrapped horizontal blocks, the confirm was asked for 2 pages with the cost note, a missing key → null + notify, cancel mid-run → `cancelled: true` and the pages done so far persisted.

```ts
// engine-runs.test.ts (excerpt)
it('OCR one page → gcv layer with the converted block; no confirm for one page', async () => {
  const confirm = vi.fn(async () => true);
  const r = await startEngineRun('ocr', ctx({ pageIndices: [0], deps: { confirm, fetch: visionFetch } }));
  expect(confirm).not.toHaveBeenCalled();
  expect(r).toMatchObject({ layerId: 'gcv', done: 1, failed: 0 });
  const row = await db.volume_ocr_layers.get(['v1', 'gcv']);
  expect(row!.kind).toBe('ocr');
  expect(row!.pages[0].blocks[0].lines).toEqual(['こんにちは', 'せかい']);
  expect(row!.pages[1].blocks).toEqual([]);
});
it('whole volume asks first with the page count and cost note; declining returns null', async () => {
  const confirm = vi.fn(async () => false);
  expect(await startEngineRun('ocr', ctx({ pageIndices: [0, 1], deps: { confirm } }))).toBeNull();
  expect(confirm.mock.calls[0][0]).toMatch(/2 pages/);
  expect(confirm.mock.calls[0][0]).toMatch(/\$1\.50 per 1000 pages/);
});
it('translate one page → tr-en layer, horizontal wrapped blocks, engine gemini:model', async () => { … });
it('missing key → null and a notice', async () => { … });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per the behaviour above (single file ~200 lines; `activeEngineRun` is a writable set at start / cleared at end; `cancel` aborts the controller).
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(engines): page/volume run orchestrator writing gcv and tr-<lang> layers`

---

### Task 9: Settings card

**Files:**

- Create: `src/lib/components/Settings/EngineSettings.svelte`
- Modify: `src/lib/components/Settings/Settings.svelte` (mount after `AnkiConnectSettings`)
- Test: `src/lib/components/Settings/__tests__/EngineSettings.test.ts`

Card content (an `AccordionItem` with header "OCR & translation engines (experimental)"):

1. Intro line: "Experimental. Keys are stored only in this browser and never synced."
2. **Google API key** (Cloud Vision + Gemini): password input `aria-label="Google API key"` with a Show toggle, "Test" button → `testGoogleVision` → inline "OK" / error text; note "Cloud Vision: about $1.50 per 1000 pages after the free monthly 1000. Gemini Flash: a few cents per volume."
3. **Anthropic API key**: same pattern, `testAnthropic`; note "Claude Haiku 4.5: roughly $0.50 per volume."
4. **OpenAI-compatible**: base URL (text, placeholder `https://api.openai.com/v1`), key (password), model (text, placeholder `gpt-4.1-mini`), Test → `testOpenAI`; note "Covers OpenAI, DeepSeek, OpenRouter, local servers."
5. **Translation**: engine select (`aria-label="Translation engine"`: Gemini / Anthropic / OpenAI-compatible) → `updateMiscSetting('translationEngine')`; model override text (`aria-label="Translation model"`, placeholder = the engine's default); target language text (`aria-label="Target language"`, default `en`).

- [ ] **Step 1: Failing component test**: renders; typing a key and blurring persists to localStorage `engine_google_key`; Show toggles the input type; Test button calls the injected tester (mock `$lib/engines/gcv` `testGoogleVision`) and shows "OK"; changing the engine select updates `miscSettings.translationEngine`.
- [ ] **Step 2–4**: implement, run, pass.
- [ ] **Step 5: Commit** `feat(settings): OCR & translation engines card (experimental)`

---

### Task 10: Reader entry points + run banner

**Files:**

- Create: `src/lib/components/Reader/EngineRunBanner.svelte` (fixed bottom-left pill: "OCR 3 / 198 · Cancel", reads `activeEngineRun`)
- Modify: `src/lib/components/Reader/Edit/EditToolbar.svelte` (add "OCR this page" and "Translate this page" buttons, props `onOcrPage?`, `onTranslatePage?`, shown only when the prop is given)
- Modify: `src/lib/components/Reader/QuickActions.svelte` (same two buttons when NOT editing, props `onOcrPage?`, `onTranslatePage?`)
- Modify: `src/lib/components/Reader/Layers/LayerPicker.svelte` (footer buttons "OCR whole volume…" / "Translate whole volume…", props `onOcrVolume?`, `onTranslateVolume?`)
- Modify: `src/lib/components/Settings/Reader/ReaderSettings.svelte` (per-volume section: same two buttons via a small store the reader registers: `engineVolumeRunner` writable `{ ocr: () => void; translate: () => void } | null` in `engine-runs.ts`)
- Modify: `src/lib/components/Reader/Reader.svelte`: `runEngine(kind, scope)` builds the `EngineRunContext` (volume titles, `rtl = volumeSettings.rightToLeft`, `sourcePages = pages`, `getImage = (i) => imageCache.getFile(i) ?? (await db.volume_files.get(uuid))?.files[pages[i].img_path]`, `pageIndices = scope === 'page' ? [editActivePage] : pages.map((_, i) => i)`); exits edit mode first when the session is on the target layer; on success `selectLayer(result.layerId)` and, if that layer was already displayed, `refreshLayerPages()` (reset `loadedLayerKey` and bump a `layerReloadTick` state read by the load effect); props wired: `onOcrPage={$hasGoogleKey ? () => runEngine('ocr','page') : undefined}` etc.; mounts `<EngineRunBanner />`.
- Tests: `EditToolbar.test.ts` (buttons appear only with the handlers and call them), `QuickActions` (same), `LayerPicker.test.ts` (footer buttons), a `Reader`-free unit test for `refresh` isn't feasible — covered by e2e.

- [ ] Steps: failing component tests → implement → pass → commit `feat(reader): OCR / translate entry points, run banner, layer refresh after a run`

---

### Task 11: E2E

**Files:**

- Create: `e2e/ocr-engines.spec.ts`

Cases (seed like `ocr-layers.spec.ts`, single page view, ONE page; second case seeds 2 pages for the volume confirm):

1. **Without a key**: quick actions has no "OCR this page"; edit toolbar has none.
2. **OCR this page**: set `localStorage.engine_google_key = 'e2e'` before load; `page.route('https://vision.googleapis.com/**', …)` fulfils with the vertical fixture (read via `readFile` from `src/lib/engines/__fixtures__/gcv-vertical.json`); quick actions → "OCR this page"; `expect.poll` the `gcv` layer row exists with lines `['こんにちは','せかい']`; the volume setting `ocrLayer` becomes `gcv`; the picker shows the Cloud Vision radio checked.
3. **Translate this page**: route `https://generativelanguage.googleapis.com/**` → `{ candidates: [{ content: { parts: [{ text: JSON.stringify([{ index: 0, text: 'Hello world' }]) }] } }] }`; quick actions → "Translate this page"; poll `tr-en` row: `kind: 'translation'`, `engine: 'gemini:gemini-2.5-flash'`, block `vertical: false`, `lines` non-empty; display switches to `tr-en`.
4. **Whole volume confirm**: 2-page seed; layer picker → "OCR whole volume…"; the confirm text contains "2 pages" and "$1.50"; click Yes; poll both pages OCR'd (route counts 2 requests).
5. **Settings card**: open settings (the gear), the accordion item "OCR & translation engines (experimental)" exists; type into "Google API key", blur, `localStorage.engine_google_key` updated; assert `localStorage.profiles` does not contain the typed value.

- [ ] Run: `E2E_PORT=5181 npx playwright test e2e/ocr-engines.spec.ts` → all pass. Commit `test(e2e): engines — OCR/translate this page, whole-volume confirm, settings card`.

---

### Task 12: Verification and review server

- [ ] `npx vitest run` → all pass (note the known flake if it fires).
- [ ] `npm run check` → 0 errors.
- [ ] `npm run lint` → 0 errors, warnings ≤ 272 + none new in touched files.
- [ ] `E2E_PORT=5181 npx playwright test e2e/ocr-engines.spec.ts e2e/ocr-layers.spec.ts e2e/ocr-editor.spec.ts` → all pass.
- [ ] `npm run dev -- --port 5182 --strictPort` in the background; `curl -s -o /dev/null -w '%{http_code}' http://localhost:5182/` → 200.

## Self-review notes

- Spec coverage: settings card (T9), keys localStorage-only + leak test (T1), Vision request/downscale/convert (T4–5), `gcv` layer create-on-first-use + per-page overwrite (T3, T8), page & volume entry points with cost confirm, queue concurrency 2, retry/backoff, cancel, progress (T2, T8, T10), adapters + prompt + parse + retry-once + page-fails-run-continues (T6–8), `tr-<lang>` layer shape and wrapping (T6, T8), experimental labelling (T9, T8 confirm text), e2e with stubs (T11).
- Type consistency: `TranslationAdapter.raw` added in T7's design note must be in `types.ts` from T6 (add it there: `raw(input: TranslationInput, signal?: AbortSignal): Promise<string>`).
