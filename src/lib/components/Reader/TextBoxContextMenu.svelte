<script lang="ts">
  interface Props {
    x: number;
    y: number;
    lines: string[];
    ankiEnabled: boolean;
    textBoxElement?: HTMLElement | null;
    onCopy: () => void;
    onCopyRaw: () => void;
    onAddToAnki: (selection: string) => void;
    onClose: () => void;
  }

  let { x, y, lines, ankiEnabled, textBoxElement, onCopy, onCopyRaw, onAddToAnki, onClose }: Props =
    $props();

  // Track current selection reactively (updates as user changes selection on mobile)
  let selection = $state(window.getSelection()?.toString().trim() || '');
  let hasSelection = $derived(selection.length > 0);

  // Update selection periodically while menu is open (for mobile selection changes)
  $effect(() => {
    const updateSelection = () => {
      const newSelection = window.getSelection()?.toString().trim() || '';
      if (newSelection !== selection) {
        selection = newSelection;
      }
    };

    // Check for selection changes on various events
    document.addEventListener('selectionchange', updateSelection);
    return () => document.removeEventListener('selectionchange', updateSelection);
  });

  // Full text from all lines
  const fullText = lines.join('');
  const fullTextStripped = fullText.replace(/[\n\r\t]/g, '');

  // Adjust position to keep menu in viewport and avoid overlapping textbox
  let menuElement: HTMLDivElement | undefined = $state();
  let adjustedX = $state(x);
  let adjustedY = $state(y);

  $effect(() => {
    if (menuElement) {
      const menuRect = menuElement.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const padding = 8;

      // If we have the textbox element, position menu to avoid overlapping it
      if (textBoxElement) {
        const boxRect = textBoxElement.getBoundingClientRect();

        // Try to position below the textbox
        let targetY = boxRect.bottom + padding;
        let targetX = boxRect.left;

        // If no room below, position above
        if (targetY + menuRect.height > viewportHeight) {
          targetY = boxRect.top - menuRect.height - padding;
        }

        // If still no room (above), just use bottom of viewport
        if (targetY < 0) {
          targetY = viewportHeight - menuRect.height - padding;
        }

        // Adjust X to stay in viewport
        if (targetX + menuRect.width > viewportWidth) {
          targetX = viewportWidth - menuRect.width - padding;
        }
        if (targetX < padding) {
          targetX = padding;
        }

        adjustedX = targetX;
        adjustedY = targetY;
      } else {
        // Fallback: position at touch point, adjusted for viewport
        if (x + menuRect.width > viewportWidth) {
          adjustedX = x - menuRect.width;
        } else {
          adjustedX = x;
        }

        if (y + menuRect.height > viewportHeight) {
          adjustedY = y - menuRect.height;
        } else {
          adjustedY = y;
        }
      }
    }
  });

  // Fallback copy method for mobile browsers
  function copyToClipboard(text: string): boolean {
    // Try modern API first
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {
        // Fallback if async clipboard fails
        fallbackCopy(text);
      });
      return true;
    }
    return fallbackCopy(text);
  }

  function fallbackCopy(text: string): boolean {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch (err) {
      console.error('Fallback copy failed:', err);
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }

  function copySelection(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    const text = selection.replace(/[\n\r\t]/g, '');
    copyToClipboard(text);
    onCopy();
    onClose();
  }

  function copySelectionRaw(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    copyToClipboard(selection);
    onCopyRaw();
    onClose();
  }

  function copyAll(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    copyToClipboard(fullTextStripped);
    onCopy();
    onClose();
  }

  function copyAllRaw(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    const text = lines.join('\n');
    copyToClipboard(text);
    onCopyRaw();
    onClose();
  }

  function handleAddToAnki(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    onAddToAnki(selection);
    onClose();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      onClose();
    }
  }
</script>

<svelte:window onclick={onClose} onkeydown={handleKeydown} />

<div
  bind:this={menuElement}
  class="context-menu"
  style:left="{adjustedX}px"
  style:top="{adjustedY}px"
  onclick={(e) => e.stopPropagation()}
  ontouchend={(e) => e.stopPropagation()}
  onpointerdown={(e) => e.stopPropagation()}
  onkeydown={(e) => e.stopPropagation()}
  oncontextmenu={(e) => e.preventDefault()}
  role="menu"
  tabindex="-1"
>
  {#if hasSelection}
    <!-- Selection-specific options -->
    <button type="button" class="menu-item" onpointerup={copySelection}>
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      <span>Copy selection</span>
    </button>
    <button type="button" class="menu-item" onpointerup={copySelectionRaw}>
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        <line x1="12" y1="13" x2="19" y2="13"></line>
        <line x1="12" y1="17" x2="19" y2="17"></line>
      </svg>
      <span>Copy selection with line breaks</span>
    </button>
    <div class="divider"></div>
  {/if}
  <!-- Always show copy all options -->
  <button type="button" class="menu-item" onpointerup={copyAll}>
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
    <span>Copy all</span>
  </button>
  <button type="button" class="menu-item" onpointerup={copyAllRaw}>
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      <line x1="12" y1="13" x2="19" y2="13"></line>
      <line x1="12" y1="17" x2="19" y2="17"></line>
    </svg>
    <span>Copy all with line breaks</span>
  </button>
  {#if ankiEnabled}
    <div class="divider"></div>
    <button type="button" class="menu-item" onpointerup={handleAddToAnki}>
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
        <path d="M2 17l10 5 10-5"></path>
        <path d="M2 12l10 5 10-5"></path>
      </svg>
      <span>Add to Anki</span>
    </button>
  {/if}
</div>

<style>
  .context-menu {
    position: fixed;
    z-index: 9999;
    min-width: 160px;
    background-color: white;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    box-shadow:
      0 10px 15px -3px rgb(0 0 0 / 0.1),
      0 4px 6px -4px rgb(0 0 0 / 0.1);
    padding: 0.25rem 0;
    font-size: 0.875rem;
    touch-action: manipulation;
  }

  :global(.dark) .context-menu {
    background-color: #1f2937;
    border-color: #374151;
    color: #f3f4f6;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    font-size: inherit;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }

  .icon {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
  }

  .menu-item:hover {
    background-color: #f3f4f6;
  }

  :global(.dark) .menu-item:hover {
    background-color: #374151;
  }

  .divider {
    height: 1px;
    margin: 0.25rem 0;
    background-color: #e5e7eb;
  }

  :global(.dark) .divider {
    background-color: #374151;
  }
</style>
