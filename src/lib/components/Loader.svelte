<script lang="ts">
  import { Spinner } from 'flowbite-svelte';

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();
</script>

<div class="flex h-full flex-col items-center justify-center gap-5 p-10">
  <Spinner size={'8'} />
  {#if children}{@render children()}{:else}Loading...{/if}
</div>
