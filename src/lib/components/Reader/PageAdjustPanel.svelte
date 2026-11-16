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

  interface Props {
    /** The reader's B: flips the adjustment and shows its notice. */
    onToggleAdjust?: () => void;
  }

  let { onToggleAdjust }: Props = $props();

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

  // Escape closes the panel wherever focus is — and does nothing else. The
  // reader's shortcuts and the layout's global "Escape = back" are both
  // bubble-phase window listeners, and the layout's ignores
  // `defaultPrevented`, so the panel takes Escape in the capture phase and
  // stops it there (as RereadPromptModal does). A modal dialog opened above
  // the panel owns its own Escape.
  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (document.querySelector('dialog:modal')) return;
    e.preventDefault();
    e.stopPropagation();
    closePageAdjustPanel();
  }

  onMount(() => {
    // Keyboard first: A, then the arrows. No scroll — the panel is fixed.
    root?.querySelector<HTMLInputElement>('input[type="range"]')?.focus({ preventScroll: true });
    window.addEventListener('keydown', onWindowKeyDown, true);
    return () => window.removeEventListener('keydown', onWindowKeyDown, true);
  });
</script>

<div
  bind:this={root}
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
