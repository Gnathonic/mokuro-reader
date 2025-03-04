<script lang="ts">
  import { A, Fileupload, Label } from 'flowbite-svelte';

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

  let input: HTMLInputElement = $state();

  function handleChange() {
    if (files && onUpload) {
      onUpload(files);
    }
  }

  function onClick(event: MouseEvent) {
    event.preventDefault();
    console.log('Click handler called');
    console.log('Input element:', input);
    input.click();
    console.log('Input click triggered');
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

<A href="#" on:click={onClick}>{#if children}{@render children()}{:else}Upload{/if}</A>
