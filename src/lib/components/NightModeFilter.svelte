<script lang="ts">
  import { nightModeActive } from '$lib/settings';
  import { browser } from '$app/environment';
  import { onDestroy } from 'svelte';

  // The colour maths lives in the <style> block in src/app.html, which explains
  // why night mode is a blend-layer pair plus a top-layer filter rather than one
  // filter on the root. This component owns the two layer elements.
  //
  // Both engines take the same path now: the Firefox-specific overlay branch is
  // gone, because the layers it used are what every browser uses.

  let desaturate: HTMLDivElement | null = null;
  let redden: HTMLDivElement | null = null;
  let observer: MutationObserver | null = null;

  function makeLayer(kind: 'desaturate' | 'redden') {
    const el = document.createElement('div');
    el.className = `night-mode-layer night-mode-${kind}`;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  /**
   * Keep the pair as the last two children of <html>, in this order.
   *
   * Both layers sit at the maximum z-index, so paint order against an extension
   * that injects at the same z-index is decided by tree order. If an extension
   * appends its popup after us, it would land above the desaturation layer and
   * render with its colour channels crushed instead of tinted, so we move back
   * on top whenever the root's children change.
   */
  function ensureOnTop() {
    const root = document.documentElement;
    if (!desaturate || !redden) return;
    if (root.lastElementChild === redden && redden.previousElementSibling === desaturate) return;
    root.appendChild(desaturate);
    root.appendChild(redden);
  }

  function applyNightModeFilter(active: boolean) {
    if (!browser) return;
    const root = document.documentElement;

    if (active) {
      desaturate ??= makeLayer('desaturate');
      redden ??= makeLayer('redden');
      ensureOnTop();

      // Only observe the root's own child list — this fires on extension
      // injection, not on anything the app renders inside <body>.
      observer ??= new MutationObserver(ensureOnTop);
      observer.observe(root, { childList: true });
    } else {
      observer?.disconnect();
      observer = null;
      desaturate?.remove();
      redden?.remove();
      desaturate = null;
      redden = null;
    }

    // Gates the layer styles.
    root.classList.toggle('night-mode', active);

    // Drives the top-layer rules (modal dialogs, popovers, fullscreen,
    // ::backdrop) — those paint above the layers, so they filter themselves.
    root.style.setProperty('--night-mode-filter', active ? 'url(#night-mode-filter)' : 'none');
  }

  // React to nightModeActive store changes (includes schedule-based activation)
  $: if (browser) {
    applyNightModeFilter($nightModeActive);
  }

  onDestroy(() => {
    if (browser) applyNightModeFilter(false);
  });
</script>

<!-- No markup: the two blend layers are appended to <html>, above everything. -->
