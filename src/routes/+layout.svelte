<script lang="ts">
  import '../app.postcss';
  import { dev } from '$app/environment';
  import { inject } from '@vercel/analytics';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { settings } from '$lib/settings';
  import NavBar from '$lib/components/NavBar.svelte';
  import Snackbar from '$lib/components/Snackbar.svelte';
  import ConfirmationPopup from '$lib/components/ConfirmationPopup.svelte';

  inject({ mode: dev ? 'development' : 'production' });

  // Keep or remove the Tailwind `dark` root class depending on user setting.
  // Default to dark theme, which existed prior to adding the theme option.
  onMount(() => {
    const apply = (darkMode: boolean) => {
      if (darkMode) document.documentElement.classList.add('dark');
      else document.documentElement.classList.remove('dark');
    };

    // Initialize and subscribe to changes
    apply(get(settings).darkMode ?? true);
    
    const unsubscribe = settings.subscribe((s) => apply(s.darkMode ?? true));
    return unsubscribe;
  });
</script>

<div class=" h-full min-h-[100svh] text-black dark:text-white">
  <NavBar />
  <slot />
  <Snackbar />
  <ConfirmationPopup />
</div>
