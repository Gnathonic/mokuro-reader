<script lang="ts">
  import { Input } from 'flowbite-svelte';

  interface Props {
    value: string; // HH:MM format
    onchange: (value: string) => void;
  }

  let { value, onchange }: Props = $props();

  function handleChange(e: Event) {
    const input = e.target as HTMLInputElement;
    onchange(input.value);
  }
</script>

<Input type="time" size="sm" class="w-28" {value} onchange={handleChange} />
