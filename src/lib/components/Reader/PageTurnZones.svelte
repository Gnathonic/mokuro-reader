<script lang="ts">
  import { settings } from '#lib/settings/index.js';
  import {
    BACKGROUND_ZONES,
    pointOverPage,
    screenStripTurns
  } from '#lib/reader/page-turn-zones.js';

  /**
   * The invisible tap-to-turn page zones (#54). Two regions, one control each:
   *
   * - **The page image's own edge** — `edgeButtonWidth` px (camera px: the
   *   strip scales with the zoom) inward from the spread's left / right edge.
   *   `0` renders none.
   * - **Outside the image** — ALL of the background around the spread: beside
   *   it, above it and below it, out to the screen's edge at any zoom
   *   (`BACKGROUND_ZONES`), flush with the page and never reaching onto it.
   *   `tapOutsideImageToTurn` makes them buttons; off they STAY, as
   *   handler-less `aria-hidden` `[data-page-turn-zone]` boxes.
   *
   * `viewport` renders both inside PagedViewport's camera wrapper: `fixed`
   * under a transformed parent positions against the spread, so `right: 100%`
   * is the background left of the page, `left-0` the page's own left edge.
   * That wrapper holds the gesture tracker, the wheel listener and
   * `touch-action: none` — the inert boxes are what keep a swipe, wheel,
   * ctrl+wheel or pinch that starts beside the page inside it.
   * `gestureTargetRole` classes them `interactive`, so a tap there toggles
   * nothing either; only the turn is gone.
   *
   * `screen` (desktop) is the image-edge control at the SCREEN's edge, for a
   * page zoomed past the screen whose own edge is out of view: two strips of
   * `edgeButtonWidth` screen px. Over the background they sit on top of the
   * background zones, so a press there does what the background would: it
   * turns only when `tapOutsideImageToTurn` is on (`screenStripTurns`,
   * hit-tested at release against the page). The slider therefore never
   * changes what a background press does.
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
  {#each BACKGROUND_ZONES as zone (zone.label)}
    {#if outsideTurns}
      <button
        aria-label={zone.label}
        class="fixed z-10 opacity-[0.01] hover:bg-slate-400"
        style={zone.style}
        onmousedown={onPress}
        onmouseup={zone.side === 'left' ? onLeft : onRight}
      ></button>
    {:else}
      <div data-page-turn-zone aria-hidden="true" class="fixed z-10" style={zone.style}></div>
    {/if}
  {/each}
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
