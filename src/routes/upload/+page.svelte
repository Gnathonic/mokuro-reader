<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import Loader from '$lib/components/Loader.svelte';
  import { getItems, processFiles } from '$lib/upload';
  import { promptConfirmation, showSnackbar } from '$lib/util';
  import { P, Progressbar } from 'flowbite-svelte';
  import { onMount } from 'svelte';

  export const BASE_URL = $page.url.searchParams.get('source') || 'https://www.mokuro.moe/manga';

  const manga = $page.url.searchParams.get('manga');
  const volume = $page.url.searchParams.get('volume');
  const url = `${BASE_URL}/${manga}/${volume}`;

  let message = $state('Loading...');

  let files: File[] = [];

  let completed = $state(0);
  let max = $state(0);

  let progress = $derived(Math.floor((completed / max) * 100).toString());

  async function onImport() {
    const mokuroRes = await fetch(url + '.mokuro', { cache: 'no-store' });
    const mokuroBlob = await mokuroRes.blob();
    const mokuroFile = new File([mokuroBlob], volume + '.mokuro', { type: mokuroBlob.type });

    Object.defineProperty(mokuroFile, 'webkitRelativePath', {
      value: '/' + volume + '.mokuro'
    });

    const res = await fetch(url + '/');
    const html = await res.text();

    const items = getItems(html);
    message = 'Downloading images...';

    const imageTypes = ['.jpg', '.jpeg', '.png', '.webp'];

    max = items.length;

    for (const item of items) {
      const itemFileExtension = ('.' + item.pathname.split('.').at(-1)).toLowerCase();
      if (imageTypes.includes(itemFileExtension || '')) {
        const image = await fetch(url + item.pathname);
        const blob = await image.blob();
        const file = new File([blob], item.pathname.substring(1));
        Object.defineProperty(file, 'webkitRelativePath', {
          value: '/' + volume + item.pathname
        });

        files.push(file);
      }
      completed++;
    }
    files.push(mokuroFile);
    files = files;
    message = 'Adding to catalog...';

    processFiles(files).then(() => {
      goto('/', { replaceState: true });
    });
  }

  function onCancel() {
    goto('/', { replaceState: true });
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
