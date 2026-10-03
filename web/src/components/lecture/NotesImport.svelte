<!--
  IMPORT A LECTURE SCRIPT: one .md, a "## 14 · …" section per slide.

  The dialog shows what applying would do BEFORE anything is written: which
  slides get a new note, which notes get replaced, and what is skipped and
  why (Paper, page 10 · N4 A). Two refusals are spelled out on purpose,
  because both used to be silent losses: a section longer than a note may be
  is skipped whole with its length shown (never cut to fit, which looked
  saved and was found in class as a stump), and a section past the last page
  says there is no such slide instead of vanishing.

  Applying is one request (routes/notes.ts), all or nothing.
-->
<script lang="ts">
  import { formatNumber, tr } from '@shared/i18n'
  import { MAX_NOTE_CHARS } from '@shared/lecture'
  import { baseOf } from '@shared/paths'
  import { parseScript, planImport, type ImportRow } from '@shared/speaker-notes'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import { getSessionState } from '@/lib/session.svelte'

  interface Props {
    file: string
    /** The document's page count; `null` when it did not open (pages are then not checked). */
    pages: number | null
    /** The notes there are now: page → text. */
    notes: Record<number, string>
    onclose: () => void
    /** Written: page → the text that went in. */
    onapplied: (written: Record<number, string>) => void
  }

  let { file, pages, notes, onclose, onapplied }: Props = $props()
  const session = getSessionState()

  /**
   * A script is text; past a megabyte it is not a script but a mistake, and
   * the server would refuse the request anyway (its body ceiling).
   */
  const MAX_BYTES = 1_000_000
  /** The page ceiling the server accepts when the document did not say its own. */
  const UNCHECKED_PAGES = 9999

  let source = $state<{ name: string | null; bytes: number; text: string } | null>(null)
  let readError = $state<string | null>(null)
  let applying = $state(false)
  let applyError = $state<string | null>(null)
  let dragging = $state(false)
  let picker = $state<HTMLInputElement | null>(null)

  const sections = $derived(source ? parseScript(source.text) : [])
  const plan = $derived(planImport(sections, pages ?? UNCHECKED_PAGES, notes))
  const writes = $derived(Object.keys(plan.writes).length)

  async function take(picked: File | null | undefined): Promise<void> {
    if (!picked) return
    readError = null
    applyError = null
    if (picked.size > MAX_BYTES) {
      readError = tr('room.notesImport.tooBig')
      return
    }
    try {
      source = { name: picked.name, bytes: picked.size, text: await picked.text() }
    } catch {
      readError = tr('room.notesImport.unreadable')
    }
  }

  function takeText(text: string): void {
    readError = null
    applyError = null
    const bytes = new Blob([text]).size
    if (bytes > MAX_BYTES) {
      readError = tr('room.notesImport.tooBig')
      return
    }
    source = { name: null, bytes, text }
  }

  /* ⌘V anywhere in the dialog takes the clipboard's text as the script. */
  $effect(() => {
    const paste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (!text.trim()) return
      event.preventDefault()
      takeText(text)
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  })

  function drop(event: DragEvent): void {
    event.preventDefault()
    dragging = false
    const picked = event.dataTransfer?.files?.[0]
    if (picked) void take(picked)
    else {
      const text = event.dataTransfer?.getData('text/plain') ?? ''
      if (text.trim()) takeText(text)
    }
  }

  async function apply(): Promise<void> {
    if (applying || writes === 0) return
    applying = true
    applyError = null
    try {
      const sent = plan.writes
      await api.importNotes(session.session.id, session.token, file, sent)
      onapplied(sent)
    } catch (err) {
      applyError = err instanceof Error ? err.message : String(err)
    } finally {
      applying = false
    }
  }

  /* -------------------------------------------------------- the rows */

  /** What the list shows: a row, or a folded run of rows that change nothing worth reading. */
  type Item = { kind: 'row'; row: ImportRow } | { kind: 'run'; key: string; rows: ImportRow[] }

  let unfolded = $state<Record<string, boolean>>({})
  let textShown = $state<Record<number, boolean>>({})

  /*
   * Runs of plain rows (new, unchanged) fold: fifty "new" lines in a row
   * hide the two that need a decision. The first and last of a run stay, so
   * the numbers on both sides of the fold are read without opening it.
   */
  const items = $derived.by((): Item[] => {
    const out: Item[] = []
    let run: ImportRow[] = []
    const flush = () => {
      if (run.length >= 4) {
        const key = `${run[0].index}`
        out.push({ kind: 'row', row: run[0] })
        if (unfolded[key]) for (const row of run.slice(1, -1)) out.push({ kind: 'row', row })
        else out.push({ kind: 'run', key, rows: run.slice(1, -1) })
        out.push({ kind: 'row', row: run[run.length - 1] })
      } else for (const row of run) out.push({ kind: 'row', row })
      run = []
    }
    for (const row of plan.rows) {
      if (row.status === 'new' || row.status === 'same') run.push(row)
      else {
        flush()
        out.push({ kind: 'row', row })
      }
    }
    flush()
    return out
  })

  /** Kilobytes as a person reads a file size: never "0 KB" for a file that has text. */
  function kilobytes(bytes: number): number {
    return Math.max(1, Math.round(bytes / 1024))
  }

  function number(row: ImportRow): string {
    return String(row.number ?? row.index).padStart(2, '0')
  }

  function runLabel(rows: ImportRow[]): string {
    const fresh = rows.filter((row) => row.status === 'new').length
    const same = rows.length - fresh
    const what = [
      fresh ? tr('room.notesImport.countNew', { count: fresh }) : '',
      same ? tr('room.notesImport.countSame', { count: same }) : '',
    ]
      .filter(Boolean)
      .join(', ')
    return tr('room.notesImport.run', {
      range: `${number(rows[0])}–${number(rows[rows.length - 1])}`,
      what,
    })
  }

  const SKIPPED = new Set(['too-long', 'no-slide', 'empty', 'duplicate'])
  const skippedList = $derived.by(() => {
    const skipped = plan.rows.filter((row) => SKIPPED.has(row.status)).map(number)
    return skipped.length > 8 ? `${skipped.slice(0, 8).join(', ')}…` : skipped.join(', ')
  })

  const STATUS_TONE: Record<string, string> = {
    new: 'text-faint',
    replace: 'text-accent-text',
    same: 'text-faint',
    'too-long': 'text-warning',
    empty: 'text-faint',
    duplicate: 'text-danger',
  }

  function statusText(row: ImportRow): string {
    switch (row.status) {
      case 'new':
        return tr('room.notesImport.statusNew')
      case 'replace':
        return tr('room.notesImport.statusReplace')
      case 'same':
        return tr('room.notesImport.statusSame')
      case 'too-long':
        return tr('room.notesImport.statusChars', { count: formatNumber(row.chars) })
      case 'empty':
        return tr('room.notesImport.statusEmpty')
      case 'duplicate':
        return tr('room.notesImport.statusDuplicate')
      default:
        return tr('room.notesImport.statusNoSlide')
    }
  }

  const TAP =
    'transition-[color,background-color,border-color,transform] duration-press ease-out ' +
    'active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-accent/40'
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-[85] flex items-start justify-center overflow-y-auto bg-brand/30 px-4 py-8
         sm:py-12"
  onclick={(event) => {
    if (event.target === event.currentTarget) onclose()
  }}
>
  <div
    class="flex w-full max-w-[640px] flex-col border-t-2 border-ink bg-canvas
           shadow-[0_18px_48px_rgb(15_45_105/0.1)]"
    role="dialog"
    aria-modal="true"
    aria-labelledby="notes-import-title"
    tabindex="-1"
    ondragover={(event) => {
      event.preventDefault()
      dragging = true
    }}
    ondragleave={(event) => {
      if (event.currentTarget === event.target) dragging = false
    }}
    ondrop={drop}
  >
    <!-- ------------------------------------------------------- header -->
    <div class="flex items-start gap-4 px-6 pb-5 pt-7 sm:px-8">
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <span class="truncate font-mono text-micro text-accent-text">
          <span class="uppercase tracking-label">{tr('room.notesImport.kicker')}</span>
          · {baseOf(file)}
        </span>
        <h3 id="notes-import-title" class="text-prompt-lg font-black tracking-[-0.02em] text-ink">
          {tr('room.notesImport.title')}
        </h3>
        <p class="max-w-[500px] text-ui text-muted">{tr('room.notesImport.lead')}</p>
      </div>
      <button
        type="button"
        class="{TAP} flex h-9 w-9 shrink-0 items-center justify-center border border-line text-muted
               hover:text-ink"
        aria-label={tr('room.notesImport.cancel')}
        onclick={onclose}
      >
        <Icon name="x" size={14} />
      </button>
    </div>

    <!-- ------------------------------------------------------- source -->
    <div class="flex flex-col px-6 pb-6 sm:px-8">
      <div
        class="flex items-center gap-4 border border-dashed bg-surface px-5 py-[18px]
               {dragging ? 'border-accent' : 'border-faint/60'}"
      >
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" class="shrink-0" aria-hidden="true">
          <path
            d="M7 3h10l5 5v17H7z"
            stroke="rgb(var(--brand))"
            stroke-width="1.6"
            stroke-linejoin="round"
          />
          <path d="M17 3v5h5" stroke="rgb(var(--brand))" stroke-width="1.6" stroke-linejoin="round" />
          <path
            d="M14.5 12v8M11.5 17l3 3 3-3"
            stroke="rgb(var(--accent))"
            stroke-width="1.6"
            stroke-linecap="square"
          />
        </svg>
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="text-ui-lg font-semibold text-ink">{tr('room.notesImport.drop')}</span>
          <span class="text-2xs text-muted">{tr('room.notesImport.dropHint')}</span>
        </div>
        <button
          type="button"
          class="{TAP} flex h-[34px] shrink-0 items-center border border-line bg-canvas px-3.5
                 text-2xs text-ink hover:bg-surface"
          onclick={() => picker?.click()}
        >
          {tr('room.notesImport.choose')}
        </button>
        <input
          bind:this={picker}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          class="hidden"
          onchange={(event) => {
            void take(event.currentTarget.files?.[0])
            event.currentTarget.value = ''
          }}
        />
      </div>
      {#if readError}
        <p class="flex items-center gap-2 px-0.5 pt-3 text-2xs text-danger" role="alert">
          <Icon name="alert" size={14} class="shrink-0" />
          {readError}
        </p>
      {:else if source}
        <div class="flex items-center gap-2.5 px-0.5 pt-3">
          <Icon name="check" size={14} class="shrink-0 text-positive" />
          <span class="min-w-0 truncate font-mono text-2xs text-ink">
            {source.name ?? tr('room.notesImport.pasted')}
          </span>
          <span class="shrink-0 text-2xs text-faint">
            {tr('room.notesImport.read', { size: formatNumber(kilobytes(source.bytes)) })}
          </span>
          <span class="flex-1"></span>
          <button
            type="button"
            class="shrink-0 border-b border-dashed border-accent-text text-2xs text-accent-text"
            onclick={() => picker?.click()}
          >
            {tr('room.notesImport.other')}
          </button>
        </div>
      {/if}
    </div>

    {#if source}
      <!-- ---------------------------------------------------- breakdown -->
      <div class="flex flex-col px-6 pt-1 sm:px-8">
        <div class="flex items-end justify-between border-b-2 border-ink pb-3">
          <span class="text-2xs font-black uppercase tracking-section text-ink">
            {tr('room.notesImport.breakdown')}
          </span>
          <span class="font-mono text-micro uppercase tracking-caps text-muted">
            {tr('room.notesImport.mapping')}
          </span>
        </div>
        {#if sections.length === 0}
          <p class="py-5 text-ui text-muted">{tr('room.notesImport.noSections')}</p>
        {:else}
          <div class="flex flex-col gap-2.5 pb-4 pt-[18px]">
            <p class="text-head font-semibold tracking-[-0.01em] text-ink">
              {tr('room.notesImport.found', {
                sections: tr('room.notesImport.sections', { count: sections.length }),
                pages: pages === null ? '—' : tr('room.notesImport.pages', { count: pages }),
              })}
            </p>
            {#if pages === null}
              <p class="text-2xs text-warning">{tr('room.notesImport.unchecked')}</p>
            {/if}
            <p class="flex flex-wrap items-center gap-x-5 gap-y-1 text-ui">
              {#if plan.counts.new}
                <span class="text-ink">{tr('room.notesImport.countNew', { count: plan.counts.new })}</span>
              {/if}
              {#if plan.counts.replace}
                <span class="text-accent-text">
                  {tr('room.notesImport.countReplace', { count: plan.counts.replace })}
                </span>
              {/if}
              {#if plan.counts.same}
                <span class="text-muted">
                  {tr('room.notesImport.countSame', { count: plan.counts.same })}
                </span>
              {/if}
              {#if plan.counts['too-long']}
                <span class="text-warning">
                  {tr('room.notesImport.countTooLong', {
                    count: plan.counts['too-long'],
                    max: formatNumber(MAX_NOTE_CHARS),
                  })}
                </span>
              {/if}
              {#if plan.counts['no-slide']}
                <span class="text-danger">
                  {tr('room.notesImport.countNoSlide', { count: plan.counts['no-slide'] })}
                </span>
              {/if}
              {#if plan.counts.duplicate}
                <span class="text-danger">
                  {tr('room.notesImport.countDuplicate', { count: plan.counts.duplicate })}
                </span>
              {/if}
              {#if plan.counts.empty}
                <span class="text-muted">
                  {tr('room.notesImport.countEmpty', { count: plan.counts.empty })}
                </span>
              {/if}
            </p>
          </div>
        {/if}
      </div>

      {#if sections.length > 0}
        <!-- ------------------------------------------------- the mapping -->
        <div class="flex max-h-[min(514px,55vh)] flex-col overflow-y-auto px-6 sm:px-8">
          {#each items as item (item.kind === 'row' ? `r${item.row.index}` : `f${item.key}`)}
            {#if item.kind === 'run'}
              <div class="flex h-9 shrink-0 items-center gap-3 border-t border-line bg-surface">
                <span class="w-7 shrink-0"></span>
                <span class="font-mono text-micro tracking-[-0.02em] text-muted">{runLabel(item.rows)}</span>
                <span class="flex-1"></span>
                <button
                  type="button"
                  class="pr-0.5 text-2xs text-accent-text hover:underline"
                  onclick={() => (unfolded = { ...unfolded, [item.key]: true })}
                >
                  {tr('room.notesImport.show')}
                </button>
              </div>
            {:else if item.row.status === 'no-slide'}
              {@const row = item.row}
              <div
                class="flex h-12 shrink-0 items-center gap-2.5 border-y border-line border-l-2 border-l-danger
                       bg-danger/[0.05] pl-2.5 pr-3"
              >
                <Icon name="alert" size={18} class="shrink-0 text-danger" />
                <span class="shrink-0 text-ui font-semibold text-ink">
                  {tr('room.notesImport.noSlideTitle', { index: number(row) })}
                </span>
                <span class="line-clamp-1 min-w-0 flex-1 text-2xs text-muted">
                  {tr('room.notesImport.noSlideBody', {
                    title: row.title || tr('room.notesImport.untitled'),
                    pages: pages === null ? '—' : tr('room.notesImport.pages', { count: pages }),
                  })}
                </span>
              </div>
            {:else}
              {@const row = item.row}
              <div class="flex h-11 shrink-0 items-center gap-3 border-t border-line">
                <span class="w-7 shrink-0 font-mono text-2xs text-muted">{number(row)}</span>
                <span
                  class="line-clamp-1 min-w-0 flex-1 text-ui-lg
                         {row.title ? 'text-ink' : 'italic text-faint'}"
                >
                  {row.title || tr('room.notesImport.untitled')}
                </span>
                <span class="w-4 shrink-0 text-ui-lg text-faint" aria-hidden="true">→</span>
                <span class="w-[72px] shrink-0 font-mono text-2xs text-ink">
                  {tr('room.notesImport.slide', { page: row.page })}
                </span>
                <span
                  class="flex w-[128px] shrink-0 justify-end text-right text-2xs
                         {STATUS_TONE[row.status]}"
                >
                  {statusText(row)}
                </span>
              </div>
              {#if row.status === 'too-long'}
                <div class="flex flex-col border-l-2 border-warning bg-warning/[0.07]">
                  <div class="flex items-start gap-2.5 pb-3.5 pl-2.5 pr-3 pt-3">
                    <Icon name="alert" size={18} class="mt-px shrink-0 text-warning" />
                    <div class="flex min-w-0 flex-1 flex-col gap-1">
                      <span class="text-ui font-semibold text-ink">
                        {tr('room.notesImport.tooLongTitle', {
                          index: number(row),
                          max: formatNumber(MAX_NOTE_CHARS),
                          count: formatNumber(row.chars),
                        })}
                      </span>
                      <span class="text-2xs text-muted">
                        {tr('room.notesImport.tooLongBody', { page: row.page })}
                      </span>
                    </div>
                    <button
                      type="button"
                      class="{TAP} flex h-8 shrink-0 items-center border border-line bg-canvas px-3
                             text-2xs text-ink hover:bg-surface"
                      aria-expanded={textShown[row.index] ?? false}
                      onclick={() => (textShown = { ...textShown, [row.index]: !textShown[row.index] })}
                    >
                      {textShown[row.index]
                        ? tr('room.notesImport.hideText')
                        : tr('room.notesImport.showText')}
                    </button>
                  </div>
                  {#if textShown[row.index]}
                    <pre
                      class="mx-3 mb-3 max-h-48 overflow-y-auto whitespace-pre-wrap border border-line bg-canvas p-3
                             font-mono text-micro text-ink">{row.body}</pre>
                  {/if}
                </div>
              {/if}
            {/if}
          {/each}
        </div>
      {/if}
    {/if}

    <!-- ------------------------------------------------------- footer -->
    <div class="flex flex-wrap items-center gap-5 px-6 pb-7 pt-6 sm:px-8">
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        {#if applyError}
          <span class="text-2xs text-danger" role="alert">{applyError}</span>
        {:else if source && sections.length > 0}
          <span class="text-ui font-semibold text-ink">
            {tr('room.notesImport.into', { count: writes, total: sections.length })}
          </span>
          <span class="text-2xs text-muted">
            {#if writes === 0}
              {tr('room.notesImport.nothing')}
            {:else}
              {[
                plan.counts.replace
                  ? tr('room.notesImport.overwrite', { count: plan.counts.replace })
                  : '',
                skippedList ? tr('room.notesImport.skip', { list: skippedList }) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            {/if}
          </span>
        {/if}
      </div>
      <div class="flex shrink-0 gap-2.5">
        <button
          type="button"
          class="{TAP} flex h-11 items-center justify-center bg-brand px-[22px] text-micro font-black uppercase
                 tracking-label text-white enabled:hover:brightness-110 disabled:opacity-40"
          disabled={!source || writes === 0 || applying}
          onclick={() => void apply()}
        >
          {#if applying}
            {tr('room.notesImport.applying')}
          {:else if plan.counts.replace > 0}
            {tr('room.notesImport.applyReplace')}
          {:else}
            {tr('room.notesImport.applyAdd')}
          {/if}
        </button>
        <button
          type="button"
          class="{TAP} flex h-11 items-center justify-center border border-line px-[18px] text-2xs
                 text-ink hover:bg-surface"
          onclick={onclose}
        >
          {tr('room.notesImport.cancel')}
        </button>
      </div>
    </div>
  </div>
</div>
