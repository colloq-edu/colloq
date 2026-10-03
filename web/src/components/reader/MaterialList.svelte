<!--
  «МАТЕРИАЛЫ» on a class page: everything the teacher put on it, in their
  order, and the whole lot as one archive.

  A row is a name to tap and a line saying what it is. The name is a link
  whose hit area stretches over the row; the download button on the right is
  a sibling, never nested, so a tap on it downloads and a tap anywhere else
  opens. A notebook opens as its tab below, a PDF in the browser's own viewer
  (a phone has one, a page of canvases would be worse), and data or code
  downloads: the name of a data file is its room path, because the code
  reads it by that path. A folder (`data/`, `scripts/`) is one row in mono,
  like the path the code writes, and downloads as one ZIP with the folder
  inside; it keeps the download button too, because its name is not a
  file anyone expects a tap to fetch.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import { iconFor } from '@/lib/file-icons'
  import type { PublicMaterial, PublicPage } from '@shared/publish'
  import { folderLabel } from '@shared/materials'
  import {
    downloadHref,
    extLabel,
    folderCount,
    materialHref,
    plainClick,
    sizeText,
    zipHref,
    zipNote,
  } from './links'

  interface Props {
    page: PublicPage
    /** The notebook open below; its name is ink, not a link colour. */
    active: string | null
    wide: boolean
    /** A notebook name was tapped: switch to its tab and bring the reader up. */
    onopen: (key: string) => void
  }

  let { page, active, wide, onopen }: Props = $props()

  function meta(m: PublicMaterial): string {
    const size = sizeText(m.bytes)
    if (m.kind === 'notebook') {
      return [
        tr('room.page.kind.notebook'),
        tr('room.page.cells', { count: m.cells ?? 0 }),
        (m.outputs ?? 0) > 0 ? tr('room.page.withOutputs') : null,
        // The rail is 360 px: the size gives way to «открыта», which says more there.
        wide ? null : size,
        wide && m.key === active ? tr('room.page.open') : null,
      ]
        .filter(Boolean)
        .join(' · ')
    }
    if (m.kind === 'pdf') return `PDF · ${size} · ${tr('room.page.inBrowser')}`
    // «Данные · 15 файлов · 25 МБ»: named by what is inside, counted, weighed.
    if (m.kind === 'folder') {
      return `${tr(`room.page.folder.${folderLabel(m.holds ?? [])}`)} · ${folderCount(m)}`
    }
    const ext = extLabel(m.path)
    return [tr(`room.page.kind.${m.kind}`), ext || null, size].filter(Boolean).join(' · ')
  }

  /** What the archive holds, in words, with the folders by name (links.ts · zipNote). */
  const caption = $derived(zipNote(page.materials))

  /** Opened by its name (a tab, the browser's PDF viewer) rather than downloaded by it. */
  const opens = (m: PublicMaterial): boolean => m.kind === 'notebook' || m.kind === 'pdf'

  function downloadLabel(m: PublicMaterial): string {
    if (m.kind === 'notebook') return tr('room.page.downloadNotebook', { name: m.name })
    if (m.kind === 'folder') return tr('room.page.downloadFolder', { name: m.name })
    return tr('room.page.download', { name: m.name })
  }

  function open(event: MouseEvent, m: PublicMaterial): void {
    if (m.kind !== 'notebook' || !plainClick(event)) return
    event.preventDefault()
    onopen(m.key)
  }
</script>

<section aria-labelledby="page-materials">
  <div class="flex items-end justify-between border-b-2 border-ink pb-3">
    <h2
      id="page-materials"
      class="text-[14px] font-black uppercase leading-5 tracking-section text-ink"
    >
      {tr('room.page.materials')}
    </h2>
    {#if wide}
      <span class="font-mono text-[13px] leading-5 text-muted">{page.materials.length}</span>
    {/if}
  </div>
  <ul>
    {#each page.materials as m (m.key)}
      {@const folder = m.kind === 'folder'}
      <li
        class="relative flex items-center gap-3 border-b border-line
               {wide ? 'py-3' : 'min-h-[60px] py-2.5'}"
      >
        <span
          class="flex h-6 w-5 shrink-0 items-center justify-center self-start text-accent-text"
          aria-hidden="true"
        >
          <Icon name={folder ? 'folder' : iconFor(m.path)} size={16} />
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <!-- A name defaults to the room path (data/sber_real_estate_train_2015.parquet),
               which has no break point: `anywhere`, not break-word, so the flex
               min-content shrinks too and a phone page does not scroll sideways. -->
          <a
            href={materialHref(page.address, m)}
            target={m.kind === 'pdf' ? '_blank' : undefined}
            rel={m.kind === 'pdf' ? 'noopener' : undefined}
            download={opens(m) ? undefined : ''}
            class="[overflow-wrap:anywhere] after:absolute after:inset-0 hover:underline
                   {folder
              ? 'font-mono text-[16px] font-medium leading-6'
              : 'text-[17px] font-semibold leading-6'}
                   {m.key === active ? 'text-ink' : 'text-accent-text'}"
            onclick={(event) => open(event, m)}
          >
            {m.name}
          </a>
          <span class="text-[14px] leading-5 text-muted">{meta(m)}</span>
        </span>
        {#if opens(m) || folder}
          {@const label = downloadLabel(m)}
          <a
            href={downloadHref(page.address, m.key)}
            download=""
            class="press relative z-10 flex shrink-0 items-center justify-center transition-colors
                   duration-100 hover:text-ink
                   {wide ? 'h-9 w-9 text-muted' : '-my-1 h-11 w-11 text-accent-text'}"
            aria-label={label}
            title={label}
          >
            <Icon name="download" size={16} strokeWidth={2.2} />
          </a>
        {/if}
      </li>
    {/each}
  </ul>
  {#if page.zip}
    <div class="flex flex-col gap-2 {wide ? 'pt-4' : 'gap-2.5 pt-3'}">
      <a
        href={zipHref(page.address)}
        download={page.zip.name}
        class="press flex shrink-0 items-center justify-center gap-2.5 px-3 text-[14px] font-bold
               uppercase leading-5 tracking-caps
               {wide
          ? 'h-12 bg-brand text-white dark:bg-primary dark:text-primary-ink'
          : 'h-12 border border-brand text-brand dark:border-ink dark:text-ink'}"
      >
        <Icon name="download" size={16} strokeWidth={2.2} class="shrink-0" />
        <span>{tr('room.course.zip', { size: sizeText(page.zip.bytes) })}</span>
      </a>
      <p class="text-[14px] leading-5 text-muted {wide ? '' : 'text-center'}">{caption}</p>
    </div>
  {/if}
</section>
