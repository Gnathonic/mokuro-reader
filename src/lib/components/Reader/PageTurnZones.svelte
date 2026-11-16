<script lang="ts">
  import { settings } from '#lib/settings/index.js';
  import { pointOverPage, screenStripTurns } from '#lib/reader/page-turn-zones.js';

  /**
   * The invisible tap-to-turn page zones (#54). Two regions, one control each:
   *
   * - **The page image's own edge** — `edgeButtonWidth` px (camera px: the
   *   strip scales with the zoom) inward from the spread's left / right edge.
   *   `0` renders none.
   * - **Outside the image** — the background beside the page and the band
   *   below it, flush with the page and never reaching onto it.
   *   `tapOutsideImageToTurn` makes them buttons; off they STAY, as
   *   handler-less `aria-hidden` `[data-page-turn-zone]` boxes.
   *
   * `viewport` renders both inside PagedViewport's camera wrapper: `fixed`
   * under a transformed parent positions against the spread, so `-left-full`
   * is the background left of the page, `left-0` the page's own left edge.
   * That wrapper holds the gesture tracker, the wheel listener and
   * `touch-action: none` — the inert boxes are what keep a swipe, wheel,
   * ctrl+wheel or pinch that starts beside the page inside it.
   * `gestureTargetRole` classes them `interactive`, so a tap there toggles
   * nothing either; only the turn is gone.
   *
   * `screen` (desktop) is the image-edge control at the SCREEN's edge, for a
   * page zoomed past the screen whose own edge is out of view: two strips of
   * `edgeButtonWidth` screen px. Over the background they would be the other
   * region, so a press there turns only when `tapOutsideImageToTurn` is on
   * (`screenStripTurns`, hit-tested at release against the page).
   */
  interface Props {
    variant: 'viewport' | 'screen';
    onPress: () => void;
    onLeft: (e: MouseEvent) => void;
    onRight: (e: MouseEvent) => void;
    /** Is a client point over the page image? Injected by tests. */
    overPage?: (x: number, y: number) => boolean;
  }

  let { variant, onPress, onLeft, onRight, overPage = pointOverPage }: Props = $props();

  let outsideTurns = $derived($settings.tapOutsideImageToTurn !== false);
  let edgeWidth = $derived(Math.max(0, Number($settings.edgeButtonWidth) || 0));

  function screenRelease(e: MouseEvent, turn: (e: MouseEvent) => void) {
    if (screenStripTurns(overPage(e.clientX, e.clientY), outsideTurns)) turn(e);
  }
</script>

{#if variant === 'viewport'}
  {#if outsideTurns}
    <button
      aria-label="Previous page (left background)"
      class="fixed -left-full z-10 h-full w-full opacity-[0.01] hover:bg-slate-400"
      onmousedown={onPress}
      onmouseup={onLeft}
    ></button>
    <button
      aria-label="Next page (right background)"
      class="fixed -right-full z-10 h-full w-full opacity-[0.01] hover:bg-slate-400"
      onmousedown={onPress}
      onmouseup={onRight}
    ></button>
    <button
      aria-label="Previous page (below, left)"
      class="fixed top-full -left-full z-10 h-screen w-[150%] opacity-[0.01] hover:bg-slate-400"
      onmousedown={onPress}
      onmouseup={onLeft}
    ></button>
    <button
      aria-label="Next page (below, right)"
      class="fixed top-full -right-full z-10 h-screen w-[150%] opacity-[0.01] hover:bg-slate-400"
      onmousedown={onPress}
      onmouseup={onRight}
    ></button>
  {:else}
    <div data-page-turn-zone aria-hidden="true" class="fixed -left-full z-10 h-full w-full"></div>
    <div data-page-turn-zone aria-hidden="true" class="fixed -right-full z-10 h-full w-full"></div>
    <div
      data-page-turn-zone
      aria-hidden="true"
      class="fixed top-full -left-full z-10 h-screen w-[150%]"
    ></div>
    <div
      data-page-turn-zone
      aria-hidden="true"
      class="fixed top-full -right-full z-10 h-screen w-[150%]"
    ></div>
  {/if}
  {#if edgeWidth > 0}
    <button
      aria-label="Previous page (left page edge)"
      class="fixed top-0 left-0 z-10 h-full opacity-[0.01] hover:bg-slate-400"
      style:width={`${edgeWidth}px`}
      onmousedown={onPress}
      onmouseup={onLeft}
    ></button>
    <button
      aria-label="Next page (right page edge)"
      class="fixed top-0 right-0 z-10 h-full opacity-[0.01] hover:bg-slate-400"
      style:width={`${edgeWidth}px`}
      onmousedown={onPress}
      onmouseup={onRight}
    ></button>
  {/if}
{:else if edgeWidth > 0}
  <button
    aria-label="Previous page (left screen edge)"
    onmousedown={onPress}
    onmouseup={(e) => screenRelease(e, onLeft)}
    class="absolute top-0 left-0 h-full opacity-[0.01] hover:bg-slate-400"
    style:width={`${edgeWidth}px`}
  ></button>
  <button
    aria-label="Next page (right screen edge)"
    onmousedown={onPress}
    onmouseup={(e) => screenRelease(e, onRight)}
    class="absolute top-0 right-0 h-full opacity-[0.01] hover:bg-slate-400"
    style:width={`${edgeWidth}px`}
  ></button>
{/if}
