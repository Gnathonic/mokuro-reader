<script lang="ts">
  import { isPWA } from '$lib/util/pwa';
  import { currentView } from '$lib/util/navigation';

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  // Lazy load view components only when needed in PWA mode
  // This avoids importing all route components upfront
  const viewComponents = {
    catalog: () => import('../../routes/+page.svelte'),
    series: () => import('../../routes/[manga]/+page.svelte'),
    reader: () => import('../../routes/[manga]/[volume]/+page.svelte'),
    'volume-text': () => import('../../routes/[manga]/[volume]/text/+page.svelte'),
    'series-text': () => import('../../routes/[manga]/text/+page.svelte'),
    cloud: () => import('../../routes/cloud/+page.svelte'),
    upload: () => import('../../routes/upload/+page.svelte'),
    'reading-speed': () => import('../../routes/reading-speed/+page.svelte')
  };

  let CurrentComponent: any = $state(null);

  // Load the appropriate component when view changes in PWA mode
  $effect(() => {
    if (!$isPWA) {
      CurrentComponent = null;
      return;
    }

    const viewType = $currentView.type;
    const loader = viewComponents[viewType as keyof typeof viewComponents];

    if (loader) {
      loader().then((mod) => {
        CurrentComponent = mod.default;
      });
    }
  });
</script>

{#if $isPWA && CurrentComponent}
  <CurrentComponent />
{:else}
  {@render children?.()}
{/if}
