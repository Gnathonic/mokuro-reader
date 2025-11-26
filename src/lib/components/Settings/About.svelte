<script lang="ts">
  import { READER_VERSION } from '$lib/consts';
  import { toClipboard } from '$lib/util';
  import { A, AccordionItem, Helper } from 'flowbite-svelte';
  import { DiscordSolid, GithubSolid } from 'flowbite-svelte-icons';
</script>

<AccordionItem>
  {#snippet header()}About{/snippet}
  <div class="flex flex-col gap-5">
    <div class="flex flex-row justify-between">
      <p class="font-semibold text-gray-900 dark:text-white">Mokuro reader {READER_VERSION}</p>
      <div class="flex gap-3">
        <a
          class="text-gray-900 hover:text-primary-600 dark:text-white"
          href="https://discord.gg/AU5pjjSQBw"
          target="_blank"
        >
          <DiscordSolid />
        </a>
        <a
          class="text-gray-900 hover:text-primary-600 dark:text-white"
          href="https://github.com/ZXY101/mokuro-reader"
          target="_blank"
        >
          <GithubSolid />
        </a>
      </div>
    </div>
    <p class="text-gray-900 dark:text-white">
      An online reader, gallery and stat tracker for <A href="https://github.com/kha-white/mokuro"
        >mokuro</A
      > processed manga.
    </p>
    <div>
      <p class="text-gray-900 dark:text-white">
        To use the reader, manga must be processed with mokuro <A
          href="https://github.com/kha-white/mokuro">0.2.0</A
        > or later which can be installed via:
      </p>
      <div role="none" onclick={toClipboard}>
        <code class="bg-slate-900 text-primary-600">pip install mokuro</code>
      </div>
    </div>
    <p class="text-gray-900 dark:text-white">
      Once processed, upload your manga along with the <span class="text-primary-500">.mokuro</span>
      file.
    </p>
    <Helper
      >Created by <A href="https://github.com/ZXY101">ZXY101</A>, <A
        href="https://github.com/kha-white">kha-white</A
      > & <A href="https://github.com/Gnathonic">Gnathonic</A></Helper
    >
  </div>
</AccordionItem>
