<!--
  A class's materials as the course page lists them: one link per material
  and the archive under them.

  The course page is where a student lands from the bookmark, so the latest
  class's slides and notebooks are one tap away from it, not two. Each name
  goes where that kind belongs (links.ts · materialHref); the kind and size
  sit on the right, small, because the name is what is looked for.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import { iconFor } from '@/lib/file-icons'
  import type { MaterialRef } from '@shared/publish'
  import { extLabel, materialHref, pageHref, plainClick, sizeText, zipHref } from './links'

  interface Props {
    address: string
    materials: MaterialRef[]
    zipBytes: number
    /** On the surface of the «сегодня» block the archive button needs a ground of its own. */
    onSurface?: boolean
    onnavigate: (path: string) => void
  }

  let { address, materials, zipBytes, onSurface = false, onnavigate }: Props = $props()

  /*
   * Six rows, then a link to the page: a class with twenty data files is a
   * page of its own, and the course rail is a pointer, not the page.
   */
  const LIMIT = 6
  const shown = $derived(materials.slice(0, LIMIT))

  /** Icons by kind: MaterialRef carries no path, and the name of a notebook says «Лекция». */
  function icon(m: MaterialRef) {
    if (m.kind === 'notebook') return 'notebook' as const
    if (m.kind === 'pdf') return 'pdf' as const
    return iconFor(m.name)
  }

  function meta(m: MaterialRef): string {
    if (m.kind === 'notebook') return tr('room.course.notebook')
    const ext = m.kind === 'pdf' ? 'PDF' : extLabel(m.name)
    return ext ? `${ext} · ${sizeText(m.bytes)}` : sizeText(m.bytes)
  }

  function follow(event: MouseEvent, m: MaterialRef): void {
    if (m.kind !== 'notebook' || !plainClick(event)) return
    event.preventDefault()
    onnavigate(materialHref(address, m))
  }

  function toPage(event: MouseEvent): void {
    if (!plainClick(event)) return
    event.preventDefault()
    onnavigate(pageHref(address))
  }
</script>

<ul class="flex flex-col">
  {#each shown as m (m.key)}
    <li class="border-t border-line">
      <a
        href={materialHref(address, m)}
        target={m.kind === 'pdf' ? '_blank' : undefined}
        rel={m.kind === 'pdf' ? 'noopener' : undefined}
        download={m.kind === 'notebook' || m.kind === 'pdf' ? undefined : ''}
        class="flex min-h-11 items-center gap-3 py-2.5 hover:bg-surface/70"
        onclick={(event) => follow(event, m)}
      >
        <span class="flex w-5 shrink-0 justify-center text-accent-text" aria-hidden="true">
          <Icon name={icon(m)} size={16} />
        </span>
        <!-- Room paths have no break points; see MaterialList for why `anywhere`. -->
        <span
          class="min-w-0 flex-1 text-[15px] font-semibold leading-[22px] text-accent-text
                 [overflow-wrap:anywhere]"
        >
          {m.name}
        </span>
        <span class="shrink-0 font-mono text-micro text-muted">{meta(m)}</span>
      </a>
    </li>
  {/each}
  {#if materials.length > LIMIT}
    <li class="border-t border-line">
      <a
        href={pageHref(address)}
        class="flex min-h-11 items-center py-2.5 text-[15px] leading-[22px] text-accent-text"
        onclick={toPage}
      >
        {tr('room.course.allMaterials', { count: materials.length })}
      </a>
    </li>
  {/if}
</ul>
<a
  href={zipHref(address)}
  download=""
  class="press mt-3 flex h-12 shrink-0 items-center justify-center gap-2.5 border border-brand px-3
         text-[13px] font-bold uppercase leading-4 tracking-caps text-brand
         dark:border-ink dark:text-ink lg:h-11 {onSurface ? 'bg-canvas' : ''}"
>
  <Icon name="download" size={16} strokeWidth={2.2} class="shrink-0" />
  <span>{tr('room.course.zip', { size: sizeText(zipBytes) })}</span>
</a>
