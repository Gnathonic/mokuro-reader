<script lang="ts">
  /* eslint-disable no-undef */
  import '../app.css';
  import { dev } from '$app/environment';
  import { inject } from '@vercel/analytics';
  import { onMount } from 'svelte';
  import { beforeNavigate, afterNavigate } from '$app/navigation';
  import NavBar from '$lib/components/NavBar.svelte';
  import Snackbar from '$lib/components/Snackbar.svelte';
  import ConfirmationPopup from '$lib/components/ConfirmationPopup.svelte';
  import ExtractionModal from '$lib/components/ExtractionModal.svelte';
  import ImageOnlyImportModal from '$lib/components/ImageOnlyImportModal.svelte';
  import ProgressTracker from '$lib/components/ProgressTracker.svelte';
  import NightModeFilter from '$lib/components/NightModeFilter.svelte';
  import GlobalDropZone from '$lib/components/GlobalDropZone.svelte';
  import ViewRouter from '$lib/components/ViewRouter.svelte';
  import { initializeProviders } from '$lib/util/sync/init-providers';
  import { initFileHandler } from '$lib/util/file-handler';
  import { initViewFromUrl, navigateBack, currentView, urlToView } from '$lib/util/navigation';
  import { page } from '$app/stores';
  import { get } from 'svelte/store';
  import { isPWA } from '$lib/util/pwa';

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  inject({ mode: dev ? 'development' : 'production' });

  // In PWA mode, intercept all navigation and handle it through view state
  // This prevents the URL from changing, which would break on refresh
  beforeNavigate(({ to, cancel }) => {
    if (!get(isPWA)) return; // Only intercept in PWA mode

    // If navigating to an internal route, cancel the URL navigation
    // and update view state instead
    if (to?.route.id) {
      cancel();

      // Parse the URL to determine the view
      const params = to.params as { manga?: string; volume?: string };
      const pathname = to.url.pathname;
      const view = urlToView(params, pathname);

      currentView.set(view);
    }
  });

  // In browser mode, sync view state from URL after navigation
  afterNavigate(({ to }) => {
    if (get(isPWA)) return; // PWA mode handles this via beforeNavigate

    if (to?.route.id) {
      const params = to.params as { manga?: string; volume?: string };
      const pathname = to.url.pathname;
      initViewFromUrl(params, pathname);
    }
  });

  // Handle global Escape key for back navigation
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      // Don't interfere with Escape on inputs or textareas
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return;
      }

      // Only navigate back if not already on catalog
      const view = get(currentView);
      if (view.type !== 'catalog') {
        event.preventDefault();
        navigateBack();
      }
    }
  }

  // Handle browser back button in PWA mode
  // In PWA mode, we intercept the popstate event and use our view hierarchy navigation
  function handlePopState(event: PopStateEvent) {
    if (!get(isPWA)) return; // Only intercept in PWA mode

    // Prevent the default browser back behavior
    event.preventDefault();

    // Use our view hierarchy navigation (same as Escape key)
    const view = get(currentView);
    if (view.type !== 'catalog') {
      navigateBack();
    }

    // Push a dummy state to keep the history stack from depleting
    // This prevents the PWA from closing when pressing back at catalog
    history.pushState(null, '', '/');
  }

  // Initialize sync providers on app startup (non-blocking)
  onMount(() => {
    // Fire and forget - don't block app initialization
    initializeProviders().catch((error) => {
      console.error('Failed to initialize providers:', error);
    });

    // Initialize file handler for PWA file associations
    initFileHandler();

    // Initialize view state from URL (for browser mode)
    const pageData = get(page);
    initViewFromUrl(pageData.params as { manga?: string; volume?: string }, pageData.url.pathname);

    // In PWA mode, initialize history state so we can intercept back button
    if (get(isPWA)) {
      // Push an initial state so back button triggers popstate instead of closing the app
      history.pushState(null, '', '/');
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} onpopstate={handlePopState} />

<div class=" h-full min-h-[100svh] text-white">
  <NavBar />
  <ViewRouter>
    {@render children?.()}
  </ViewRouter>
  <Snackbar />
  <ConfirmationPopup />
  <ExtractionModal />
  <ImageOnlyImportModal />
  <ProgressTracker />
  <NightModeFilter />
  <GlobalDropZone />
</div>
