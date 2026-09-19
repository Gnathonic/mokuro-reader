<script lang="ts">
  /**
   * The one name prompt for layer actions (new / rename), driven by the
   * `layerNamePrompt` store so the picker and the settings panel share it.
   * Mounted once by the reader.
   */
  import { Button, Input, Label, Modal, Radio } from 'flowbite-svelte';
  import { layerNamePrompt, type LayerSource } from './layer-actions';

  let name = $state('');
  let source = $state<LayerSource>('copy');
  let open = $derived($layerNamePrompt !== null);

  $effect(() => {
    const p = $layerNamePrompt;
    if (p) {
      name = p.initialName;
      source = 'copy';
    }
  });

  function cancel() {
    $layerNamePrompt?.resolve(null);
  }

  function confirm() {
    const p = $layerNamePrompt;
    if (!p || !name.trim()) return;
    p.resolve({ name: name.trim(), source });
  }
</script>

{#if $layerNamePrompt}
  <!-- data-popover: keyboardShouldIgnore (gesture-target.ts) walks up from
       event.target, and the native <dialog> traps focus inside it, so this
       reliably blocks Reader's window keydown handler (arrows/Escape) from
       acting on the reader underneath while the prompt is open. -->
  <Modal {open} size="xs" onclose={cancel} dismissable data-popover>
    <form
      class="flex flex-col gap-4 p-2"
      onsubmit={(e) => {
        e.preventDefault();
        confirm();
      }}
    >
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">{$layerNamePrompt.title}</h3>
      <Label>
        Name
        <Input class="mt-1" aria-label="Layer name" bind:value={name} />
      </Label>
      {#if $layerNamePrompt.askSource}
        <div class="flex flex-col gap-1">
          <Radio name="layer-source" value="copy" bind:group={source}
            >Copy of the current layer</Radio
          >
          <Radio name="layer-source" value="empty" bind:group={source}>Empty</Radio>
        </div>
      {/if}
      <!-- relative z-10: night mode's dialog filter resets stacking (see CLAUDE.md) -->
      <div class="relative z-10 flex justify-end gap-2">
        <Button color="alternative" type="button" onclick={cancel}>Cancel</Button>
        <Button
          color="primary"
          type="submit"
          aria-label="Confirm layer name"
          disabled={!name.trim()}
        >
          OK
        </Button>
      </div>
    </form>
  </Modal>
{/if}
