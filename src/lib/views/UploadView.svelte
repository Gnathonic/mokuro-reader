<script lang="ts">
  import Loader from '$lib/components/Loader.svelte';
  import { getItems } from '$lib/upload';
  import { importFiles } from '$lib/import';
  import { normalizeFilename, promptConfirmation, showSnackbar } from '$lib/util';
  import { nav } from '$lib/util/hash-router';
  import { P, Progressbar } from 'flowbite-svelte';
  import { onMount } from 'svelte';

  // Use window.location.search for query params (works alongside hash routing)
  const searchParams = new window.URLSearchParams(window.location.search);
  const BASE_URL = searchParams.get('source') || 'https://mokuro.moe/manga';
  const manga = searchParams.get('manga');
  const volume = searchParams.get('volume');
  const url = `${BASE_URL}/${manga}/${volume}`;

  let message = $state('Loading...');

  let files: File[] = [];

  let completed = $state(0);
  let max = $state(0);

  let progress = $derived(Math.floor((completed / max) * 100).toString());

  async function onImport() {
    const normalizedVolume = normalizeFilename(volume || '');
    const mokuroRes = await fetch(url + '.mokuro', { cache: 'no-store' });
    const mokuroBlob = await mokuroRes.blob();
    const mokuroFile = new File([mokuroBlob], normalizedVolume + '.mokuro', {
      type: mokuroBlob.type
    });

    Object.defineProperty(mokuroFile, 'webkitRelativePath', {
      value: '/' + normalizedVolume + '.mokuro'
    });

    const res = await fetch(url + '/');
    const html = await res.text();

    const items = getItems(html);
    message = 'Downloading images...';

    const imageTypes = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff', '.gif', '.bmp'];

    max = items.length;

    for (const item of items) {
      const itemFileExtension = ('.' + item.pathname.split('.').at(-1)).toLowerCase();
      if (imageTypes.includes(itemFileExtension || '')) {
        const image = await fetch(url + item.pathname);
        const blob = await image.blob();
        const normalizedPath = normalizeFilename(item.pathname);
        const file = new File([blob], normalizedPath.substring(1));
        Object.defineProperty(file, 'webkitRelativePath', {
          value: '/' + normalizedVolume + normalizedPath
        });

        files.push(file);
      }
      completed++;
    }
    files.push(mokuroFile);
    message = 'Adding to catalog...';

    importFiles(files).then(() => {
      nav.toCatalog({ replaceState: true });
    });
  }

  function onCancel() {
    nav.toCatalog({ replaceState: true });
  }

  onMount(() => {
    if (!manga || !volume) {
      showSnackbar('Something went wrong');
      onCancel();
    } else {
      promptConfirmation(`Import ${decodeURI(volume || '')} into catalog?`, onImport, onCancel);
    }
  });
</script>

<div>
  <Loader>
    {message}
    {#if completed && progress !== '100'}
      <P>{completed} / {max}</P>
      <Progressbar {progress} />
    {/if}
  </Loader>
</div>
