<script lang="ts">
  interface Props {
    files?: FileList | undefined;
    onUpload?: ((files: FileList) => void) | undefined;
    children?: import('svelte').Snippet;
    webkitdirectory?: boolean;
    multiple?: boolean;
    accept?: string;
  }

  let { 
    files = $bindable(undefined), 
    onUpload = undefined, 
    children, 
    webkitdirectory = false,
    multiple = false,
    accept = undefined
  }: Props = $props();

  let fileInput: HTMLInputElement;

  function handleChange() {
    if (files && onUpload) {
      onUpload(files);
    }
  }

  function triggerFileInput() {
    if (fileInput) {
      fileInput.click();
    }
  }
</script>

<div class="inline-block">
  <input
    type="file"
    bind:files
    bind:this={fileInput}
    onchange={handleChange}
    class="hidden"
    {multiple}
    {accept}
    webkitdirectory={webkitdirectory ? "" : undefined}
    directory={webkitdirectory ? "" : undefined}
    mozdirectory={webkitdirectory ? "" : undefined}
  />

  <button 
    type="button" 
    onclick={triggerFileInput}
    class="text-primary-600 dark:text-primary-500 hover:underline font-medium bg-transparent border-none p-0 cursor-pointer"
  >
    {#if children}{@render children()}{:else}Upload{/if}
  </button>
</div>
