<script lang="ts">
  import { catalog } from '$lib/catalog';
  import { goto } from '$app/navigation';
  import VolumeItem from '$lib/components/VolumeItem.svelte';
  import { Button, Listgroup } from 'flowbite-svelte';
  import { db } from '$lib/catalog/db';
  import { promptConfirmation, showSnackbar, zipManga } from '$lib/util';
  import { promptExtraction } from '$lib/util/modals';
  import { page } from '$app/stores';
  import type { VolumeMetadata } from '$lib/types';
  import { deleteVolume } from '$lib/settings';
  import { mangaStats} from '$lib/settings';
  import ExtractionModal from '$lib/components/ExtractionModal.svelte';
  import { CloudArrowUpSolid, TrashBinSolid } from 'flowbite-svelte-icons';
  import { exportAndUploadVolumesToDrive } from '$lib/util/cloud';
import { driveApiRequest, DriveErrorType } from "$lib/util/api-helpers";
  import driveStore, { isSeriesBackedUp, removeSeries } from '$lib/util/drive-store';

  function sortManga(a: VolumeMetadata, b: VolumeMetadata) {
    return a.volume_title.localeCompare(b.volume_title, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  }

  $: manga = $catalog?.find((item) => item.series_uuid === $page.params.manga)?.volumes.sort(sortManga);

  $: loading = false;
  $: uploadingToDrive = false;
  $: removingFromDrive = false;
  
  // Create a derived store to check if this series is backed up
  $: seriesTitle = manga?.[0]?.series_title || '';
  $: volumeTitles = manga?.map(vol => vol.volume_title) || [];
  $: isBackedUp = isSeriesBackedUp(seriesTitle, volumeTitles);
  
  // Check if the series exists in Drive at all (even partially backed up)
  $: seriesExistsInDrive = !!$driveStore.series[seriesTitle];

  async function confirmDelete() {
    const seriesUuid = manga?.[0].series_uuid;
    if (seriesUuid) {
      manga?.forEach((vol) => {
        const volId = vol.volume_uuid;
        db.volumes_data.where('volume_uuid').equals(vol.volume_uuid).delete();
        db.volumes.where('volume_uuid').equals(vol.volume_uuid).delete();
        deleteVolume(volId);
      });
      goto('/');
    }
  }

  function onDelete() {
    promptConfirmation('Are you sure you want to delete this manga?', confirmDelete);
  }

  async function onExtract() {
    if (manga && manga.length > 0) {
      const firstVolume = {
        series_title: manga[0].series_title,
        volume_title: manga[0].volume_title
      };
      
      promptExtraction(
        firstVolume,
        async (asCbz, individualVolumes, includeSeriesTitle) => {
          loading = true;
          loading = await zipManga(manga, asCbz, individualVolumes, includeSeriesTitle);
        }
      );
    }
  }
  
  async function onExportToDrive() {
    if (!manga || manga.length === 0) {
      showSnackbar('No manga to export');
      return;
    }
    
    // Check if we have a Google Drive token
    const accessToken = $driveStore.accessToken || localStorage.getItem('gdrive_token');
    if (!accessToken) {
      showSnackbar('Please connect to Google Drive first in the Cloud menu');
      goto('/cloud');
      return;
    }
    
    try {
      uploadingToDrive = true;
      
      // Get the reader folder ID
      const readerFolderId = $driveStore.readerFolderId || await getReaderFolderId(accessToken);
      if (!readerFolderId) {
        showSnackbar('Could not find or create mokuro-reader folder in Google Drive');
        uploadingToDrive = false;
        return;
      }
      
      // Export and upload the volumes
      await exportAndUploadVolumesToDrive(manga, accessToken, readerFolderId);
      
      showSnackbar('Export to Google Drive completed');
    } catch (error) {
      console.error('Error exporting to Google Drive:', error);
      showSnackbar(`Error exporting to Google Drive: ${error.message || 'Unknown error'}`);
    } finally {
      uploadingToDrive = false;
    }
  }
  
  async function onRemoveFromDrive() {
    if (!seriesTitle || !seriesExistsInDrive) {
      showSnackbar('Series not found in Google Drive');
      return;
    }
    
    promptConfirmation(
      `Move ${seriesTitle} to trash in Google Drive?`,
      async () => {
        try {
          removingFromDrive = true;
          
          const accessToken = $driveStore.accessToken;
          if (!accessToken) {
            showSnackbar('Not connected to Google Drive');
            removingFromDrive = false;
            return;
          }
          
          const seriesFolderId = $driveStore.series[seriesTitle]?.folderId;
          if (!seriesFolderId) {
            showSnackbar('Series folder not found in Google Drive');
            removingFromDrive = false;
            return;
          }
          
          // Mark the folder as trashed in Google Drive instead of deleting it
          try {
            await driveApiRequest(
              `https://www.googleapis.com/drive/v3/files/${seriesFolderId}`,
              {
                method: 'PATCH',
                headers: new Headers({ 
                  'Authorization': 'Bearer ' + accessToken,
                  'Content-Type': 'application/json'
                }),
                body: JSON.stringify({ trashed: true })
              }
            );
            
            // Remove the series from our store
            removeSeries(seriesTitle);
            showSnackbar(`${seriesTitle} moved to trash in Google Drive`);
          } catch (error: any) {
            console.error('Error moving folder to trash:', error);
            
            // Only throw auth errors, handle other errors gracefully
            if (error.errorType === DriveErrorType.AUTH_ERROR) {
              showSnackbar('Authentication error: Please log in again');
              goto('/cloud');
              return;
            }
            
            throw new Error(error.message || 'Failed to move folder to trash');
          }
        } catch (error) {
          console.error('Error removing from Google Drive:', error);
          showSnackbar(`Error removing from Google Drive: ${error.message || 'Unknown error'}`);
        } finally {
          removingFromDrive = false;
        }
      }
    );
  }
  
  async function getReaderFolderId(accessToken: string): Promise<string | null> {
    try {
      // Check if the mokuro-reader folder exists
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=name='mokuro-reader' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`,
        {
          method: 'GET',
          headers: new Headers({ Authorization: 'Bearer ' + accessToken })
        }
      );
      
      const data = await response.json();
      
      if (data.files && data.files.length > 0) {
        return data.files[0].id;
      }
      
      // Create the folder if it doesn't exist
      const metadata = {
        name: 'mokuro-reader',
        mimeType: 'application/vnd.google-apps.folder'
      };
      
      const createResponse = await fetch(
        'https://www.googleapis.com/drive/v3/files',
        {
          method: 'POST',
          headers: new Headers({ 
            'Authorization': 'Bearer ' + accessToken,
            'Content-Type': 'application/json'
          }),
          body: JSON.stringify(metadata)
        }
      );
      
      const createData = await createResponse.json();
      return createData.id;
    } catch (error) {
      console.error('Error getting reader folder ID:', error);
      return null;
    }
  }
</script>

<svelte:head>
  <title>{manga?.[0].series_title || 'Manga'}</title>
</svelte:head>
{#if manga && $mangaStats}
  <div class="p-2 flex flex-col gap-5">
    <div class="flex flex-row justify-between">
      <div class="flex flex-col gap-2">
        <h3 class="font-bold">{manga[0].series_title}</h3>
        <div class="flex flex-col gap-0 sm:flex-row sm:gap-5">
          <p>Volumes: {$mangaStats.completed} / {manga.length}</p>
          <p>Characters read: {$mangaStats.chars}</p>
          <p>Minutes read: {$mangaStats.timeReadInMinutes}</p>
        </div>
      </div>
      <div class="sm:block flex-col flex gap-2">
        <Button color="alternative" on:click={onDelete}>Remove manga</Button>
        <Button color="light" on:click={onExtract} disabled={loading}>
          {loading ? 'Extracting...' : 'Extract manga'}
        </Button>
        
        {#if $driveStore.isLoggedIn}
          {#if $isBackedUp}
            <Button color="green" disabled={true}>
              <CloudArrowUpSolid class="mr-2 h-5 w-5" />
              Backed up to Drive
            </Button>
          {:else}
            <Button color="blue" on:click={onExportToDrive} disabled={uploadingToDrive}>
              <CloudArrowUpSolid class="mr-2 h-5 w-5" />
              {uploadingToDrive ? 'Uploading...' : 'Backup to Drive'}
            </Button>
          {/if}
          
          {#if seriesExistsInDrive}
            <Button color="red" on:click={onRemoveFromDrive} disabled={removingFromDrive}>
              <TrashBinSolid class="mr-2 h-5 w-5" />
              {removingFromDrive ? 'Moving to trash...' : 'Move to trash'}
            </Button>
          {/if}
        {/if}
      </div>
    </div>
    <Listgroup active class="flex-1 h-full w-full">
      {#each manga as volume (volume.volume_uuid)}
        <VolumeItem {volume} />
      {/each}
    </Listgroup>
  </div>
{:else}
  <div class="flex justify-center p-16">Manga not found</div>
{/if}
