<script lang="ts">
  /**
   * A host that can change the `covers` prop AND NOTHING ELSE.
   *
   * `@testing-library/svelte`'s `rerender` cannot express that: it replaces the whole
   * props object (`currentProps = { ...currentProps, ...next }` over a `$state.raw`), so
   * every prop read invalidates and the canvas' draw effect re-runs whichever prop was
   * actually passed. A test driven that way therefore cannot tell a tracked `covers` read
   * from an untracked one — which is the exact thing `CompositeCanvas`' `void covers;`
   * exists for, since `draw()` reads the map inside a `requestAnimationFrame` callback
   * where nothing it touches is tracked.
   *
   * Here `covers` is local state and every other prop is a value this component holds
   * still, so a redraw after {@link Props.control}'s setter runs can only have come from
   * the canvas tracking `covers` itself.
   */
  import type { VolumeMetadata } from '$lib/types';
  import CompositeCanvas from '../../CompositeCanvas.svelte';

  interface Props {
    volumes: VolumeMetadata[];
    canvasWidth: number;
    canvasHeight: number;
    getCanvasDimensions: (volumeUuid: string) => { width: number; height: number } | null;
    stepSizes: { horizontal: number; vertical: number; leftOffset: number; topOffset: number };
    /** Handed the setter for `covers`, once, while this component initialises. */
    control: (setCovers: (next: Map<string, File>) => void) => void;
  }

  let { volumes, canvasWidth, canvasHeight, getCanvasDimensions, stepSizes, control }: Props =
    $props();

  // `$state.raw`: a Map is not proxied anyway, so the reassignment IS the change — the
  // same shape the catalog card publishes its resolved covers in.
  let covers = $state.raw<Map<string, File>>(new Map());

  // Held still for the component's life, so neither can be the reason for a redraw.
  const volumeOffsets = new Map<number, number>();

  control((next) => {
    covers = next;
  });
</script>

<CompositeCanvas
  {volumes}
  {canvasWidth}
  {canvasHeight}
  {getCanvasDimensions}
  {stepSizes}
  {covers}
  {volumeOffsets}
/>
