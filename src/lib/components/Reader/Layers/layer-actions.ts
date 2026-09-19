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
import {
  clearPendingLayerDelete as realClearPendingLayerDelete,
  deleteCloudLayerFile as realDeleteCloudLayerFile,
  type CloudLayerDeleteOutcome
} from '$lib/metadata/layer-sync';

export type LayerAction = 'new' | 'rename' | 'promote' | 'export' | 'delete';
export type LayerSource = 'copy' | 'empty';

export interface LayerNamePrompt {
  title: string;
  initialName: string;
  askSource: boolean;
  resolve: (r: { name: string; source: LayerSource } | null) => void;
}

const prompt = writable<LayerNamePrompt | null>(null);
/** The open name prompt, if any — rendered by `LayerNameModal`. */
export const layerNamePrompt = readonly(prompt);

export function promptLayerName(opts: {
  title: string;
  initialName?: string;
  askSource?: boolean;
}): Promise<{ name: string; source: LayerSource } | null> {
  return new Promise((resolve) => {
    let current: LayerNamePrompt | null = null;
    prompt.update((prev) => {
      // One prompt at a time: a newer request cancels the older one.
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
  /**
   * Removes the layer's cloud copy first — otherwise the next listing pulls it
   * back. `'unconfirmed'` = a copy may survive; layer-sync has left a
   * pending-delete tombstone that hides it and retries on later listings.
   */
  deleteCloudLayerFile: (volumeUuid: string, layerId: string) => Promise<CloudLayerDeleteOutcome>;
  /** A layer created under a previously deleted id must not inherit its tombstone. */
  clearPendingLayerDelete: (volumeUuid: string, layerId: string) => void;
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
  deleteCloudLayerFile: realDeleteCloudLayerFile,
  clearPendingLayerDelete: realClearPendingLayerDelete,
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
  /**
   * Awaited once the user has committed to a promote, a new layer or a delete,
   * BEFORE any layer row is read or written — the reader passes its edit
   * session's flush. Unsaved edits written late would otherwise land on a row
   * the action already swapped, copied without them, or deleted. A rejection
   * aborts the action (reported like any other failure).
   */
  onBeforeMutate?: () => Promise<void>;
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
        await ctx.onBeforeMutate?.();
        const layer = await d.createLayer(volumeUuid, {
          name: r.name,
          pages: r.source === 'empty' ? 'empty' : ctx.displayedPages,
          sourcePages: ctx.displayedPages
        });
        d.clearPendingLayerDelete(volumeUuid, layer.layer_id);
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
        await ctx.onBeforeMutate?.();
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
        // Before the switch to primary too: selecting another layer must not
        // be what decides where the session's pending edits end up.
        await ctx.onBeforeMutate?.();
        await ctx.onSelectLayer(null);
        const cloud = await d.deleteCloudLayerFile(volumeUuid, layerId);
        // The row goes either way — being offline must not block a delete. An
        // unconfirmed cloud removal is covered by layer-sync's tombstone (the
        // file is never pulled back, and is removed once a listing allows it).
        await d.deleteLayer(volumeUuid, layerId);
        d.notify(
          cloud === 'unconfirmed'
            ? 'Layer deleted on this device. Its cloud copy will be removed when the cloud allows it.'
            : 'Layer deleted'
        );
        return;
      }
    }
  } catch (error) {
    d.notify(error instanceof Error ? error.message : String(error));
  }
}
