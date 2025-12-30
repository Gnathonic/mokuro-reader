<script lang="ts">
  import { browser } from '$app/environment';
  import { webdavErrorModalStore, closeWebDAVError } from '$lib/util/modals';
  import { Modal, Button, AccordionItem, Accordion } from 'flowbite-svelte';
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
    network: 'Network Error',
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

    <!-- Network Error Content (was CORS) -->
    {#if $webdavErrorModalStore?.errorType === 'network'}
      <div class="space-y-4">
        <p class="text-gray-300">
          The request failed before reaching the server. This can happen for several reasons.
        </p>

        <div class="rounded border border-blue-700 bg-blue-900/30 p-3">
          <p class="text-sm text-blue-300">
            <strong>Tip:</strong> Press
            <kbd class="rounded bg-gray-700 px-1.5 py-0.5 text-xs">F12</kbd>
            to open DevTools, then check the <strong>Console</strong> tab for the specific error
            (look for <code class="text-blue-200">net::ERR_*</code> messages).
          </p>
        </div>

        <p class="text-sm text-gray-400">Click a section below for troubleshooting steps:</p>

        <Accordion>
          <AccordionItem open>
            {#snippet header()}<span class="text-gray-200">CORS Not Configured (most common)</span
              >{/snippet}
            <div class="space-y-3">
              <p class="text-sm text-gray-400">
                Console shows: <code class="text-red-400">net::ERR_FAILED</code> with a CORS policy message
              </p>
              <p class="text-gray-300">
                Your WebDAV server is blocking requests from this web app. This is a browser
                security feature called <strong>CORS</strong> (Cross-Origin Resource Sharing).
              </p>

              <div class="space-y-2">
                <p class="text-sm text-gray-400">Your server needs to send these HTTP headers:</p>
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
                <p class="mb-2 font-medium text-gray-300">How to fix:</p>
                <ul class="list-inside list-disc space-y-1">
                  <li>Search for "CORS" in your WebDAV server's settings or documentation</li>
                  <li>If self-hosting, edit your server's configuration file</li>
                  <li>Some cloud services have CORS settings in their admin panel</li>
                  <li>After making changes, restart your server and try again</li>
                </ul>
              </div>
            </div>
          </AccordionItem>

          <AccordionItem>
            {#snippet header()}<span class="text-gray-200">SSL Certificate Issue</span>{/snippet}
            <div class="space-y-3">
              <p class="text-sm text-gray-400">
                Console shows: <code class="text-red-400">net::ERR_SSL_*</code> or
                <code class="text-red-400">net::ERR_CERT_*</code>
              </p>
              <p class="text-gray-300">
                The server's SSL certificate is invalid, expired, or not trusted by your browser.
              </p>
              <div class="text-sm text-gray-400">
                <p class="mb-2 font-medium text-gray-300">How to fix:</p>
                <ul class="list-inside list-disc space-y-1">
                  <li>Check if the certificate has expired</li>
                  <li>Ensure the certificate matches the domain name</li>
                  <li>
                    Try visiting the URL directly in a new tab - if you see a security warning, the
                    cert is the issue
                  </li>
                  <li>If self-signed, you may need to add an exception in your browser first</li>
                </ul>
              </div>
            </div>
          </AccordionItem>

          <AccordionItem>
            {#snippet header()}<span class="text-gray-200">DNS Resolution Failed</span>{/snippet}
            <div class="space-y-3">
              <p class="text-sm text-gray-400">
                Console shows: <code class="text-red-400">net::ERR_NAME_NOT_RESOLVED</code>
              </p>
              <p class="text-gray-300">The domain name could not be resolved to an IP address.</p>
              <div class="text-sm text-gray-400">
                <p class="mb-2 font-medium text-gray-300">How to fix:</p>
                <ul class="list-inside list-disc space-y-1">
                  <li>Check that the URL is spelled correctly</li>
                  <li>Verify the domain exists and DNS is configured</li>
                  <li>Try using an IP address instead of a hostname</li>
                  <li>Check your network/VPN connection</li>
                </ul>
              </div>
            </div>
          </AccordionItem>

          <AccordionItem>
            {#snippet header()}<span class="text-gray-200">Server Unreachable</span>{/snippet}
            <div class="space-y-3">
              <p class="text-sm text-gray-400">
                Console shows: <code class="text-red-400">net::ERR_CONNECTION_REFUSED</code> or
                <code class="text-red-400">net::ERR_CONNECTION_TIMED_OUT</code>
              </p>
              <p class="text-gray-300">The server is not responding or is blocking connections.</p>
              <div class="text-sm text-gray-400">
                <p class="mb-2 font-medium text-gray-300">How to fix:</p>
                <ul class="list-inside list-disc space-y-1">
                  <li>Verify the server is running</li>
                  <li>Check the port number is correct</li>
                  <li>Ensure firewall isn't blocking the connection</li>
                  <li>If on a local network, check you're connected to the right network</li>
                </ul>
              </div>
            </div>
          </AccordionItem>
        </Accordion>
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
