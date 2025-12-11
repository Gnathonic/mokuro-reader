import type { Page, Block } from '$lib/types';

export class OcrState {
  // --- Raw State ---
  page = $state<Page | null>(null);

  // Track numeric scale instead of Panzoom instance
  currentScale = $state(1);

  overlayElement = $state<HTMLElement | null>(null);

  // --- Modes ---
  // Simplified: Only BOX (Layout) or TEXT (Content)
  ocrMode = $state<'BOX' | 'TEXT'>('BOX');
  isSmartResizeMode = $state(false);
  showTriggerOutline = $state(false);
  readingDirection = $state('rtl');

  // --- Focus Tracking ---
  focusedBlock = $state<Block | null>(null);

  // --- Callbacks ---
  onOcrChange = $state<() => void>(() => { });
  onLineFocus = $state<(block: Block | null, page: Page | null) => void>(() => { });

  constructor(init?: Partial<OcrState>) {
    Object.assign(this, init);
  }

  // --- Derived State ---
  fontScale = $derived.by(() => {
    if (!this.overlayElement || !this.page) return 1;

    // Font calculation adapted for manual CSS scale
    const container = this.overlayElement.parentElement;
    if (!container) return 1;

    const rect = container.getBoundingClientRect();
    if (!rect.height) return 1;

    // Logic: Rendered Height / Image Height / Zoom
    return rect.height / this.page.img_height / this.currentScale * devicePixelRatio;
  });

  imgWidth = $derived(this.page?.img_width ?? 0);
  imgHeight = $derived(this.page?.img_height ?? 0);

  // --- Actions ---
  markDirty() {
    this.onOcrChange();
  }

  setMode(mode: 'BOX' | 'TEXT') {
    this.ocrMode = mode;
  }

  setFocus(block: Block | null) {
    this.focusedBlock = block;
    this.onLineFocus(block, this.page);
  }
}
