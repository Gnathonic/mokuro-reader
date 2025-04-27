<script lang="ts">
  export const prerender = true;
  export const ssr = false;
  import '../app.postcss';
  import { dev } from '$app/environment';
  import { inject } from '@vercel/analytics';

  import NavBar from '$lib/components/NavBar.svelte';
  import Snackbar from '$lib/components/Snackbar.svelte';
  import ConfirmationPopup from '$lib/components/ConfirmationPopup.svelte';
  inject({ mode: dev ? 'development' : 'production' });
</script>

<div class=" h-full min-h-[100svh] text-white">
  <NavBar />
  <slot />
  <Snackbar />
  <ConfirmationPopup />
</div>
