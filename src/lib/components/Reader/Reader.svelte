<script lang="ts">
  import { catalog } from '$lib/catalog';
  import {
    Panzoom,
    panzoomStore,
    toggleFullScreen,
    zoomDefault,
    zoomFitToScreen
  } from '$lib/panzoom';
  import { progress, settings, updateProgress, type VolumeSettings } from '$lib/settings';
  import { clamp, debounce, fireExstaticEvent } from '$lib/util';
  import { Input, Popover, Range, Spinner } from 'flowbite-svelte';
  import MangaPage from './MangaPage.svelte';
  import {
    ChervonDoubleLeftSolid,
    ChervonDoubleRightSolid,
    ChevronLeftSolid,
    ChevronRightSolid
  } from 'flowbite-svelte-icons';
  import Cropper from './Cropper.svelte';
  import { page as pageStore } from '$app/stores';
  import SettingsButton from './SettingsButton.svelte';
  import { getCharCount } from '$lib/util/count-chars';
  import QuickActions from './QuickActions.svelte';
  import { beforeNavigate } from '$app/navigation';
  import { onMount } from 'svelte';

  // TODO: Refactor this whole mess
  export let volumeSettings: VolumeSettings;

  $: volume = $catalog
    ?.find((item) => item.id === $pageStore.params.manga)
    ?.manga.find((item) => item.mokuroData.volume_uuid === $pageStore.params.volume);

  $: pages = volume?.mokuroData.pages || [];

  $: page = $progress?.[volume?.mokuroData.volume_uuid || 0] || 1;
  $: index = page - 1;
  $: navAmount =
    volumeSettings.singlePageView ||
    (volumeSettings.hasCover && !volumeSettings.singlePageView && index === 0)
      ? 1
      : 2;

  let start: Date;

  function mouseDown() {
    start = new Date();
  }

  function left(_e: any, ingoreTimeOut?: boolean) {
    const newPage = volumeSettings.rightToLeft ? page + navAmount : page - navAmount;
    changePage(newPage, ingoreTimeOut);
  }

  function right(_e: any, ingoreTimeOut?: boolean) {
    const newPage = volumeSettings.rightToLeft ? page - navAmount : page + navAmount;
    changePage(newPage, ingoreTimeOut);
  }

  function changePage(newPage: number, ingoreTimeOut = false) {
    const end = new Date();
    const clickDuration = ingoreTimeOut ? 0 : end.getTime() - start?.getTime();

    if (pages && volume && clickDuration < 200) {
      if (showSecondPage() && page + 1 === pages.length && newPage > page) {
        return;
      }
      const pageClamped = clamp(newPage, 1, pages?.length);
      const { charCount } = getCharCount(pages, pageClamped);

      updateProgress(
        volume.mokuroData.volume_uuid,
        pageClamped,
        charCount,
        pageClamped === pages.length || pageClamped === pages.length - 1
      );
      zoomDefault();
    }
  }

  $: showSecondPage = () => {
    if (!pages) {
      return false;
    }

    if (volumeSettings.singlePageView || index + 1 >= pages.length) {
      return false;
    }

    if (index === 0 && volumeSettings.hasCover) {
      return false;
    }

    return true;
  };

  $: manualPage = page;
  $: pageDisplay = showSecondPage()
    ? `${page},${page + 1} / ${pages?.length}`
    : `${page} / ${pages?.length}`;

  $: charDisplay = `${charCount} / ${maxCharCount}`;

  function onInputClick(this: any) {
    this.select();
  }

  function onManualPageChange() {
    changePage(manualPage, true);
  }

  function handleShortcuts(event: KeyboardEvent & { currentTarget: EventTarget & Window }) {
    const action = event.code || event.key;

    switch (action) {
      case 'ArrowLeft':
        left(event, true);
        return;
      case 'ArrowUp':
      case 'PageUp':
        changePage(page - navAmount, true);
        return;
      case 'ArrowRight':
        right(event, true);
        return;
      case 'ArrowDown':
      case 'PageDown':
      case 'Space':
        changePage(page + navAmount, true);
        return;
      case 'Home':
        changePage(1, true);
        return;
      case 'End':
        if (pages) {
          changePage(pages.length, true);
        }
        return;
      case 'KeyF':
        toggleFullScreen();
        return;
      default:
        break;
    }
  }

  $: charCount = $settings.charCount ? getCharCount(pages, page).charCount : 0;
  $: maxCharCount = getCharCount(pages).charCount;
  $: totalLineCount = getCharCount(pages).lineCount;

  let startX = 0;
  let startY = 0;
  let touchStart: Date;

  function handleTouchStart(event: TouchEvent) {
    if ($settings.mobile) {
      const { clientX, clientY } = event.touches[0];
      touchStart = new Date();

      startX = clientX;
      startY = clientY;
    }
  }

  function handlePointerUp(event: TouchEvent) {
    if ($settings.mobile) {
      debounce(() => {
        if (event.touches.length === 0) {
          const { clientX, clientY } = event.changedTouches[0];

          const distanceX = clientX - startX;
          const distanceY = clientY - startY;

          const isSwipe = distanceY < 200 && distanceY > 200 * -1;

          const end = new Date();
          const touchDuration = end.getTime() - touchStart?.getTime();

          if (isSwipe && touchDuration < 500) {
            const swipeThreshold = Math.abs(($settings.swipeThreshold / 100) * window.innerWidth);

            if (distanceX > swipeThreshold) {
              left(event, true);
            } else if (distanceX < swipeThreshold * -1) {
              right(event, true);
            }
          }
        }
      });
    }
  }

  function onDoubleTap(event: MouseEvent) {
    if ($panzoomStore && $settings.mobile) {
      const { clientX, clientY } = event;
      const { scale } = $panzoomStore.getTransform();

      if (scale < 1) {
        $panzoomStore.zoomTo(clientX, clientY, 1.5);
      } else {
        zoomFitToScreen();
      }
    }
  }

  $: {
    if (volume) {
      const { charCount, lineCount } = getCharCount(pages, page);

      fireExstaticEvent('mokuro-reader:page.change', {
        title: volume.mokuroData.title,
        volumeName: volume.mokuroData.volume,
        currentCharCount: charCount,
        currentPage: page,
        totalPages: pages.length,
        totalCharCount: maxCharCount || 0,
        currentLineCount: lineCount,
        totalLineCount
      });
    }
  }

  onMount(() => {
    if ($settings.defaultFullscreen) {
      document.documentElement.requestFullscreen();
    }
  });

  beforeNavigate(() => {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    }

    if (volume) {
      const { charCount, lineCount } = getCharCount(pages, page);

      fireExstaticEvent('mokuro-reader:reader.closed', {
        title: volume.mokuroData.title,
        volumeName: volume.mokuroData.volume,
        currentCharCount: charCount,
        currentPage: page,
        totalPages: pages.length,
        totalCharCount: maxCharCount || 0,
        currentLineCount: lineCount,
        totalLineCount
      });
    }
  });
</script>

<svelte:window
  on:resize={zoomDefault}
  on:keyup={handleShortcuts}
  on:touchstart={handleTouchStart}
  on:touchend={handlePointerUp}
/>
<svelte:head>
  <title>{volume?.mokuroData.volume || 'Volume'}</title>
</svelte:head>
{#if volume && pages}
  <QuickActions
    {left}
    {right}
    src1={Object.values(volume?.files)[index]}
    src2={!volumeSettings.singlePageView ? Object.values(volume?.files)[index + 1] : undefined}
  />
  <SettingsButton />
  <Cropper />
  <Popover placement="bottom" trigger="click" triggeredBy="#page-num" class="z-20 w-full max-w-xs">
    <div class="flex flex-col gap-3">
      <div class="flex flex-row items-center gap-5 z-10">
        <ChervonDoubleLeftSolid
          on:click={() => changePage(volumeSettings.rightToLeft ? pages.length : 1, true)}
          class="hover:text-primary-600"
          size="sm"
        />
        <ChevronLeftSolid
          on:click={(e) => left(e, true)}
          class="hover:text-primary-600"
          size="sm"
        />
        <Input
          type="number"
          size="sm"
          bind:value={manualPage}
          on:click={onInputClick}
          on:change={onManualPageChange}
        />
        <ChevronRightSolid
          on:click={(e) => right(e, true)}
          class="hover:text-primary-600"
          size="sm"
        />
        <ChervonDoubleRightSolid
          on:click={() => changePage(volumeSettings.rightToLeft ? 1 : pages.length, true)}
          class="hover:text-primary-600"
          size="sm"
        />
      </div>
      <div style:direction={volumeSettings.rightToLeft ? 'rtl' : 'ltr'}>
        <Range
          min={1}
          max={pages.length}
          bind:value={manualPage}
          on:change={onManualPageChange}
          defaultClass=""
        />
      </div>
    </div>
  </Popover>
  <button class="absolute opacity-50 left-5 top-5 z-10 mix-blend-difference" id="page-num">
    <p class="text-left" class:hidden={!$settings.charCount}>{charDisplay}</p>
    <p class="text-left" class:hidden={!$settings.pageNum}>{pageDisplay}</p>
  </button>
  <div class="flex" style:background-color={$settings.backgroundColor}>
    <Panzoom>
      <button
        class="h-full fixed -left-full z-10 w-full hover:bg-slate-400 opacity-[0.01]"
        style:margin-left={`${$settings.edgeButtonWidth}px`}
        on:mousedown={mouseDown}
        on:mouseup={left}
      />
      <button
        class="h-full fixed -right-full z-10 w-full hover:bg-slate-400 opacity-[0.01]"
        style:margin-right={`${$settings.edgeButtonWidth}px`}
        on:mousedown={mouseDown}
        on:mouseup={right}
      />
      <button
        class="h-screen fixed top-full -left-full z-10 w-[150%] hover:bg-slate-400 opacity-[0.01]"
        on:mousedown={mouseDown}
        on:mouseup={left}
      />
      <button
        class="h-screen fixed top-full -right-full z-10 w-[150%] hover:bg-slate-400 opacity-[0.01]"
        on:mousedown={mouseDown}
        on:mouseup={right}
      />
      <div
        class="flex flex-row"
        class:flex-row-reverse={!volumeSettings.rightToLeft}
        style:filter={`invert(${$settings.invertColors ? 1 : 0})`}
        on:dblclick={onDoubleTap}
        role="none"
        id="manga-panel"
      >
        {#key page}
          {#if showSecondPage()}
            <MangaPage page={pages[index + 1]} src={Object.values(volume?.files)[index + 1]} />
          {/if}
          <MangaPage page={pages[index]} src={Object.values(volume?.files)[index]} />
        {/key}
      </div>
    </Panzoom>
  </div>
  {#if !$settings.mobile}
    <button
      on:mousedown={mouseDown}
      on:mouseup={left}
      class="left-0 top-0 absolute h-full w-16 hover:bg-slate-400 opacity-[0.01]"
      style:width={`${$settings.edgeButtonWidth}px`}
    />
    <button
      on:mousedown={mouseDown}
      on:mouseup={right}
      class="right-0 top-0 absolute h-full w-16 hover:bg-slate-400 opacity-[0.01]"
      style:width={`${$settings.edgeButtonWidth}px`}
    />
  {/if}
{:else}
  <div class="fixed z-50 left-1/2 top-1/2">
    <Spinner />
  </div>
{/if}