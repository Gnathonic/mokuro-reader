import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { get } from 'svelte/store';
import type { Page } from '$lib/types';
import vertical from './__fixtures__/gcv-vertical.json';

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_engine_runs_test') };
});
vi.mock('$lib/util/sync/sidecar-backfill', () => ({ noteOcrEdited: vi.fn() }));

import { db } from '$lib/catalog/db';
import { activeEngineRun, startEngineRun, type EngineRunContext } from './engine-runs';

function pg(text: string, img_path: string): Page {
  return {
    version: '0.2.1',
    img_width: 400,
    img_height: 600,
    img_path,
    blocks: text ? [{ box: [250, 50, 310, 250], vertical: true, font_size: 30, lines: [text] }] : []
  };
}
const PAGES = [pg('こんにちは', '001.png'), pg('さようなら', '002.png')];
const geminiReply = (texts: string[]) =>
  JSON.stringify(texts.map((text, index) => ({ index, text })));

function fetchFor(routes: Record<string, () => unknown | Response>) {
  return vi.fn(async (url: string) => {
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        const b = body();
        return b instanceof Response ? b : new Response(JSON.stringify(b), { status: 200 });
      }
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}
const VISION = 'https://vision.googleapis.com/';
const GEMINI = 'https://generativelanguage.googleapis.com/';

const creds = {
  googleKey: 'g',
  anthropicKey: '',
  openaiBaseUrl: '',
  openaiKey: '',
  openaiModel: ''
};
const prefs = {
  translationEngine: 'gemini' as const,
  translationModel: '',
  translationLanguage: 'en'
};

function ctx(over: Partial<EngineRunContext> = {}): EngineRunContext {
  return {
    volumeUuid: 'v1',
    volumeTitle: 'Vol 1',
    seriesTitle: 'Series',
    rtl: true,
    sourcePages: PAGES,
    getImage: async () => new Blob(['png']),
    pageIndices: [0],
    ...over,
    deps: {
      credentials: creds,
      prefs,
      confirm: vi.fn(async () => true),
      notify: vi.fn(),
      decode: async () => ({ width: 400, height: 600, draw: async () => new Blob(['x']) }),
      fetch: fetchFor({ [VISION]: () => vertical, [GEMINI]: () => ({}) }),
      sleep: async () => {},
      ...over.deps
    }
  };
}

beforeEach(async () => {
  await db.volume_ocr_layers.clear();
});

describe('startEngineRun', () => {
  it('OCR one page → gcv layer with the converted block; no confirm for one page', async () => {
    const confirm = vi.fn(async () => true);
    const r = await startEngineRun('ocr', ctx({ deps: { confirm } }));
    expect(confirm).not.toHaveBeenCalled();
    expect(r).toMatchObject({ layerId: 'gcv', done: 1, failed: 0, cancelled: false });
    const row = await db.volume_ocr_layers.get(['v1', 'gcv']);
    expect(row!.kind).toBe('ocr');
    expect(row!.engine).toBe('gcv');
    expect(row!.pages[0].blocks[0].lines).toEqual(['こんにちは', 'せかい']);
    expect(row!.pages[1].blocks).toEqual([]);
    expect(get(activeEngineRun)).toBeNull();
  });

  it('whole volume asks first with the page count and cost note; declining returns null', async () => {
    const confirm = vi.fn(async (_message: string) => false);
    expect(await startEngineRun('ocr', ctx({ pageIndices: [0, 1], deps: { confirm } }))).toBeNull();
    expect(confirm.mock.calls[0][0]).toMatch(/2 pages/);
    expect(confirm.mock.calls[0][0]).toMatch(/\$1\.50 per 1000 pages/);
    expect(confirm.mock.calls[0][0]).toMatch(/experimental/i);
    expect(await db.volume_ocr_layers.get(['v1', 'gcv'])).toBeUndefined();
  });

  it('translate one page → tr-en layer with horizontal wrapped blocks, engine gemini:<model>', async () => {
    const fetch = fetchFor({
      [GEMINI]: () => ({
        candidates: [{ content: { parts: [{ text: geminiReply(['Hello there']) }] } }]
      })
    });
    const r = await startEngineRun('translate', ctx({ deps: { fetch } }));
    expect(r).toMatchObject({ layerId: 'tr-en', done: 1, failed: 0 });
    const row = await db.volume_ocr_layers.get(['v1', 'tr-en']);
    expect(row!.kind).toBe('translation');
    expect(row!.engine).toBe('gemini:gemini-2.5-flash');
    const b = row!.pages[0].blocks[0];
    expect(b.vertical).toBe(false);
    expect(b.box).toEqual([250, 50, 310, 250]);
    expect(b.lines_coords).toBeUndefined();
    // 60 px wide at 30 px → 3 chars per line: the text wraps (hard-split), nothing lost
    expect(b.lines.join('').replace(/\s/g, '')).toBe('Hellothere');
    expect(b.lines.length).toBeGreaterThan(1);
    // the untouched page keeps its image facts with no blocks
    expect(row!.pages[1].blocks).toEqual([]);
  });

  it('a page with no blocks is skipped as done without calling the translator', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = await startEngineRun(
      'translate',
      ctx({ sourcePages: [pg('', '001.png')], pageIndices: [0], deps: { fetch: fetchImpl } })
    );
    expect(r).toMatchObject({ done: 1, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('missing key → null and a notice', async () => {
    const notify = vi.fn();
    const r = await startEngineRun(
      'ocr',
      ctx({ deps: { notify, credentials: { ...creds, googleKey: '' } } })
    );
    expect(r).toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Google API key/));
  });

  it('a failing page is counted and the run continues; cancel keeps what finished', async () => {
    let calls = 0;
    const fetch = fetchFor({
      [VISION]: () => {
        calls++;
        return calls === 1
          ? new Response('{"error":{"message":"boom"}}', { status: 400 })
          : vertical;
      }
    });
    const notify = vi.fn();
    const r = await startEngineRun(
      'ocr',
      ctx({ pageIndices: [0, 1], deps: { fetch, notify, concurrency: 1 } })
    );
    expect(r).toMatchObject({ done: 1, failed: 1 });
    const row = await db.volume_ocr_layers.get(['v1', 'gcv']);
    expect(row!.pages[1].blocks[0].lines).toEqual(['こんにちは', 'せかい']);
    expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/1 failed/));
  });

  it('refuses a second run while one is active', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify(vertical), { status: 200 });
    }) as unknown as typeof fetch;
    const first = startEngineRun('ocr', ctx({ deps: { fetch: fetchImpl } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(get(activeEngineRun)?.kind).toBe('ocr');
    const notify = vi.fn();
    expect(await startEngineRun('ocr', ctx({ deps: { notify } }))).toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/already running/));
    release();
    await first;
  });
});
