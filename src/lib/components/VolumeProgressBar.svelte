<script lang="ts">
  interface Props {
    progressPercentString: string;
    remainingPages: number;
    isHovered?: boolean;
  }

  let { progressPercentString, remainingPages, isHovered = false }: Props = $props();
</script>

<!--
  `--box-width` is provided by the parent VolumeCard's scoped rule. It is NOT a
  `:root` declaration: Svelte leaves `:root` unscoped, so a component-level one
  leaks into the document (see the `--spacing` note in VolumeCard).
-->
<div class="progress-bar bg-gray-400 dark:bg-gray-600">
  <div
    class="progress-bar-percentage {isHovered
      ? 'bg-primary-300 dark:bg-primary-400'
      : 'bg-primary-400 dark:bg-primary-500'}"
    style="width: {progressPercentString};"
  >
    {#key `${progressPercentString}|${remainingPages}`}
      <span class="progress-text text-gray-900">
        <span class="progress">{progressPercentString}</span> (<span class="remaining"
          >{remainingPages}</span
        >p)
      </span>
    {/key}
  </div>
</div>

<style>
  .progress-bar {
    margin: auto;
    position: relative;
    border-style: solid;
    border-width: thin;
    margin-top: 3px;
    width: var(--box-width);
    font-size: 12px;
    cursor: default;
    text-align: center;
  }

  .progress-bar-percentage {
    box-sizing: content-box;
    padding: 5px 0px;
    height: 1em;
    transition: background-color 0.3s ease;
    display: flex;
    align-items: center;
  }

  .progress-bar-percentage > span {
    display: inline-block;
    position: absolute;
    width: 100%;
    left: 0;
  }
</style>
