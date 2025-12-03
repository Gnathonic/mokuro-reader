<script lang="ts">
  import { browser } from '$app/environment';
  import { webdavErrorModalStore, closeWebDAVError } from '$lib/util/modals';
  import { Modal, Button } from 'flowbite-svelte';
  import { ExclamationCircleOutline, ClipboardListOutline } from 'flowbite-svelte-icons';
  import { showSnackbar } from '$lib/util/snackbar';
  import type { WebDAVErrorType } from '$lib/util/modals';

  let open = $state(false);

  $effect(() => {
    open = $webdavErrorModalStore?.open ?? false;
  });

  function handleClose() {
    closeWebDAVError();
  }

  function handleRetry() {
    const retryFn = $webdavErrorModalStore?.onRetry;
    closeWebDAVError();
    if (retryFn) {
      retryFn();
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    showSnackbar('Copied to clipboard');
  }

  // Error type titles
  const errorTitles: Record<WebDAVErrorType, string> = {
    cors: 'CORS Configuration Required',
    auth: 'Authentication Failed',
    connection: 'Connection Failed',
    permission: 'Read-Only Access',
    unknown: 'Connection Error'
  };

  // Get the app's origin for CORS headers
  let appOrigin = $derived(browser ? window.location.origin : 'https://reader.mokuro.app');

  // Required CORS headers - use actual app URL instead of wildcard
  let requiredHeaders = $derived(`Access-Control-Allow-Origin: ${appOrigin}
Access-Control-Allow-Methods: GET, PUT, DELETE, OPTIONS, PROPFIND, MKCOL
Access-Control-Allow-Headers: Authorization, Content-Type, Depth, Overwrite, Destination
Access-Control-Allow-Credentials: true`);
</script>

<Modal bind:open size="lg" dismissable={false} class="z-50">
  <div class="flex flex-col gap-4">
    <!-- Header -->
    <div class="flex items-center gap-3">
      <ExclamationCircleOutline class="h-8 w-8 text-red-500" />
      <h3 class="text-xl font-semibold">
        WebDAV Error: {errorTitles[$webdavErrorModalStore?.errorType ?? 'unknown']}
      </h3>
    </div>

    <!-- Error message -->
    {#if $webdavErrorModalStore?.serverUrl}
      <p class="text-sm text-gray-400">
        Server: <code class="rounded bg-gray-700 px-1">{$webdavErrorModalStore.serverUrl}</code>
      </p>
    {/if}

    <!-- CORS Error Content -->
    {#if $webdavErrorModalStore?.errorType === 'cors'}
      <div class="space-y-4">
        <p class="text-gray-300">
          Your WebDAV server is blocking requests from this web app. This is a browser security
          feature called <strong>CORS</strong> (Cross-Origin Resource Sharing).
        </p>

        <div class="space-y-3">
          <p class="text-sm text-gray-400">
            Your server needs to be configured to allow requests from this app. It must send these
            HTTP headers:
          </p>
          <div class="relative">
            <pre
              class="overflow-x-auto rounded bg-gray-800 p-3 text-xs text-gray-300">{requiredHeaders}</pre>
            <button
              class="absolute top-2 right-2 rounded bg-gray-700 p-1.5 hover:bg-gray-600"
              onclick={() => copyToClipboard(requiredHeaders)}
              title="Copy to clipboard"
            >
              <ClipboardListOutline class="h-4 w-4" />
            </button>
          </div>
        </div>

        <div class="text-sm text-gray-400">
          <p class="mb-2 font-medium text-gray-300">How to fix this:</p>
          <ul class="list-inside list-disc space-y-1">
            <li>
              Search for "<strong>CORS</strong>" or "<strong>cross-origin</strong>" in your WebDAV
              server's settings or documentation
            </li>
            <li>If self-hosting, you may need to edit your server's configuration file</li>
            <li>Some cloud services have CORS settings in their admin panel</li>
            <li>After making changes, restart your server and try again</li>
          </ul>
        </div>
      </div>

      <!-- Authentication Error Content -->
    {:else if $webdavErrorModalStore?.errorType === 'auth'}
      <div class="space-y-4">
        <p class="text-gray-300">
          The server rejected your credentials. Check your username and password.
        </p>

        <div class="text-sm text-gray-400">
          <p class="mb-2 font-medium text-gray-300">Things to check:</p>
          <ul class="list-inside list-disc space-y-1">
            <li>Username and password are correct</li>
            <li>If you have 2FA enabled, use an App Password instead of your main password</li>
            <li>The server URL path is correct for your WebDAV service</li>
            <li>Your account is not locked or disabled</li>
          </ul>
        </div>
      </div>

      <!-- Connection Error Content -->
    {:else if $webdavErrorModalStore?.errorType === 'connection'}
      <div class="space-y-4">
        <p class="text-gray-300">
          Could not connect to the WebDAV server. The server may be offline or the URL may be
          incorrect.
        </p>

        <div class="text-sm text-gray-400">
          <p class="mb-2 font-medium text-gray-300">Things to check:</p>
          <ul class="list-inside list-disc space-y-1">
            <li>The server URL is spelled correctly</li>
            <li>The server is running and accessible</li>
            <li>You're using the correct protocol (https:// vs http://)</li>
            <li>Your network/VPN connection is working</li>
            <li>Try opening the URL directly in a new browser tab</li>
          </ul>
        </div>
      </div>

      <!-- Unknown Error Content -->
    {:else}
      <div class="space-y-4">
        <p class="text-gray-300">
          An unexpected error occurred while connecting to the WebDAV server.
        </p>

        <div class="rounded bg-gray-800 p-3">
          <p class="text-sm text-gray-400">
            Error: <code>{$webdavErrorModalStore?.errorMessage}</code>
          </p>
        </div>

        <p class="text-sm text-gray-500">
          If this problem persists, check the browser console (F12) for more details.
        </p>
      </div>
    {/if}

    <!-- Action buttons -->
    <div class="mt-4 flex justify-end gap-3">
      <Button color="alternative" onclick={handleClose}>Close</Button>
      {#if $webdavErrorModalStore?.onRetry}
        <Button color="primary" onclick={handleRetry}>Try Again</Button>
      {/if}
    </div>
  </div>
</Modal>
