<script lang="ts">
  import '../app.postcss';
  import { dev } from '$app/environment';
  import { inject } from '@vercel/analytics';

  import NavBar from '$lib/components/NavBar.svelte';
  import Snackbar from '$lib/components/Snackbar.svelte';
  import ConfirmationPopup from '$lib/components/ConfirmationPopup.svelte';
  import ExtractionModal from '$lib/components/ExtractionModal.svelte';
  import ProgressTracker from '$lib/components/ProgressTracker.svelte';
  import NightModeFilter from '$lib/components/NightModeFilter.svelte';

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  inject({ mode: dev ? 'development' : 'production' });
</script>

<div class=" h-full min-h-[100svh] text-white">
  <NavBar />
  {@render children?.()}
  <Snackbar />
  <ConfirmationPopup />
  <ExtractionModal />
  <ProgressTracker />
  <NightModeFilter />
</div>
