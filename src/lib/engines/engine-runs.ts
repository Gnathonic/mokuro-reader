/**
 * One orchestrator for every engine run the reader offers: "OCR this page",
 * "OCR whole volume", "Translate this page", "Translate whole volume". Checks
 * the key, confirms a whole-volume run with its cost, drives the shared run
 * queue, writes results into the engine's layer (`gcv` / `tr-<lang>`), and
 * reports progress through the progress tracker plus `activeEngineRun` for
 * the reader's banner (which owns the Cancel button). Everything a test
 * needs to fake — fetch, image decode, credentials, prefs, confirm, notify —
 * is injectable through `deps`.
 */
import { get, readonly, writable } from 'svelte/store';
import type { Block, Page } from '$lib/types';
import {
  miscSettings,
  type TranslationEngineId,
  type TranslationModelOverrides
} from '$lib/settings/misc';
import { progressTrackerStore } from '$lib/util/progress-tracker';
import { promptConfirmation } from '$lib/util/modals';
import { showSnackbar } from '$lib/util/snackbar';
import { loadLayerPages, upsertLayerPages } from '$lib/reader/edit/layers';
import { engineCredentials, type EngineCredentials } from './credentials';
import { annotateImage, prepareImage, type DecodedImage } from './gcv';
import { gcvToPage } from './gcv-convert';
import { runQueue } from './run-queue';
import { getTranslationAdapter, translateBlocks } from './translate';
import { readingOrder } from './translate/prompt';
import { wrapTranslatedBlock } from './translate/wrap';

export type EngineKind = 'ocr' | 'translate';

export const OCR_LAYER_ID = 'gcv';
export const OCR_LAYER_NAME = 'Cloud Vision';

export function translationLayerId(lang: string): string {
  const slug =
    lang
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x';
  return `tr-${slug}`.slice(0, 32);
}

export const OCR_COST_NOTE = 'about $1.50 per 1000 pages after the free monthly 1000';
export const TRANSLATE_COST_NOTE =
  'a few cents per volume on Flash-class models, more on larger ones';

export interface EngineRunDeps {
  credentials: EngineCredentials;
  prefs: {
    translationEngine: TranslationEngineId;
    translationModels: TranslationModelOverrides;
    translationLanguage: string;
  };
  fetch: typeof fetch;
  decode?: (file: Blob) => Promise<DecodedImage>;
  confirm: (message: string) => Promise<boolean>;
  notify: (message: string) => void;
  concurrency: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface EngineRunContext {
  volumeUuid: string;
  volumeTitle: string;
  seriesTitle: string;
  rtl: boolean;
  /** The displayed page set: the translation source, and the OCR layer's image facts. */
  sourcePages: Page[];
  getImage: (pageIndex: number) => Promise<Blob | null>;
  /** One page, or every page of the volume. */
  pageIndices: number[];
  deps?: Partial<EngineRunDeps>;
}

export interface EngineRunResult {
  layerId: string;
  done: number;
  failed: number;
  cancelled: boolean;
}

export interface ActiveEngineRun {
  kind: EngineKind;
  volumeUuid: string;
  done: number;
  total: number;
  cancel: () => void;
}

const active = writable<ActiveEngineRun | null>(null);
/** The run in flight, for the reader's banner. */
export const activeEngineRun = readonly(active);

/**
 * The reader registers its whole-volume runners here while a volume is open,
 * so the settings panel (not a child of the reader) can offer the same
 * "OCR / Translate whole volume" buttons. Null outside the reader or when
 * no engine key is configured for that runner.
 */
export const engineVolumeRunner = writable<{
  ocr?: () => void;
  translate?: () => void;
} | null>(null);

function defaultDeps(): EngineRunDeps {
  const m = get(miscSettings);
  return {
    credentials: get(engineCredentials),
    prefs: {
      translationEngine: m.translationEngine,
      translationModels: m.translationModels,
      translationLanguage: m.translationLanguage || 'en'
    },
    fetch: (input, init) => globalThis.fetch(input, init),
    confirm: (message) =>
      new Promise((resolve) =>
        promptConfirmation(
          message,
          () => resolve(true),
          () => resolve(false)
        )
      ),
    notify: (message) => showSnackbar(message),
    concurrency: 2
  };
}

const KIND_LABEL: Record<EngineKind, string> = { ocr: 'OCR', translate: 'Translation' };

/** Pages written every this-many completions, so a cancel keeps its progress. */
const FLUSH_EVERY = 10;

/**
 * The one run slot, taken synchronously by `startEngineRun`. `active` cannot
 * be that guard on its own: it is only set once the cost confirm and the
 * baseline read have been awaited, so two starts in the same moment (a
 * double-click, or the settings panel and the toolbar) both saw it empty and
 * both ran — and billed — the whole volume.
 */
let slotClaimed = false;

export async function startEngineRun(
  kind: EngineKind,
  ctx: EngineRunContext
): Promise<EngineRunResult | null> {
  const d: EngineRunDeps = { ...defaultDeps(), ...ctx.deps };
  if (slotClaimed || get(active)) {
    d.notify(`An engine run is already running — wait for it to finish or cancel it`);
    return null;
  }
  // No await between the check above and this line.
  slotClaimed = true;
  try {
    return await runInClaimedSlot(kind, ctx, d);
  } finally {
    // Declined, missing key, thrown or finished: the slot is free again.
    slotClaimed = false;
  }
}

async function runInClaimedSlot(
  kind: EngineKind,
  ctx: EngineRunContext,
  d: EngineRunDeps
): Promise<EngineRunResult | null> {
  // ---- engine + key ----
  let layerId: string;
  let layerName: string;
  let engine: string;
  let adapter: ReturnType<typeof getTranslationAdapter> = null;
  if (kind === 'ocr') {
    if (!d.credentials.googleKey) {
      d.notify('Add a Google API key under Settings → OCR & translation engines first');
      return null;
    }
    layerId = OCR_LAYER_ID;
    layerName = OCR_LAYER_NAME;
    engine = 'gcv';
  } else {
    adapter = getTranslationAdapter(d.credentials, d.prefs, d.fetch);
    if (!adapter) {
      d.notify(
        `Add the ${d.prefs.translationEngine === 'gemini' ? 'Google API key' : d.prefs.translationEngine === 'anthropic' ? 'Anthropic API key' : 'OpenAI-compatible key'} under Settings → OCR & translation engines first`
      );
      return null;
    }
    layerId = translationLayerId(d.prefs.translationLanguage);
    layerName = `Translation (${d.prefs.translationLanguage})`;
    engine = `${adapter.id}:${adapter.model}`;
  }

  // ---- whole-volume confirm ----
  const indices = [...new Set(ctx.pageIndices)].filter((i) => i >= 0 && i < ctx.sourcePages.length);
  if (indices.length === 0) return null;
  if (indices.length > 1) {
    const cost = kind === 'ocr' ? OCR_COST_NOTE : TRANSLATE_COST_NOTE;
    const ok = await d.confirm(
      `${KIND_LABEL[kind]} all ${indices.length} pages of "${ctx.volumeTitle}" with ${kind === 'ocr' ? 'Google Cloud Vision' : engine}? This is experimental and costs ${cost}. Results go to the "${layerName}" layer; the primary OCR is untouched.`
    );
    if (!ok) return null;
  }

  // ---- run ----
  const controller = new AbortController();
  const processId = `engine-${kind}-${ctx.volumeUuid}`;
  const results = new Map<number, Page>();
  // The run is not tied to the reader's lifecycle, so the volume can be
  // deleted (or removed from this device) under it. The write then refuses
  // (`upsertLayerPages` → null); stop here too, rather than keep paying an API
  // for pages that have nowhere to go.
  let volumeGone = false;
  // What the layer held before this run touched it: a page that no longer
  // matches when its result lands was edited by hand mid-run, and is kept.
  const baseline = await loadLayerPages(ctx.volumeUuid, layerId);
  let keptEdits = 0;
  const flush = async () => {
    if (results.size === 0) return;
    const batch = new Map(results);
    results.clear();
    if (volumeGone) return;
    const written = await upsertLayerPages(ctx.volumeUuid, layerId, {
      name: layerName,
      kind: kind === 'ocr' ? 'ocr' : 'translation',
      engine,
      sourcePages: ctx.sourcePages,
      pages: batch,
      baseline
    });
    if (!written) {
      volumeGone = true;
      controller.abort();
      return;
    }
    // The returned layer holds the very objects it was given, except where a
    // hand edit was kept instead.
    for (const [i, page] of batch) if (written.pages[i] !== page) keptEdits++;
  };

  active.set({
    kind,
    volumeUuid: ctx.volumeUuid,
    done: 0,
    total: indices.length,
    cancel: () => controller.abort()
  });
  progressTrackerStore.addProcess({
    id: processId,
    description: `${KIND_LABEL[kind]}: ${ctx.volumeTitle}`,
    progress: 0,
    status: `0 / ${indices.length}`
  });

  const worker = async (pageIndex: number, signal: AbortSignal) => {
    const source = ctx.sourcePages[pageIndex];
    if (kind === 'ocr') {
      const image = await ctx.getImage(pageIndex);
      if (!image) throw new Error(`page ${pageIndex + 1} has no image on this device`);
      const { base64, scale } = await prepareImage(image, undefined, d.decode);
      const response = await annotateImage(base64, d.credentials.googleKey, {
        fetch: d.fetch,
        signal
      });
      results.set(pageIndex, gcvToPage(response, source, scale));
    } else {
      if (source.blocks.length === 0) {
        results.set(pageIndex, { ...source, blocks: [] });
        return;
      }
      const order = readingOrder(source.blocks, ctx.rtl);
      const translated = await translateBlocks(
        adapter!,
        {
          seriesTitle: ctx.seriesTitle,
          volumeTitle: ctx.volumeTitle,
          target: d.prefs.translationLanguage,
          blocks: order.map((blockIndex) => ({
            index: blockIndex,
            text: source.blocks[blockIndex].lines.join('')
          }))
        },
        signal
      );
      const byIndex = new Map(translated.map((t) => [t.index, t.text]));
      const blocks: Block[] = source.blocks.map((b, i) =>
        wrapTranslatedBlock(b, byIndex.get(i) ?? '')
      );
      // The spread carries the source's image facts.
      results.set(pageIndex, { ...source, blocks });
    }
  };

  let result: EngineRunResult;
  try {
    const q = await runQueue(indices, worker, {
      concurrency: d.concurrency,
      signal: controller.signal,
      sleep: d.sleep,
      onProgress: (done, total, failed) => {
        active.update((a) => (a ? { ...a, done: done + failed } : a));
        progressTrackerStore.updateProcess(processId, {
          progress: total ? Math.round(((done + failed) / total) * 100) : 100,
          status: `${done + failed} / ${total}${failed ? ` (${failed} failed)` : ''}`
        });
        // `flush` empties `results`, so its size IS the unflushed count.
        if (results.size >= FLUSH_EVERY) {
          void flush().catch((error) => console.error('[engine-runs] flush failed:', error));
        }
      }
    });
    for (const { item, error } of q.errors) {
      console.warn(`[engine-runs] ${KIND_LABEL[kind]} failed for page ${item + 1}:`, error);
    }
    await flush();
    result = { layerId, done: q.done, failed: q.failed, cancelled: q.cancelled };
  } catch (error) {
    await flush().catch(() => {});
    d.notify(
      `${KIND_LABEL[kind]} failed: ${error instanceof Error ? error.message : String(error)}`
    );
    result = { layerId, done: 0, failed: indices.length, cancelled: controller.signal.aborted };
  } finally {
    active.set(null);
    progressTrackerStore.updateProcess(processId, { progress: 100 });
    setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
  }

  if (volumeGone) {
    d.notify(`${KIND_LABEL[kind]} stopped: "${ctx.volumeTitle}" is no longer on this device`);
    return result;
  }
  const parts = [
    `${KIND_LABEL[kind]} ${result.cancelled ? 'cancelled' : 'done'}: ${result.done} page${result.done === 1 ? '' : 's'}`
  ];
  if (result.failed) parts.push(`${result.failed} failed`);
  if (keptEdits) parts.push(`${keptEdits} kept your manual edit${keptEdits === 1 ? '' : 's'}`);
  d.notify(parts.join(', '));
  return result;
}
