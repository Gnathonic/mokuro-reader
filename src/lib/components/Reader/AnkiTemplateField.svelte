<script lang="ts">
  import { ChevronRightOutline } from 'flowbite-svelte-icons';
  import { slide } from 'svelte/transition';

  type TemplateButton = {
    readonly template: string;
    readonly description: string;
  };

  type VariableValue = {
    readonly template: string;
    readonly value: string;
    readonly isImage?: boolean;
  };

  interface Props {
    fieldName: string;
    template: string;
    resolvedValue: string;
    templateButtons: readonly TemplateButton[];
    availableVariables?: readonly VariableValue[];
    isModified?: boolean;
    willUpdate?: boolean; // True if this field will change the card (not just {existing})
    configureMode?: boolean;
    hint?: string; // Helper text shown in expanded view
    spaceBeforeInsert?: boolean; // Add space before inserted templates (for tags)
    onTemplateChange?: (template: string) => void;
    // Accordion behavior
    fieldId: string;
    expandedId?: string | null;
    onExpand?: (id: string | null) => void;
  }

  let {
    fieldName,
    template = $bindable(),
    resolvedValue,
    templateButtons,
    availableVariables = [],
    isModified = false,
    willUpdate = false,
    configureMode = false,
    hint,
    spaceBeforeInsert = false,
    onTemplateChange,
    fieldId,
    expandedId = null,
    onExpand
  }: Props = $props();

  let expanded = $derived(expandedId === fieldId);

  function toggleExpand() {
    onExpand?.(expanded ? null : fieldId);
  }

  // Check if template contains a variable
  function hasVariable(t: string): boolean {
    return template?.includes(t) ?? false;
  }

  // Simplify HTML content for display (convert <img> to [img], strip other tags)
  function simplifyHtml(html: string): string {
    if (!html) return '';
    return (
      html
        // Replace <img> tags with [img]
        .replace(/<img[^>]*>/gi, '[img]')
        // Replace <br> with newline
        .replace(/<br\s*\/?>/gi, '\n')
        // Strip remaining HTML tags
        .replace(/<[^>]+>/g, '')
        // Decode common HTML entities
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        // Clean up whitespace
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    );
  }

  // Get resolved value for a template variable
  function getVariableValue(t: string): string | null {
    const variable = availableVariables.find((v) => v.template === t);
    if (variable) {
      if (variable.isImage) return '[img]';
      return simplifyHtml(variable.value);
    }
    return null;
  }

  // Reference to textarea for cursor position
  let textareaEl: HTMLTextAreaElement | null = null;

  // Toggle template variable - add at cursor if not present, remove all if present
  function toggleTemplate(t: string) {
    if (hasVariable(t)) {
      // Remove the variable (and any surrounding whitespace if it leaves gaps)
      template = (template || '')
        .replace(new RegExp(t.replace(/[{}]/g, '\\$&') + '\\s*', 'g'), '')
        .replace(/\s+/g, ' ')
        .trim();
    } else {
      // Determine what to insert (optionally with leading space)
      const needsSpace = spaceBeforeInsert && template && !template.endsWith(' ');
      const toInsert = needsSpace ? ' ' + t : t;

      // Insert at cursor position if we have a textarea reference
      if (textareaEl) {
        const start = textareaEl.selectionStart;
        const end = textareaEl.selectionEnd;
        const before = template?.slice(0, start) || '';
        const after = template?.slice(end) || '';

        // Check if we need space based on cursor position
        const needsSpaceAtCursor = spaceBeforeInsert && before && !before.endsWith(' ');
        const insertText = needsSpaceAtCursor ? ' ' + t : t;
        template = before + insertText + after;

        // Set cursor position after the inserted text
        const newPos = start + insertText.length;
        requestAnimationFrame(() => {
          if (textareaEl) {
            textareaEl.focus();
            textareaEl.setSelectionRange(newPos, newPos);
            autoResize(textareaEl);
          }
        });
      } else {
        // Fallback: append to end
        template = template ? `${template}${toInsert}` : t;
      }
    }
    onTemplateChange?.(template);
    if (textareaEl) {
      requestAnimationFrame(() => autoResize(textareaEl!));
    }
  }

  function handleInput(e: Event) {
    onTemplateChange?.(template);
    autoResize(e.target as HTMLTextAreaElement);
  }

  // Auto-resize textarea to fit content
  function autoResize(el: HTMLTextAreaElement) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  // Initialize textarea size when mounted and store reference
  function initTextarea(el: HTMLTextAreaElement) {
    textareaEl = el;
    // Wait for content to be set
    requestAnimationFrame(() => autoResize(el));
  }

  // Get display-friendly resolved value
  let displayResolvedValue = $derived(simplifyHtml(resolvedValue));
</script>

<div
  class="rounded border border-gray-200 dark:border-gray-700 {isModified
    ? 'border-yellow-400 dark:border-yellow-600'
    : ''}"
>
  <!-- Header - always visible, clickable to expand -->
  <button
    type="button"
    class="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
    onclick={toggleExpand}
  >
    <span class="mt-0.5 text-gray-400 transition-transform duration-200" class:rotate-90={expanded}>
      <ChevronRightOutline class="h-3 w-3" />
    </span>
    <span class="mt-0.5 min-w-16 shrink-0 text-sm font-medium text-gray-900 dark:text-white"
      >{fieldName}</span
    >
    <!-- Always show preview in title - wraps if needed -->
    <span class="flex-1 text-xs break-words whitespace-pre-wrap text-gray-500 dark:text-gray-400">
      {#if configureMode}
        <code class="rounded bg-gray-100 px-1 dark:bg-gray-700">{template || '(not set)'}</code>
      {:else}
        {displayResolvedValue || '(empty)'}
      {/if}
    </span>
    {#if willUpdate}
      <span
        class="mt-0.5 shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700 dark:bg-blue-900 dark:text-blue-300"
      >
        Update
      </span>
    {/if}
    {#if isModified}
      <span
        class="mt-0.5 shrink-0 rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300"
      >
        Modified
      </span>
    {/if}
  </button>

  <!-- Expanded content with animation -->
  {#if expanded}
    <div
      class="border-t border-gray-200 px-2 py-2 dark:border-gray-700"
      transition:slide={{ duration: 150 }}
    >
      {#if configureMode}
        <!-- Configure mode: template input + buttons (no value previews) -->
        <div class="space-y-2">
          <textarea
            bind:value={template}
            placeholder={'e.g., {selection}'}
            class="block w-full resize-none overflow-hidden rounded-lg border border-gray-300 bg-gray-50 p-2 font-mono text-sm text-gray-900 focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400 dark:focus:border-blue-500 dark:focus:ring-blue-500"
            rows="1"
            oninput={handleInput}
            use:initTextarea
          ></textarea>

          {#if hint}
            <p class="text-xs text-gray-500 dark:text-gray-400">{hint}</p>
          {/if}

          <!-- Template buttons without value previews -->
          <div class="flex flex-wrap gap-1.5">
            {#each templateButtons as { template: t, description }}
              {@const active = hasVariable(t)}
              <button
                type="button"
                onclick={() => toggleTemplate(t)}
                class="rounded px-2 py-1 text-xs font-medium transition-colors {active
                  ? 'bg-blue-600 text-white dark:bg-blue-500'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}"
                title={description}
              >
                {t}
              </button>
            {/each}
          </div>
        </div>
      {:else}
        <!-- Create/Update mode: template input + variable buttons with values -->
        <div class="space-y-2">
          <!-- Template input -->
          <textarea
            bind:value={template}
            placeholder="Template..."
            class="block w-full resize-none overflow-hidden rounded-lg border border-gray-300 bg-gray-50 p-2 font-mono text-xs text-gray-900 focus:border-blue-500 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400 dark:focus:border-blue-500 dark:focus:ring-blue-500"
            rows="1"
            oninput={handleInput}
            use:initTextarea
          ></textarea>

          {#if hint}
            <p class="text-xs text-gray-500 dark:text-gray-400">{hint}</p>
          {/if}

          <!-- Template buttons with values - can wrap -->
          <div class="flex flex-wrap gap-1.5">
            {#each templateButtons as { template: t, description }}
              {@const active = hasVariable(t)}
              {@const value = getVariableValue(t)}
              <button
                type="button"
                onclick={() => toggleTemplate(t)}
                class="flex max-w-full flex-col items-start rounded px-2 py-1 text-left transition-colors {active
                  ? 'bg-blue-600 text-white dark:bg-blue-500'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}"
                title={description}
              >
                <span class="text-xs font-medium">{t}</span>
                {#if value}
                  <span
                    class="text-xs break-all whitespace-pre-wrap opacity-75"
                    class:text-blue-100={active}
                  >
                    {value}
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
