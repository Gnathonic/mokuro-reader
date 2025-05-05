<script lang="ts">
  import { settings } from '$lib/settings';
  import { browser } from '$app/environment';
  import { onMount, onDestroy } from 'svelte';

  // Elements for Firefox overlay approach
  let grayscaleLayer: HTMLDivElement | null = null;
  let redOverlay: HTMLDivElement | null = null;
  let isFirefox = false;

  // Function to detect Firefox
  function detectFirefox() {
    if (!browser) return false;
    return navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
  }

  // Function to apply the night mode filter
  function applyNightModeFilter() {
    if (!browser) return;
    
    // Detect Firefox
    isFirefox = detectFirefox();
    
    if (isFirefox) {
      // Firefox approach: Use overlays with blend modes
      if ($settings.nightMode) {
        // Create grayscale layer if it doesn't exist
        if (!grayscaleLayer) {
          grayscaleLayer = document.createElement('div');
          grayscaleLayer.id = 'grayscale-saturation-layer';
          grayscaleLayer.style.position = 'fixed';
          grayscaleLayer.style.top = '0';
          grayscaleLayer.style.left = '0';
          grayscaleLayer.style.width = '100%';
          grayscaleLayer.style.height = '100%';
          grayscaleLayer.style.backgroundColor = 'rgba(0, 0, 0, 1)';
          grayscaleLayer.style.pointerEvents = 'none';
          grayscaleLayer.style.zIndex = '999998';
          grayscaleLayer.style.mixBlendMode = 'saturation'; // Removes color saturation
          grayscaleLayer.style.display = 'block';
          document.body.appendChild(grayscaleLayer);
        }
        
        // Create red overlay if it doesn't exist
        if (!redOverlay) {
          redOverlay = document.createElement('div');
          redOverlay.id = 'red-overlay';
          redOverlay.style.position = 'fixed';
          redOverlay.style.top = '0';
          redOverlay.style.left = '0';
          redOverlay.style.width = '100%';
          redOverlay.style.height = '100%';
          redOverlay.style.backgroundColor = 'rgba(255, 0, 0, 1)';
          redOverlay.style.pointerEvents = 'none';
          redOverlay.style.zIndex = '999999'; // Higher than grayscale
          redOverlay.style.mixBlendMode = 'multiply';
          redOverlay.style.display = 'block';
          document.body.appendChild(redOverlay);
        }
      } else {
        // Remove overlays if night mode is off
        if (grayscaleLayer) {
          grayscaleLayer.remove();
          grayscaleLayer = null;
        }
        if (redOverlay) {
          redOverlay.remove();
          redOverlay = null;
        }
      }
    } else {
      // Non-Firefox approach: Use CSS variables with SVG filter
      const rootElement = document.documentElement;
      
      if ($settings.nightMode) {
        rootElement.style.setProperty('--night-mode-filter', 'url(#night-mode-filter)');
      } else {
        rootElement.style.setProperty('--night-mode-filter', 'none');
      }
    }
  }

  // Watch for changes to the night mode setting
  $: if (browser && $settings) {
    applyNightModeFilter();
  }

  // Set up
  onMount(() => {
    applyNightModeFilter();
  });

  // Clean up
  onDestroy(() => {
    if (browser) {
      if (grayscaleLayer) {
        grayscaleLayer.remove();
      }
      if (redOverlay) {
        redOverlay.remove();
      }
    }
  });
</script>

<!-- No visible elements - just applies the filter via CSS variables or overlays -->