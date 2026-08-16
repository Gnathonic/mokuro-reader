<script lang="ts">
  import { AccordionItem, Label, Select } from 'flowbite-svelte';
  import { catalogSettings, updateCatalogSetting } from '$lib/settings/settings';
  import type { DisplayTitleLanguage } from '$lib/metadata/types';
  import AniListAccountSettings from './AniListAccountSettings.svelte';

  const titleLanguageOptions: { value: DisplayTitleLanguage; name: string }[] = [
    { value: 'imported', name: 'As imported (folder name)' },
    { value: 'native', name: 'Native (日本語)' },
    { value: 'romaji', name: 'Romaji' },
    { value: 'english', name: 'English' }
  ];
</script>

<AccordionItem>
  {#snippet header()}Metadata &amp; tracking{/snippet}
  <div class="flex flex-col gap-4">
    <div>
      <Label class="mb-2 text-sm font-medium">Preferred series title</Label>
      <Select
        items={titleLanguageOptions}
        value={$catalogSettings?.preferredTitleLanguage ?? 'imported'}
        onchange={(e) =>
          updateCatalogSetting(
            'preferredTitleLanguage',
            e.currentTarget.value as DisplayTitleLanguage
          )}
      />
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Applies to series linked to AniList. Folder names are never changed; when a language is
        missing the reader falls back to English → Romaji → Native → folder name. Each series can
        override this on its page.
      </p>
    </div>

    <AniListAccountSettings />
  </div>
</AccordionItem>
