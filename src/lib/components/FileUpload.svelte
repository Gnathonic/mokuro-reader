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
  class="m-0 inline-flex cursor-pointer items-center border-none bg-transparent p-0 text-primary-600 hover:underline dark:text-primary-500"
>
  {#if children}{@render children()}{:else}Upload{/if}
</button>

<input type="file" bind:files bind:this={fileInput} {...rest} class="hidden" />
