/**
 * "IS THIS SURFACE WORTH FETCHING FOR YET?" — the viewport gate behind every
 * cover request.
 *
 * The catalog renders EVERY series card at once (no virtualisation: 1,027
 * cards and a 161,961 px page on the measured library), and each card asks
 * `cover-service.ts` for the covers of the ~4 volumes its stack draws. Before
 * this gate that was ~4,347 cover requests fired on mount — a 12.2-second,
 * 134 MB burst for a screenful of maybe six cards, the rest thousands of
 * pixels below the fold. The user's report: "the page rendering still freezes
 * while downloading covers... I can scroll soon after startup and the volume
 * names and placeholders won't even be there."
 *
 * A surface hands its root node to {@link observeNearViewport} and is told
 * ONCE, when that node first comes within {@link COVER_VIEWPORT_ROOT_MARGIN}
 * of the viewport. Same primitive `ThumbnailCanvas.svelte` already uses for
 * lazy bitmap decoding, and deliberately the same shape: observe, fire once,
 * disconnect.
 */

/**
 * How far ahead of the viewport a surface starts asking for covers:
 * ONE FULL SCREEN in each direction, none sideways.
 *
 * A percentage rather than the flat `200px` `CompositeCanvas`/`ThumbnailCanvas`
 * use, because those gate a LOCAL bitmap decode — sub-frame work that only has
 * to beat the next paint — while this gates a network round trip plus a DB
 * write, which needs seconds of lead, not milliseconds. One screenful is the
 * natural unit for that lead: it is exactly the distance a Page Down, a space
 * bar, or a one-flick scroll travels, so the single most common "scroll ahead"
 * gesture can never land on a card whose cover was not already asked for. It
 * also scales with the device, which a pixel constant cannot — a 1,000 px
 * margin is two screens of lead on a phone and half a screen on a tall
 * desktop window.
 *
 * On a 1080p window that is ~950 px of lead in each direction, roughly one
 * second at a sustained ~1,000 px/s scroll, and it holds ~74 cards' covers in
 * play instead of 4,347. A hard flick can still outrun it; the covers for
 * wherever the flick STOPS are requested the moment it stops, which is the
 * behaviour a reader actually experiences.
 *
 * THE LEAD IS NOT UNIVERSAL, because `rootMargin` inflates only the ROOT — here
 * the implicit viewport. The intersection is then clipped by every scrolling
 * ancestor in between, and those clip rects are applied UNMARGINED. So a surface
 * that scrolls inside a nested container rather than with the document — the
 * spine shelf inside the series editor dialog's scrolling body, say — gets zero
 * prefetch lead from this constant and pops its covers in on entry instead of
 * ahead of it. Not starvation: entering the container still fires the gate, and
 * `cover-service.ts`'s ledgers mean the request is issued once. It is the
 * document-scrolled catalog — the surface this constant was measured on and the
 * one with 1,027 cards below the fold — that gets the full screenful of lead.
 *
 * Exported because the test stub matches on it: a stub that reported every
 * observer visible would also switch on `CompositeCanvas`'s canvas painting in
 * jsdom, which those suites deliberately keep off.
 */
export const COVER_VIEWPORT_ROOT_MARGIN = '100% 0px';

/**
 * Watch `node` and call `onNear` the FIRST time it comes within the prefetch
 * margin, then stop watching. Returns a teardown for the "never got there"
 * case (unmounted while still off-screen).
 *
 * ONE-SHOT BY DESIGN. A cover request is not something to take back when a
 * card scrolls away — `cover-service.ts`'s `settled` ledger means asking again
 * costs nothing, but re-arming would make an unmount/remount cycle the only
 * thing standing between a scrolling user and the burst this gate removes. It
 * also means a surface's target list changing AFTER it has been seen (a volume
 * joining the series, the stack count changing) still asks immediately, which
 * is what a card the user is looking at should do.
 *
 * NO OBSERVER, NO GATE. An environment without `IntersectionObserver` — jsdom,
 * every component suite in this repo that does not stub one — gets `onNear`
 * synchronously and behaves exactly as it did before this gate existed. That
 * keeps the gate from silently blanking surfaces in a browser that lacks the
 * API, at the cost of the gate being invisible in an unstubbed test; the
 * gating suites therefore stub one and assert on it rather than relying on the
 * ambient environment.
 */
export function observeNearViewport(node: Element, onNear: () => void): () => void {
  if (typeof IntersectionObserver !== 'function') {
    onNear();
    return () => {};
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      onNear();
    },
    { rootMargin: COVER_VIEWPORT_ROOT_MARGIN, threshold: 0 }
  );
  observer.observe(node);

  return () => observer.disconnect();
}

/**
 * "IS THIS SURFACE STILL NEAR THE VIEWPORT RIGHT NOW?" — the liveness probe
 * behind the cover fetch queue's visibility preference.
 *
 * {@link observeNearViewport} answers "has this surface EVER come close" and
 * latches; this answers the question the fetch queue actually has when a slot
 * frees up: is the surface that asked still worth serving FIRST? A fast
 * scroll enqueues a request for every card it passes (each one crossed the
 * margin), and by the time a slot frees most of them are thousands of pixels
 * behind — `cloud-thumbnails.ts` grants its slots newest-first among the
 * requests whose probe still says yes, and treats everything else as
 * backlog to drain when nothing visible is waiting.
 *
 * Same geometry as {@link COVER_VIEWPORT_ROOT_MARGIN}: one full viewport of
 * vertical lead in each direction, none sideways. A DETACHED node (its
 * surface unmounted or swapped) measures 0x0 at 0,0 and reads as "not near",
 * which is the right answer for a card that no longer exists on screen — its
 * request still drains eventually, it just never outranks a visible one.
 *
 * No `IntersectionObserver` involvement: this is a synchronous rect check,
 * taken only when a slot is granted (a handful of times per second at most),
 * so it costs one layout read, not a persistent observer per card. An
 * environment without a window (SSR, a bare worker) answers `true` — the
 * preference degrades to plain newest-first, never to starvation.
 */
export function isNearViewport(node: Element): boolean {
  if (typeof window === 'undefined') return true;
  const rect = node.getBoundingClientRect();
  // Detached from the document: jsdom and real DOMs both report an all-zero
  // rect. (A mounted card is never zero-sized.)
  if (rect.width === 0 && rect.height === 0) return false;
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  return (
    rect.bottom >= -viewportHeight &&
    rect.top <= viewportHeight * 2 &&
    rect.right >= 0 &&
    rect.left <= viewportWidth
  );
}
