<script lang="ts">
  interface Props {
    files?: FileList | undefined;
    onUpload?: ((files: FileList) => void) | undefined;
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { files = $bindable(undefined), onUpload = undefined, children, ...rest }: Props = $props();

  let fileInput: HTMLInputElement;

  function handleClick() {
    if (fileInput) {
      fileInput.click();
    }
  }

  $effect(() => {
    if (files && onUpload) {
      onUpload(files);
    }
  });
</script>

<button
  type="button"
  onclick={handleClick}
  class="inline-flex items-center hover:underline text-primary-600 dark:text-primary-500 cursor-pointer bg-transparent border-none p-0 m-0"
>
  {#if children}{@render children()}{:else}Upload{/if}
</button>

<input type="file" bind:files bind:this={fileInput} {...rest} class="hidden" />
