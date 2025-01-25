<script lang="ts">
  import { Button, Dropzone, Modal, Spinner, Accordion, AccordionItem, ProgressBar } from 'flowbite-svelte';
  import FileUpload from './FileUpload.svelte';
  import { processFiles } from '$lib/upload';
  import { onMount } from 'svelte';
  import { scanFiles } from '$lib/upload';
  import { formatBytes } from '$lib/util/upload';
  import { toClipboard } from '$lib/util';
  import { uploadProgress } from '$lib/stores/uploadProgress';

  export let open = false;

  let promise: Promise<void>;
  let files: FileList | undefined = undefined;

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

  let storageSpace = '';

  onMount(() => {
    navigator?.storage?.estimate().then(({ usage, quota }) => {
      if (usage && quota) {
        storageSpace = `Storage: ${formatBytes(usage)} / ${formatBytes(quota)}`;
      }
    });
  });

  let filePromises: Promise<File>[];
  let draggedFiles: File[] | undefined;
  let loading = false;
  $: disabled = loading || (!draggedFiles && !files);

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
              draggedFiles = draggedFiles;
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

  let activeStyle = defaultStyle;
</script>

<Modal title="Upload" bind:open outsideclose on:close={reset}>
  {#await promise}
    <div class="flex flex-col gap-4">
      <h2 class="justify-center flex">
        {#if $uploadProgress.currentPhase === 'preparing'}
          Preparing files...
        {:else if $uploadProgress.currentPhase === 'processing'}
          Processing files ({$uploadProgress.processedFiles}/{$uploadProgress.totalFiles})
        {:else if $uploadProgress.currentPhase === 'saving'}
          Saving to database...
        {:else if $uploadProgress.currentPhase === 'complete'}
          Upload complete!
        {:else if $uploadProgress.currentPhase === 'error'}
          Error occurred
        {/if}
      </h2>
      
      {#if $uploadProgress.currentPhase !== 'complete' && $uploadProgress.currentPhase !== 'error'}
        <div class="text-center"><Spinner /></div>
      {/if}
      
      {#if $uploadProgress.totalFiles > 0}
        <ProgressBar 
          progress={($uploadProgress.processedFiles / $uploadProgress.totalFiles) * 100} 
          size="h-3"
        />
      {/if}
      
      {#if Object.keys($uploadProgress.volumes).length > 0}
        <div class="flex flex-col gap-2 max-h-60 overflow-y-auto">
          {#each Object.entries($uploadProgress.volumes) as [path, volume]}
            <div class="flex flex-col gap-1 p-2 bg-gray-50 dark:bg-gray-800 rounded">
              <div class="flex justify-between items-center">
                <span class="text-sm font-medium">{volume.name}</span>
                <span class="text-xs {volume.status === 'error' ? 'text-red-500' : 'text-gray-500'}">{volume.message}</span>
              </div>
              <ProgressBar 
                progress={volume.progress} 
                size="h-2"
                color={volume.status === 'error' ? 'red' : volume.status === 'complete' ? 'green' : 'blue'}
              />
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {:then}
    <Accordion flush>
      <AccordionItem>
        <span slot="header">What to upload?</span>
        <div class="flex flex-col gap-5">
          <div>
            <p>
              Firstly, ensure that you process your manga with the <b>0.2.0-beta.6</b> of mokuro, you
              can install it by running the following command:
            </p>
            <div role="none" on:click={toClipboard}>
              <code class="text-primary-600 bg-slate-900"
                >pip3 install git+https://github.com/kha-white/mokuro.git@web-reader</code
              >
            </div>
          </div>
          <p>
            This will generate a <code>.mokuro</code> file for each volume processed, upload your
            manga along with the <code>.mokuro</code> files.
          </p>
          <p>
            On mobile, uploading via directory is not supported so you will need to zip your manga
            first and then upload it via
            <code class="text-primary-600 bg-slate-900">choose files</code>.
          </p>
        </div>
      </AccordionItem>
    </Accordion>
    <Dropzone
      id="dropzone"
      on:drop={dropHandle}
      on:dragover={(event) => {
        event.preventDefault();
        activeStyle = highlightStyle;
      }}
      on:dragleave={(event) => {
        event.preventDefault();
        activeStyle = defaultStyle;
      }}
      on:click={(event) => {
        event.preventDefault();
      }}
      defaultClass={activeStyle}
    >
      <svg
        aria-hidden="true"
        class="mb-3 w-10 h-10 text-gray-400"
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
          Drag and drop / <FileUpload bind:files accept=".mokuro,.zip,.cbz" multiple
            >choose files</FileUpload
          > /
          <FileUpload bind:files webkitdirectory>choose directory</FileUpload>
        </p>
      {/if}
    </Dropzone>
    <p class=" text-sm text-gray-500 dark:text-gray-400 text-center">{storageSpace}</p>
    <div class="flex flex-1 flex-col gap-2">
      <Button outline on:click={reset} {disabled} color="dark">Reset</Button>
      <Button outline on:click={onUpload} {disabled}>Upload</Button>
    </div>
  {/await}
</Modal>
