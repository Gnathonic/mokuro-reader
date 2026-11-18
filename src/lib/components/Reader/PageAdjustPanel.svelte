<script lang="ts">
  /**
   * Brightness and contrast, adjusted over the page (#362, #363) — see
   * `reader/page-adjust-panel.ts` for why this is not in the settings drawer.
   *
   * Non-modal and in normal flow, NOT a `<dialog>`: no backdrop, no top layer
   * (so night mode's blend layers cover it like the rest of the reader HUD,
   * with no filter of its own), and the page keeps taking turns, taps and keys
   * while it is open. Nothing in it moves or resizes while it is used: the
   * values are fixed-width tabular figures, the reset buttons are disabled at
   * the default rather than hidden, and switching the adjustment off only
   * fades the rows.
   */
  import { onMount } from 'svelte';
  import { Range, Toggle } from 'flowbite-svelte';
  import { CloseOutline, UndoOutline } from 'flowbite-svelte-icons';
  import { settings, updateSetting } from '#lib/settings/index.js';
  import {
    PAGE_ADJUST_DEFAULT,
    PAGE_ADJUST_MAX,
    PAGE_ADJUST_MIN,
    PAGE_ADJUST_STEP,
    clampPageAdjust,
    sanitizePageAdjustEnabled
  } from '#lib/reader/page-filter.js';
  import { PAGE_ADJUST_PANEL_KEY, closePageAdjustPanel } from '#lib/reader/page-adjust-panel.js';
  import { bottomOverlay } from '#lib/reader/bottom-overlay.js';

  interface Props {
    /** The reader's B: flips the adjustment and shows its notice. */
    onToggleAdjust?: () => void;
    /**
     * Escape outside the panel that no focused control took: the reader
     * closes another non-modal control opened over it that listens for
     * Escape on the window (the layer picker, the page-number popover, a text
     * box menu, an edit-mode selection or draw tool) and returns true, or
     * returns false when there is none — then the Escape is the panel's.
     */
    onEscapeElsewhere?: () => boolean;
  }

  let { onToggleAdjust, onEscapeElsewhere }: Props = $props();

  type AdjustKey = 'pageBrightness' | 'pageContrast';
  const sliders: { key: AdjustKey; label: string }[] = [
    { key: 'pageBrightness', label: 'Brightness' },
    { key: 'pageContrast', label: 'Contrast' }
  ];

  let enabled = $derived(sanitizePageAdjustEnabled($settings.pageAdjustEnabled));
  let root: HTMLElement | undefined = $state();

  // Live: the page under the panel follows the thumb. Moving a slider while
  // the adjustment is off switches it back on — otherwise the drag shows
  // nothing.
  function onInput(key: AdjustKey, e: Event) {
    updateSetting(key, clampPageAdjust(Number((e.target as HTMLInputElement).value)));
    if (!enabled) updateSetting('pageAdjustEnabled', true);
  }

  // The reader stands its shortcuts down for keys typed in here
  // (`keyboardShouldIgnore`, `[data-reader-panel]`), so the panel answers the
  // ones that concern it itself: A closes it, B flips the adjustment. Arrows,
  // Page Up/Down and Home/End stay the sliders'.
  function onKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.code === PAGE_ADJUST_PANEL_KEY) {
      e.preventDefault();
      closePageAdjustPanel();
    } else if (e.code === 'KeyB') {
      e.preventDefault();
      onToggleAdjust?.();
    }
  }

  // While the panel is open, Escape never leaves the reader, and one Escape
  // closes one thing, the latest first. The reader's shortcuts and the
  // layout's global "Escape = back" are both bubble-phase WINDOW listeners,
  // and the layout's ignores `defaultPrevented`, so the panel stops Escape on
  // its way up at the DOCUMENT — after every element on the path has had it,
  // before either window listener does:
  //  - a control with the focus that handles its own Escape (the OCR text
  //    editor, a popover's field, …) gets it first and stops it, so it never
  //    gets here; one that only prevents the default is left at that;
  //  - a modal dialog above the panel handles its own;
  //  - with focus outside the panel, a reader control opened over it that
  //    listens on the window (`onEscapeElsewhere`: the layer picker, the
  //    page-number popover, a text box menu, an edit-mode selection or draw
  //    tool) closes;
  //  - only then the panel itself.
  function onDocumentKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (document.querySelector('dialog:modal')) return;
    e.stopPropagation();
    if (e.defaultPrevented) return;
    e.preventDefault();
    const inPanel = root?.contains(e.target as Node) ?? false;
    if (!inPanel && onEscapeElsewhere?.()) return;
    closePageAdjustPanel();
  }

  function focusFirstSlider() {
    root?.querySelector<HTMLInputElement>('input[type="range"]')?.focus({ preventScroll: true });
  }

  onMount(() => {
    // Keyboard first: A, then the arrows. No scroll — the panel is fixed.
    focusFirstSlider();
    // Opened from the drawer's card, the panel mounts while the drawer's
    // <dialog> is still modal (closing), which makes the rest of the page
    // inert: that focus() did nothing, and closing the dialog then puts focus
    // back on whatever opened the drawer. Take it once the dialog has closed —
    // its `close` event fires after that restore.
    const pending = [...document.querySelectorAll('dialog')].filter((d) => d.matches(':modal'));
    if (document.activeElement !== root?.querySelector('input[type="range"]')) {
      for (const d of pending) d.addEventListener('close', focusFirstSlider, { once: true });
    }
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      document.removeEventListener('keydown', onDocumentKeyDown);
      for (const d of pending) d.removeEventListener('close', focusFirstSlider);
    };
  });
</script>

<div
  bind:this={root}
  use:bottomOverlay
  data-reader-panel
  data-page-adjust-panel
  role="dialog"
  aria-modal="false"
  aria-label="Page image"
  tabindex="-1"
  onkeydown={onKeyDown}
  class="fixed right-3 bottom-[4.5rem] left-3 z-20 rounded-xl border border-gray-200 bg-white px-3 py-2 text-gray-900 shadow-lg sm:right-auto sm:bottom-3 sm:left-1/2 sm:w-[26rem] sm:-translate-x-1/2 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
>
  <div class="flex items-center gap-2">
    <Toggle
      size="small"
      checked={enabled}
      onchange={() => updateSetting('pageAdjustEnabled', !enabled)}
      class="min-w-0"
    >
      <span class="truncate text-sm font-medium text-gray-900 dark:text-white"
        >Brightness &amp; contrast</span
      >
      <span class="ml-1.5 text-xs text-gray-500 dark:text-gray-400">(B)</span>
    </Toggle>
    <button
      type="button"
      class="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
      aria-label="Close"
      title="Close (Esc or A)"
      onclick={closePageAdjustPanel}
    >
      <CloseOutline class="h-4 w-4" />
    </button>
  </div>
  <div class="mt-1 transition-opacity duration-150" class:opacity-50={!enabled}>
    {#each sliders as { key, label } (key)}
      {@const value = clampPageAdjust($settings[key])}
      <div class="grid h-8 grid-cols-[5.25rem_1fr_3rem_1.75rem] items-center gap-2">
        <label for={`page-adjust-panel-${key}`} class="text-sm">{label}</label>
        <Range
          id={`page-adjust-panel-${key}`}
          size="sm"
          min={PAGE_ADJUST_MIN}
          max={PAGE_ADJUST_MAX}
          step={PAGE_ADJUST_STEP}
          {value}
          aria-valuetext={`${value}%`}
          oninput={(e: Event) => onInput(key, e)}
        />
        <span class="text-right text-sm tabular-nums" data-value={key}>{value}%</span>
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:pointer-events-none disabled:opacity-30 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
          aria-label={`Reset ${label.toLowerCase()}`}
          title={`Reset to ${PAGE_ADJUST_DEFAULT}%`}
          disabled={value === PAGE_ADJUST_DEFAULT}
          onclick={() => updateSetting(key, PAGE_ADJUST_DEFAULT)}
        >
          <UndoOutline class="h-4 w-4" />
        </button>
      </div>
    {/each}
  </div>
</div>
