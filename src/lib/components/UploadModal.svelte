<script lang="ts">
  import { Accordion, AccordionItem, Button, Dropzone, Modal, Spinner } from 'flowbite-svelte';
  import { processFiles, scanFiles } from '$lib/upload';
  import { onMount } from 'svelte';
  import { formatBytes } from '$lib/util/upload';
  import { toClipboard } from '$lib/util';

  interface Props {
    open?: boolean;
  }

  // In Svelte 5, we need to make sure the open prop is properly bindable
  let { open = $bindable(false) }: Props = $props();

  let promise: Promise<void> | undefined = $state(undefined);
  let files: FileList | undefined = $state(undefined);
  let isMobileDevice = $state(false);

  // Check if the device is mobile
  function checkMobileDevice() {
    // Using userAgent to detect mobile devices
    const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
    if (/android|iPad|iPhone|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)) {
      return true;
    }

    // Additional check for touch devices and small screens
    return (
      'ontouchstart' in window ||
      navigator.maxTouchPoints > 0 ||
      (window.innerWidth <= 800 && window.innerHeight <= 900)
    );
  }

  async function onUpload() {
    if (files) {
      promise = processFiles([...files]).then(() => {
        open = false;
      });
    } else if (draggedFiles) {
      promise = processFiles(draggedFiles).then(() => {
        open = false;
      });
    }
  }

  function reset() {
    files = undefined;
    draggedFiles = undefined;
  }

  let storageSpace = $state('');

  onMount(() => {
    // Check if device is mobile
    isMobileDevice = checkMobileDevice();

    navigator?.storage?.estimate().then(({ usage, quota }) => {
      if (usage && quota) {
        storageSpace = `Storage: ${formatBytes(usage)} / ${formatBytes(quota)}`;
      }
    });
  });

  let filePromises: Promise<File>[];
  let draggedFiles: File[] | undefined = $state();
  let loading = $state(false);
  let disabled = $derived(loading || (!draggedFiles && !files));

  const dropHandle = async (event: DragEvent) => {
    loading = true;
    draggedFiles = [];
    filePromises = [];
    event.preventDefault();
    activeStyle = defaultStyle;

    if (event?.dataTransfer?.items) {
      for (const item of [...event.dataTransfer.items]) {
        const entry = item.webkitGetAsEntry();
        if (item.kind === 'file' && entry) {
          if (entry.isDirectory) {
            await scanFiles(entry, filePromises);
          } else {
            const file = item.getAsFile();
            if (file) {
              draggedFiles.push(file);
            }
          }
        }
      }

      if (filePromises && filePromises.length > 0) {
        const files = await Promise.all(filePromises);
        if (files) {
          draggedFiles = [...draggedFiles, ...files];
        }
      }
    }

    loading = false;
  };

  let defaultStyle =
    'flex flex-col justify-center items-center w-full h-64 bg-gray-50 rounded-lg border-2 border-gray-300 border-dashed cursor-pointer dark:hover:bg-bray-800 dark:bg-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:hover:border-gray-500 dark:hover:bg-gray-600';
  let highlightStyle =
    'flex flex-col justify-center items-center w-full h-64 bg-gray-50 rounded-lg border-2 border-gray-300 border-dashed cursor-pointer dark:bg-bray-800 dark:bg-gray-700 bg-gray-100 dark:border-gray-600 dark:border-gray-500 dark:bg-gray-600';

  let activeStyle = $state(defaultStyle);
</script>

<Modal title="Upload" bind:open outsideclose onclose={reset}>
  {#await promise}
    <h2 class="flex justify-center">Loading...</h2>
    <div class="text-center"><Spinner /></div>
  {:then}
    <Accordion flush>
      <AccordionItem>
        {#snippet header()}What to upload?{/snippet}
        <div class="flex flex-col gap-5">
          <div>
            <p>
              Firstly, ensure that you process your manga with the <b>0.2.0-beta.6</b> of mokuro, you
              can install it by running the following command:
            </p>
            <div role="none" onclick={toClipboard}>
              <code class="bg-slate-900 text-primary-600"
                >pip3 install git+https://github.com/kha-white/mokuro.git@web-reader</code
              >
            </div>
          </div>
          <p>
            This will generate a <code>.mokuro</code> file for each volume processed, upload your
            manga along with the <code>.mokuro</code> files.
          </p>
          <p>
            {#if isMobileDevice}
              <b>Note:</b> On mobile devices, directory upload is not supported. Please zip your
              manga first and then upload it via
              <code class="bg-slate-900 text-primary-600">choose files</code>.
            {:else}
              On mobile devices, directory upload is not supported. If you're using a mobile device,
              you will need to zip your manga first and then upload it via
              <code class="bg-slate-900 text-primary-600">choose files</code>.
            {/if}
          </p>
        </div>
      </AccordionItem>
    </Accordion>
    <Dropzone
      id="dropzone"
      ondrop={dropHandle}
      ondragover={(event) => {
        event.preventDefault();
        activeStyle = highlightStyle;
      }}
      ondragleave={(event) => {
        event.preventDefault();
        activeStyle = defaultStyle;
      }}
      onclick={(event) => {
        event.preventDefault();
      }}
      class={activeStyle}
    >
      <svg
        aria-hidden="true"
        class="mb-3 h-10 w-10 text-gray-400"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        ><path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
        /></svg
      >
      {#if files}
        <p class="mb-2 text-sm text-gray-500 dark:text-gray-400">
          Upload {files.length}
          {files.length > 1 ? 'files' : 'file'}?
        </p>
      {:else if draggedFiles && draggedFiles.length > 0}
        <p class="mb-2 text-sm text-gray-500 dark:text-gray-400">
          Upload {draggedFiles.length} hih
          {draggedFiles.length > 1 ? 'files' : 'file'}?
        </p>
      {:else if loading}
        <Spinner />
      {:else}
        <p class="mb-2 text-sm text-gray-500 dark:text-gray-400">
          Drag and drop /
          <button
            type="button"
            class="m-0 inline-flex cursor-pointer border-none bg-transparent p-0 text-primary-600 hover:underline dark:text-primary-500"
            onclick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.mokuro,.zip,.cbz';
              input.multiple = true;
              input.onchange = (e) => {
                const target = e.target as HTMLInputElement;
                if (target.files && target.files.length > 0) {
                  files = target.files;
                }
              };
              input.click();
            }}
          >
            choose files
          </button>

          {#if !isMobileDevice}
            / <button
              type="button"
              class="m-0 inline-flex cursor-pointer border-none bg-transparent p-0 text-primary-600 hover:underline dark:text-primary-500"
              onclick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.setAttribute('webkitdirectory', '');
                input.onchange = (e) => {
                  const target = e.target as HTMLInputElement;
                  if (target.files && target.files.length > 0) {
                    files = target.files;
                  }
                };
                input.click();
              }}
            >
              choose directory
            </button>
          {/if}

          {#if isMobileDevice}
            <span class="ml-1 text-xs text-gray-500 italic dark:text-gray-400">
              (directory upload not available on mobile)
            </span>
          {/if}
        </p>
      {/if}
    </Dropzone>
    <p class=" text-center text-sm text-gray-500 dark:text-gray-400">{storageSpace}</p>
    <div class="flex flex-1 flex-col gap-2">
      <Button outline onclick={reset} {disabled} color="dark">Reset</Button>
      <Button outline onclick={onUpload} {disabled}>Upload</Button>
    </div>
  {/await}
</Modal>
