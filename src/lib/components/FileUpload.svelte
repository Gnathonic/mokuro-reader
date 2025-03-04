<script lang="ts">
  import { A, Button } from 'flowbite-svelte';

  interface Props {
    files?: FileList | undefined;
    onUpload?: ((files: FileList) => void) | undefined;
    children?: import('svelte').Snippet;
    webkitdirectory?: boolean;
    [key: string]: any
  }

  let { 
    files = $bindable(undefined), 
    onUpload = undefined, 
    children, 
    webkitdirectory = false,
    ...rest 
  }: Props = $props();

  let input: HTMLInputElement;

  function handleChange() {
    if (files && onUpload) {
      onUpload(files);
    }
  }

  function handleClick() {
    if (input) {
      input.click();
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

<Button color="none" class="p-0 text-primary-600 dark:text-primary-500 hover:underline font-medium" onclick={handleClick}>
  {#if children}{@render children()}{:else}Upload{/if}
</Button>
