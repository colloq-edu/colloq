<!--
  A class page: what one class left behind, for the students who sat in it
  and those who missed it.

  The order is the order of the questions a student comes with. Which class
  is this (number, day, title), what is on it (every material, each opening
  where it belongs, and all of it as one archive), and then the notebooks
  themselves, one tab each, with a table of contents. Markdown text the
  teacher put on the page («Что почитать») is a tab too, laid out like a
  notebook's prose, with its headings in the same table of contents. From 1024 px the
  materials and the contents move to a 360 px rail and the notebook gets the
  main column; below that the materials come first, then a sticky strip with
  the tabs and «Содержание».

  The page itself is loaded once (ReaderScreen); a notebook's cells are
  fetched the first time its tab opens and kept for the visit, so switching
  back and forth costs nothing. The tab lives in the address
  (`/p/<page>/<key>`), so «Back» returns to the previous tab and a tab can
  be sent to a classmate; a cell lives in the hash (`#<cellId>`).
-->
<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  import { tick } from 'svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import Splash from '@/components/ui/Splash.svelte'
  import { api, ApiError } from '@/lib/api'
  import { loadRenderers, renderers } from '@/lib/render.svelte'
  import { longDay, ordinal, shortDay } from '@/lib/course-now'
  import { storedTokens } from '@/lib/identity'
  import { formatDay } from '@shared/class-day'
  import { baseOf } from '@shared/paths'
  import {
    MAX_DOOR_TOKENS,
    MAX_OUTLINE_TEXT,
    refusedMaterial,
    type OutlineEntry,
    type PublicNeighbor,
    type PublicNotebook as NotebookBody,
    type PublicPage,
    type RoomDoor as DoorAnswer,
  } from '@shared/publish'
  import ReaderBar from './ReaderBar.svelte'
  import CopyLink from './CopyLink.svelte'
  import MaterialList from './MaterialList.svelte'
  import Outline from './Outline.svelte'
  import PublicNotebook from './PublicNotebook.svelte'
  import RoomDoor from './RoomDoor.svelte'
  import { wideScreen } from './wide.svelte'
  import { downloadHref, opensAsTab, pageHref, plainClick } from './links'

  interface Props {
    page: PublicPage
    /** The material in the address; `null` opens the first notebook. */
    materialKey: string | null
    onnavigate: (path: string) => void
    /** Rewrites the address without a history entry: a link to a PDF's key opens the page. */
    onreplace: (path: string) => void
    /** Fetches the page again: a tab that vanished means the page was rebuilt meanwhile. */
    onreload: () => void
  }

  let { page, materialKey, onnavigate, onreplace, onreload }: Props = $props()

  const wide = wideScreen()

  /** The page's tabs: its notebooks and its Markdown text, in the teacher's order. */
  const tabs = $derived(page.materials.filter((m) => opensAsTab(m)))
  const requested = $derived(
    materialKey === null ? null : (page.materials.find((m) => m.key === materialKey) ?? null),
  )
  /** A key the page does not have: an old tab link, or a typo. The page is alive. */
  const unknownKey = $derived(materialKey !== null && requested === null)
  const activeKey = $derived(
    requested && opensAsTab(requested) ? requested.key : (tabs[0]?.key ?? null),
  )
  const active = $derived(tabs.find((m) => m.key === activeKey) ?? null)
  /** A notebook's outline comes with the page; a text's is read off its headings once drawn. */
  let docOutline = $state<OutlineEntry[]>([])
  const outline = $derived(active?.kind === 'notebook' ? (active.outline ?? []) : docOutline)
  /** Tabs are furniture with one notebook: a legacy page has exactly one. */
  const tabbed = $derived(tabs.length >= 2)

  /*
   * A key that names a PDF or a data file is not a tab: the page opens on its
   * first notebook and the address stops pretending otherwise.
   */
  $effect(() => {
    if (requested && !opensAsTab(requested)) onreplace(pageHref(page.address))
  })

  /* ----------------------------------------------------------- the notebook */

  /** Cells by material key, for this visit: a tab opened twice is fetched once. */
  const cache = new Map<string, NotebookBody>()
  let notebook = $state<NotebookBody | null>(null)
  /** A Markdown tab's text, by key, the same way. */
  const texts = new Map<string, string>()
  let doc = $state<string | null>(null)
  let render = $state(renderers())
  let status = $state<'idle' | 'loading' | 'ready' | 'failed' | 'gone' | 'missing'>('idle')
  /** «Повторить»: a counter in the effect's dependencies, not a second way of loading. */
  let attempt = $state(0)
  /** The tab that answered «not on the page»: never offered as «Открыть первый». */
  let failedKey = $state<string | null>(null)
  /** The tab a page reload was already asked for, so a stubborn 404 cannot loop. */
  let reloadedFor: string | null = null

  $effect(() => {
    const key = activeKey
    const id = page.id
    const text = active !== null && active.kind !== 'notebook'
    void attempt
    if (!key || unknownKey || page.state !== 'published') return
    if (text) return loadText(key)
    const known = cache.get(key)
    if (known) {
      doc = null
      notebook = known
      status = 'ready'
      return
    }
    let cancelled = false
    // The previous tab's cells go at once: a lying page is worse than an empty one.
    notebook = null
    doc = null
    status = 'loading'
    api
      .notebook(id, key)
      .then((body) => {
        if (cancelled) return
        cache.set(key, body.notebook)
        notebook = body.notebook
        status = 'ready'
      })
      .catch((err: unknown) => {
        if (cancelled) return
        /*
         * Which of the two 404s it is, the body decides (shared/publish.ts ·
         * refusedMaterial): a page rebuilt without this tab is alive and has
         * a first tab to offer; a withdrawn one leads to the course.
         */
        const what = err instanceof ApiError ? refusedMaterial(err.status, err.message) : null
        status = what === 'publication' ? 'gone' : what === 'material' ? 'missing' : 'failed'
        if (status !== 'missing') return
        /*
         * The page was rebuilt since this visit loaded it: the tab was taken
         * off or renamed. Its list is stale, so it is fetched again once, and
         * the tabs and «Открыть первый» come from the page as it is now.
         */
        failedKey = key
        if (reloadedFor !== key) {
          reloadedFor = key
          onreload()
        }
      })
    return () => {
      cancelled = true
    }
  })

  /**
   * A Markdown tab: the file itself, from the same door its download button
   * uses, drawn by the sanitizing renderer the notebooks' prose goes through.
   * A 404 is the page rebuilt without it, as for a notebook.
   */
  function loadText(key: string): (() => void) | undefined {
    if (!render) void loadRenderers().then((loaded) => (render = loaded))
    const known = texts.get(key)
    notebook = null
    if (known !== undefined) {
      doc = known
      status = 'ready'
      return
    }
    let cancelled = false
    doc = null
    status = 'loading'
    fetch(downloadHref(page.address, key))
      .then(async (res) => {
        if (cancelled) return
        if (res.status === 404) {
          status = 'missing'
          failedKey = key
          if (reloadedFor !== key) {
            reloadedFor = key
            onreload()
          }
          return
        }
        if (!res.ok) throw new Error(String(res.status))
        const body = await res.text()
        if (cancelled) return
        texts.set(key, body)
        doc = body
        status = 'ready'
      })
      .catch(() => {
        if (!cancelled) status = 'failed'
      })
    return () => {
      cancelled = true
    }
  }

  /*
   * A text's table of contents: its h1–h3 as drawn, each given an id the
   * outline scrolls to. Read off the page rather than parsed again from the
   * source, so a heading inside a code block never shows up in it.
   */
  let docEl = $state<HTMLElement | null>(null)
  $effect(() => {
    const el = docEl
    const key = activeKey
    void render
    void doc
    if (!el || !key) {
      docOutline = []
      return
    }
    const found: OutlineEntry[] = []
    el.querySelectorAll<HTMLElement>('h1, h2, h3').forEach((heading, i) => {
      heading.id = `${key}-h${i + 1}`
      heading.classList.add('scroll-mt-16', 'lg:scroll-mt-20')
      const text = (heading.textContent ?? '').trim().slice(0, MAX_OUTLINE_TEXT)
      if (text) found.push({ id: heading.id, level: Number(heading.tagName[1]) as 1 | 2 | 3, text })
    })
    docOutline = found
  })

  /** A cell named in the address when the page opened: scrolled to once its notebook is drawn. */
  let pendingHash: string | null = (() => {
    try {
      return decodeURIComponent(location.hash.slice(1)) || null
    } catch {
      return null
    }
  })()
  $effect(() => {
    if ((!notebook && !docOutline.length) || pendingHash === null) return
    const id = pendingHash
    pendingHash = null
    document.getElementById(id)?.scrollIntoView({ block: 'start' })
  })

  /* ----------------------------------------------------------- the room door */

  /**
   * The way back into the class's room, asked once the page is here. The
   * page never names its room; the server answers this POST with the room's
   * address only for a browser whose keys prove it was there, for staff, or
   * when the teacher opened the room to everyone (shared/publish.ts ·
   * RoomDoor). A refusal or a network failure draws nothing: the door is an
   * extra, the materials are the page.
   */
  let door = $state<DoorAnswer | null>(null)

  $effect(() => {
    const id = page.id
    door = null
    if (page.state !== 'published') return
    let cancelled = false
    api
      .roomDoor(id, storedTokens(MAX_DOOR_TOKENS))
      .then((answer) => {
        if (!cancelled) door = answer
      })
      .catch(() => {
        if (!cancelled) door = null
      })
    return () => {
      cancelled = true
    }
  })

  /* ------------------------------------------------------------ the outline */

  let current = $state<string | null>(null)
  /**
   * The section being read: the last heading above the upper third of the
   * window. The observer has no root (the document scrolls, not a pane), and
   * it only says "something crossed the band"; the geometry decides which.
   */
  $effect(() => {
    const ids = [...new Set(outline.map((entry) => entry.id))]
    if ((!notebook && doc === null) || ids.length === 0) {
      current = null
      return
    }
    const cells = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null)
    const pick = () => {
      const line = window.innerHeight * 0.3
      let found = ids[0]
      for (const el of cells) if (el.getBoundingClientRect().top <= line) found = el.id
      current = found
    }
    const observer = new IntersectionObserver(pick, { rootMargin: '0px 0px -70% 0px' })
    for (const el of cells) observer.observe(el)
    pick()
    return () => observer.disconnect()
  })

  let contentsOpen = $state(false)

  function toCell(id: string): void {
    contentsOpen = false
    document.getElementById(id)?.scrollIntoView({ block: 'start' })
    current = id
  }

  /* ------------------------------------------------------------- the tabs */

  let reader = $state<HTMLElement | null>(null)
  let strip = $state<HTMLElement | null>(null)

  /*
   * The open tab brings itself to the middle of the strip, by the strip's own
   * scroll and never scrollIntoView: that scrolls the page too, and on a
   * phone the strip starts below the materials, so opening a tab link must
   * not jump the page down to it. Measured again whenever the strip or a tab
   * changes size: the web fonts landing change every tab's width, and
   * «Содержание» appears beside the strip only once a text's headings are
   * read, narrowing it — a strip centred before either left the last tab
   * («Что почитать») out of sight.
   */
  $effect(() => {
    const key = activeKey
    const root = strip
    if (!root || !key) return
    const center = () => {
      const tabEl = root.querySelector<HTMLElement>(`[data-key="${key}"]`)
      if (!tabEl) return
      const box = root.getBoundingClientRect()
      const at = tabEl.getBoundingClientRect()
      root.scrollLeft += at.left - box.left - (box.width - at.width) / 2
    }
    center()
    const sizes = new ResizeObserver(center)
    sizes.observe(root)
    for (const child of root.children) sizes.observe(child)
    return () => sizes.disconnect()
  })

  function openTab(key: string): void {
    contentsOpen = false
    if (key !== activeKey) onnavigate(pageHref(page.address, key))
  }

  function tab(event: MouseEvent, key: string): void {
    if (!plainClick(event)) return
    event.preventDefault()
    openTab(key)
    // A tab picked deep inside the previous notebook opens the next one at its top.
    if (reader && reader.getBoundingClientRect().top < 0) reader.scrollIntoView({ block: 'start' })
  }

  /** A notebook tapped in «МАТЕРИАЛЫ»: its tab, and the reader brought up to it. */
  async function fromList(key: string): Promise<void> {
    openTab(key)
    await tick()
    reader?.scrollIntoView({ block: 'start' })
  }

  /* ------------------------------------------------------------- the header */

  const future = $derived(page.day !== null && page.day > page.today)
  const label = $derived.by(() => {
    if (page.day === null) return page.n !== null ? tr('room.page.class', { n: ordinal(page.n) }) : ''
    const day = longDay(page.day, page.n === null ? null : wide.current ? 'long' : 'short')
    return page.n !== null ? tr('room.page.label', { n: ordinal(page.n), day }) : day
  })
  /**
   * «обновлено 14 сен», only when the page changed after its class day: a
   * page refreshed the same evening is simply the class's page.
   */
  const updated = $derived.by(() => {
    if (page.day === null) return null
    // The server's day, like `today`: the browser's zone never decides a date here.
    const on = page.updatedOn
    if (on <= page.day) return null
    return tr('room.page.updated', { day: formatDay(on, getLocale(), { weekday: false }) })
  })
  const courseHref = $derived(page.course ? `/c/${page.course.slug ?? page.course.id}` : null)
  /** The first tab that is still there; `null` when the visit knows of none (see `openFirst`). */
  const firstKey = $derived(tabs.find((m) => m.key !== failedKey)?.key ?? null)
  const firstHref = $derived(pageHref(page.address, firstKey))
  const withdrawn = $derived(page.state === 'withdrawn' || status === 'gone')
  const noMaterial = $derived(unknownKey || status === 'missing')

  function follow(event: MouseEvent, path: string): void {
    if (!plainClick(event)) return
    event.preventDefault()
    onnavigate(path)
  }

  /**
   * «Открыть первый». With no other tab known, navigating in place would land
   * on the same missing key and do nothing, so the browser loads the page
   * afresh instead.
   */
  function openFirst(event: MouseEvent): void {
    if (!plainClick(event)) return
    event.preventDefault()
    if (firstKey !== null) onnavigate(firstHref)
    else location.assign(firstHref)
  }
</script>

{#snippet neighbor(side: 'prev' | 'next', item: PublicNeighbor)}
  {@const href = item.address ? pageHref(item.address) : null}
  {@const dateLine = [item.day ? shortDay(item.day) : null, href ? null : tr('room.course.afterRow')]
    .filter(Boolean)
    .join(' · ')}
  {@const name = `${ordinal(item.n)} · ${item.title}`}
  <div
    class="flex flex-col gap-1.5 py-4 sm:flex-1 sm:py-0
           {side === 'next' ? 'items-end text-right' : ''}"
  >
    <p class="order-2 font-mono text-[13px] leading-5 text-muted sm:order-1 sm:uppercase sm:tracking-label">
      <span class="hidden sm:inline">
        {side === 'prev' ? `← ${tr('room.page.prev')}` : tr('room.page.next')}{dateLine ? ' · ' : ''}
      </span>{dateLine}<span class="hidden sm:inline">{side === 'next' ? ' →' : ''}</span>
    </p>
    {#if href}
      <a
        {href}
        class="order-1 text-[17px] font-semibold leading-6 text-ink hover:underline sm:order-2
               sm:text-[18px] sm:leading-[26px] sm:text-accent-text"
        onclick={(event) => follow(event, href)}
      >
        <span class="sm:hidden">{side === 'prev' ? '← ' : ''}</span>{name}<span class="sm:hidden"
          >{side === 'next' ? ' →' : ''}</span
        >
      </a>
    {:else}
      <span class="order-1 text-[17px] leading-6 text-muted sm:order-2 sm:text-[18px] sm:leading-[26px]">
        {name}
      </span>
    {/if}
  </div>
{/snippet}

<div class="reading-ui min-h-screen bg-canvas">
  <ReaderBar
    course={page.course && courseHref ? { name: page.course.name, href: courseHref } : null}
    crumb={page.n !== null ? tr('room.page.class', { n: ordinal(page.n) }) : null}
    wide={wide.current}
    {onnavigate}
  />

  <div class="mx-auto w-full max-w-[1440px] px-4 pb-10 pt-8 sm:px-10 lg:pb-12 lg:pt-14">
    {#if label}
      <p class="font-mono text-[13px] uppercase leading-5 tracking-label text-muted lg:text-accent-text">
        {label}{#if future && !withdrawn}<span class="text-accent-text"> · {tr('room.page.beforeClass')}</span>{/if}
      </p>
    {/if}
    <h1
      class="max-w-[1040px] pt-3.5 text-[30px] font-black leading-[34px] tracking-[-0.02em] text-ink
             sm:text-marquee lg:pt-[18px] lg:text-[56px] lg:leading-[58px] lg:tracking-[-0.035em]"
    >
      {page.title}
    </h1>
    {#if page.about && !withdrawn}
      <p
        class="max-w-[720px] pt-3.5 text-[17px] leading-[26px] text-muted lg:pt-[18px] lg:text-[19px]
               lg:leading-[30px]"
      >
        {page.about}
      </p>
    {/if}
    {#if updated && !withdrawn && !noMaterial}
      <p class="pt-2.5 text-[14px] leading-5 text-muted">{updated}</p>
    {/if}
  </div>

  {#if withdrawn}
    <!-- Never a 404 for a link a student was given: the page says it was
         taken down and leads up, to the course. -->
    <div class="mx-auto w-full max-w-[1440px] px-4 pb-12 sm:px-10">
      <div class="flex max-w-[720px] flex-col gap-1.5 border-t-2 border-faint bg-surface px-4 pb-2 pt-5">
        <p class="text-title text-ink">{tr('room.page.withdrawn')}</p>
        {#if page.course && courseHref}
          <a
            href={courseHref}
            class="flex min-h-11 items-center text-[16px] font-semibold leading-6 text-accent-text"
            onclick={(event) => follow(event, courseHref)}
          >
            {tr('room.page.toCourse', { name: page.course.name })}
          </a>
        {/if}
      </div>
    </div>
  {:else if noMaterial}
    <div class="mx-auto w-full max-w-[1440px] px-4 pb-12 sm:px-10">
      <div class="flex max-w-[720px] flex-col gap-1.5 border-t-2 border-faint bg-surface px-4 pb-4 pt-5">
        <p class="text-title text-ink">{tr('room.page.noMaterial')}</p>
        <a
          href={firstHref}
          class="press mt-2.5 flex h-12 shrink-0 items-center justify-center border border-brand
                 text-[14px] font-bold uppercase leading-5 tracking-caps text-brand
                 dark:border-ink dark:text-ink"
          onclick={openFirst}
        >
          {tr('room.page.openFirst')}
        </a>
      </div>
    </div>
  {:else}
    <div class="mx-auto w-full max-w-[1440px] px-4 pb-12 sm:px-10 lg:flex lg:gap-[72px] lg:pb-24">
      <main class="min-w-0 flex-1">
        {#if !wide.current}
          <div class="pb-10">
            <MaterialList {page} active={activeKey} wide={false} onopen={(key) => void fromList(key)} />
            {#if door}<RoomDoor {door} wide={false} />{/if}
          </div>
        {/if}

        {#if active}
          <section bind:this={reader} aria-label={active.name}>
            {#if tabbed || wide.current || outline.length > 1}
              <div class="sticky top-0 z-20 -mx-4 bg-canvas sm:-mx-10 lg:mx-0">
                <div
                  class="flex h-[52px] items-stretch justify-between gap-4 border-b border-line px-4
                         sm:px-10 lg:h-14 lg:px-0"
                >
                  <nav
                    bind:this={strip}
                    aria-label={tr('room.page.tabs')}
                    class="flex min-w-0 items-stretch gap-6 overflow-x-auto [scrollbar-width:none]
                           lg:gap-8 [&::-webkit-scrollbar]:hidden"
                  >
                    {#if tabbed}
                      {#each tabs as m (m.key)}
                        {@const on = m.key === activeKey}
                        <a
                          href={pageHref(page.address, m.key)}
                          data-key={m.key}
                          aria-current={on ? 'page' : undefined}
                          class="press flex shrink-0 items-center whitespace-nowrap border-b-[3px] pt-0.5
                                 text-[16px] leading-6 transition-colors duration-100 lg:text-[17px]
                                 {on
                            ? 'border-ink font-semibold text-ink lg:font-bold'
                            : 'border-transparent font-semibold text-muted hover:text-ink lg:font-normal'}"
                          onclick={(event) => tab(event, m.key)}
                        >
                          {m.name}
                        </a>
                      {/each}
                    {:else}
                      <span
                        class="flex shrink-0 items-center whitespace-nowrap text-[16px] font-semibold
                               leading-6 text-ink lg:text-[17px] lg:font-bold"
                      >
                        {active.name}
                      </span>
                    {/if}
                  </nav>
                  {#if wide.current}
                    <a
                      href={downloadHref(page.address, active.key)}
                      download=""
                      class="flex shrink-0 items-center gap-2 text-[15px] leading-[22px] text-accent-text
                             hover:underline"
                    >
                      <Icon name="download" size={16} strokeWidth={2.2} />
                      <!-- «с результатами» only when there are some: a notebook
                           nobody ran downloads as plain code. -->
                      {(active.outputs ?? 0) > 0
                        ? tr('room.page.ipynb', { file: baseOf(active.path) })
                        : baseOf(active.path)}
                    </a>
                  {:else if outline.length > 1}
                    <button
                      type="button"
                      class="press flex shrink-0 items-center gap-1 pl-3 text-[15px] leading-[22px]
                             text-accent-text"
                      aria-expanded={contentsOpen}
                      aria-controls="page-contents"
                      onclick={() => (contentsOpen = !contentsOpen)}
                    >
                      {tr('room.page.contents')}
                      <Icon name={contentsOpen ? 'chevron-up' : 'chevron-down'} size={12} strokeWidth={2.6} />
                    </button>
                  {/if}
                </div>
                {#if contentsOpen && !wide.current}
                  <div
                    id="page-contents"
                    class="absolute inset-x-0 top-full max-h-[60vh] overflow-y-auto border-b border-line
                           bg-canvas px-4 pb-3 pt-2 sm:px-10"
                  >
                    <Outline entries={outline} {current} name={null} variant="panel" onpick={toCell} />
                  </div>
                {/if}
              </div>
            {/if}

            {#if status === 'ready' && notebook}
              <div class="pt-6 lg:pt-8">
                <PublicNotebook cells={notebook.cells} publication={page.id} />
              </div>
            {:else if status === 'ready' && doc !== null}
              <!-- The same rules as a notebook's prose (`.prose-note`): a text
                   on the page reads like the text of the seminar. -->
              <article bind:this={docEl} class="prose-note prose-cell pt-6 lg:pt-8">
                {#if render}
                  <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized in lib/render -->
                  {@html render.markdown(doc, { lazyImages: true })}
                {:else}
                  <p class="whitespace-pre-wrap">{doc}</p>
                {/if}
              </article>
            {:else if status === 'failed'}
              <p class="pt-8 text-[16px] leading-6 text-muted">
                {tr('room.page.notebookFailed')}
                <button
                  type="button"
                  class="press font-semibold text-accent-text"
                  onclick={() => (attempt += 1)}
                >
                  {tr('room.ui.552')}
                </button>
              </p>
            {:else}
              <!-- The page is drawn and only this tab's cells are on their
                   way: a pane splash where they will be. -->
              <Splash size="pane" label={tr('room.ui.874')} />
            {/if}
          </section>
        {/if}

        {#if page.prev || page.next}
          <nav
            class="mt-14 border-t-2 border-ink sm:flex sm:gap-10 sm:pt-5
                   {page.prev && page.next ? '[&>*+*]:border-t [&>*+*]:border-line sm:[&>*+*]:border-t-0' : ''}
                   {!page.prev ? 'sm:justify-end' : ''}"
          >
            {#if page.prev}{@render neighbor('prev', page.prev)}{/if}
            {#if page.next}{@render neighbor('next', page.next)}{/if}
          </nav>
        {/if}

        <footer class="flex flex-col gap-5 pt-7 lg:gap-2 lg:pt-8">
          <p class="max-w-[680px] text-[14px] leading-[21px] text-muted lg:text-[15px] lg:leading-[22px]">
            {tr('room.page.footer')}
          </p>
          <div class="flex flex-col gap-1">
            {#if !wide.current}
              <p class="font-mono text-[13px] uppercase leading-5 tracking-label text-muted">
                {tr('room.page.link')}
              </p>
            {/if}
            <CopyLink
              path={pageHref(page.address)}
              size="sm"
              layout={wide.current ? 'inline' : 'spread'}
            />
          </div>
        </footer>
      </main>

      {#if wide.current}
        <aside class="flex w-[360px] shrink-0 flex-col gap-10 pt-[22px]">
          <MaterialList {page} active={activeKey} wide onopen={(key) => void fromList(key)} />
          {#if door}<RoomDoor {door} wide />{/if}
          {#if outline.length > 0}
            <div class="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto">
              <Outline entries={outline} {current} name={active?.name ?? null} variant="rail" onpick={toCell} />
            </div>
          {/if}
        </aside>
      {/if}
    </div>
  {/if}
</div>
