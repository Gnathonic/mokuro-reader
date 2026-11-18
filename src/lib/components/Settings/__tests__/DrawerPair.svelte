<script lang="ts">
  // The app's two mounts of the settings drawer, as NavBar and the reader's
  // SettingsButton make them.
  import SettingsDrawerHost from '../SettingsDrawerHost.svelte';
</script>

<div data-mount="app"><SettingsDrawerHost context="app" /></div>
<div data-mount="reader"><SettingsDrawerHost context="reader" /></div>
