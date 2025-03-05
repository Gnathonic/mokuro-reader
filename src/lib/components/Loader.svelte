<script lang="ts">
  import { Spinner } from 'flowbite-svelte';

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();
</script>

<div class="flex flex-col gap-5 items-center justify-center h-full p-10">
  <Spinner size={'8'} />
  {#if children}{@render children()}{:else}Loading...{/if}
</div>
