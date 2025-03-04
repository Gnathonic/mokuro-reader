<script lang="ts">
  import { A } from 'flowbite-svelte';

  // Define props interface for Svelte 5
  interface Props {
    files?: FileList | undefined;
    onUpload?: ((files: FileList) => void) | undefined;
    webkitdirectory?: boolean;
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  // Use $props() and $bindable for Svelte 5
  let { 
    files = $bindable(undefined), 
    onUpload = undefined, 
    webkitdirectory = false,
    children,
    ...rest 
  }: Props = $props();

  // Use regular variable instead of $state() for input element
  let input: HTMLInputElement;

  function handleChange() {
    if (files && onUpload) {
      onUpload(files);
    }
  }

  function onClick(event: MouseEvent) {
    // Prevent default anchor behavior
    event.preventDefault();
    
    // Log for debugging
    console.log('Click handler called');
    console.log('Input element:', input);
    
    // Trigger file input click
    if (input) {
      input.click();
      console.log('Input click triggered');
    }
  }
</script>

<input
  type="file"
  bind:files
  bind:this={input}
  onchange={handleChange}
  {...rest}
  class="hidden"
  webkitdirectory={webkitdirectory ? "" : undefined}
  directory={webkitdirectory ? "" : undefined}
  mozdirectory={webkitdirectory ? "" : undefined}
/>

<!-- Use href="#" to ensure proper cursor behavior -->
<A href="#" on:click={onClick}>
  {#if children}{@render children()}{:else}Upload{/if}
</A>
