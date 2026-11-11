<script lang="ts">
  import { settings } from '$lib/settings';

  /**
   * The invisible tap-to-turn page zones (#54).
   *
   * - `viewport`: four buttons rendered INSIDE the paged viewport — the page
   *   margins either side of the page (reaching `edgeButtonWidth` px onto the
   *   page's own edge) and the two bottom corners.
   * - `screen`: two absolute strips of `edgeButtonWidth` against the screen's
   *   own left/right edge, outside the viewport.
   *
   * With `tapPageEdgesToTurn` off the `viewport` zones STAY, as handler-less
   * `aria-hidden` boxes (`data-page-turn-zone`) over the margins — flush with
   * the page, without the `edgeButtonWidth` reach that would lay them over the
   * page's edge and its text boxes. They are children of PagedViewport's
   * camera wrapper and overflow it into the margins, and that wrapper is where
   * the gesture tracker, the wheel listener and `touch-action: none` live:
   * without them a swipe, wheel, ctrl+wheel or pinch that starts beside or
   * below the page would land outside the wrapper — no page flip, and the
   * browser would scroll / page-zoom natively. `gestureTargetRole` classes
   * them `interactive`, so a tap on one toggles nothing, exactly like the
   * buttons it replaces; only the turn is gone. The `screen` strips sit
   * outside the wrapper, so they simply go — the viewport zones beneath take
   * the events.
   */
  interface Props {
    variant: 'viewport' | 'screen';
    onPress: () => void;
    onLeft: (e: MouseEvent) => void;
    onRight: (e: MouseEvent) => void;
  }

  let { variant, onPress, onLeft, onRight }: Props = $props();
</script>

{#if $settings.tapPageEdgesToTurn !== false}
  {#if variant === 'viewport'}
    <button
      aria-label="Previous page (left edge)"
      class="fixed -left-full z-10 h-full w-full opacity-[0.01] hover:bg-slate-400"
      style:margin-left={`${$settings.edgeButtonWidth}px`}
      onmousedown={onPress}
      onmouseup={onLeft}
    ></button>
    <button
      aria-label="Next page (right edge)"
      class="fixed -right-full z-10 h-full w-full opacity-[0.01] hover:bg-slate-400"
      style:margin-right={`${$settings.edgeButtonWidth}px`}
      onmousedown={onPress}
      onmouseup={onRight}
    ></button>
    <button
      aria-label="Previous page (bottom left)"
      class="fixed top-full -left-full z-10 h-screen w-[150%] opacity-[0.01] hover:bg-slate-400"
      onmousedown={onPress}
      onmouseup={onLeft}
    ></button>
    <button
      aria-label="Next page (bottom right)"
      class="fixed top-full -right-full z-10 h-screen w-[150%] opacity-[0.01] hover:bg-slate-400"
      onmousedown={onPress}
      onmouseup={onRight}
    ></button>
  {:else}
    <button
      aria-label="Previous page (left edge)"
      onmousedown={onPress}
      onmouseup={onLeft}
      class="absolute top-0 left-0 h-full w-16 opacity-[0.01] hover:bg-slate-400"
      style:width={`${$settings.edgeButtonWidth}px`}
    ></button>
    <button
      aria-label="Next page (right edge)"
      onmousedown={onPress}
      onmouseup={onRight}
      class="absolute top-0 right-0 h-full w-16 opacity-[0.01] hover:bg-slate-400"
      style:width={`${$settings.edgeButtonWidth}px`}
    ></button>
  {/if}
{:else if variant === 'viewport'}
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
