<!--
  An address a person is told to keep, and a way to take it.

  The address is printed in full (host and path), because it is what gets
  written on the board and dictated; the button copies the same words with
  the scheme in front. A refusal is said on the button itself: on an http
  instance there is no async clipboard, the fallback may be refused too, and
  a button that silently does nothing reads as a broken page.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { copyText } from '@/lib/clipboard'

  interface Props {
    /** Path on this instance: `/c/ml-strong`, `/p/ml-strong-04`. */
    path: string
    /** Mono size of the address: the course rail is a step larger than a page footer. */
    size?: 'sm' | 'md'
    /** 'spread': the button at the far edge (a rail, a phone); 'inline': right after the address. */
    layout?: 'spread' | 'inline'
  }

  let { path, size = 'md', layout = 'spread' }: Props = $props()

  const shown = $derived(`${location.host}${path}`)
  let state = $state<'idle' | 'copied' | 'refused'>('idle')
  let timer: ReturnType<typeof setTimeout> | null = null

  async function copy(): Promise<void> {
    if (timer) clearTimeout(timer)
    try {
      await copyText(`${location.origin}${path}`)
      state = 'copied'
    } catch {
      state = 'refused'
    }
    timer = setTimeout(() => (state = 'idle'), 1800)
  }

  $effect(() => () => {
    if (timer) clearTimeout(timer)
  })
</script>

<div
  class="flex min-h-11 flex-wrap items-center gap-y-1
         {layout === 'spread' ? 'justify-between gap-x-3' : 'gap-x-4'}"
>
  <span
    class="min-w-0 select-all break-all font-mono text-ink
           {size === 'md' ? 'text-[15px] leading-[22px]' : 'text-[14px] leading-5'}"
  >
    {shown}
  </span>
  <button
    type="button"
    class="press -my-2 flex h-11 shrink-0 items-center text-[15px] leading-[22px]
           {state === 'refused' ? 'text-warning' : 'text-accent-text'}"
    onclick={() => void copy()}
  >
    <span class="border-b border-dashed border-current">
      {state === 'copied'
        ? tr('room.ui.138')
        : state === 'refused'
          ? tr('room.course.copyFailed')
          : tr('room.course.copy')}
    </span>
  </button>
</div>
