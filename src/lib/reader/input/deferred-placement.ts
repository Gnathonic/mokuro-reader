/**
 * A view placement deferred to the next animation frame that input can pull
 * forward — never one that lands on top of the input.
 *
 * The continuous strips place their opening view (the reader's page at the
 * top, or a spread centred) one frame after they mount, so layout has
 * settled. A key pressed in between — Page Down right after switching into
 * continuous mode — used to act first and then be overwritten when the frame
 * ran: the strip scrolled, then snapped back to the opening page, and the
 * press was lost.
 *
 * Each surface's MotionGate calls `flush()` before any motion starts, so the
 * placement happens FIRST, synchronously, and the input then acts on the
 * placed view; the frame finds nothing left to do.
 */
export class DeferredPlacement {
  private place: (() => void) | null = null;
  private frame: number | null = null;

  /** Run `place` on the next animation frame, unless flushed first. */
  schedule(place: () => void): void {
    this.cancel();
    this.place = place;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.flush();
    });
  }

  /** Run the pending placement now (no-op when none is pending). */
  flush(): void {
    const place = this.place;
    if (!place) return;
    this.cancel();
    place();
  }

  /** Drop the pending placement without running it. */
  cancel(): void {
    this.place = null;
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  get pending(): boolean {
    return this.place !== null;
  }
}
