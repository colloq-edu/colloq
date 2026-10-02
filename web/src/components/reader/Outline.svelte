<!--
  The table of contents of the open notebook: its h1–h3 headings, as links.

  A seminar notebook is forty cells long, and a student back home looks for
  «2. Признаки одежды», not for cell 23. Each entry is a real link to
  `#<cellId>`: it can be copied and sent, and a plain tap pushes the anchor
  into the history so «Back» returns to where the reader was. The current
  section is marked by its parent (ClassPage tracks it with an
  IntersectionObserver), so the list itself stays a plain list.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { OutlineEntry } from '@shared/publish'
  import { plainClick } from './links'

  interface Props {
    entries: OutlineEntry[]
    current: string | null
    /** The open tab's name, for «СОДЕРЖАНИЕ · СЕМИНАР»; `null` prints the bare label. */
    name: string | null
    /** 'rail': the desktop column; 'panel': the phone disclosure, with finger-sized rows. */
    variant: 'rail' | 'panel'
    onpick: (id: string) => void
  }

  let { entries, current, name, variant, onpick }: Props = $props()

  /*
   * Indents by level: 12 px a step, as the artboards draw them. Every entry
   * carries the 2 px left rule, transparent unless current, so the text does
   * not jump sideways when it becomes current.
   */
  const INDENT = { 1: 'pl-3', 2: 'pl-6', 3: 'pl-9' } as const

  function pick(event: MouseEvent, id: string): void {
    if (!plainClick(event)) return
    event.preventDefault()
    // The anchor goes into the history: «Back» returns to the place it was tapped from.
    history.pushState(history.state, '', `#${id}`)
    onpick(id)
  }
</script>

<nav aria-label={tr('room.page.contents')}>
  {#if variant === 'rail'}
    <div class="border-b-2 border-ink pb-3">
      <p class="font-mono text-micro uppercase tracking-label text-muted">
        {name ? tr('room.page.contentsOf', { name }) : tr('room.page.contents')}
      </p>
    </div>
  {:else}
    <p class="pb-2 pt-3 font-mono text-micro uppercase tracking-label text-muted">
      {tr('room.page.contents')}
    </p>
  {/if}
  <ol class={variant === 'rail' ? 'pt-2' : ''}>
    {#each entries as entry, i (i)}
      {@const on = entry.id === current}
      <li>
        <a
          href={`#${entry.id}`}
          aria-current={on ? 'location' : undefined}
          class="block text-[14px] leading-5 transition-colors duration-100 hover:text-ink
                 {on ? 'border-l-2 border-accent text-ink' : 'border-l-2 border-transparent text-muted'}
                 {INDENT[entry.level]}
                 {variant === 'rail' ? `py-1.5 ${on ? 'font-semibold' : ''}` : 'flex min-h-11 items-center'}"
          onclick={(event) => pick(event, entry.id)}
        >
          {entry.text}
        </a>
      </li>
    {/each}
  </ol>
</nav>
