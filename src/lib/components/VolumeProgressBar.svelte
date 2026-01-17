<script lang="ts">
  interface Props {
    progressPercentString: string;
    remainingPages: number;
    isHovered?: boolean;
  }

  let { progressPercentString, remainingPages, isHovered = false }: Props = $props();
</script>

<div class="progress-bar border-black" class:hovered={isHovered}>
  <div class="progress-bar-percentage" style="width: {progressPercentString};">
    <span class="progress-text">
      <span class="progress">{progressPercentString}</span> (<span class="remaining"
        >{remainingPages}</span
      >p)
    </span>
  </div>
</div>

<style>
  :root {
    --progress-bg: #8bd;
    --progress-hover: #9ce;
  }

  .progress-bar {
    margin: auto;
    background-color: #666;
    position: relative;
    border-style: solid;
    border-width: thin;
    margin-top: 3px;
    width: var(--box-width);
    font-size: 12px;
    cursor: default;
  }

  .progress-bar-percentage {
    background-color: var(--progress-bg);
    box-sizing: content-box;
    padding: 5px 0px;
    color: #000;
    height: 1em;
    transition: background-color 0.3s ease;
    display: flex;
    align-items: center;
  }

  .progress-bar.hovered .progress-bar-percentage {
    background-color: var(--progress-hover);
  }

  .progress-bar-percentage > span {
    display: inline-block;
    position: absolute;
    width: 100%;
    left: 0;
  }
</style>
