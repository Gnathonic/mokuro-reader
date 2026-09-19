/**
 * Reader-level rules of the OCR editor, kept out of `Reader.svelte` so they
 * can be tested without mounting the reader: which pages an engine run
 * targets, when a run in flight forbids editing, the flush on tab hide, and
 * who owns the keyboard while the layer UI is open. `Reader.svelte` feeds
 * these its own state; the one thing held here is the reader's registration
 * for `beforeLayerMutation`.
 */
import { OCR_LAYER_ID, type ActiveEngineRun, type EngineKind } from '$lib/engines/engine-runs';
import type { LayerAction } from '$lib/components/Reader/Layers/layer-actions';

/**
 * The pages an engine run covers, resolved around the close of the edit
 * session the run would race.
 *
 * The order is the rule: the active page is read BEFORE the session closes.
 * "The page the editor is on" is the session's own notion (the right-hand page
 * of a spread, say); once the session is gone the reader can only answer with
 * its base index — the LEFT page — so reading it afterwards ran "OCR this
 * page" on the wrong half of the spread.
 */
export async function resolveEngineRunPages(opts: {
  scope: 'page' | 'volume';
  pageCount: number;
  /** The page the editor acts on right now. */
  activePage: () => number;
  /** Closes (saving) the session the run would race; a no-op when none does. */
  closeSession: () => Promise<void>;
}): Promise<number[]> {
  const target = opts.activePage();
  await opts.closeSession();
  if (opts.scope === 'page') return [target];
  return Array.from({ length: opts.pageCount }, (_, i) => i);
}

/**
 * Whether a run of this kind can write the layer an edit session is (or would
 * be) open on. OCR only ever writes its own layer. A translation's layer id
 * comes from the language preference at run time, which the reader does not
 * resolve — so a translation counts for every layer.
 */
export function engineRunTouchesLayer(kind: EngineKind, layerId: string | null): boolean {
  return kind === 'translate' || layerId === OCR_LAYER_ID;
}

const RUN_LABEL: Record<EngineKind, string> = { ocr: 'OCR', translate: 'Translation' };

/**
 * Why edit mode may not be entered right now because of the engine run in
 * flight, or null when it may. A run overwrites whole pages of its layer as
 * they complete (and a whole-volume run takes minutes), so a manual edit made
 * meanwhile on that layer is silently replaced by the run's result.
 */
export function engineRunEditBlock(
  run: Pick<ActiveEngineRun, 'kind' | 'volumeUuid'> | null,
  volumeUuid: string | undefined,
  layerId: string | null
): string | null {
  if (!run || !volumeUuid || run.volumeUuid !== volumeUuid) return null;
  if (!engineRunTouchesLayer(run.kind, layerId)) return null;
  return `${RUN_LABEL[run.kind]} is running on this volume — edit once it finishes`;
}

/**
 * Save pending edits when the page is about to stop running: the tab is
 * hidden (mobile browsers may kill a hidden tab without another event) or the
 * page is being unloaded. The debounced save would otherwise lose the last
 * half second of edits. Returns the detach function.
 */
export function flushOnPageHide(flush: () => void): () => void {
  const onVisibilityChange = () => {
    if (document.hidden) flush();
  };
  const onPageHide = () => flush();
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
  };
}

export type LayerUiKeyAction = 'pass' | 'swallow' | 'close-picker';

/**
 * What the reader's window keydown handler does with a key while the layer UI
 * is open. `keyboardShouldIgnore` only sees the event TARGET, and the picker
 * opens without taking focus from its toggle button — so the reader's own
 * state has to say the picker is up, or Escape navigates back out of the
 * reader and the arrows page it underneath. The name prompt is a native
 * dialog that handles its own Escape; the reader just stays out of the way.
 */
export function layerUiKeyAction(
  code: string,
  ui: { pickerOpen: boolean; namePromptOpen: boolean }
): LayerUiKeyAction {
  if (ui.namePromptOpen) return 'swallow';
  if (ui.pickerOpen) return code === 'Escape' ? 'close-picker' : 'swallow';
  return 'pass';
}

type BeforeLayerMutation = (action: LayerAction) => Promise<void>;
let readerBeforeLayerMutation: BeforeLayerMutation | null = null;

/**
 * The reader registers how it settles its open edit session before a layer
 * action touches the DB, so a surface that is not its child (the settings
 * panel's layer buttons) can pass the same thing as its
 * `LayerActionContext.onBeforeMutate`. Returns the unregister function, which
 * only removes its OWN registration — a reader being torn down must not
 * unhook the one that replaced it.
 */
export function registerBeforeLayerMutation(fn: BeforeLayerMutation): () => void {
  readerBeforeLayerMutation = fn;
  return () => {
    if (readerBeforeLayerMutation === fn) readerBeforeLayerMutation = null;
  };
}

/** Settle the reader's unsaved edits ahead of `action`. No reader, nothing unsaved. */
export function beforeLayerMutation(action: LayerAction): Promise<void> {
  return readerBeforeLayerMutation?.(action) ?? Promise.resolve();
}
