import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { providerManager } from '$lib/util/sync/provider-manager';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { ensureFreshCloudListing } from './series-file-sync';
import { registerFactsChangeListener } from './store';

/**
 * The automatic producer of the root `catalog.json` for backends that do not
 * compile it themselves (Drive / MEGA / WebDAV / OneDrive / Local Folder).
 *
 * Same three rules as `series-file-sync.ts`, one file instead of N:
 *
 * - Debounced globally — the file lists every series, so a tagging spree or an
 *   import batch must write it ONCE, not per series. Longer than the per-series
 *   debounce for exactly that reason.
 * - Gated on a writable connected provider that is NOT server-compiled: bunko is
 *   the sole producer of its own catalog, and a client write would race its
 *   regeneration (and be rejected for scoped users anyway).
 * - Preceded by the shared listing refresh, because the write merges and prunes
 *   against that listing — and skipped outright when the refresh fails, rather
 *   than publishing a catalog built from a view we know may be hours old.
 * - Serialized: the write is read-merge-upload against the cloud copy, so a
 *   second one starting mid-flight would merge the copy the first is about to
 *   replace and drop whatever it added.
 *
 * Failures are logged at debug and dropped: the next fact edit or backup run
 * rewrites the file. Nothing here ever surfaces UI.
 */

/** Long enough to swallow a whole tagging spree or import batch. */
export const CATALOG_FILE_WRITE_DEBOUNCE_MS = 5000;

let timer: ReturnType<typeof setTimeout> | null = null;
/** The write currently running, so the next one queues behind it. */
let inFlight: Promise<void> | null = null;

/** A connected provider that can be written to AND does not compile the file itself. */
function canProduceCatalog(): boolean {
  const status = get(providerManager.status);
  if (!status.hasAnyAuthenticated) return false;
  const type = status.currentProviderType;
  if (!type) return false;
  const provider = status.providers[type];
  if (!provider) return false;
  if (provider.isReadOnly === true) return false;
  return provider.serverCompilesMetadata !== true;
}

async function runWrite(): Promise<void> {
  try {
    if (!canProduceCatalog()) return;
    if (!(await ensureFreshCloudListing())) return;
    // 'skipped' is a normal outcome (an unloaded provider cache, an empty
    // listing, nothing to change) and needs no handling — the next edit or
    // backup run tries again.
    await unifiedCloudManager.writeCatalogFile();
  } catch (error) {
    // Best-effort by contract: never a snackbar, never a read-only fallback.
    console.debug('[catalog-file-sync] could not write catalog.json:', error);
  }
}

/** Start a write, or queue it behind the one already running. */
function chainWrite(): Promise<void> {
  const previous = inFlight ?? Promise.resolve();
  let next: Promise<void>;
  next = previous.then(runWrite).finally(() => {
    if (inFlight === next) inFlight = null;
  });
  inFlight = next;
  return next;
}

/**
 * Queue a `catalog.json` write, coalescing anything already queued. Safe to call
 * from any edit path — the gates are evaluated when the timer fires, not now.
 */
export function scheduleCatalogFileWrite(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void chainWrite();
  }, CATALOG_FILE_WRITE_DEBOUNCE_MS);
}

/**
 * Run a queued write now (cancelling its timer) and wait for it. For tests,
 * teardown and backup runs. Waits out a write already in flight rather than
 * racing it.
 */
export async function flushCatalogFileWrites(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await chainWrite();
}

let teardown: (() => void) | null = null;

/**
 * Subscribe the debounced writer to local fact edits. Idempotent — a second call
 * while one is live returns the same disposer instead of registering the
 * listener twice. Mounted once in `+layout.svelte`.
 */
export function initCatalogFileSync(): () => void {
  if (!browser) return () => {};
  if (teardown) return teardown;

  // The series title is irrelevant here: the catalog lists them all, so ANY
  // fact edit means the file is stale.
  const unregister = registerFactsChangeListener(() => scheduleCatalogFileWrite());

  const dispose = () => {
    if (teardown !== dispose) return;
    teardown = null;
    unregister();
    if (timer) clearTimeout(timer);
    timer = null;
  };

  teardown = dispose;
  return dispose;
}
