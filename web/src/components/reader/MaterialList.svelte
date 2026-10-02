<!--
  «МАТЕРИАЛЫ» on a class page: everything the teacher put on it, in their
  order, and the whole lot as one archive.

  A row is a name to tap and a line saying what it is. The name is a link
  whose hit area stretches over the row; the download button on the right is
  a sibling, never nested, so a tap on it downloads and a tap anywhere else
  opens. A notebook opens as its tab below, a PDF in the browser's own viewer
  (a phone has one, a page of canvases would be worse), and data or code
  downloads: the name of a data file is its room path, because the code
  reads it by that path.
-->
<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import { iconFor } from '@/lib/file-icons'
  import type { PublicMaterial, PublicPage } from '@shared/publish'
  import { downloadHref, extLabel, materialHref, plainClick, sizeText, zipHref } from './links'

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
    const ext = extLabel(m.path)
    return [tr(`room.page.kind.${m.kind}`), ext || null, size].filter(Boolean).join(' · ')
  }

  /** What the archive holds, in words: «Тетради с результатами и слайды». */
  const zipWhat = $derived.by(() => {
    const kinds = new Set(page.materials.map((m) => m.kind))
    const words: string[] = []
    if (kinds.has('notebook')) words.push(tr('room.page.zipWhat.notebooks'))
    if (kinds.has('pdf')) words.push(tr('room.page.zipWhat.slides'))
    if (kinds.has('data')) words.push(tr('room.page.zipWhat.data'))
    if (kinds.has('code')) words.push(tr('room.page.zipWhat.code'))
    if (kinds.has('text') || kinds.has('image') || kinds.has('file')) {
      words.push(tr('room.page.zipWhat.files'))
    }
    const list = new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(words)
    return list.charAt(0).toUpperCase() + list.slice(1)
  })

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
      class="text-[13px] font-black uppercase leading-4 tracking-section text-ink"
    >
      {tr('room.page.materials')}
    </h2>
    {#if wide}
      <span class="font-mono text-micro text-muted">{page.materials.length}</span>
    {/if}
  </div>
  <ul>
    {#each page.materials as m (m.key)}
      {@const downloadable = m.kind === 'notebook' || m.kind === 'pdf'}
      <li
        class="relative flex items-center gap-3 border-b border-line
               {wide ? 'py-3' : 'min-h-14 py-2'}"
      >
        <span
          class="flex h-[22px] w-5 shrink-0 items-center justify-center self-start text-accent-text"
          aria-hidden="true"
        >
          <Icon name={iconFor(m.path)} size={16} />
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <!-- A name defaults to the room path (data/sber_real_estate_train_2015.parquet),
               which has no break point: `anywhere`, not break-word, so the flex
               min-content shrinks too and a phone page does not scroll sideways. -->
          <a
            href={materialHref(page.address, m)}
            target={m.kind === 'pdf' ? '_blank' : undefined}
            rel={m.kind === 'pdf' ? 'noopener' : undefined}
            download={downloadable ? undefined : ''}
            class="text-[16px] font-semibold leading-[22px] [overflow-wrap:anywhere]
                   after:absolute after:inset-0 hover:underline
                   {m.key === active ? 'text-ink' : 'text-accent-text'}"
            onclick={(event) => open(event, m)}
          >
            {m.name}
          </a>
          <span class="text-[13px] leading-[18px] text-muted">{meta(m)}</span>
        </span>
        {#if downloadable}
          {@const label =
            m.kind === 'notebook'
              ? tr('room.page.downloadNotebook', { name: m.name })
              : tr('room.page.download', { name: m.name })}
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
        class="press flex shrink-0 items-center justify-center gap-2.5 px-3 text-[13px] font-bold
               uppercase leading-4 tracking-caps
               {wide
          ? 'h-11 bg-brand text-white dark:bg-primary dark:text-primary-ink'
          : 'h-12 border border-brand text-brand dark:border-ink dark:text-ink'}"
      >
        <Icon name="download" size={16} strokeWidth={2.2} class="shrink-0" />
        <span>{tr('room.course.zip', { size: sizeText(page.zip.bytes) })}</span>
      </a>
      <p class="text-[13px] leading-[18px] text-muted {wide ? '' : 'text-center'}">
        {tr('room.page.zipNote', { what: zipWhat })}
      </p>
    </div>
  {/if}
</section>
