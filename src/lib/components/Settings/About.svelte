<script lang="ts">
  import { READER_VERSION } from '$lib/consts';
  import { toClipboard } from '$lib/util';
  import { A, AccordionItem, Badge, Helper } from 'flowbite-svelte';
  import { GithubSolid } from 'flowbite-svelte-icons';
</script>

<AccordionItem>
  <span slot="header">About</span>
  <div class="flex flex-col gap-5">
    <div class="flex flex-row justify-between">
      <p class="font-semibold">Mokuro reader {READER_VERSION} <Badge>BETA</Badge></p>
      <a
        class="hover:text-primary-600"
        href="https://github.com/ZXY101/mokuro-reader"
        target="_blank"
      >
        <GithubSolid />
      </a>
    </div>
    <p>
      An online reader, gallery and stat tracker for <A href="https://github.com/kha-white/mokuro"
        >mokuro</A
      > processed manga.
    </p>
    <div>
      <p>
        To use the reader, manga must be processed with mokuro <A
          href="https://github.com/kha-white/mokuro/tree/web-reader">0.2.0-beta.6</A
        > which can be installed via:
      </p>
      <div role="none" onclick={toClipboard}>
        <code class="text-primary-600 bg-slate-900"
          >pip3 install git+https://github.com/kha-white/mokuro.git@web-reader</code
        >
      </div>
    </div>
    <p>
      Once processed, upload your manga along with the <span class="text-primary-500">.mokuro</span>
      file.
    </p>
    <Helper
      >Created by <A href="https://github.com/ZXY101">ZXY101</A> & <A
        href="https://github.com/kha-white">kha-white</A
      ></Helper
    >
  </div>
</AccordionItem>
