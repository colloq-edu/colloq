<!--
  «Страница занятия»: what of a room goes onto its public page.

  A screen, not a window over the list: the panel has its own rule for this —
  "anything that needs a decision gets a screen of its own". Here the teacher
  decides what the class will be reading for the rest of the year, and a link
  handed out cannot be taken back.

  The room is offered whole: every notebook with its results and every file,
  each ticked or not by the server's defaults (shared/materials.ts), and
  every unticked row saying why. What is decided once is remembered
  (PublishSelection), so «Завершить занятие» can rebuild the page next week
  without this screen.
-->
<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  import { onMount, tick } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Check from '@/admin/ui/Check.svelte'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import {
    AdminApiError,
    addressHolderOf,
    adminApi,
    publishRefusal,
    type RefusedReason,
  } from '@/lib/adminApi'
  import { copyText } from '@/lib/clipboard'
  import { formatDay } from '@shared/class-day'
  import {
    MAX_FOLDER_FILES,
    MAX_MATERIAL_NAME,
    ROOM_ACCESS,
    slugOk,
    type AddressHolder,
    type AdminPage as PageInfo,
    type FileChoice,
    type FolderEntry,
    type NotebookChoice,
    type PublishInfo,
    type RoomAccess,
  } from '@shared/publish'
  import {
    checkText,
    entryPath,
    entryReason,
    fileReason,
    folderMeta,
    folderReason,
    folderRequest,
    goingPaths,
    kindText,
    lockedEntry,
    lockedFile,
    lockedNotebook,
    notebookMeta,
    notebookReason,
    pickedBytes,
    publishBlocked,
    relevantChecks,
    sizeText,
  } from '@/admin/page-picker'
  import { localDay, twoDigits } from '@/admin/course-plan'

  interface Props {
    /** The room — or, for a page whose room was deleted, the page itself. */
    sessionId: string
    navigate: (path: string) => void
    /**
     * Where the teacher came from: `course:<id>` goes back to that course,
     * anything else (the classes list, the room's end-of-class dialog) to
     * the classes list.
     */
    from?: string | null
    /** `address`: opened from a course row's «Адрес страницы…» — the field gets the focus. */
    focus?: string | null
  }

  let { sessionId, navigate, from = null, focus = null }: Props = $props()

  let info = $state<PublishInfo | null>(null)
  let loadErrorText = $state<(() => string) | null>(null)
  const loadError = $derived(loadErrorText?.() ?? null)
  /** The rows as the teacher arranges them: ticks, names and the notebooks' order. */
  let books = $state<NotebookChoice[]>([])
  let files = $state<FileChoice[]>([])
  /** The names the server suggested: an emptied field publishes under them, not under nothing. */
  let suggested = new Map<string, string>()
  /** Check ids confirmed with «Проверил(а)» — those saved with the page and those ticked here. */
  let acked = $state<string[]>([])
  let autoRefresh = $state(true)
  /** «Вход в комнату со страницы» (shared/publish.ts · RoomAccess). */
  let roomAccess = $state<RoomAccess>('anyone')
  /**
   * Whether the server keeps a pick for this page, so the door setting can be
   * saved on its own. Before the first publish (or on a page carried over
   * from 0.12 without one) the choice rides with «Опубликовать».
   */
  let hasPick = $state(false)
  let savingAccess = $state(false)
  /** The class day of a page outside a course, stored as held_on. */
  let heldOn = $state('')
  /** The page as it stands now: published earlier, or just now on this screen. */
  let already = $state<PageInfo | null>(null)
  /** Published during this visit: the result line is shown. */
  let done = $state(false)
  let refused = $state<{ path: string; reason: RefusedReason }[]>([])
  let building = $state(false)
  let busy = $state(false)
  let errorText = $state<(() => string | null) | null>(null)
  const error = $derived(errorText?.() ?? null)
  let copied = $state(false)
  let addressField = $state<HTMLInputElement | null>(null)

  const explain = (cause: unknown, fallback: string): string =>
    cause instanceof AdminApiError ? cause.message : fallback

  /**
   * The notebooks in the order the page will have them.
   *
   * A saved pick is the teacher's order (Лекция before Семинар, whatever the
   * room's tree says); whatever it does not name follows in the room's own
   * order.
   */
  function ordered(body: PublishInfo): NotebookChoice[] {
    const rank = new Map(body.selection?.notebooks.map((n, i) => [n.root, i]) ?? [])
    return body.notebooks
      .map((book, i) => ({ book: { ...book }, at: rank.get(book.root) ?? 1e6 + i }))
      .sort((a, b) => a.at - b.at)
      .map(({ book }) => book)
  }

  function adopt(body: PublishInfo): void {
    info = body
    already = body.page
    books = ordered(body)
    // A folder's files are ticked one by one too: copies, so a tick here never edits `info`.
    files = body.files.map((file) => ({
      ...file,
      ...(file.entries ? { entries: file.entries.map((entry) => ({ ...entry })) } : {}),
    }))
    suggested = new Map([
      ...body.notebooks.map((b): [string, string] => [b.root, b.name]),
      ...body.files.map((f): [string, string] => [f.path, f.name]),
    ])
    acked = body.selection?.ack ?? []
    autoRefresh = body.selection?.autoRefresh ?? true
    roomAccess = body.roomAccess ?? 'anyone'
    hasPick = body.selection !== null
    heldOn =
      body.heldOn ?? localDay(body.room.finishedAt ?? Date.now())
    former = already?.former ?? []
    slug = already?.slug ?? ''
    slugDraft = slug
  }

  onMount(() => {
    void adminApi
      .publishInfo(sessionId)
      .then(async (body) => {
        adopt(body)
        if (focus === 'address' && body.page) {
          await tick()
          addressField?.scrollIntoView({ block: 'center' })
          addressField?.focus()
        }
      })
      .catch((cause: unknown) => {
        loadErrorText = () => explain(cause, tr('admin.page.loadFailed'))
      })
  })

  /* ------------------------------------------------------------ the way back */

  const fromCourse = $derived(from?.startsWith('course:') ? from.slice('course:'.length) : null)
  /** The course's name for «← К курсу «…»», when the page is not that course's own row. */
  let fromCourseName = $state<string | null>(null)
  $effect(() => {
    const id = fromCourse
    if (!id || !info || info.course?.id === id) return
    void adminApi
      .course(id)
      .then((course) => (fromCourseName = course.name))
      .catch(() => (fromCourseName = null))
  })
  const back = $derived.by(() => {
    if (from === 'courses') return { href: '/admin/courses', text: tr('admin.page.backToCourses') }
    if (!fromCourse) return { href: '/admin', text: tr('admin.page.backToClasses') }
    const name = info?.course?.id === fromCourse ? info.course.name : fromCourseName
    return {
      href: `/admin/courses/${fromCourse}`,
      text: name ? tr('admin.page.backToCourse', { name }) : tr('admin.page.backToCourseBare'),
    }
  })

  /** «04 · Лики и хаки данных · вс, 4 окт · МЛ | сильная группа». */
  const meta = $derived.by(() => {
    const course = info?.course
    if (!course) return null
    const row = course.row
    return [
      row.n !== null ? `${twoDigits(row.n)} · ${row.title}` : row.title,
      row.day ? formatDay(row.day, getLocale()) : null,
      course.name,
    ]
      .filter(Boolean)
      .join(' · ')
  })

  /* --------------------------------------------------------------- the pick */

  const pickedBooks = $derived(books.filter((b) => b.picked))
  const pickedFiles = $derived(files.filter((f) => f.picked))
  /*
   * Root files first, the room's top-level folders after them: the page
   * orders them the same way (shared/materials.ts · materialRank), and a
   * folder row is a different shape — a count and a «состав папки» under it
   * rather than a name field. Both are the same `files` objects, so a tick
   * here is a tick in what gets published.
   */
  const rootFiles = $derived(files.filter((f) => f.kind !== 'folder'))
  const folders = $derived(files.filter((f) => f.kind === 'folder'))
  /** Folders whose «состав папки» is open. */
  let opened = $state<string[]>([])
  const toggleFolder = (path: string): void => {
    opened = opened.includes(path) ? opened.filter((p) => p !== path) : [...opened, path]
  }
  /**
   * A file in «состав папки» ticked or unticked. Ticking one in an unticked
   * folder ticks the folder (that is what the teacher means), and a folder
   * left with nothing ticked in it is unticked: it would go out empty.
   */
  function pickEntry(folder: FileChoice, entry: FolderEntry, on: boolean): void {
    entry.picked = on
    if (on) folder.picked = true
    else if (!(folder.entries ?? []).some((e) => e.picked)) folder.picked = false
  }
  const fileLimit = $derived(info?.limits.fileBytes ?? Infinity)
  const checks = $derived(
    info
      ? relevantChecks(
          info.checks,
          new Set(pickedBooks.map((b) => b.root)),
          goingPaths(files),
        )
      : [],
  )
  const unconfirmed = $derived(checks.filter((check) => !acked.includes(check.id)))
  const blocked = $derived(
    info
      ? publishBlocked({
          picked: pickedBooks.length + pickedFiles.length,
          limit: info.limits.materials,
          unconfirmed: unconfirmed.length,
        })
      : 'nothing',
  )

  /**
   * What the page will weigh, as far as the panel can know before building:
   * the ticked files, plus each notebook's size on the page as it stands. A
   * notebook never published has no size yet and is not guessed at.
   */
  const pageBytes = $derived.by(() => {
    const onPage = new Map(already?.materials.map((m) => [m.path, m.bytes]) ?? [])
    let sum = 0
    for (const file of pickedFiles) sum += pickedBytes(file)
    for (const book of pickedBooks) sum += onPage.get(book.path) ?? 0
    return sum
  })
  const budget = $derived(info?.limits.pageBytes ?? 1)

  function move(index: number, by: -1 | 1): void {
    const to = index + by
    if (to < 0 || to >= books.length) return
    const next = [...books]
    ;[next[index], next[to]] = [next[to], next[index]]
    books = next
  }

  /** «Проверил(а)»: confirms exactly the findings on screen, and unticking takes them back. */
  function confirmChecks(on: boolean): void {
    const ids = checks.map((check) => check.id)
    acked = on ? [...new Set([...acked, ...ids])] : acked.filter((id) => !ids.includes(id))
  }

  async function publish(): Promise<void> {
    const current = info
    if (!current || blocked || building) return
    building = true
    errorText = null
    refused = []
    const known = new Set(current.checks.map((check) => check.id))
    try {
      const result = await adminApi.publish(sessionId, {
        notebooks: pickedBooks.map((b) => ({
          root: b.root,
          name: b.name.trim() || suggested.get(b.root) || '',
        })),
        files: pickedFiles.map((f) => ({
          ...(f.kind === 'folder' ? folderRequest(f, '') : {}),
          path: f.path,
          name: f.name.trim() || suggested.get(f.path) || '',
        })),
        autoRefresh,
        ack: acked.filter((id) => known.has(id)),
        roomAccess,
        ...(current.course === null && heldOn ? { heldOn } : {}),
      })
      already = result.page
      refused = result.refused
      done = true
      hasPick = true
      slug = result.page.slug ?? ''
      slugDraft = slug
      former = result.page.former
      // Everything on screen is now part of the saved pick: nothing is «новая» any more.
      books = books.map((b) => ({ ...b, isNew: false }))
      files = files.map((f) => ({ ...f, isNew: false }))
    } catch (cause) {
      const refusal = publishRefusal(cause)
      if (refusal?.kind === 'unconfirmed') {
        // The room changed since the screen was read: the new findings join
        // the list, and the box is unticked by their arrival.
        const seen = new Set(current.checks.map((check) => check.id))
        current.checks = [...current.checks, ...refusal.checks.filter((c) => !seen.has(c.id))]
        errorText = () => tr('admin.page.unconfirmed')
      } else {
        errorText = () => explain(cause, tr('admin.page.publishFailed'))
      }
    } finally {
      building = false
    }
  }

  const address = $derived(already ? (already.slug ?? already.id) : null)
  const link = $derived(address ? `${location.origin}/p/${address}` : null)

  async function copyLink(): Promise<void> {
    if (!link) return
    try {
      await copyText(link)
    } catch {
      errorText = () => tr('admin.could.not.copy.the.link.copy.it.manually', { p0: link })
      return
    }
    copied = true
    setTimeout(() => (copied = false), 1600)
  }

  /* ---------------------------------------------------------- the room door */

  /** The segment labels, spelled out so every key is visible to the catalog tools. */
  function accessLabel(access: RoomAccess): string {
    if (access === 'anyone') return tr('admin.page.roomAccess.anyone')
    if (access === 'none') return tr('admin.page.roomAccess.none')
    return tr('admin.page.roomAccess.members')
  }

  /**
   * Pick who the page leads into the room. With a saved pick it is saved at
   * once and alone (PATCH, no rebuild: the materials and the page's revision
   * stay as they are); otherwise it waits for «Опубликовать». A refusal puts
   * the previous choice back, so the control never shows what the server
   * did not keep.
   */
  async function chooseAccess(next: RoomAccess): Promise<void> {
    if (next === roomAccess || savingAccess) return
    const was = roomAccess
    roomAccess = next
    const page = already
    if (!page || !hasPick) return
    savingAccess = true
    errorText = null
    try {
      await adminApi.setRoomAccess(page.id, next)
    } catch (cause) {
      roomAccess = was
      errorText = () => explain(cause, tr('admin.page.roomAccessFailed'))
    } finally {
      savingAccess = false
    }
  }

  /* ------------------------------------------- a page whose room is gone */

  async function takeOff(key: string, name: string): Promise<void> {
    const page = already
    if (!page || busy) return
    if (!window.confirm(tr('admin.page.removeConfirm', { name }))) return
    busy = true
    errorText = null
    try {
      already = (await adminApi.removeMaterial(page.id, key)).page
    } catch (cause) {
      errorText = () => explain(cause, tr('admin.could.not.complete.the.request.try.again'))
    } finally {
      busy = false
    }
  }

  async function restore(): Promise<void> {
    const page = already
    if (!page || busy) return
    busy = true
    errorText = null
    try {
      await adminApi.restorePublication(page.id)
      already = { ...page, state: 'published' }
    } catch (cause) {
      errorText = () => explain(cause, tr('admin.could.not.complete.the.request.try.again'))
    } finally {
      busy = false
    }
  }

  /* ------------------------------------------------------------ the address */

  /** The name in the address; editable whenever there is a page, with no rebuild. */
  let slug = $state('')
  let slugDraft = $state('')

  /**
   * Names this page has already lived under.
   *
   * The server remembers a former name: `setPublicationSlug` puts it into
   * `publish_addresses`, and `findPublication` finds the page by it
   * (server/src/publish/store.ts · moveAddress, findPublication). The list
   * comes with the page and is extended by renames made here: a screen opened
   * a year later knows exactly what the server knows — otherwise there would
   * be nothing in it to release.
   */
  let former = $state<string[]>([])

  /** The page whose former names these are: their owner releases them, and here is its id. */
  const pageId = $derived(already?.id ?? null)

  /**
   * The name that was refused, and who holds it.
   *
   * An "already taken" refusal comes in two quite different kinds. Another
   * page's live address is a dead end: only its owner can free it. But a
   * former name, kept for the sake of a link that was handed out, can be
   * released — and whoever it belongs to has the right to release it
   * (server/src/publish/store.ts · releaseFormerSlug). While the server does
   * not name the holder, this stays null and the screen behaves as before:
   * it repeats the refusal phrase and offers nothing.
   */
  let held = $state<{ slug: string; holder: AddressHolder } | null>(null)
  /** Step two: releasing a former address is irreversible, so it is asked aloud. */
  let asking = $state(false)

  async function saveSlug(): Promise<void> {
    const id = pageId
    if (!id || busy) return
    const next = slugDraft.trim().toLowerCase()
    if (next && !slugOk(next)) {
      errorText = () => tr('admin.address.3.64.lowercase.latin.letters.digits.or.dashes.start.and.e')
      return
    }
    busy = true
    errorText = null
    held = null
    try {
      await adminApi.setSlug('publication', id, next || null)
      // The former name stays an address, and the new one stops being
      // anyone's former name — in the same move as on the server.
      const was = slug
      slug = next
      former = [...new Set([...former, was].filter((name) => name && name !== next))]
      if (already) already = { ...already, slug: next || null }
    } catch (cause) {
      errorText = () => explain(cause, tr('admin.could.not.save.the.address.try.again'))
      const holder = addressHolderOf(cause)
      // Only a former one: a live address is not released from here; a
      // rename takes it down.
      if (holder?.former && next) held = { slug: next, holder }
    } finally {
      busy = false
    }
  }

  /**
   * Release a former address and take it — as one decision.
   *
   * One, because it is released precisely to give that name to your own
   * page: two presses in a row would leave a "the name belongs to nobody"
   * state in between, in which anyone else could take it.
   */
  async function release(): Promise<void> {
    if (!held || busy) return
    const { holder, slug: freed } = held
    busy = true
    errorText = null
    try {
      await adminApi.releaseFormerSlug(holder.kind, holder.id, freed)
    } catch (cause) {
      errorText = () => explain(cause, tr('admin.could.not.release.the.previous.address.try.again'))
      return
    } finally {
      busy = false
    }
    held = null
    asking = false
    slugDraft = freed
    await saveSlug()
  }

  /**
   * Release your own former name.
   *
   * A different action from the one above, although the route is the same:
   * there the name is taken for yourself, here it is simply released. The
   * only thing that will happen for sure is that the link with this address
   * stops opening, and there is nothing to bring it back with; hence a
   * second step, and the cost is named both at the button and in the
   * question.
   */
  let dropping = $state<string | null>(null)

  async function dropFormer(): Promise<void> {
    const page = pageId
    const name = dropping
    if (!page || !name || busy) return
    busy = true
    errorText = null
    try {
      await adminApi.releaseFormerSlug('publication', page, name)
    } catch (cause) {
      errorText = () => explain(cause, tr('admin.could.not.release.the.previous.address.try.again'))
      return
    } finally {
      busy = false
    }
    former = former.filter((was) => was !== name)
    dropping = null
  }

  /** Escape closes the question — but not in the middle of a server response. */
  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || busy) return
    if (asking) asking = false
    else if (dropping) dropping = null
  }

  function refusedText(item: { path: string; reason: RefusedReason }): string {
    // A folder is refused whole ('data/'): gone, or nothing in it may go out.
    const folder = item.path.endsWith('/')
    if (item.reason === 'missing') {
      return tr(folder ? 'admin.page.refused.folderMissing' : 'admin.page.refused.missing', {
        path: item.path,
      })
    }
    if (item.reason === 'too-large') return tr('admin.page.refused.tooLarge', { path: item.path })
    if (item.reason === 'too-many') {
      return tr('admin.page.refused.tooMany', { path: item.path, count: MAX_FOLDER_FILES })
    }
    return tr('admin.page.refused.budget', { path: item.path })
  }

  const blockedText = $derived(
    blocked === 'nothing'
      ? tr('admin.page.nothing')
      : blocked === 'too-many'
        ? tr('admin.page.tooMany', { count: info?.limits.materials ?? 0 })
        : blocked === 'unconfirmed'
          ? tr('admin.page.confirmFirst')
          : null,
  )

  const YES = 'M2.5 7.2L5.6 10.2L11.5 3.8'
  const NO = 'M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5'
  /*
   * The panel's shared vocabulary (index.css · the teacher's panel): one row,
   * one section head and one icon button for this screen, the course table
   * and the competition screens alike. Only the picker's own geometry lives
   * here — the `pick-row` hooks the container query below reads.
   */
  const ROW = 'pick-row admin-list-row gap-y-2'
  /* A folder row grows downwards (its reason, «состав папки»): the tick stays on the first line. */
  const FOLDER_ROW = 'pick-row admin-list-row items-start gap-y-2'
  /* The reorder arrows keep their frame: two bare chevrons side by side read
     as decoration, not as two buttons. */
  const ARROW = 'admin-icon-btn border border-line'
</script>

<svelte:window onkeydown={onKey} />

<!--
  The page's former addresses — as a list, and something can be done with
  them.

  Renaming does not cancel a link that has been handed out: the old name stays
  this page's address forever — and holds it against everyone else too, so
  next year's page can no longer be given that name. The owner releases them,
  one at a time, and the cost is named right above the button, not only in
  the question after it: the link written in last year's group chat stops
  opening.
-->
{#snippet formerNames()}
  {#if former.length > 0}
    <div class="border-t border-line pt-3">
      <p class="admin-label">{tr("admin.previous.addresses")}</p>
      <p class="admin-meta mt-0.5">
        {tr("admin.these.links.open.the.current.publication.releasing.an.address.sto")}
      </p>
      <div class="mt-2 flex flex-col">
        {#each former as name (name)}
          <div class="flex items-center gap-3 border-b border-line-soft py-1.5 last:border-b-0">
            <span class="min-w-0 flex-1 truncate font-mono text-2xs text-ink">/p/{name}</span>
            <button
              type="button"
              class="btn-outline shrink-0"
              disabled={busy}
              onclick={() => (dropping = name)}
            >
              {tr("admin.release")}
            </button>
          </div>
        {/each}
      </div>
    </div>
  {/if}
{/snippet}

{#snippet sectionHead(label: string, note: string | null, count: string | null, warn: boolean)}
  <div class="admin-section">
    <h2 class="admin-section-title">{label}</h2>
    {#if note}<span class="text-2xs text-muted">{note}</span>{/if}
    {#if count}
      <span class="ml-auto shrink-0 font-mono text-micro {warn ? 'text-warning' : 'text-muted'}">{count}</span>
    {/if}
  </div>
{/snippet}

<AdminPage title={tr('admin.page.title')}>
  {#snippet eyebrow()}
    <!-- The eyebrow's own voice, as on every screen with one: AdminPage sizes
         and colours it; min-w-0 lets a long course name wrap, not overflow. -->
    <a
      class="min-w-0 transition-colors duration-quick hover:text-ink"
      href={back.href}
      onclick={(event) => {
        event.preventDefault()
        navigate(back.href)
      }}
    >
      {back.text}
    </a>
  {/snippet}
  {#snippet lede()}
    {#if info?.course}
      <span class="text-ui text-muted">{meta}</span>
      <!-- The row editor of the course, not a copy of it here: the title, the
           day and the «о чём» belong to the course row, and two places to
           edit them would be two truths. -->
      <a
        class="admin-link"
        href={`/admin/courses/${info.course.id}?edit=${info.course.row.id}`}
        onclick={(event) => {
          event.preventDefault()
          if (info?.course) navigate(`/admin/courses/${info.course.id}?edit=${info.course.row.id}`)
        }}
      >
        {tr('admin.page.editInCourse')}
      </a>
    {:else if info}
      <!-- Outside a course there is no row to carry the day: the page keeps
           its own (held_on), defaulting to the day the class was finished. -->
      <label class="flex items-center gap-3 text-ui text-muted">
        {tr('admin.page.heldOn')}
        <input
          type="date"
          class="field w-auto font-mono"
          bind:value={heldOn}
          disabled={!info.room.exists}
        />
      </label>
    {:else}
      <span class="text-ui text-muted">&nbsp;</span>
    {/if}
  {/snippet}

  <div class="flex flex-col gap-x-12 gap-y-10 pt-9 xl:flex-row xl:items-start">
    <!-- The main column: what is on the page. -->
    <div class="pick-list flex min-w-0 flex-1 flex-col gap-11 xl:max-w-[760px]">
      {#if loadError}
        <p class="text-ui text-danger" role="alert">{loadError}</p>
      {:else if !info}
        <p class="text-ui text-muted">{tr('admin.page.loading')}</p>
      {:else if !info.room.exists}
        <!--
          The room is gone, the page stayed: nothing new can be picked, but
          what is on the page can still be taken off — a student's file that
          should not have gone out is exactly why someone opens this.
        -->
        <section class="flex flex-col">
          {@render sectionHead(tr('admin.page.current'), null, String(already?.materials.length ?? 0), false)}
          <p class="border-b border-line py-3.5 text-2xs text-muted">{tr('admin.page.roomGone')}</p>
          {#each already?.materials ?? [] as material (material.key)}
            <div class={ROW}>
              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-ui text-ink">{material.name}</span>
                <span class="admin-meta">
                  {#if material.kind === 'folder'}
                    <!-- A folder: its name is its path ('data/'), and what counts is how much went out in it. -->
                    {kindText(material.kind, material.path)} · {folderMeta(material)}
                  {:else}
                    <span class="font-mono">{material.path}</span> · {kindText(material.kind, material.path)} · {sizeText(material.bytes)}
                  {/if}
                </span>
              </div>
              <button
                type="button"
                class="btn-outline shrink-0"
                disabled={busy || (already?.materials.length ?? 0) <= 1}
                onclick={() => void takeOff(material.key, material.name)}
              >
                {tr('admin.page.remove')}
              </button>
            </div>
          {/each}
        </section>
      {:else}
        <!-- Notebooks: each one a tab on the page, with its run results. -->
        <section class="flex flex-col">
          {@render sectionHead(
            tr('admin.page.notebooks'),
            tr('admin.page.notebooksNote'),
            books.length > 0 ? tr('admin.page.pickedOf', { picked: pickedBooks.length, total: books.length }) : null,
            false,
          )}
          {#if books.length === 0}
            <p class="border-b border-line py-3.5 text-2xs text-muted">{tr('admin.page.noNotebooks')}</p>
          {/if}
          {#each books as book, index (book.root)}
            {@const reason = notebookReason(book)}
            <div class={ROW}>
              <span class="flex w-6 shrink-0 items-center">
                <Check
                  bind:checked={book.picked}
                  disabled={lockedNotebook(book)}
                  label={tr('admin.page.pickThis', { path: book.path })}
                />
              </span>
              <div class="pick-name w-[220px] shrink-0">
                {#if book.picked}
                  <input
                    class="field"
                    placeholder={tr('admin.page.tabName')}
                    aria-label={tr('admin.page.tabName')}
                    maxlength={MAX_MATERIAL_NAME}
                    bind:value={book.name}
                  />
                {:else}
                  <!-- The lane stays: an unticked row keeps the column where
                       the name will be, so the paths line up down the list.
                       Drawn as the field itself, so it is the field's height. -->
                  <div class="field flex h-10 items-center bg-canvas text-faint max-[640px]:h-11" aria-hidden="true">
                    {tr('admin.page.tabName')}
                  </div>
                {/if}
              </div>
              <div class="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span class="min-w-0 break-all font-mono text-2xs {book.picked ? 'text-ink' : 'text-muted'}">{book.path}</span>
                  {#if book.isNew}
                    <Badge word={tr('admin.page.new')} tone="accent" form="outline" case="lower" />
                  {/if}
                </span>
                <span class="admin-meta">{notebookMeta(book)}</span>
              </div>
              <div class="pick-side flex w-[200px] shrink-0 justify-end gap-1">
                {#if book.picked}
                  <button
                    type="button"
                    class={ARROW}
                    disabled={index === 0}
                    aria-label={tr('admin.move.up')}
                    onclick={() => move(index, -1)}
                  >
                    <Icon name="chevron-up" size={15} />
                  </button>
                  <button
                    type="button"
                    class={ARROW}
                    disabled={index === books.length - 1}
                    aria-label={tr('admin.move.down')}
                    onclick={() => move(index, 1)}
                  >
                    <Icon name="chevron-down" size={15} />
                  </button>
                {:else if reason}
                  <span class="admin-meta text-right">{reason}</span>
                {/if}
              </div>
            </div>
          {/each}
        </section>

        <!-- Files: the room's folder minus notebooks, at the paths the code reads them by. -->
        <section class="flex flex-col">
          {@render sectionHead(
            tr('admin.page.files'),
            null,
            files.length > 0 ? tr('admin.page.pickedOf', { picked: pickedFiles.length, total: files.length }) : null,
            false,
          )}
          {#if files.length === 0}
            <p class="border-b border-line py-3.5 text-2xs text-muted">{tr('admin.page.noFiles')}</p>
          {/if}
          {#each rootFiles as file (file.path)}
            {@const reason = fileReason(file, fileLimit)}
            {@const named = file.kind === 'pdf' || file.kind === 'notebook'}
            <div class={ROW}>
              <span class="flex w-6 shrink-0 items-center">
                <Check
                  bind:checked={file.picked}
                  disabled={lockedFile(file, fileLimit)}
                  label={tr('admin.page.pickThis', { path: file.path })}
                />
              </span>
              <div class="pick-name w-[220px] shrink-0 {named && file.picked ? '' : 'pick-spacer'}">
                {#if named && file.picked}
                  <input
                    class="field"
                    placeholder={tr('admin.page.fileName')}
                    aria-label={tr('admin.page.fileName')}
                    maxlength={MAX_MATERIAL_NAME}
                    bind:value={file.name}
                  />
                {/if}
              </div>
              <div class="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span class="min-w-0 break-all font-mono text-2xs {file.picked ? 'text-ink' : 'text-muted'}">{file.path}</span>
                  {#if file.isNew}
                    <Badge word={tr('admin.page.new')} tone="accent" form="outline" case="lower" />
                  {/if}
                </span>
                <span class="admin-meta">{kindText(file.kind, file.path)} · {sizeText(file.bytes)}</span>
              </div>
              <div class="pick-side flex w-[200px] shrink-0 justify-end">
                {#if reason}
                  <span class="admin-meta text-right">{reason.text}</span>
                {/if}
              </div>
            </div>
          {/each}

          <!--
            The room's top-level folders, one row each (F1): a class whose
            notebooks import `scripts` and read `data/*.csv` needs both beside
            them, with the paths intact, and fifteen datasets as fifteen rows
            would not fit on the page. The reason sits under the name, not in
            the side lane: «читается в lecture.ipynb и scripts/eda_tools.py» is
            the line the teacher checks, and it is longer than a lane. Inside,
            the same rules as anywhere (shared/materials.ts · folderEntryWhy),
            and «состав папки» shows every file with what stays in the room
            and why — a folder ticked whole must not hide an answer key — and
            lets the teacher overrule the rules file by file.
          -->
          {#each folders as folder (folder.path)}
            {@const reason = folderReason(folder, budget)}
            {@const open = opened.includes(folder.path)}
            {@const entries = folder.entries ?? []}
            <div class={FOLDER_ROW}>
              <span class="flex h-[22px] w-6 shrink-0 items-center">
                <Check
                  bind:checked={folder.picked}
                  disabled={lockedFile(folder, fileLimit)}
                  label={tr('admin.page.pickThis', { path: folder.path })}
                />
              </span>
              <div class="pick-name pick-spacer w-[220px] shrink-0"></div>
              <div class="flex min-w-0 flex-1 flex-col gap-[3px]">
                <!-- The path may break anywhere (a long folder name), the count never
                     does: «1,8 М» on one line and «Б» on the next is not a size. -->
                <span class="flex min-w-0 flex-wrap items-center gap-x-[0.6ch] gap-y-0.5 font-mono text-2xs">
                  <span class="min-w-0 break-all {folder.picked ? 'text-ink' : 'text-muted'}">{folder.path}</span>
                  <span class="whitespace-nowrap text-muted">· {folderMeta(folder, entries)}</span>
                  {#if folder.isNew}
                    <Badge word={tr('admin.page.new')} tone="accent" form="outline" case="lower" />
                  {/if}
                </span>
                {#if reason}
                  <span class="admin-meta">{reason.text}</span>
                {/if}
                {#if entries.length > 0}
                  <button
                    type="button"
                    class="admin-link self-start"
                    aria-expanded={open}
                    onclick={() => toggleFolder(folder.path)}
                  >
                    {tr('admin.page.folder.contents')} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
                  </button>
                {/if}
                {#if open}
                  <!--
                    Every file inside with its own tick, as the rules set it: a
                    file they keep in the room says why, and the teacher may
                    tick it anyway (a `_utils.py` the package imports) or
                    untick one they send. The decision is kept with the page
                    and survives a refresh; a file over the upload limit is
                    locked.
                  -->
                  <ul class="mt-1.5 flex max-h-[300px] flex-col overflow-y-auto border-l-2 border-line pl-3">
                    {#each entries as entry (entry.path)}
                      {@const rule = entryReason(entry, fileLimit)}
                      <li class="flex items-start gap-2.5 py-[3px]">
                        <span class="flex h-5 shrink-0 items-center">
                          <Check
                            size={16}
                            checked={entry.picked}
                            disabled={lockedEntry(entry)}
                            label={tr('admin.page.pickThis', { path: entry.path })}
                            onchange={(on) => pickEntry(folder, entry, on)}
                          />
                        </span>
                        <span class="min-w-0 flex-1 break-all font-mono text-micro {entry.picked ? 'text-ink' : 'text-muted'}">{entryPath(folder, entry)}</span>
                        <span class="admin-meta shrink-0 text-right">{rule ?? sizeText(entry.bytes)}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            </div>
          {/each}
          {#if folders.length > 0}
            <p class="admin-meta py-3.5">{tr('admin.page.folder.note')}</p>
          {/if}
        </section>

        <!--
          The check: only what concerns the ticked materials, and only when
          there is something to say. The box gates the button: a key in a
          cell goes out to everyone with the link, and «публиковать как есть»
          is a decision someone has to make on purpose.
        -->
        {#if info.scrubbed > 0 || checks.length > 0}
          <section class="flex flex-col">
            {@render sectionHead(
              tr('admin.page.check'),
              null,
              checks.length > 0 ? tr('admin.page.warnings', { count: checks.length }) : null,
              true,
            )}
            {#if info.scrubbed > 0}
              <div class="flex items-center gap-4 border-b border-line py-3.5">
                <span class="flex w-6 shrink-0 items-center text-muted"><Icon name="info" size={18} /></span>
                <p class="text-ui text-ink">{tr('admin.page.scrubbed', { count: info.scrubbed })}</p>
              </div>
            {/if}
            {#each checks as check (check.id)}
              <div class="flex flex-wrap items-center gap-2.5 border-b border-l-2 border-b-line border-l-warning py-3 pl-2.5 pr-3">
                <svg class="shrink-0 text-warning" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                  <path d="M9 2.25L16.25 15.25H1.75L9 2.25Z" fill="none" stroke="currentColor" stroke-width="1.5" />
                  <path d="M9 7v4" stroke="currentColor" stroke-width="1.5" />
                  <rect x="8.2" y="12.2" width="1.6" height="1.6" fill="currentColor" />
                </svg>
                <p class="flex min-w-0 flex-1 basis-[220px] flex-wrap items-baseline gap-x-2">
                  <span class="text-ui text-ink">{checkText(check)}</span>
                  {#if check.kind !== 'roomId'}
                    <span class="font-mono text-2xs text-warning">{check.sample}</span>
                  {/if}
                </p>
                {#if check.kind !== 'roomId'}
                  <a
                    class="btn-outline shrink-0"
                    href={`/s/${info.room.id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {tr('admin.page.openInRoom')}
                  </a>
                {/if}
              </div>
            {/each}
            {#if checks.length > 0}
              <label class="flex cursor-pointer items-center gap-4 border-b border-line py-3.5">
                <span class="flex w-6 shrink-0 items-center">
                  <Check
                    checked={unconfirmed.length === 0}
                    onchange={(on) => confirmChecks(on)}
                  />
                </span>
                <span class="text-ui font-semibold text-ink">{tr('admin.page.ack')}</span>
              </label>
            {/if}
          </section>
        {/if}
      {/if}
    </div>

    <!-- The rail: what goes public, how the page lives on, and the button. -->
    <!-- 340, not the artboard's 312: at the panel's scale «ОПУБЛИКОВАТЬ СНОВА»
         and «Отмена» take 337px side by side, and at 1440 the main column
         still keeps its 760. Its sections are headed as the main column's
         are (.admin-section): one voice for a section head on the screen. -->
    <aside class="flex w-full shrink-0 flex-col gap-8 xl:w-[340px]">
      <section class="flex flex-col">
        <div class="admin-section">
          <h2 class="admin-section-title">{tr('admin.page.public')}</h2>
        </div>
        <ul class="flex flex-col gap-2.5 border-b border-line py-3.5">
          {#each [tr('admin.page.public.notebooks'), tr('admin.page.public.files')] as line (line)}
            <li class="flex items-start gap-3">
              <span class="flex h-5 w-[18px] shrink-0 items-center justify-center text-positive">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d={YES} fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" />
                </svg>
              </span>
              <span class="text-2xs text-ink">{line}</span>
            </li>
          {/each}
        </ul>
        <ul class="flex flex-col gap-2.5 border-b border-line py-3.5">
          {#each [tr('admin.page.private.who'), tr('admin.page.private.oracle'), tr('admin.page.private.terminal'), tr('admin.page.private.unticked')] as line (line)}
            <li class="flex items-start gap-3">
              <span class="flex h-5 w-[18px] shrink-0 items-center justify-center text-faint">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d={NO} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" />
                </svg>
              </span>
              <span class="text-2xs text-muted">{line}</span>
            </li>
          {/each}
        </ul>
      </section>

      {#if info?.room.exists}
        <label class="flex cursor-pointer items-start gap-3">
          <span class="flex h-5 w-[18px] shrink-0 items-center">
            <Check bind:checked={autoRefresh} />
          </span>
          <span class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="text-2xs text-ink">{tr('admin.page.autoRefresh')}</span>
            <span class="admin-meta">{tr('admin.page.autoRefreshHint')}</span>
          </span>
        </label>

        <!--
          The room keeps what the page does not: names, marks, the oracle
          thread. Who the page leads there is the teacher's call, and «Все»
          says its cost in the hint right under it.
        -->
        <section class="flex flex-col gap-3">
          <div class="admin-section">
            <h2 id="room-access" class="admin-section-title">
              {tr('admin.page.roomAccess')}
            </h2>
          </div>
          <!-- Drawn as the panel's option chips (admin/ui/Choice.svelte, sm): the
               same 40 px chip as every other set of options in the panel. Not
               Choice itself, because these are radios — one of three, read
               out as a group — where Choice's chips are pressed toggles. -->
          <div class="flex flex-wrap items-center gap-2" role="radiogroup" aria-labelledby="room-access">
            {#each ROOM_ACCESS as option, i (option)}
              {@const on = roomAccess === option}
              <button
                type="button"
                role="radio"
                aria-checked={on}
                class="inline-flex min-h-10 items-center border px-3 py-1.5 text-ui font-medium
                       transition-colors duration-100 disabled:cursor-wait max-[640px]:min-h-11
                       focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/15
                       {on
                  ? 'border-primary bg-primary text-primary-ink'
                  : 'border-line bg-surface text-ink hover:border-faint hover:bg-raised'}"
                disabled={savingAccess}
                onclick={() => void chooseAccess(option)}
              >
                {accessLabel(option)}
              </button>
            {/each}
          </div>
          <p class="admin-meta">{tr('admin.page.roomAccessHint')}</p>
        </section>
      {/if}

      <!--
        The address is dictated out loud and written on the board, so it is
        editable whenever there is a page — not only right after a publish —
        and renaming it rebuilds nothing. The old address keeps working: a
        link that has already been given out must not break.
      -->
      <section class="flex flex-col gap-3">
        <div class="admin-section">
          <h2 class="admin-section-title">{tr('admin.page.address')}</h2>
        </div>
        {#if already}
          <!-- The competition editor's /k/ field, here with /p/ (Editor.svelte · slug). -->
          <div class="admin-affix">
            <span class="shrink-0 font-mono text-2xs text-muted">{location.host}/p/</span>
            <input
              bind:this={addressField}
              placeholder={already.id}
              maxlength={64}
              aria-label={tr('admin.page.address')}
              bind:value={slugDraft}
              onkeydown={(event) => {
                if (event.key === 'Enter') void saveSlug()
              }}
            />
          </div>
          {#if slugDraft.trim() !== slug || held}
            <div class="flex flex-wrap items-center gap-2">
              {#if slugDraft.trim() !== slug}
                <button
                  type="button"
                  class="btn-primary"
                  disabled={busy}
                  onclick={() => void saveSlug()}
                >
                  {slug ? tr('admin.change.address') : tr('admin.set.address')}
                </button>
              {/if}
              <!-- The name is held not by a live page but by the memory of a
                   link that was handed out — and that is the only kind of
                   "taken" the owner can resolve themselves. -->
              {#if held}
                <button
                  type="button"
                  class="btn-outline"
                  disabled={busy}
                  onclick={() => (asking = true)}
                >
                  {tr('admin.release.previous.address')}
                </button>
              {/if}
            </div>
          {/if}
          {#if held}
            <p class="admin-meta">
              <span class="font-mono text-ink">/p/{held.slug}</span> {tr("admin.the.previous.address.of.the.page")}
              {#if held.holder.name}«{held.holder.name}»{/if}{tr("admin.after.transfer.this.link.will.open.the.current.publication.instea")}
            </p>
          {/if}
          {#if slug}
            <p class="admin-meta">{tr("admin.the.old.address.p")}{already.id} {tr("admin.also.works")}</p>
          {/if}
          {@render formerNames()}
        {:else}
          <div class="admin-affix">
            <span class="font-mono text-2xs text-muted">{location.host}/p/…</span>
          </div>
          <p class="admin-meta">{tr('admin.page.addressLater')}</p>
        {/if}
      </section>

      {#if already?.state === 'withdrawn'}
        <div class="flex flex-col gap-2 border-l-2 border-warning bg-surface px-3 py-2.5">
          <p class="text-ui text-ink">{tr('admin.page.withdrawn')}</p>
          <button type="button" class="btn-outline self-start" disabled={busy} onclick={() => void restore()}>
            {tr('admin.put.the.page.back')}
          </button>
        </div>
      {/if}

      <div class="flex flex-col gap-4 border-t border-line pt-6">
        {#if info?.room.exists}
          <div class="flex flex-col gap-2">
            <p class="text-ui {pageBytes > budget ? 'text-danger' : 'text-ink'}">
              {tr('admin.page.size', { size: sizeText(pageBytes), limit: sizeText(budget) })}
            </p>
            <div class="flex h-1 bg-line" aria-hidden="true">
              <div class="h-1 {pageBytes > budget ? 'bg-danger' : 'bg-ink'}" style="width: {Math.min(100, (pageBytes / budget) * 100)}%"></div>
            </div>
          </div>
        {/if}

        {#if error}
          <p class="text-ui text-danger" role="alert">{error}</p>
        {/if}

        {#if done && link}
          <!-- The result: the address the class will be given, ready to copy. -->
          <div class="flex flex-col gap-2 border-l-2 border-positive bg-surface px-3 py-2.5">
            <p class="text-ui text-ink">{tr('admin.page.ready')}</p>
            <a class="block break-all font-mono text-2xs text-accent-text" href={link} target="_blank" rel="noreferrer">
              {location.host}/p/{address}
            </a>
            <div class="flex flex-wrap gap-2">
              <button type="button" class="btn-outline" onclick={() => void copyLink()}>
                {copied ? tr('admin.copied') : tr('admin.copy.link')}
              </button>
              <a class="btn-outline" href={link} target="_blank" rel="noreferrer">
                {tr('admin.open')}
              </a>
            </div>
            {#if refused.length > 0}
              <div class="border-t border-line pt-2">
                <p class="admin-label text-warning">{tr('admin.page.refused')}</p>
                <ul class="mt-1 flex flex-col gap-0.5">
                  {#each refused as item (item.path)}
                    <li class="admin-meta break-all">{refusedText(item)}</li>
                  {/each}
                </ul>
              </div>
            {/if}
          </div>
        {/if}

        {#if info?.room.exists}
          {#if blockedText && !building}
            <p class="admin-meta">{blockedText}</p>
          {/if}
          <!-- One line in the rail; on a phone «Отмена» drops under the button
               rather than breaking the button's words in two. -->
          <div class="flex flex-wrap gap-2">
            <!-- The competitions' primary action (Editor.svelte · «Открыть соревнование»),
                 at the panel's control height: 40, 44 on a phone. -->
            <button
              type="button"
              class="btn-primary btn-caps grow gap-2 whitespace-nowrap px-4"
              disabled={blocked !== null || building}
              onclick={() => void publish()}
            >
              {#if building}
                <Icon name="spinner" size={14} class="animate-spin" />
                {tr('admin.page.building')}
              {:else}
                <!-- On a withdrawn page this makes it public again, so it says so. -->
                {already?.state === 'withdrawn'
                  ? tr('admin.page.publishAgain')
                  : already
                    ? tr('admin.page.update')
                    : tr('admin.page.publish')}
              {/if}
            </button>
            <!-- «Отмена» beside the commit is the editor's ghost (Editor.svelte · actions). -->
            <button
              type="button"
              class="btn-ghost px-3 max-[640px]:grow"
              onclick={() => navigate(back.href)}
            >
              {done ? tr('admin.close') : tr('admin.cancel')}
            </button>
          </div>
        {:else if info}
          <button
            type="button"
            class="btn-outline"
            onclick={() => navigate(back.href)}
          >
            {tr('admin.close')}
          </button>
        {/if}
      </div>
    </aside>
  </div>
</AdminPage>

<!--
  Releasing a former address — with a question, not a single press.

  The only irreversible action on this screen: a link already dictated to the
  class answers 404 after this, and there is nothing to bring it back with.
  Hence a second step — and the cost in it is named by the same address that
  sits in the group chat, not by the words "related data".
-->
{#if asking && held}
  {@const going = held}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="release-slug-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="release-slug-title" class="text-title font-semibold text-ink">
        {tr('admin.publication.releaseHeading', { address: going.slug })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr("admin.it.currently.leads.to.the.page")}
        {#if going.holder.name}«{going.holder.name}»{/if}{tr("admin.after.transfer.this.link.will.open.the.current.publication.instea")}
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (asking = false)}>
          {tr("admin.cancel")}
        </button>
        <button
          type="button"
          class="btn-danger-solid"
          disabled={busy}
          onclick={() => void release()}
        >
          {busy ? tr("admin.transferring") : tr("admin.transfer.address")}
        </button>
      </div>
    </div>
  </div>
{/if}

<!--
  Releasing your own former name — the same question, but nobody is waiting
  for the name.

  Here it is released not in order to take it: it is freed for everyone, and
  the only thing that will happen for sure is that the link with it stops
  opening. Hence different words, and a different verb on the button.
-->
{#if dropping}
  {@const going = dropping}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="drop-slug-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="drop-slug-title" class="text-title font-semibold text-ink">
        {tr('admin.publication.releaseHeading', { address: going })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr("admin.this.link.will.stop.opening.the.current.publication.another.publi")}
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (dropping = null)}>
          {tr("admin.cancel")}
        </button>
        <button
          type="button"
          class="btn-danger-solid"
          disabled={busy}
          onclick={() => void dropFormer()}
        >
          {busy ? tr("admin.releasing") : tr("admin.release.address")}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /*
   * The picker rows on a narrow column: the name field drops under the path
   * and the reason under the meta, both indented past the tick.
   *
   * By the width of the list itself (a container), not the window: the
   * panel's menu takes 236px from md up, so a 768 window leaves the list less
   * room than a 640 one with the narrow menu. 600px is the tick, the 220px
   * name field, the 200px side lane and a path that is still readable.
   */
  .pick-list {
    container-type: inline-size;
  }

  @container (max-width: 600px) {
    .pick-row {
      flex-wrap: wrap;
    }

    .pick-name {
      order: 9;
      width: 100%;
      padding-left: 40px;
    }

    .pick-spacer {
      display: none;
    }

    .pick-side {
      width: auto;
    }

    .pick-side:has(> span) {
      order: 10;
      width: 100%;
      padding-left: 40px;
      justify-content: flex-start;
    }

    .pick-side span {
      text-align: left;
    }
  }
</style>
