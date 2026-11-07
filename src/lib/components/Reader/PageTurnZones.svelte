<script lang="ts">
  import { settings } from '$lib/settings';

  /**
   * The invisible tap-to-turn page zones (#54).
   *
   * - `viewport`: four buttons rendered INSIDE the paged viewport — the page
   *   margins either side of the page (inset by `edgeButtonWidth`) and the two
   *   bottom corners.
   * - `screen`: two absolute strips of `edgeButtonWidth` against the screen's
   *   own left/right edge, outside the viewport.
   *
   * With `tapPageEdgesToTurn` off the zones are not rendered at all, so a tap
   * where one used to be lands on the viewport's wrapper like a tap on any
   * other empty reader space (it toggles the overlays). Swipes, keyboard,
   * wheel and the quick-actions menu never went through these buttons.
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
{/if}
