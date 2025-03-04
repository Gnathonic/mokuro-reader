<script lang="ts">
  // Define the props interface
  interface Props {
    files?: FileList | undefined;
    onUpload?: ((files: FileList) => void) | undefined;
    children?: import('svelte').Snippet;
    webkitdirectory?: boolean;
    multiple?: boolean;
    accept?: string;
  }

  // Extract props with defaults
  let { 
    files = $bindable(undefined), 
    onUpload = undefined, 
    children, 
    webkitdirectory = false,
    multiple = false,
    accept = undefined
  }: Props = $props();

  // Create a reference to the file input element
  let fileInputElement: HTMLInputElement;

  // Function to handle file selection
  function handleFileSelection(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files) {
      files = input.files;
      if (onUpload) {
        onUpload(files);
      }
    }
  }

  // Function to trigger the file input click
  function openFilePicker() {
    if (fileInputElement) {
      fileInputElement.click();
    }
  }
</script>

<!-- Wrapper div to maintain inline styling -->
<span class="inline-block">
  <!-- Hidden file input element -->
  <input
    type="file"
    id="file-upload-input"
    bind:this={fileInputElement}
    on:change={handleFileSelection}
    style="display: none;"
    {multiple}
    {accept}
    webkitdirectory={webkitdirectory ? "" : undefined}
    directory={webkitdirectory ? "" : undefined}
    mozdirectory={webkitdirectory ? "" : undefined}
  />

  <!-- Button styled as a link that triggers the file input -->
  <button 
    type="button" 
    on:click={openFilePicker}
    class="text-primary-600 dark:text-primary-500 hover:underline font-medium bg-transparent border-none p-0 cursor-pointer"
  >
    {#if children}{@render children()}{:else}Upload{/if}
  </button>
</span>
