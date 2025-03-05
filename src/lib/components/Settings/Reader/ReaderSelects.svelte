<script lang="ts">
  import { Input, Label, Select } from 'flowbite-svelte';
  import type { SettingsKey } from '$lib/settings';
  import { settings, updateSetting } from '$lib/settings';

  let zoomModeValue = $derived($settings.zoomDefault);
  let fontSizeValue = $derived($settings.fontSize);

  let zoomModes = [
    { value: 'zoomFitToScreen', name: 'Fit to screen' },
    { value: 'zoomFitToWidth', name: 'Fit to width' },
    { value: 'zoomOriginal', name: 'Original size' },
    { value: 'keepZoom', name: 'Keep zoom' },
    { value: 'keepZoomStart', name: 'Keep zoom, pan to top' }
  ];

  let fontSizes = [
    { value: 'auto', name: 'auto' },
    { value: '9', name: '9' },
    { value: '10', name: '10' },
    { value: '11', name: '11' },
    { value: '12', name: '12' },
    { value: '14', name: '14' },
    { value: '16', name: '16' },
    { value: '18', name: '18' },
    { value: '20', name: '20' },
    { value: '24', name: '24' },
    { value: '32', name: '32' },
    { value: '40', name: '40' },
    { value: '48', name: '48' },
    { value: '60', name: '60' }
  ];

  function onBackgroundColor(event: Event) {
    updateSetting('backgroundColor', (event.target as HTMLInputElement).value);
  }

  function onSelectChange(event: Event, setting: SettingsKey) {
    updateSetting(setting, (event.target as HTMLInputElement).value);
  }
</script>

<div>
  <Label>On page zoom:</Label>
  <Select
    items={zoomModes}
    value={zoomModeValue}
    on:change={(e) => onSelectChange(e, 'zoomDefault')}
  />
</div>
<div>
  <Label>Fontsize:</Label>
  <Select
    items={fontSizes}
    value={fontSizeValue}
    on:change={(e) => onSelectChange(e, 'fontSize')}
  />
</div>
<div>
  <Label>Background color:</Label>
  <Input type="color" on:change={onBackgroundColor} value={$settings.backgroundColor} />
</div>
