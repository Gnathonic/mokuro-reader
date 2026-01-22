<script lang="ts">
  import { catalog } from '$lib/catalog';
  import { nav, routeParams } from '$lib/util/hash-router';
  import { db } from '$lib/catalog/db';
  import { getCharCount } from '$lib/util/count-chars';
  import { Button, Alert } from 'flowbite-svelte';
  import { ArrowLeftOutline, ClipboardOutline, CheckOutline } from 'flowbite-svelte-icons';
  import { Spinner } from 'flowbite-svelte';
  import type { VolumeData, VolumeMetadata } from '$lib/types';
  import { onMount } from 'svelte';
  import { personalizedReadingSpeed } from '$lib/settings/reading-speed';
  import { calculateEstimatedTime } from '$lib/util/reading-speed';

  let seriesId = $derived($routeParams.manga || '');

  // Get series volumes from catalog - match by title first (for placeholder URLs), then UUID
  let seriesData = $derived(
    $catalog?.find((item) => item.title === seriesId) ||
      $catalog?.find((item) => item.series_uuid === seriesId)
  );
  let volumes = $derived(
    seriesData?.volumes
      .filter((v) => !v.isPlaceholder)
      .sort((a, b) =>
        a.volume_title.localeCompare(b.volume_title, undefined, {
          numeric: true,
          sensitivity: 'base'
        })
      ) || []
  );

  // Use state to track loaded data
  let volumesData = $state<Array<{ volume: VolumeMetadata; data: VolumeData }>>([]);
  let dataLoaded = $state(false);

  // Load all volume data on mount
  onMount(async () => {
    if (volumes.length > 0) {
      const results = await Promise.all(
        volumes.map(async (volume) => {
          try {
            const ocr = await db.volume_ocr.get(volume.volume_uuid);
            if (!ocr) return null;
            // Create a minimal data object with just pages for text extraction
            const data = { volume_uuid: volume.volume_uuid, pages: ocr.pages };
            return { volume, data };
          } catch (error) {
            console.error(`Failed to load data for ${volume.volume_title}:`, error);
            return null;
          }
        })
      );

      // Filter out null results
      volumesData = results.filter(
        (item): item is { volume: VolumeMetadata; data: VolumeData } => item !== null
      );
      dataLoaded = true;
    }
  });

  // State for copy feedback
  let copySuccess = $state(false);
  let copyError = $state(false);

  // Extract all text with volume and page markers
  let formattedText = $derived.by(() => {
    if (volumesData.length === 0) return '';

    const textParts: string[] = [];

    volumesData.forEach(({ volume, data }) => {
      const pages = data.pages || [];

      // Add volume marker
      textParts.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      textParts.push(`Volume: ${volume.volume_title}`);
      textParts.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      pages.forEach((pageData, pageIndex) => {
        // Add page marker
        textParts.push(`─── Page ${pageIndex + 1} ───\n`);

        // Extract all text from blocks
        pageData.blocks.forEach((block) => {
          block.lines.forEach((line) => {
            textParts.push(line);
          });
        });

        // Add blank line between pages
        textParts.push('\n');
      });
    });

    return textParts.join('\n');
  });

  // Calculate stats
  let stats = $derived.by(() => {
    if (volumesData.length === 0) {
      return {
        volumeCount: 0,
        pageCount: 0,
        japaneseCharCount: 0,
        totalCharCount: 0,
        wordCount: 0,
        lineCount: 0,
        estimatedTime: null
      };
    }

    let totalPages = 0;
    let totalJapaneseChars = 0;
    let totalChars = 0;
    let totalLines = 0;
    let allText = '';

    volumesData.forEach(({ data }) => {
      const pages = data.pages || [];
      totalPages += pages.length;

      const { charCount, lineCount } = getCharCount(pages);
      totalJapaneseChars += charCount;
      totalLines += lineCount;

      // Count total characters (including non-Japanese)
      pages.forEach((pageData) => {
        pageData.blocks.forEach((block) => {
          block.lines.forEach((line) => {
            totalChars += line.length;
            allText += line + ' ';
          });
        });
      });
    });

    // Count words (space-separated)
    const wordCount = allText.split(/\s+/).filter((w) => w.length > 0).length;

    // Calculate estimated reading time using utility function
    const estimatedTime = calculateEstimatedTime(totalJapaneseChars, $personalizedReadingSpeed);

    return {
      volumeCount: volumesData.length,
      pageCount: totalPages,
      japaneseCharCount: totalJapaneseChars,
      totalCharCount: totalChars,
      wordCount,
      lineCount: totalLines,
      estimatedTime
    };
  });

  // Copy text to clipboard
  async function copyText() {
    try {
      await navigator.clipboard.writeText(formattedText);
      copySuccess = true;
      copyError = false;
      setTimeout(() => {
        copySuccess = false;
      }, 3000);
    } catch (err) {
      console.error('Failed to copy text:', err);
      copyError = true;
      copySuccess = false;
      setTimeout(() => {
        copyError = false;
      }, 3000);
    }
  }

  function goBackToSeries() {
    if (seriesId) nav.toSeries(seriesId);
  }

  function goBackToCatalog() {
    nav.toCatalog();
  }
</script>

<svelte:head>
  <title>{seriesData?.title || 'Series'} - Text View</title>
</svelte:head>

{#if dataLoaded && volumesData.length > 0 && seriesData}
  <div class="min-h-screen bg-gray-50 py-8 dark:bg-gray-900">
    <div class="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
      <!-- Header -->
      <div class="mb-8">
        <!-- Navigation Buttons -->
        <div class="mb-4 flex flex-wrap gap-2">
          <Button size="sm" color="alternative" onclick={goBackToSeries}>
            <ArrowLeftOutline class="mr-2 h-3.5 w-3.5" />
            Back to Series
          </Button>
          <Button size="sm" color="alternative" onclick={goBackToCatalog}>
            <ArrowLeftOutline class="mr-2 h-3.5 w-3.5" />
            Back to Catalog
          </Button>
          <Button size="sm" color="primary" onclick={copyText}>
            {#if copySuccess}
              <CheckOutline class="mr-2 h-3.5 w-3.5" />
              Copied!
            {:else}
              <ClipboardOutline class="mr-2 h-3.5 w-3.5" />
              Copy All Text
            {/if}
          </Button>
        </div>

        {#if copyError}
          <Alert color="red" dismissable class="mb-4">
            Failed to copy text. Please try again or manually select and copy.
          </Alert>
        {/if}

        <!-- Series Title -->
        <h1 class="mb-2 text-3xl font-bold text-gray-900 dark:text-white">
          {seriesData.title}
        </h1>
        <p class="mb-4 text-lg text-gray-600 dark:text-gray-400">
          All volumes combined in a single text view for language analysis and searching
        </p>

        <!-- Stats -->
        <div class="rounded-lg bg-white p-6 shadow dark:bg-gray-800">
          <h2 class="mb-3 text-lg font-semibold text-gray-900 dark:text-white">
            Series Statistics
          </h2>
          <dl class="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <dt class="text-sm font-medium text-gray-500 dark:text-gray-400">Volumes</dt>
              <dd class="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
                {stats.volumeCount.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt class="text-sm font-medium text-gray-500 dark:text-gray-400">Pages</dt>
              <dd class="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
                {stats.pageCount.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt class="text-sm font-medium text-gray-500 dark:text-gray-400">
                Japanese Characters
              </dt>
              <dd class="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
                {stats.japaneseCharCount.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt class="text-sm font-medium text-gray-500 dark:text-gray-400">Total Characters</dt>
              <dd class="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
                {stats.totalCharCount.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt class="text-sm font-medium text-gray-500 dark:text-gray-400">Words</dt>
              <dd class="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
                {stats.wordCount.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt class="text-sm font-medium text-gray-500 dark:text-gray-400">Lines</dt>
              <dd class="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
                {stats.lineCount.toLocaleString()}
              </dd>
            </div>
            {#if stats.estimatedTime}
              <div class="col-span-2 sm:col-span-1">
                <dt class="text-sm font-medium text-gray-500 dark:text-gray-400">
                  Est. Reading Time
                </dt>
                <dd class="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
                  {stats.estimatedTime.displayText}{stats.estimatedTime.isPersonalized ? ' ⭐' : ''}
                </dd>
              </div>
            {/if}
          </dl>
          {#if stats.estimatedTime}
            <p class="mt-4 text-xs text-gray-500 dark:text-gray-400">
              {#if stats.estimatedTime.isPersonalized}
                * Estimated based on your average speed from the last 8 hours of reading (~{$personalizedReadingSpeed.charsPerMinute}
                chars/min)
              {:else}
                * Estimated reading time based on default speed (~100 Japanese characters/minute for
                manga)
              {/if}
            </p>
          {/if}
        </div>
      </div>

      <!-- Text Content -->
      <div class="rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="p-6">
          <h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Full Series Text</h2>
          <div
            class="max-h-[800px] overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-6 dark:border-gray-700 dark:bg-gray-900"
          >
            <pre
              class="font-mono text-sm leading-relaxed whitespace-pre-wrap text-gray-900 dark:text-gray-100">{formattedText}</pre>
          </div>
          <p class="mt-4 text-sm text-gray-500 dark:text-gray-400">
            Tip: Use Ctrl+F (Cmd+F on Mac) to search within the text, or use browser extensions for
            language analysis.
          </p>
        </div>
      </div>
    </div>
  </div>
{:else if !seriesData}
  <div class="flex h-screen w-screen items-center justify-center">
    <div class="text-center">
      <Spinner size="12" />
      <p class="mt-4 text-gray-600 dark:text-gray-400">Loading series...</p>
    </div>
  </div>
{:else}
  <div class="flex h-screen w-screen items-center justify-center">
    <div class="text-center">
      <p class="text-gray-600 dark:text-gray-400">No volumes available for this series.</p>
      <Button class="mt-4" color="alternative" onclick={goBackToCatalog}>
        <ArrowLeftOutline class="mr-2 h-3.5 w-3.5" />
        Back to Catalog
      </Button>
    </div>
  </div>
{/if}
