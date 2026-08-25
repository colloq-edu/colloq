<script lang="ts">
  import { initials } from '@/lib/utils'

  interface Props {
    name: string
    color: string
    avatar?: string | null
    size?: 'xs' | 'sm' | 'md' | 'lg'
    ring?: boolean
    class?: string
    title?: string
  }

  let {
    name,
    color,
    avatar = null,
    size = 'sm',
    ring = false,
    class: className = '',
    title,
  }: Props = $props()

  const SIZES = {
    xs: 'h-5 w-5 text-micro',
    sm: 'h-6 w-6 text-micro',
    md: 'h-8 w-8 text-2xs',
    lg: 'h-12 w-12 text-ui-lg',
  } as const

  const isEmoji = $derived(!!avatar && !avatar.startsWith('http') && !avatar.startsWith('data:'))
</script>

<!-- An emoji if the person picked one, otherwise their initials on their colour. -->
<span
  title={title ?? name}
  class="inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold uppercase leading-none text-white {SIZES[
    size
  ]} {ring ? 'ring-2 ring-surface' : ''} {className}"
  style="background-color: {isEmoji ? 'transparent' : color}"
>
  {#if avatar && !isEmoji}
    <img src={avatar} alt={name} class="h-full w-full rounded-full object-cover" />
  {:else if isEmoji}
    <span class="text-[1.15em] leading-none">{avatar}</span>
  {:else}
    {initials(name)}
  {/if}
</span>
