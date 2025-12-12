<script lang="ts">
  let {
    forceVisible = false,
    class: className = '',
    trigger,
    children
  } = $props<{
    forceVisible?: boolean;
    class?: string;
    trigger?: import('svelte').Snippet;
    children?: import('svelte').Snippet;
  }>();

  let isHovered = $state(false);
  let isTouched = $state(false);

  // Derived visibility state
  const isVisible = $derived(forceVisible || isHovered || isTouched);

  function handleTouch() {
    isTouched = true;
    // Auto-hide after delay on touch devices
    setTimeout(() => {
      isTouched = false;
    }, 2000);
  }
</script>

<div
  class={className}
  role="group"
  onmouseenter={() => (isHovered = true)}
  onmouseleave={() => (isHovered = false)}
  ontouchstart={handleTouch}
>
  <!-- The trigger area (always visible/interactive) -->
  {#if trigger}
    {@render trigger()}
  {/if}

  <!-- The toggled content -->
  <div
    class="h-full w-full transition-opacity duration-200"
    class:opacity-0={!isVisible}
    class:opacity-100={isVisible}
    class:pointer-events-none={!isVisible}
    class:pointer-events-auto={isVisible}
  >
    {@render children?.()}
  </div>
</div>
