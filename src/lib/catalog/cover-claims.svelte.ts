import { onDestroy, untrack } from 'svelte';
import { fromStore } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';
import { acquireCover, type CoverHandle, type ResolvedCover } from './cover-resolver';
import { activeAccountScopeStore } from './account-scope-store';
import { isCoverFetchTarget, requestCover } from './cover-service';
import { isNearViewport, observeNearViewport } from './cover-viewport';

/**
 * THE ONE COVER EFFECT. Every surface that draws a cloud cover — the catalog
 * grid card, the catalog list row, the series spine shelf, the volume row, the
 * placeholder box — runs the same three-part rule, and runs it HERE:
 *
 * 1. CLAIM what it draws. A volume with no `thumbnail` of its own and a
 *    listing `cloudPath` has its cover in `cloud_covers`; `cover-resolver.ts`
 *    turns that path into one keyed read and a refcounted handle.
 * 2. ASK for what is missing, but only once the surface is near the viewport
 *    (`cover-viewport.ts`). This is the gate that turns ~4,347 requests on a
 *    1,027-series library into the ~74 a screenful actually needs.
 * 3. RELEASE every handle exactly once, in the order below.
 *
 * It lived in five near-identical copies before this — three single-claim
 * (`PlaceholderThumbnail`, `CatalogListItem`, `VolumeItem`) and two
 * multi-claim (`CatalogItem`, `SeriesSpineShowcase`) — and they had already
 * drifted: only `CatalogItem` had the acquire-then-release ordering below, so
 * the spine shelf still carried the blank-for-a-frame bug that ordering exists
 * to fix. Five copies of one rule is how that happens.
 *
 * WHAT STAYS AT THE CALL SITE: which volumes a surface draws and which it may
 * ask for. Those genuinely differ (a card claims its whole stack but asks only
 * for the slice the stack will draw; a list row's claim path falls back from
 * the stored row to the listing prop), so they are the two getters this takes.
 * Everything downstream of them is here.
 */

/** Shared empty result, so a surface with no cloud covers never invalidates a canvas. */
const NO_COVERS: Map<string, ResolvedCover> = new Map();
const NO_VOLUMES: VolumeMetadata[] = [];

/**
 * ONE subscription to the account scope for every surface in the app.
 *
 * `acquireCover` binds the scope at acquire time and `refreshCoverKeys` resolves
 * the CURRENT one, so a handle taken under the old account is unreachable by
 * refresh after a switch — every claim key therefore leads with the scope, so
 * a switch releases and re-acquires. `fromStore` shares one store subscription
 * across every reader instead of the per-component `$activeAccountScopeStore`
 * each of the five copies used to take.
 */
const accountScope = fromStore(activeAccountScopeStore);

export interface CoverClaimsOptions {
  /**
   * The volumes this surface DRAWS. Each one with no `thumbnail` and a listing
   * `cloudPath` becomes a claim; the rest are ignored, and duplicates by
   * `volume_uuid` are collapsed so two spines of the same volume take one
   * reference, not two.
   *
   * THE PATH MUST COME FROM THE LISTING. `cloudPath` is decorated onto the
   * catalog's in-memory copy of a row and is NEVER persisted, so a surface
   * that re-reads its row from Dexie must fall back to the prop it was handed
   * (see `VolumeItem`/`CatalogListItem`, where that fallback is load-bearing:
   * without it a metadata-only row blanks the moment its series is opened).
   */
  claims: () => VolumeMetadata[];
  /**
   * The volumes this surface may ASK for, before filtering. Kept separate from
   * {@link claims} because they are not the same list — a catalog card claims
   * every volume in its stack but asks only for the slice the stack will draw.
   * Filtered here by `isCoverFetchTarget` (the shared no-thumbnail-yet /
   * stale-stamp rule) and deduped by uuid.
   *
   * Omit it for a surface that only PAINTS already-cached covers and never
   * fetches — the catalog list row, today.
   */
  targets?: () => VolumeMetadata[];
}

export interface CoverClaims {
  /** Resolved covers by `volume_uuid`. The same empty Map identity whenever there are none. */
  readonly covers: Map<string, ResolvedCover>;
  /** The first claim's cover — the convenience for a surface that draws exactly one. */
  readonly cover: ResolvedCover | undefined;
  /**
   * Svelte action: put it on the surface's root element (`use:gate`) to arm
   * the viewport gate. A surface that passes {@link CoverClaimsOptions.targets}
   * and forgets this asks for nothing, ever — in a real browser only, which is
   * why forgetting it warns in dev (see `warnIfUngated`).
   */
  gate(node: Element): { destroy(): void };
}

/** One claim this surface is holding, with the subscription that feeds it. */
interface HeldCoverClaim {
  handle: CoverHandle;
  unsubscribe: () => void;
}

function releaseAll(held: HeldCoverClaim[]): void {
  for (const claim of held) {
    claim.unsubscribe();
    // Every acquire paired with exactly one release. At 1,027 cards x ~4 volumes a
    // leaked handle is a leaked blob AND a leaked object URL, for the tab's lifetime.
    claim.handle.release();
  }
}

/**
 * Wire a surface's covers up. Call it once, during component initialisation —
 * it installs the surface's `$effect`s and its `onDestroy`.
 */
export function createCoverClaims(options: CoverClaimsOptions): CoverClaims {
  /** (uuid, listing path) pairs, deduped — the claim rule, in one place. */
  const claims = $derived.by(() => {
    const seen = new Set<string>();
    const pairs: Array<{ uuid: string; path: string }> = [];
    for (const vol of options.claims()) {
      if (vol.thumbnail || !vol.cloudPath || seen.has(vol.volume_uuid)) continue;
      seen.add(vol.volume_uuid);
      pairs.push({ uuid: vol.volume_uuid, path: vol.cloudPath });
    }
    return pairs;
  });

  /**
   * The claim set folded to a PRIMITIVE, so the effect below re-runs only when
   * what is claimed actually changes.
   *
   * Every one of these lists is a fresh array on every catalog emission and on
   * every settings-adjacent one (a per-wheel-tick spine offset write included),
   * so keying the effect on the array itself would release and re-acquire — a
   * fresh keyed read per surface — for changes that cannot alter which covers
   * it wants. Svelte dedupes a derived string by value, so an unchanged claim
   * set is inert. The account scope leads it: see {@link accountScope}.
   */
  const claimKey = $derived(
    `${accountScope.current ?? ''}\u0002` +
      claims.map((claim) => `${claim.uuid}\u0000${claim.path}`).join('\u0001')
  );

  let covers = $state<Map<string, ResolvedCover>>(NO_COVERS);

  /**
   * The claims held RIGHT NOW.
   *
   * A plain `let`, deliberately not `$state`: the effect below both reads and
   * writes it, and a reactive read of its own output would re-run it forever.
   */
  let held: HeldCoverClaim[] = [];

  $effect(() => {
    // Tracked: only the folded key. The claims themselves are read untracked so a
    // re-derived-but-identical list cannot re-run this.
    void claimKey;
    const current = untrack(() => claims);

    /**
     * ACQUIRE THE NEW SET BEFORE RELEASING THE OLD ONE, which is why the release does
     * not live in this effect's teardown: Svelte runs the previous run's teardown
     * FIRST, so releasing there would drop the resolver entry for every path this
     * surface is still showing (being its only holder) the instant the claim set is
     * recomputed — for a stack-count or hide-read change, a volume joining the series,
     * the series index re-keying uuids. The re-acquire would then find an empty entry
     * and issue a fresh async keyed read, so the surface would publish an EMPTY cover
     * map, lose its `thumbnailDimensions`, and swap its painted stack for the "Click to
     * download" boxes until the read landed — every card in a cloud library at once,
     * plus a redundant read per cover.
     *
     * Acquiring first means the entry never reaches zero refs: the second
     * `acquireCover` joins the live entry, `startRead` bails on `settled`, and
     * `subscribe` emits the resolved cover SYNCHRONOUSLY, so `found` is already
     * populated by the time this publishes. An account switch still blanks correctly,
     * and must: the scope is part of the resolver's key, so the new acquire lands on a
     * different entry with no value.
     *
     * THIS ORDERING IS LOAD-BEARING. It is the whole reason the release lives in
     * `onDestroy` below rather than in a teardown here; a refactor that "tidies" it
     * back into the teardown reintroduces the blank frame.
     */
    const previous = held;
    const next: HeldCoverClaim[] = [];
    // Accumulated OUTSIDE `$state` so the subscribers can update it without this effect
    // ever reading its own output — which would make it re-run on every cover it lands.
    const found = new Map<string, ResolvedCover>();
    // A handle whose path already resolved emits synchronously on subscribe; publishing
    // per emission during setup would assign N times for one mount.
    let publishing = false;

    for (const claim of current) {
      const handle = acquireCover(claim.path);
      const unsubscribe = handle.subscribe((cover) => {
        if (cover) found.set(claim.uuid, cover);
        else found.delete(claim.uuid);
        // A cover arriving after mount reaches the surface HERE — the handle emits, and
        // `refreshCoverKeys` (driven from the cover key set) is what makes a handle that
        // already resolved a miss read again.
        if (publishing) covers = found.size > 0 ? new Map(found) : NO_COVERS;
      });
      next.push({ handle, unsubscribe });
    }
    // Published before the release, so an unmount racing it can never find a set this
    // surface has already let go of — and so the old claims are unreachable from here on.
    held = next;
    releaseAll(previous);

    publishing = true;
    // The shared empty Map when there is nothing, not a new one: assigning the same
    // identity is inert, so a surface with no cloud covers never invalidates its canvas.
    covers = found.size > 0 ? new Map(found) : NO_COVERS;
  });

  // The effect above owns no teardown, so THIS is the only thing that frees the last set
  // of claims. `onDestroy` runs on unmount whether or not the effect ever re-ran.
  onDestroy(() => {
    releaseAll(held);
    held = [];
  });

  /**
   * Has this surface come within a screenful of the viewport? Starts closed
   * and latches open; see `cover-viewport.ts` for why it never closes again.
   */
  let nearViewport = $state(false);

  /**
   * The element the gate currently watches — or, once that element's action
   * is destroyed with no replacement, the LAST one it watched. Requests carry
   * this as a liveness probe: "is this surface STILL near the viewport?" The
   * fetch queue (`cloud-thumbnails.ts`) serves still-near requests first and
   * treats the rest as backlog.
   *
   * THREE readings, by state (see {@link stillNear}):
   *  - never gated (a paint-only surface, or before this surface's first
   *    `gate` attach): stays `null`, and the probe degrades to `true`.
   *  - gated and mounted: `isNearViewport` reads its live rect.
   *  - gated and torn down, with no swap-in: `isNearViewport` reads its now-
   *    detached (0x0) rect, which reads as `false`.
   *
   * Updated on every `gate` attach — a surface that swaps its gated element
   * (`PlaceholderThumbnail` trades boxes for an `<img>`) keeps the probe
   * pointed at what is actually on screen, and the attach in {@link gate}
   * overwrites this UNCONDITIONALLY, before the old node's `destroy` can run
   * — so a swap always lands on the new element even when the old element's
   * teardown happens to run after this call.
   *
   * DELIBERATELY NEVER CLEARED on destroy. Nulling it there would make an
   * unmounted surface's still-in-flight request answer the SAME as a surface
   * that was never gated at all — indistinguishable from the legitimate
   * "never gated" degrade — which is backwards: it would prioritize a card
   * that no longer exists on screen ahead of one that genuinely does, instead
   * of behind it. Leaving the reference in place after teardown means its
   * probe instead reads the element's real, now-detached rect.
   */
  let gateNode: Element | null = null;

  /**
   * The probe handed to every `requestCover` this surface issues. With no
   * gate node at all (paint-only surfaces never attach one; jsdom opens the
   * gate without one) it answers `true`, degrading to plain newest-first
   * ordering — the only state {@link gateNode} being `null` can mean, since a
   * torn-down gate stays pointed at its (now detached) element rather than
   * reverting to `null`. See {@link gateNode} for the three states.
   */
  const stillNear = () => (gateNode ? isNearViewport(gateNode) : true);

  /** The volumes actually worth asking for: the shared rule, deduped. */
  const fetchTargets = $derived.by(() => {
    const source = options.targets?.() ?? NO_VOLUMES;
    if (source.length === 0) return NO_VOLUMES;
    const seen = new Set<string>();
    const targets: VolumeMetadata[] = [];
    for (const vol of source) {
      if (seen.has(vol.volume_uuid) || !isCoverFetchTarget(vol)) continue;
      seen.add(vol.volume_uuid);
      targets.push(vol);
    }
    return targets;
  });

  // Ask for every target's cover, once this surface is worth fetching for.
  //
  // `requestCover` is idempotent and fire-and-forget — the service's own dedupe
  // (in-flight + settled ledgers, keyed by account scope + uuid) makes a redundant call
  // free, so there is no per-surface ledger to maintain. The gate is read FIRST and the
  // targets only after it opens: an off-screen surface whose target list churns costs
  // nothing, and the list it finally asks for is the one current when it came into view.
  $effect(() => {
    if (!nearViewport) return;
    for (const vol of fetchTargets) requestCover(vol, stillNear);
  });

  /** Set by {@link gate}. See {@link warnIfUngated} for why this is worth tracking. */
  let gateAttached = false;

  function gate(node: Element): { destroy(): void } {
    gateAttached = true;
    // The probe always follows the newest gated element, opened or not. This
    // is unconditional and runs before anything below, so it always wins over
    // the PREVIOUS node's `destroy` — whichever order the two run in (see
    // {@link gateNode}) — and is why `destroy` below has nothing to undo.
    gateNode = node;
    // Already open: nothing left to watch for. This also covers a surface whose
    // observed element is swapped for another (`PlaceholderThumbnail` trades its
    // placeholder boxes for an `<img>` the moment a cover lands).
    if (untrack(() => nearViewport)) return { destroy() {} };
    const stop = observeNearViewport(node, () => {
      nearViewport = true;
    });
    return {
      destroy() {
        stop();
        // Deliberately does not touch `gateNode`: see {@link gateNode} for why
        // a torn-down node stays the probe target instead of being cleared.
      }
    };
  }

  if (import.meta.env.DEV) warnIfUngated();

  /**
   * THE ONE MISTAKE THIS MODULE CANNOT CATCH BY SHAPE: a surface passes
   * {@link CoverClaimsOptions.targets} and forgets `use:gate`.
   *
   * It fails SILENTLY and asymmetrically. In jsdom with no observer stubbed,
   * `observeNearViewport` opens the gate synchronously (see `cover-viewport.ts`),
   * so the new surface's own tests pass; in a browser the gate never opens, the
   * surface requests NOTHING EVER, and the user gets a permanently blank cover
   * with no error, no failed request, and nothing in the console. There is no
   * type that prevents it — `use:gate` is markup, and a required argument would
   * only move the same silent omission to a forgotten `bind:this`, which fails
   * exactly as quietly. So the fix is to make the surface say so out loud, in
   * dev, the moment it has something to ask for and no way to ask.
   *
   * Deliberately NOT the request effect above: that effect reads `nearViewport`
   * FIRST and bails, so an off-screen surface whose target list churns re-runs
   * nothing. Reading `fetchTargets` there to check would take a dependency on
   * exactly the churn it is written to ignore. This is a separate effect that
   * only exists in dev.
   *
   * NO DEFERRAL NEEDED. `use:` compiles to a BLOCK effect (`action()` in
   * `svelte/internal/client`), and block effects run in the render phase ahead of
   * every `$effect` — so by the time this one runs, a surface that has `use:gate`
   * anywhere in its markup has already set `gateAttached`. The
   * "a surface WITH `use:gate` never warns" test is what holds that down; a
   * microtask hop here made no test move, so there is none.
   */
  function warnIfUngated(): void {
    if (!options.targets) return; // a paint-only surface has nothing to gate
    let warned = false;
    $effect(() => {
      if (warned || gateAttached) return;
      // Nothing to ask for yet is not a defect: `VolumeItem`'s grid variant supplies
      // `targets` that resolve to nothing and correctly renders no gate node at all.
      if (fetchTargets.length === 0) return;
      warned = true;
      console.warn(
        '[cover-claims] A surface passed `targets` but never attached `use:gate`, ' +
          'so its viewport gate can never open and it will request no covers at all. ' +
          'Put `use:gate` on the element the surface renders (see cover-claims.svelte.ts).'
      );
    });
  }

  return {
    get covers() {
      return covers;
    },
    get cover() {
      const first = claims[0];
      return first ? covers.get(first.uuid) : undefined;
    },
    gate
  };
}
