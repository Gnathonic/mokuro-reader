<script lang="ts">
  /**
   * An image crop on cropperjs 2's web components, for the cover picker and the
   * Anki card modal.
   *
   * cropperjs 2 supplies the interaction — dragging and resizing the selection,
   * drawing a new one, the handles, guides and shade, all styled from inside each
   * element's shadow root through constructed (adopted) stylesheets, which no
   * `style-src` rule applies to. The rest is here, because v2 leaves it out:
   *
   *   - the image is fitted (contain, centred) by this component, and refitted
   *     whenever the crop area changes size, keeping the crop where it was ON
   *     THE IMAGE (cropperjs 1 reset it on a window resize; the Anki modal used
   *     to restore it by hand);
   *   - the selection is kept inside the image (v1's `viewMode: 1`), see
   *     `constrainSelection`;
   *   - a new box (`drawable`) is drawn here, not by cropperjs: from the press
   *     clamped onto the image to the pointer, as v1 drew it (`drawnRect`);
   *   - the image never moves, zooms or turns under the pointer or the wheel —
   *     only `rotate()` turns it, a quarter at a time;
   *   - the output is cut from the image at natural size (`toCanvas`), to the
   *     same pixel size cropperjs 1's `getCroppedCanvas()` gave (`croppedCanvasPlan`).
   *
   * Every crop the parent sees is in image pixels of the turned image
   * (`crop-geometry.ts`), unrounded, like v1's `getData()`.
   */
  import 'cropperjs';
  import type { CropperCanvas, CropperImage, CropperSelection } from 'cropperjs';
  import { onMount } from 'svelte';
  import {
    clampMove,
    clampPoint,
    constrainSelection,
    containLayout,
    croppedCanvasPlan,
    drawnRect,
    fullImageRect,
    layoutBounds,
    layoutMatrix,
    nextQuarterTurn,
    rotatedSize,
    sameRect,
    toFrameRect,
    toImageRect,
    type CropRect,
    type ImageLayout,
    type Point,
    type QuarterTurn
  } from '$lib/util/crop-geometry';

  interface Props {
    src: string;
    alt?: string;
    /** The crop to start from (and to go back to on `reset()`), in image pixels. */
    initialCrop?: (width: number, height: number) => CropRect;
    /** Dragging outside the selection draws a new one (v1's `dragMode: 'crop'`). */
    drawable?: boolean;
    /** Large, always-visible resize handles (the Anki modal's). */
    largeHandles?: boolean;
    /** The image has loaded and the first crop is placed. */
    onready?: () => void;
    /** The crop changed (placed, dragged, resized, set, reset or turned). */
    onchange?: (crop: CropRect) => void;
  }

  let {
    src,
    alt = 'Crop preview',
    initialCrop = fullImageRect,
    drawable = false,
    largeHandles = false,
    onready,
    onchange
  }: Props = $props();

  let wrapperEl: HTMLDivElement;
  let canvasEl: CropperCanvas;
  let imageEl: CropperImage;
  let selectionEl: CropperSelection;

  let image: HTMLImageElement | null = null;
  let rotation: QuarterTurn = 0;
  let layout: ImageLayout | null = null;
  /** The crop, in image pixels of the turned image: what survives a refit. */
  let crop: CropRect | null = null;
  /** True while this component moves the selection itself. */
  let placing = false;
  let readyFired = false;
  /**
   * The new box being drawn: where the press was, clamped onto the image, and
   * the selection's shape when it began (what Shift keeps), in frame pixels.
   */
  let drawing: { anchor: Point; aspectRatio: number } | null = null;

  function turnedSize() {
    return image ? rotatedSize(image.naturalWidth, image.naturalHeight, rotation) : null;
  }

  /** `$setTransform` is a no-op on an image that is not transformable. */
  function setImageTransform(matrix: number[]) {
    const scalable = imageEl.scalable;
    imageEl.scalable = true;
    try {
      imageEl.$setTransform(matrix);
    } finally {
      imageEl.scalable = scalable;
    }
  }

  function placeSelection() {
    if (!layout || !crop) return;
    const frame = toFrameRect(crop, layout);
    placing = true;
    try {
      selectionEl.$change(frame.x, frame.y, frame.width, frame.height);
    } finally {
      placing = false;
    }
  }

  function commit(next: CropRect) {
    crop = next;
    placeSelection();
    onchange?.(next);
  }

  /** Fit the image to the frame as it is now, and put the crop back on it. */
  function relayout() {
    if (!image || !canvasEl) return;
    const frameWidth = canvasEl.clientWidth;
    const frameHeight = canvasEl.clientHeight;
    if (frameWidth === 0 || frameHeight === 0) return;
    const { naturalWidth, naturalHeight } = image;
    layout = containLayout(naturalWidth, naturalHeight, rotation, frameWidth, frameHeight);
    setImageTransform(layoutMatrix(naturalWidth, naturalHeight, rotation, layout));
    if (crop) {
      placeSelection();
    } else {
      const size = turnedSize()!;
      commit(
        clampMove(initialCrop(size.width, size.height), fullImageRect(size.width, size.height))
      );
    }
    if (!readyFired) {
      readyFired = true;
      onready?.();
    }
  }

  function handleSelectionChange(event: Event) {
    if (placing || !layout) return;
    const { detail } = event as CustomEvent<CropRect>;
    if (!detail) return;
    const current = {
      x: selectionEl.x,
      y: selectionEl.y,
      width: selectionEl.width,
      height: selectionEl.height
    };
    const next = constrainSelection(detail, current, layoutBounds(layout));
    if (!next) {
      event.preventDefault();
      return;
    }
    if (!sameRect(next, detail)) {
      // Refuse the change as asked and make the one inside the image instead.
      event.preventDefault();
      commit(toImageRect(next, layout));
      return;
    }
    crop = toImageRect(next, layout);
    onchange?.(crop);
  }

  /** A page-coordinate point (cropperjs's `pageX`/`pageY`) in frame pixels. */
  function framePoint(pageX: number, pageY: number): Point {
    const box = canvasEl.getBoundingClientRect();
    return { x: pageX - (box.left + window.scrollX), y: pageY - (box.top + window.scrollY) };
  }

  interface ActionDetail {
    action?: string;
    relatedEvent?: { pageX: number; pageY: number; shiftKey?: boolean };
    endX?: number;
    endY?: number;
  }

  /*
   * Drawing a new box. The canvas announces every gesture as `actionstart`,
   * `action` (per pointer move) and `actionend` events; these listeners run in
   * the capture phase on the wrapper, so before the selection's own. cropperjs
   * would draw its first box from the raw press — wholly outside the image for
   * a press in the margin, so `constrainSelection` refuses it — and then switch
   * the gesture to resizing a corner of whatever selection there is, refused
   * or not: the old crop would follow the mouse from anywhere in the frame.
   * Instead the press is clamped onto the image and the box drawn from there,
   * and the selection never sees the `select` gesture's moves.
   */
  function handleActionStart(event: Event) {
    drawing = null;
    const { detail } = event as CustomEvent<ActionDetail | undefined>;
    if (!drawable || !layout || detail?.action !== 'select' || !detail.relatedEvent) return;
    const { pageX, pageY } = detail.relatedEvent;
    drawing = {
      anchor: clampPoint(framePoint(pageX, pageY), layoutBounds(layout)),
      aspectRatio: selectionEl.width / selectionEl.height
    };
  }

  function handleAction(event: Event) {
    const { detail } = event as CustomEvent<ActionDetail | undefined>;
    if (!drawing || !layout || detail?.action !== 'select') return;
    // The selection skips an action whose default is prevented.
    event.preventDefault();
    if (detail.endX === undefined || detail.endY === undefined) return;
    const pointer = clampPoint(framePoint(detail.endX, detail.endY), layoutBounds(layout));
    const shape = detail.relatedEvent?.shiftKey ? drawing.aspectRatio : undefined;
    const rect = drawnRect(drawing.anchor, pointer, shape);
    if (rect) commit(toImageRect(rect, layout));
  }

  function handleActionEnd() {
    drawing = null;
  }

  /**
   * The canvas swallows every wheel event (it zooms on the wheel, and calls
   * `preventDefault` even when nothing may zoom), which would stop the modal
   * scrolling under the pointer. Nothing here zooms: keep the wheel from it.
   */
  function keepWheelFromCanvas(event: WheelEvent) {
    event.stopPropagation();
  }

  onMount(() => {
    let disposed = false;
    imageEl
      .$ready()
      .then((loaded) => {
        if (disposed) return;
        image = loaded;
        relayout();
      })
      .catch((err: unknown) => console.error('ImageCropper: the image did not load', err));
    const resizeObserver = new ResizeObserver(() => relayout());
    resizeObserver.observe(canvasEl);
    selectionEl.addEventListener('change', handleSelectionChange);
    wrapperEl.addEventListener('actionstart', handleActionStart, true);
    wrapperEl.addEventListener('action', handleAction, true);
    wrapperEl.addEventListener('actionend', handleActionEnd, true);
    return () => {
      disposed = true;
      resizeObserver.disconnect();
      selectionEl.removeEventListener('change', handleSelectionChange);
      wrapperEl.removeEventListener('actionstart', handleActionStart, true);
      wrapperEl.removeEventListener('action', handleAction, true);
      wrapperEl.removeEventListener('actionend', handleActionEnd, true);
    };
  });

  /** The crop in image pixels of the turned image, or null before the image is placed. */
  export function getCrop(): CropRect | null {
    return crop ? { ...crop } : null;
  }

  /** The turned image's natural size, or null before it has loaded. */
  export function getImageSize(): { width: number; height: number } | null {
    return turnedSize();
  }

  /** Set the crop, in image pixels; kept inside the image. */
  export function setCrop(rect: CropRect) {
    const size = turnedSize();
    if (!size) return;
    commit(clampMove(rect, fullImageRect(size.width, size.height)));
  }

  /** Back to the image unturned and the initial crop. */
  export function reset() {
    if (!image) return;
    rotation = 0;
    crop = null;
    relayout();
  }

  /**
   * Turn the image a quarter clockwise and refit it. The selection keeps its
   * place on screen, moved and shrunk just enough to stay on the turned image —
   * as cropperjs 1's `rotate(90)` left it.
   */
  export function rotate() {
    const frameWidth = canvasEl.clientWidth;
    const frameHeight = canvasEl.clientHeight;
    if (!image || !layout || !crop || frameWidth === 0 || frameHeight === 0) return;
    const onScreen = toFrameRect(crop, layout);
    rotation = nextQuarterTurn(rotation);
    const { naturalWidth, naturalHeight } = image;
    layout = containLayout(naturalWidth, naturalHeight, rotation, frameWidth, frameHeight);
    setImageTransform(layoutMatrix(naturalWidth, naturalHeight, rotation, layout));
    commit(toImageRect(clampMove(onScreen, layoutBounds(layout)), layout));
  }

  /** The crop at the image's natural resolution, or null before the image is placed. */
  export function toCanvas(): HTMLCanvasElement | null {
    const size = turnedSize();
    if (!image || !crop || !size) return null;
    const plan = croppedCanvasPlan(crop, size.width, size.height);
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext('2d');
    if (!context || !plan.drawParams) return canvas;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    const source = rotation === 0 ? image : turnedSource(image, rotation, size);
    if (!source) return canvas;
    context.drawImage(source, ...plan.drawParams);
    return canvas;
  }

  /** The image turned by `rotation` at natural size, pixel for pixel. */
  function turnedSource(
    source: HTMLImageElement,
    turn: QuarterTurn,
    size: { width: number; height: number }
  ): HTMLCanvasElement | null {
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    // Whole-pixel offsets only, so the turn moves pixels and resamples none.
    if (turn === 90) context.translate(size.width, 0);
    else if (turn === 180) context.translate(size.width, size.height);
    else if (turn === 270) context.translate(0, size.height);
    context.rotate((turn * Math.PI) / 180);
    context.drawImage(source, 0, 0);
    return canvas;
  }
</script>

<div
  bind:this={wrapperEl}
  class="image-cropper"
  class:large-handles={largeHandles}
  onwheelcapture={keepWheelFromCanvas}
>
  <cropper-canvas bind:this={canvasEl} background>
    <cropper-image bind:this={imageEl} {src} {alt}></cropper-image>
    <cropper-shade hidden theme-color="rgba(0, 0, 0, 0.5)"></cropper-shade>
    {#if drawable}
      <cropper-handle action="select" plain></cropper-handle>
    {/if}
    <cropper-selection bind:this={selectionEl} movable resizable precise outlined>
      <cropper-grid role="grid" covered theme-color="rgba(238, 238, 238, 0.5)"></cropper-grid>
      <cropper-crosshair centered theme-color="rgba(238, 238, 238, 0.75)"></cropper-crosshair>
      <cropper-handle action="move" plain></cropper-handle>
      <cropper-handle action="n-resize"></cropper-handle>
      <cropper-handle action="e-resize"></cropper-handle>
      <cropper-handle action="s-resize"></cropper-handle>
      <cropper-handle action="w-resize"></cropper-handle>
      <cropper-handle action="ne-resize"></cropper-handle>
      <cropper-handle action="nw-resize"></cropper-handle>
      <cropper-handle action="se-resize"></cropper-handle>
      <cropper-handle action="sw-resize"></cropper-handle>
    </cropper-selection>
  </cropper-canvas>
</div>

<style>
  .image-cropper,
  cropper-canvas {
    display: block;
    width: 100%;
    height: 100%;
  }

  /*
   * The Anki modal's handles: 20 px squares on the corners and 40×20 px bars on
   * the edges, always visible (they were cropperjs 1 "points" restyled the same
   * way). The element is the hit area, its ::after the visible handle; each
   * edge's hit area stays the full edge.
   */
  .large-handles cropper-handle[action$='-resize'] {
    width: 20px;
    height: 20px;
  }
  .large-handles cropper-handle[action$='-resize']::after {
    width: 20px;
    height: 20px;
  }
  .large-handles cropper-handle[action='n-resize'],
  .large-handles cropper-handle[action='s-resize'] {
    width: 100%;
  }
  .large-handles cropper-handle[action='n-resize']::after,
  .large-handles cropper-handle[action='s-resize']::after {
    width: 40px;
  }
  .large-handles cropper-handle[action='e-resize'],
  .large-handles cropper-handle[action='w-resize'] {
    height: 100%;
  }
  .large-handles cropper-handle[action='e-resize']::after,
  .large-handles cropper-handle[action='w-resize']::after {
    height: 40px;
  }
  .large-handles cropper-handle[action='n-resize'],
  .large-handles cropper-handle[action='ne-resize'],
  .large-handles cropper-handle[action='nw-resize'] {
    top: -10px;
  }
  .large-handles cropper-handle[action='s-resize'],
  .large-handles cropper-handle[action='se-resize'],
  .large-handles cropper-handle[action='sw-resize'] {
    bottom: -10px;
  }
  .large-handles cropper-handle[action='e-resize'],
  .large-handles cropper-handle[action='ne-resize'],
  .large-handles cropper-handle[action='se-resize'] {
    right: -10px;
  }
  .large-handles cropper-handle[action='w-resize'],
  .large-handles cropper-handle[action='nw-resize'],
  .large-handles cropper-handle[action='sw-resize'] {
    left: -10px;
  }
</style>
