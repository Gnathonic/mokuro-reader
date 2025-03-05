<script>
  /** @type {{children?: import('svelte').Snippet}} */
  let { children } = $props();
</script>

{@render children?.()}

<style>
  :global(body.reader) {
    overflow: hidden !important;
    overscroll-behavior: contain;
  }
</style>
