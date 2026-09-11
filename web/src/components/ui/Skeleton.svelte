<script lang="ts">
  interface Props {
    width?: string
    height?: string
    radius?: string
    tone?: 'default' | 'onDark'
    class?: string
  }

  let { width = '100%', height = '1em', radius = '3px', tone = 'default', class: className = '' }: Props = $props()
</script>

<span
  aria-hidden="true"
  class="skeleton {className}"
  class:on-dark={tone === 'onDark'}
  style:width
  style:height
  style:border-radius={radius}
></span>

<style>
  .skeleton {
    display: inline-block;
    position: relative;
    overflow: hidden;
    isolation: isolate;
    max-width: 100%;
    flex-shrink: 0;
    vertical-align: middle;
    background: rgb(var(--line) / 0.65);
    --glint: rgb(var(--canvas) / 0.8);
  }

  .on-dark {
    background: rgb(255 255 255 / 0.13);
    --glint: rgb(255 255 255 / 0.16);
  }

  .skeleton::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(100deg, transparent 15%, var(--glint) 50%, transparent 85%);
    transform: translateX(-100%);
    animation: shimmer 1.8s ease-in-out infinite;
  }

  @keyframes shimmer {
    to { transform: translateX(100%); }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton::after { animation: none; display: none; }
  }
</style>
