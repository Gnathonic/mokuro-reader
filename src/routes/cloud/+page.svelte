<script lang="ts">
  import { processFiles } from '$lib/upload';

  /** @type {string} */
  export let accessToken = '';
  import Loader from '$lib/components/Loader.svelte';
  import { formatBytes, showSnackbar, uploadFile } from '$lib/util';
  import { Button, P, Progressbar } from 'flowbite-svelte';
  import { onMount } from 'svelte';
  import { promptConfirmation } from '$lib/util';
  import { GoogleSolid } from 'flowbite-svelte-icons';
  import { profiles, volumes } from '$lib/settings';

  const CLIENT_ID = import.meta.env.VITE_GDRIVE_CLIENT_ID;
  const API_KEY = import.meta.env.VITE_GDRIVE_API_KEY;

  const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
  const SCOPES = 'https://www.googleapis.com/auth/drive.file';

  const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
  const READER_FOLDER = 'mokuro-reader';
  const VOLUME_DATA_FILE = 'volume-data.json';
  const PROFILES_FILE = 'profiles.json';

  const type = 'application/json';

  let tokenClient: any;
  let readerFolderId = '';
  let volumeDataId = '';
  let profilesId = '';

  let loadingMessage = '';

  let completed = 0;
  let totalSize = 0;
  $: progress = Math.floor((completed / totalSize) * 100).toString();

  $: if (accessToken) {
    localStorage.setItem('gdrive_token', accessToken);
  }

  function xhrDownloadFileId(fileId: string) {
    return new Promise<Blob>((resolve, reject) => {
      const { access_token } = gapi.auth.getToken();
      const xhr = new XMLHttpRequest();

      completed = 0;
      totalSize = 0;

      xhr.open('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
      xhr.setRequestHeader('Authorization', `Bearer ${access_token}`);
      xhr.responseType = 'blob';

      xhr.onprogress = ({ loaded, total }) => {
        loadingMessage = '';
        completed = loaded;
        totalSize = total;
      };

      xhr.onabort = (event) => {
        console.warn(`xhr ${fileId}: download aborted at ${event.loaded} of ${event.total}`);
        showSnackbar('Download failed');
        reject(new Error('Download aborted'));
      };

      xhr.onerror = (event) => {
        console.error(`xhr ${fileId}: download error at ${event.loaded} of ${event.total}`);
        showSnackbar('Download failed');
        reject(new Error('Error downloading file'));
      };

      xhr.onload = () => {
        completed = 0;
        totalSize = 0;
        resolve(xhr.response);
      };

      xhr.ontimeout = (event) => {
        console.warn(`xhr ${fileId}: download timeout after ${event.loaded} of ${event.total}`);
        showSnackbar('Download timed out');
        reject(new Error('Timeout downloading file'));
      };

      xhr.send();
    });
  }

  export async function connectDrive(resp?: any) {
    if (resp?.error !== undefined) {
      localStorage.removeItem('gdrive_token');
      accessToken = '';
      throw resp;
    }

    accessToken = resp?.access_token;
    loadingMessage = 'Connecting to drive';

    const { result: readerFolderRes } = await gapi.client.drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${READER_FOLDER}'`,
      fields: 'files(id)'
    });

    if (readerFolderRes.files?.length === 0) {
      const { result: createReaderFolderRes } = await gapi.client.drive.files.create({
        resource: { mimeType: FOLDER_MIME_TYPE, name: READER_FOLDER },
        fields: 'id'
      });

      readerFolderId = createReaderFolderRes.id || '';
    } else {
      const id = readerFolderRes.files?.[0]?.id || '';

      readerFolderId = id || '';
    }

    const { result: volumeDataRes } = await gapi.client.drive.files.list({
      q: `'${readerFolderId}' in parents and name='${VOLUME_DATA_FILE}'`,
      fields: 'files(id, name)'
    });

    if (volumeDataRes.files?.length !== 0) {
      volumeDataId = volumeDataRes.files?.[0].id || '';
    }

    const { result: profilesRes } = await gapi.client.drive.files.list({
      q: `'${readerFolderId}' in parents and name='${PROFILES_FILE}'`,
      fields: 'files(id, name)'
    });

    if (profilesRes.files?.length !== 0) {
      profilesId = profilesRes.files?.[0].id || '';
    }

    loadingMessage = '';

    if (accessToken) {
      showSnackbar('Connected to Google Drive');
    }
  }

  function signIn() {
    // Always show the account picker to allow switching accounts
    tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  export function logout() {
    // Remove token from localStorage
    localStorage.removeItem('gdrive_token');
    
    // Clear the token from memory
    accessToken = '';
    
    // Revoke the token with Google to ensure account picker shows up next time
    if (gapi.client.getToken()) {
      const token = gapi.client.getToken().access_token;
      // Clear the token from gapi client
      gapi.client.setToken(null);
      
      // Revoke the token with Google's OAuth service
      fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }).catch(error => {
        console.error('Error revoking token:', error);
      });
    }
  }

  onMount(() => {
    gapi.load('client', async () => {
      await gapi.client.init({
        apiKey: API_KEY,
        discoveryDocs: [DISCOVERY_DOC]
      });

      // Initialize token client after gapi client is ready
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: connectDrive
      });

      // Try to restore the saved token only after gapi client is initialized
      const savedToken = localStorage.getItem('gdrive_token');
      if (savedToken) {
        try {
          // Set the token in gapi client
          gapi.client.setToken({ access_token: savedToken });
          accessToken = savedToken;
          await connectDrive({ access_token: savedToken });
        } catch (error) {
          console.error('Failed to restore saved token:', error);
          // Token will be cleared in connectDrive if there's an error
        }
      }
    });

    gapi.load('picker', () => {});
  });

  function createPicker() {
    const docsView = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes('application/zip,application/x-zip-compressed')
      .setMode(google.picker.DocsViewMode.LIST)
      .setIncludeFolders(true)
      .setParent(readerFolderId);

    const picker = new google.picker.PickerBuilder()
      .addView(docsView)
      .setOAuthToken(accessToken)
      .setAppId(CLIENT_ID)
      .setDeveloperKey(API_KEY)
      .enableFeature(google.picker.Feature.NAV_HIDDEN)
      .setCallback(pickerCallback)
      .build();
    picker.setVisible(true);
  }

  async function pickerCallback(data: google.picker.ResponseObject) {
    try {
      if (data[google.picker.Response.ACTION] == google.picker.Action.PICKED) {
        loadingMessage = 'Downloading from drive...';
        const docs = data[google.picker.Response.DOCUMENTS];
        const blob = await xhrDownloadFileId(docs[0].id);

        loadingMessage = 'Adding to catalog...';

        const file = new File([blob], docs[0].name);

        await processFiles([file]);
        loadingMessage = '';
      }
    } catch (error) {
      showSnackbar('Something went wrong');
      loadingMessage = '';
      console.error(error);
    }
  }

  async function onUploadVolumeData() {
    const metadata = {
      mimeType: type,
      name: VOLUME_DATA_FILE,
      parents: [volumeDataId ? null : readerFolderId]
    };

    loadingMessage = 'Uploading volume data';

    const res = await uploadFile({
      accessToken,
      fileId: volumeDataId,
      metadata,
      localStorageId: 'volumes',
      type
    });

    volumeDataId = res.id;
    loadingMessage = '';

    if (volumeDataId) {
      showSnackbar('Volume data uploaded');
    }
  }

  async function onUploadProfiles() {
    const metadata = {
      mimeType: type,
      name: PROFILES_FILE,
      parents: [profilesId ? null : readerFolderId]
    };

    loadingMessage = 'Uploading profiles';

    const res = await uploadFile({
      accessToken,
      fileId: profilesId,
      metadata,
      localStorageId: 'profiles',
      type
    });

    profilesId = res.id;
    loadingMessage = '';

    if (profilesId) {
      showSnackbar('Profiles uploaded');
    }
  }

  async function onDownloadVolumeData() {
    if (!volumeDataId) {
      showSnackbar('No volume data file found');
      return;
    }

    loadingMessage = 'Downloading volume data';

    try {
      // Use the XHR method which is more reliable for downloads
      const blob = await xhrDownloadFileId(volumeDataId);
      
      // Convert blob to text
      const text = await blob.text();
      
      // Parse the JSON response
      const downloaded = JSON.parse(text);
      
      // Log the structure to help debug
      console.log('Downloaded volume data structure:', Object.keys(downloaded));
      
      // Update the volumes store with careful handling of potential structure changes
      volumes.update((prev) => {
        const result = { ...prev };
        
        // Process each volume entry to ensure compatibility with current structure
        Object.entries(downloaded).forEach(([key, value]) => {
          try {
            // If the value is not an object or is null, skip it
            if (!value || typeof value !== 'object') {
              console.warn(`Skipping invalid volume data for key ${key}:`, value);
              return;
            }
            
            // Ensure the volume data has the expected structure
            const volumeData = {
              progress: typeof value.progress === 'number' ? value.progress : 0,
              chars: typeof value.chars === 'number' ? value.chars : 0,
              completed: !!value.completed,
              timeReadInMinutes: typeof value.timeReadInMinutes === 'number' ? value.timeReadInMinutes : 0,
              settings: {
                singlePageView: typeof value.settings?.singlePageView === 'boolean' ? value.settings.singlePageView : false,
                rightToLeft: typeof value.settings?.rightToLeft === 'boolean' ? value.settings.rightToLeft : true,
                hasCover: typeof value.settings?.hasCover === 'boolean' ? value.settings.hasCover : false
              }
            };
            
            result[key] = volumeData;
          } catch (err) {
            console.error(`Error processing volume data for key ${key}:`, err);
          }
        });
        
        return result;
      });
      
      loadingMessage = '';
      showSnackbar('Volume data downloaded');
    } catch (error) {
      console.error('Error downloading volume data:', error);
      loadingMessage = '';
      showSnackbar('Failed to download volume data: ' + (error.message || 'Unknown error'));
    }
  }

  async function onDownloadProfiles() {
    if (!profilesId) {
      showSnackbar('No profiles file found');
      return;
    }

    loadingMessage = 'Downloading profiles';

    try {
      // Use the XHR method which is more reliable for downloads
      const blob = await xhrDownloadFileId(profilesId);
      
      // Convert blob to text
      const text = await blob.text();
      
      // Parse the JSON response
      const downloaded = JSON.parse(text);
      
      // Log the structure to help debug
      console.log('Downloaded profiles structure:', Object.keys(downloaded));
      
      // Update the profiles store with careful handling of potential structure changes
      profiles.update((prev) => {
        const result = { ...prev };
        
        // Process each profile entry to ensure compatibility with current structure
        Object.entries(downloaded).forEach(([profileName, profileValue]) => {
          try {
            // If the value is not an object or is null, skip it
            if (!profileValue || typeof profileValue !== 'object') {
              console.warn(`Skipping invalid profile data for ${profileName}:`, profileValue);
              return;
            }
            
            // Create a valid profile with defaults for any missing properties
            const defaultSettings = {
              defaultFullscreen: false,
              displayOCR: true,
              textEditable: false,
              textBoxBorders: false,
              boldFont: false,
              pageNum: true,
              charCount: false,
              mobile: false,
              bounds: false,
              backgroundColor: '#030712',
              swipeThreshold: 50,
              edgeButtonWidth: 40,
              showTimer: false,
              quickActions: true,
              fontSize: 'auto',
              zoomDefault: 'zoomFitToScreen',
              invertColors: false,
              volumeDefaults: {
                singlePageView: false,
                rightToLeft: true,
                hasCover: false
              },
              ankiConnectSettings: {
                enabled: false,
                cropImage: false,
                grabSentence: false,
                overwriteImage: true,
                pictureField: 'Picture',
                sentenceField: 'Sentence',
                triggerMethod: 'both'
              }
            };
            
            // Merge the downloaded profile with defaults
            result[profileName] = {
              ...defaultSettings,
              ...profileValue,
              // Ensure nested objects are properly merged
              volumeDefaults: {
                ...defaultSettings.volumeDefaults,
                ...(profileValue.volumeDefaults || {})
              },
              ankiConnectSettings: {
                ...defaultSettings.ankiConnectSettings,
                ...(profileValue.ankiConnectSettings || {})
              }
            };
          } catch (err) {
            console.error(`Error processing profile data for ${profileName}:`, err);
          }
        });
        
        return result;
      });
      
      loadingMessage = '';
      showSnackbar('Profiles downloaded');
    } catch (error) {
      console.error('Error downloading profiles:', error);
      loadingMessage = '';
      showSnackbar('Failed to download profiles: ' + (error.message || 'Unknown error'));
    }
  }
</script>

<svelte:head>
  <title>Cloud</title>
</svelte:head>

<div class="p-2 h-[90svh]">
  {#if loadingMessage || completed > 0}
    <Loader>
      {#if completed > 0}
        <P>{formatBytes(completed)} / {formatBytes(totalSize)}</P>
        <Progressbar {progress} />
      {:else}
        {loadingMessage}
      {/if}
    </Loader>
  {:else if accessToken}
    <div class="flex justify-between items-center gap-6 flex-col">
      <div class="flex justify-between items-center w-full max-w-3xl">
        <h2 class="text-3xl font-semibold text-center pt-2">Google Drive:</h2>
        <Button color="red" on:click={logout}>Log out</Button>
      </div>
      <p class="text-center">
        Add your zipped manga files to the <span class="text-primary-700">{READER_FOLDER}</span> folder
        in your Google Drive.
      </p>
      <div class="flex flex-col gap-4 w-full max-w-3xl">
        <Button color="blue" on:click={createPicker}>Download manga</Button>
        <div class="flex-col gap-2 flex">
          <Button
            color="dark"
            on:click={() => promptConfirmation('Upload volume data?', onUploadVolumeData)}
          >
            Upload volume data
          </Button>
          {#if volumeDataId}
            <Button
              color="alternative"
              on:click={() =>
                promptConfirmation('Download and overwrite volume data?', onDownloadVolumeData)}
            >
              Download volume data
            </Button>
          {/if}
        </div>
        <div class="flex-col gap-2 flex">
          <Button
            color="dark"
            on:click={() => promptConfirmation('Upload profiles?', onUploadProfiles)}
          >
            Upload profiles
          </Button>
          {#if profilesId}
            <Button
              color="alternative"
              on:click={() =>
                promptConfirmation('Download and overwrite profiles?', onDownloadProfiles)}
            >
              Download profiles
            </Button>
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <div class="flex justify-center pt-0 sm:pt-32">
      <button
        class="w-full border rounded-lg border-slate-600 p-10 border-opacity-50 hover:bg-slate-800 max-w-3xl"
        on:click={signIn}
      >
        <div class="flex sm:flex-row flex-col gap-2 items-center justify-center">
          <GoogleSolid size="lg" />
          <h2 class="text-lg">Connect to Google Drive</h2>
        </div>
      </button>
    </div>
  {/if}
</div>
