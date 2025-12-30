<script lang="ts">
  import { Accordion, AccordionItem, Button, Dropzone, Modal, Spinner } from 'flowbite-svelte';
  import { UploadSolid } from 'flowbite-svelte-icons';
  import { importFiles, isImporting } from '$lib/import';
  import { scanFiles } from '$lib/upload';
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

  async function onImport() {
    const filesToImport = files ? [...files] : draggedFiles;
    if (filesToImport && filesToImport.length > 0) {
      promise = importFiles(filesToImport).then(() => {
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
        storageSpace = `Browser storage: ${formatBytes(usage)} / ${formatBytes(quota)}`;
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

<Modal title="Import" bind:open outsideclose onclose={reset}>
  {#await promise}
    <h2 class="flex justify-center">Importing...</h2>
    <div class="text-center"><Spinner /></div>
  {:then}
    <Accordion flush>
      <AccordionItem>
        {#snippet header()}What can I add?{/snippet}
        <div class="flex flex-col gap-3 text-gray-700 dark:text-gray-300">
          <p>
            This reader is designed for manga processed with <a
              href="https://github.com/kha-white/mokuro"
              target="_blank"
              class="text-primary-600 hover:underline dark:text-primary-500">mokuro</a
            >, which extracts Japanese text from manga pages for use with popup dictionaries like
            Yomitan.
          </p>
          <p>
            To add a volume, provide your manga images (as a <b>ZIP</b>, <b>CBZ</b>, or folder)
            along with the <code>.mokuro</code> file that contains the OCR text data. The reader pairs
            them automatically — whether the mokuro file is inside the archive, alongside it, or in a
            parent folder.
          </p>
          <p>
            <b>Image-only comics:</b> You can also add comics without a <code>.mokuro</code> file. These
            won't have text overlays, but are useful for reference copies in other languages.
          </p>
          <p class="text-sm text-gray-500 dark:text-gray-400">
            The reader handles nested archives, mixed folders, and special characters in filenames
            automatically.
          </p>
        </div>
      </AccordionItem>
      <AccordionItem>
        {#snippet header()}Creating mokuro files{/snippet}
        <div class="flex flex-col gap-3 text-gray-700 dark:text-gray-300">
          <p>
            <a
              href="https://github.com/kha-white/mokuro"
              target="_blank"
              class="text-primary-600 hover:underline dark:text-primary-500">Mokuro</a
            >
            is an OCR tool that analyzes manga pages and extracts Japanese text. It generates a
            <code>.mokuro</code> file for each volume, which this reader uses to display selectable text
            overlays on top of your manga images.
          </p>
          <p>Install mokuro (<b>0.2.0</b> or later required):</p>
          <div role="none" onclick={toClipboard}>
            <code class="bg-slate-900 text-primary-600">pip install mokuro</code>
          </div>
          <p>Then run it on your manga folder:</p>
          <div role="none" onclick={toClipboard}>
            <code class="bg-slate-900 text-primary-600">mokuro /path/to/manga/volume</code>
          </div>
          <p class="text-sm">
            See the <a
              href="https://github.com/kha-white/mokuro"
              target="_blank"
              class="text-primary-600 hover:underline dark:text-primary-500">mokuro documentation</a
            > for detailed usage and options.
          </p>
        </div>
      </AccordionItem>
      <AccordionItem>
        {#snippet header()}Mobile tips{/snippet}
        <div class="flex flex-col gap-3 text-gray-700 dark:text-gray-300">
          <p>
            Importing on mobile works best with smaller files. ZIP or CBZ individual volumes rather
            than entire series — folder selection usually doesn't work, and large archives may crash
            due to RAM limits.
          </p>
          <p>
            <b>Export for mobile:</b> On a computer, use the export button on the series page to download
            volumes as mobile-ready CBZ files (includes the mokuro file). Transfer them to your device
            and import here.
          </p>
          <p>
            <b>Easiest method:</b> Back up to Google Drive or MEGA (free), then grab volumes from the
            cloud on mobile with a tap.
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
      <UploadSolid class="mb-3 h-10 w-10 text-gray-400" />
      {#if files}
        <p class="mb-2 text-sm text-gray-500 dark:text-gray-400">
          Import {files.length}
          {files.length > 1 ? 'files' : 'file'}?
        </p>
      {:else if draggedFiles && draggedFiles.length > 0}
        <p class="mb-2 text-sm text-gray-500 dark:text-gray-400">
          Import {draggedFiles.length}
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
              choose folder
            </button>
          {/if}
        </p>
      {/if}
    </Dropzone>
    <p class="text-center text-sm text-gray-500 dark:text-gray-400">{storageSpace}</p>
    <div class="flex flex-1 flex-col gap-2">
      <Button outline onclick={reset} {disabled} color="dark">Reset</Button>
      <Button outline onclick={onImport} {disabled}>Import</Button>
    </div>
  {/await}
</Modal>
