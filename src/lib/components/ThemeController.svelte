<!-- src/lib/components/ThemeController.svelte -->
<script lang="ts">
  import { activeTheme } from '$lib/settings';
  import { browser } from '$app/environment';
  import { onDestroy } from 'svelte';

  // Track which custom properties we set last time so we can clear stale ones
  // when switching to a theme that defines fewer variables (e.g. Dark).
  let appliedKeys = new Set<string>();

  function applyTheme(theme: { id: string; base: 'light' | 'dark'; vars: Record<string, string> }) {
    if (!browser) return;
    const root = document.documentElement;

    // `.dark` is kept ON for every theme. The app is dark-first, so all components
    // (including ones with only bare dark utilities) read the dark-mode colour slots;
    // themes repaint those slots via CSS variables. A light theme is the dark layout
    // with light-valued slots — see deriveVars() in settings/theme.ts.
    root.classList.add('dark');

    root.dataset.theme = theme.id;

    const nextKeys = new Set(Object.keys(theme.vars));
    // Remove variables from the previous theme that the new one does not set.
    for (const key of appliedKeys) {
      if (!nextKeys.has(key)) root.style.removeProperty(key);
    }
    for (const [key, value] of Object.entries(theme.vars)) {
      root.style.setProperty(key, value);
    }
    appliedKeys = nextKeys;
  }

  // Legacy reactive syntax matches NightModeFilter.svelte (also a controller component).
  $: if (browser) applyTheme($activeTheme);

  onDestroy(() => {
    if (!browser) return;
    const root = document.documentElement;
    for (const key of appliedKeys) root.style.removeProperty(key);
  });
</script>

<!-- No visible output: applies theme variables to <html>. -->
