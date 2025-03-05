<script lang="ts">
  import { initPanzoom } from './util';

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();
</script>

<div use:initPanzoom>
  {@render children?.()}
</div>
