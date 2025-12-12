<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { db } from '$lib/catalog/db';
  import { getCurrentPages, hasEdits } from '$lib/catalog/pages';
  import type { VolumeData, Page, Block } from '$lib/types';
  import { Button, Modal, Spinner, Toast } from 'flowbite-svelte';
  import { CheckCircleSolid, CloseCircleSolid } from 'flowbite-svelte-icons';
  import EditToolbar from '$lib/components/Editor/EditToolbar.svelte';
  import EditCanvas from '$lib/components/Editor/EditCanvas.svelte';
  import { promptConfirmation } from '$lib/util';

  type ZoomMode = 'fit-screen' | 'fit-width' | 'original' | number;

  let volumeUuid = $derived($page.params.volume || '');
  let pageIndexParam = $derived($page.params.pageIndex || '0');
  let pageIndex = $derived(parseInt(pageIndexParam, 10));

  let volumeData = $state<VolumeData | undefined>(undefined);
  let workingBlocks = $state<Block[]>([]);
  let focusedBlock = $state<Block | null>(null);

  let hasUnsavedChanges = $state(false);
  let isLoading = $state(true);
  let showUnsavedWarning = $state(false);
  let pendingNavigation: (() => void) | null = null;
  let zoomMode = $state<ZoomMode>('fit-screen');
  let showSaveSuccess = $state(false);
  let showSaveError = $state(false);
  let saveErrorMessage = $state('');
  let showRevertSuccess = $state(false);
  let isMounted = $state(false);

  // Reference to the Canvas component
  let canvasRef: ReturnType<typeof EditCanvas> | undefined = $state();

  let pageData = $derived(volumeData ? getCurrentPages(volumeData)[pageIndex] : undefined);
  let totalPages = $derived(volumeData ? getCurrentPages(volumeData).length : 0);
  let volumeHasEdits = $derived(volumeData ? hasEdits(volumeData) : false);
  let pageImage = $derived(
    volumeData?.files && Object.values(volumeData.files)[pageIndex]
      ? URL.createObjectURL(Object.values(volumeData.files)[pageIndex])
      : ''
  );

  // Initialize data whenever volumeUuid changes
  $effect(() => {
    if (volumeUuid && !isMounted) {
      loadVolumeData();
      isMounted = true;
    }
  });

  // Reload working blocks when page index changes
  $effect(() => {
    if (volumeData && pageIndex >= 0) {
      const currentPages = getCurrentPages(volumeData);
      if (currentPages[pageIndex]) {
        workingBlocks = JSON.parse(JSON.stringify(currentPages[pageIndex].blocks || []));
        focusedBlock = null; // no need to notify children since they are refreshed anyway
        hasUnsavedChanges = false;
      }
    }
  });

  async function loadVolumeData() {
    isLoading = true;

    try {
      const [ocrData, filesData] = await Promise.all([
        db.volume_ocr.get(volumeUuid),
        db.volume_files.get(volumeUuid)
      ]);

      if (ocrData && filesData) {
        volumeData = {
          volume_uuid: volumeUuid,
          pages: ocrData.pages,
          edited_pages: ocrData.edited_pages,
          files: filesData.files
        };

        const currentPages = getCurrentPages(volumeData);
        if (currentPages[pageIndex]) {
          workingBlocks = JSON.parse(JSON.stringify(currentPages[pageIndex].blocks || []));
        } else {
          console.error(`[Editor] Page index ${pageIndex} out of bounds.`);
        }
      } else {
        console.warn('[Editor] Volume data partial or missing in V3 tables');
      }
    } catch (error) {
      console.error('Failed to load volume data:', error);
    } finally {
      isLoading = false;
    }
  }

  // --- CRUD Handlers ---
  // Note: Most updates happen via binding workingBlocks directly.
  // These handlers are used for explicit Toolbar actions.

  function handleDeleteRequest() {
    canvasRef?.deleteFocusedBlock();
  }

  function addTextbox() {
    canvasRef?.addTextboxToCenter();
  }

  async function saveEdits() {
    if (!volumeData) return;
    try {
      const currentPages = getCurrentPages(volumeData);
      const updatedPages = JSON.parse(JSON.stringify(currentPages));
      updatedPages[pageIndex].blocks = JSON.parse(JSON.stringify(workingBlocks));

      await db.volume_ocr.update(volumeUuid, {
        edited_pages: updatedPages
      });

      volumeData.edited_pages = updatedPages;
      hasUnsavedChanges = false;

      showSaveSuccess = true;
      setTimeout(() => {
        showSaveSuccess = false;
      }, 3000);
    } catch (error) {
      console.error('Failed to save edits:', error);
      saveErrorMessage = error instanceof Error ? error.message : 'Unknown error';
      showSaveError = true;
      setTimeout(() => {
        showSaveError = false;
      }, 5000);
    }
  }

  function navigatePage(newPageIndex: number) {
    if (newPageIndex < 0 || newPageIndex >= totalPages) return;

    if (hasUnsavedChanges) {
      showUnsavedWarning = true;
      pendingNavigation = () => {
        goto(`/${$page.params.manga}/${volumeUuid}/edit/${newPageIndex}`);
      };
    } else {
      goto(`/${$page.params.manga}/${volumeUuid}/edit/${newPageIndex}`);
    }
  }

  function exitToReader() {
    if (hasUnsavedChanges) {
      showUnsavedWarning = true;
      pendingNavigation = () => {
        goto(`/${$page.params.manga}/${volumeUuid}?page=${pageIndex + 1}`);
      };
    } else {
      goto(`/${$page.params.manga}/${volumeUuid}?page=${pageIndex + 1}`);
    }
  }

  async function saveAndNavigate() {
    await saveEdits();
    showUnsavedWarning = false;
    if (pendingNavigation) {
      pendingNavigation();
      pendingNavigation = null;
    }
  }

  function discardAndNavigate() {
    hasUnsavedChanges = false;
    showUnsavedWarning = false;
    if (pendingNavigation) {
      pendingNavigation();
      pendingNavigation = null;
    }
  }

  function cancelNavigation() {
    showUnsavedWarning = false;
    pendingNavigation = null;
  }

  async function revertToOriginal() {
    if (!volumeData) return;
    promptConfirmation('Revert all edits to original? This cannot be undone.', async () => {
      try {
        await db.volume_ocr.update(volumeUuid, {
          edited_pages: undefined
        });

        await loadVolumeData();

        showRevertSuccess = true;
        setTimeout(() => {
          showRevertSuccess = false;
        }, 3000);
      } catch (error) {
        console.error('Failed to revert edits:', error);
        saveErrorMessage = error instanceof Error ? error.message : 'Unknown error';
        showSaveError = true;
        setTimeout(() => {
          showSaveError = false;
        }, 5000);
      }
    });
  }

  async function exportMokuro() {
    if (!volumeData) return;

    try {
      const metadata = await db.volumes.get(volumeUuid);
      if (!metadata) return;

      const currentPages = getCurrentPages(volumeData);

      const mokuroData = {
        version: metadata.mokuro_version,
        title: metadata.series_title,
        title_uuid: metadata.series_uuid,
        volume: metadata.volume_title,
        volume_uuid: metadata.volume_uuid,
        pages: currentPages,
        chars: currentPages.reduce(
          (total, page) =>
            total +
            page.blocks.reduce((pageTotal, block) => pageTotal + block.lines.join('').length, 0),
          0
        )
      };

      const blob = new Blob([JSON.stringify(mokuroData, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${metadata.volume_title}_edited.mokuro`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export .mokuro file:', error);
    }
  }

  // --- Focus Handler ---
  function handleBlockFocus(block: Block | null) {
    focusedBlock = block;
  }
</script>

<svelte:head>
  <title>Edit Page {pageIndex + 1}</title>
</svelte:head>

{#if isLoading}
  <div class="flex h-screen w-screen items-center justify-center">
    <Spinner size="12" />
  </div>
{:else if volumeData && pageData}
  <EditToolbar
    {pageIndex}
    {totalPages}
    {hasUnsavedChanges}
    hasEdits={volumeHasEdits}
    isBlockSelected={focusedBlock !== null}
    bind:zoomMode
    onPrev={() => navigatePage(pageIndex - 1)}
    onNext={() => navigatePage(pageIndex + 1)}
    onSave={saveEdits}
    onExport={exportMokuro}
    onExit={exitToReader}
    onRevert={revertToOriginal}
    onAddBox={addTextbox}
    onDelete={handleDeleteRequest}
  />

  <EditCanvas
    bind:this={canvasRef}
    {pageData}
    {pageImage}
    bind:zoomMode
    bind:workingBlocks
    onBlockFocus={handleBlockFocus}
    onOcrChange={() => {
      hasUnsavedChanges = true;
    }}
  />

  <Modal bind:open={showUnsavedWarning} size="xs" autoclose={false}>
    <div class="text-center">
      <h3 class="mb-5 text-lg font-normal text-gray-500 dark:text-gray-400">
        You have unsaved changes. Save before leaving?
      </h3>
      <div class="flex justify-center gap-4">
        <Button color="green" onclick={saveAndNavigate}>Save & Continue</Button>
        <Button color="red" onclick={discardAndNavigate}>Discard</Button>
        <Button color="alternative" onclick={cancelNavigation}>Cancel</Button>
      </div>
    </div>
  </Modal>

  {#if isMounted && showSaveSuccess}
    <Toast color="green" position="top-right" class="fixed top-20 right-4 z-50">
      {#snippet icon()}
        <CheckCircleSolid class="h-5 w-5" />
      {/snippet}
      Edits saved successfully
    </Toast>
  {/if}

  {#if isMounted && showSaveError}
    <Toast color="red" position="top-right" class="fixed top-20 right-4 z-50">
      {#snippet icon()}
        <CloseCircleSolid class="h-5 w-5" />
      {/snippet}
      Failed to save: {saveErrorMessage}
    </Toast>
  {/if}

  {#if isMounted && showRevertSuccess}
    <Toast color="green" position="top-right" class="fixed top-20 right-4 z-50">
      {#snippet icon()}
        <CheckCircleSolid class="h-5 w-5" />
      {/snippet}
      Reverted to original
    </Toast>
  {/if}
{:else}
  <div class="flex h-screen w-screen items-center justify-center">
    <p class="text-xl">Failed to load page data</p>
  </div>
{/if}
