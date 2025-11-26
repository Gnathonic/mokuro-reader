<script lang="ts">
  import { currentVolume, currentVolumeData } from '$lib/catalog';
  import { nav, routeParams } from '$lib/util/navigation';
  import { getCharCount } from '$lib/util/count-chars';
  import { Button, Alert } from 'flowbite-svelte';
  import { ArrowLeftOutline, ClipboardOutline, CheckOutline } from 'flowbite-svelte-icons';
  import { Spinner } from 'flowbite-svelte';
  import { onMount } from 'svelte';
  import type { VolumeData, VolumeMetadata } from '$lib/types';
  import { personalizedReadingSpeed } from '$lib/settings/reading-speed';
  import { calculateEstimatedTime } from '$lib/util/reading-speed';

  let volumeId = $derived($routeParams.volume || '');
  let volume = $derived($currentVolume);

  // Use state instead of derived to wait for data to fully load
  let volumeData = $state<VolumeData | undefined>(undefined);
  let dataLoaded = $state(false);

  // Load data on mount and wait for it
  onMount(() => {
    // Subscribe to currentVolumeData and wait for it to be non-null
    const unsubscribe = currentVolumeData.subscribe((data) => {
      if (data) {
        volumeData = data;
        dataLoaded = true;
      }
    });

    return unsubscribe;
  });

  let pages = $derived(volumeData?.pages || []);

  // State for copy feedback
  let copySuccess = $state(false);
  let copyError = $state(false);

  // Extract all text with page markers
  let formattedText = $derived.by(() => {
    if (!pages || pages.length === 0) return '';

    const textParts: string[] = [];

    pages.forEach((page, pageIndex) => {
      // Add page marker
      textParts.push(`━━━━━ Page ${pageIndex + 1} ━━━━━\n`);

      // Extract all text from blocks
      page.blocks.forEach((block) => {
        block.lines.forEach((line) => {
          textParts.push(line);
        });
      });

      // Add blank line between pages
      textParts.push('\n');
    });

    return textParts.join('\n');
  });

  // Calculate stats
  let stats = $derived.by(() => {
    if (!pages || pages.length === 0) {
      return {
        pageCount: 0,
        japaneseCharCount: 0,
        totalCharCount: 0,
        wordCount: 0,
        lineCount: 0,
        estimatedTime: null
      };
    }

    const { charCount: japaneseCharCount, lineCount } = getCharCount(pages);
    const pageCount = pages.length;

    // Count total characters (including non-Japanese)
    let totalCharCount = 0;
    pages.forEach((page) => {
      page.blocks.forEach((block) => {
        block.lines.forEach((line) => {
          totalCharCount += line.length;
        });
      });
    });

    // Count words (space-separated for English/romaji, or character count for Japanese)
    const allText = pages.flatMap((p) => p.blocks.flatMap((b) => b.lines)).join(' ');
    const wordCount = allText.split(/\s+/).filter((w) => w.length > 0).length;

    // Calculate estimated reading time using utility function
    const estimatedTime = calculateEstimatedTime(japaneseCharCount, $personalizedReadingSpeed);

    return {
      pageCount,
      japaneseCharCount,
      totalCharCount,
      wordCount,
      lineCount,
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

  function goBackToReader() {
    if (volume?.series_uuid && volumeId) nav.toReader(volume.series_uuid, volumeId);
  }

  function goBackToSeries() {
    if (volume?.series_uuid) nav.toSeries(volume.series_uuid);
  }
</script>

<svelte:head>
  <title>{volume?.volume_title || 'Volume'} - Text View</title>
</svelte:head>

{#if dataLoaded && volume && volumeData && pages.length > 0}
  <div class="min-h-screen bg-gray-50 py-8 dark:bg-gray-900">
    <div class="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
      <!-- Header -->
      <div class="mb-8">
        <!-- Navigation Buttons -->
        <div class="mb-4 flex flex-wrap gap-2">
          <Button size="sm" color="alternative" onclick={goBackToReader}>
            <ArrowLeftOutline class="mr-2 h-3.5 w-3.5" />
            Back to Reader
          </Button>
          <Button size="sm" color="alternative" onclick={goBackToSeries}>
            <ArrowLeftOutline class="mr-2 h-3.5 w-3.5" />
            Back to Series
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

        <!-- Volume Title -->
        <h1 class="mb-2 text-3xl font-bold text-gray-900 dark:text-white">
          {volume.volume_title}
        </h1>
        <p class="mb-4 text-lg text-gray-600 dark:text-gray-400">
          {volume.series_title} • Text-only view for language analysis
        </p>

        <!-- Stats -->
        <div class="rounded-lg bg-white p-6 shadow dark:bg-gray-800">
          <h2 class="mb-3 text-lg font-semibold text-gray-900 dark:text-white">
            Volume Statistics
          </h2>
          <dl class="grid grid-cols-2 gap-4 sm:grid-cols-3">
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
              <div>
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
          <h2 class="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Full Text</h2>
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
{:else if !volume || !volumeData}
  <div class="flex h-screen w-screen items-center justify-center">
    <div class="text-center">
      <Spinner size="12" />
      <p class="mt-4 text-gray-600 dark:text-gray-400">Loading volume text...</p>
    </div>
  </div>
{:else}
  <div class="flex h-screen w-screen items-center justify-center">
    <div class="text-center">
      <p class="text-gray-600 dark:text-gray-400">No text data available for this volume.</p>
      <Button class="mt-4" color="alternative" onclick={goBackToSeries}>
        <ArrowLeftOutline class="mr-2 h-3.5 w-3.5" />
        Back to Series
      </Button>
    </div>
  </div>
{/if}
