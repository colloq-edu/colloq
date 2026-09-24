<script lang="ts">
  import RowsSkeleton from '@/components/ui/RowsSkeleton.svelte'
  import { tr, getLocale } from '@shared/i18n'
  import { onMount } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { people, ruleRefusal, runningLine } from '@/admin/panel'
  import { seminarLink } from '@/lib/seminar-link'
  import { cn } from '@/lib/utils'
  import {
    LIMITS,
    type AdminEnvironment,
    type AdminSeminar,
    type ImportPreview,
    type InstanceResources,
  } from '@shared/admin'
  import { copyText } from '@/lib/clipboard'
  import { plural } from '@/lib/plural'
  import RoomRulesRows from '@/components/RoomRulesRows.svelte'
  import Resources from '@/admin/ui/Resources.svelte'
  import type { RoomRules } from '@shared/rules'

  /**
   * The seminar list, and the one thing a teacher comes here to do: get the
   * link. It is on every row as a button, it is on the running banner, and it
   * is focused the moment a seminar is created — because the alternative is
   * opening a room to find its address, which is how a class starts late.
   */

  let seminars = $state<AdminSeminar[]>([])
  let loading = $state(true)
  let loadErrorText = $state<(() => string | null) | null>(null)
  const loadError = $derived(loadErrorText?.() ?? null)
  let query = $state('')
  /** Ticks with the poll below so "started 12 min ago" does not freeze at 12. */
  let now = $state(Date.now())

  interface Props {
    /** Hands over to the full New seminar screen; absent keeps the inline row. */
    onfull?: () => void
    /**
     * A seminar made on the other screen, so this one can put the room at the
     * top and the cursor on its Copy button — the same landing the inline form
     * has always given.
     */
    arrived?: string | null
    /**
     * The landing has happened — it can be forgotten.
     *
     * Without this `arrived` lives until the page is reloaded: coming back to
     * the seminars tab a month later cleared the search again and highlighted
     * that room as just created.
     */
    onarrived?: () => void
    /** Leads to the publishing screen: a decision, not a menu item with an effect. */
    onpublish?: (sessionId: string) => void
  }

  let { onfull, arrived = null, onarrived, onpublish }: Props = $props()

  /**
   * Withdraw or restore the public page.
   *
   * A withdrawn page answers "the teacher withdrew it", not 404: the link
   * cannot be recalled from the students, and running into an error where
   * yesterday there was a seminar is the worse of the two.
   */
  async function withdraw(seminar: AdminSeminar, hide: boolean): Promise<void> {
    try {
      if (hide) await adminApi.withdraw(seminar.id)
      else await adminApi.republish(seminar.id)
      // Re-read the list: the row's publication state has changed.
      local(await adminApi.listSeminars())
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      rowError = { id: seminar.id, message: () => (tr("admin.could.not.update.the.publication", { p0: explain(cause) })) }
    }
  }

  /** The address read out loud: the name if one was given, otherwise the id. */
  const addressOf = (item: { id: string; slug: string | null }): string => item.slug ?? item.id

  async function copyPublished(seminar: AdminSeminar): Promise<void> {
    if (!seminar.publication) return
    const link = `${location.origin}/p/${addressOf(seminar.publication)}`
    try {
      await copyText(link)
    } catch {
      // As with the room link: the clipboard is closed on an insecure origin
      // — the usual way to run a department's instance. The link is the
      // whole point of the press, so it goes to the screen, not into an
      // unhandled promise.
      rowError = { id: seminar.id, message: () => (tr("admin.could.not.copy.the.link.copy.it.manually", { p0: link })) }
      return
    }
    if (rowError?.id === seminar.id) rowError = null
    copiedId = seminar.id
    setTimeout(() => (copiedId = copiedId === seminar.id ? null : copiedId), 1600)
  }

  /*
   * Coming back from the New seminar screen. The list is reloaded rather than
   * patched by hand: the two creation paths return different shapes — a blank
   * seminar and an import — and reloading is the one branch that is right for
   * both. Any filter is cleared first, because a filter that hides the room you
   * just made sends the teacher hunting for a seminar they are looking at.
   */
  $effect(() => {
    if (!arrived) return
    query = ''
    justCreatedId = arrived
    void load()
    onarrived?.()
  })

  let creating = $state(false)
  /**
   * Environments for the dropdown. Loaded once and only when the form opens:
   * the seminar list screen does not need them, and the request goes to
   * docker and costs noticeably more than reading the table.
   */
  let environments = $state<AdminEnvironment[] | null>(null)
  let newEnvironment = $state('')

  /*
   * Import from GitHub. A teacher's material almost never lives in this
   * product — it lives in the course repository, a notebook per week, with
   * the csv that notebook reads lying next to it. Asking to move everything
   * by hand means asking people not to use the tool.
   *
   * The preview is a separate step on purpose: "a hundred and ten cells and
   * train.csv" has to be seen BEFORE the room appears, not after.
   */
  let fromGithub = $state(false)
  let githubUrl = $state('')
  let preview = $state<ImportPreview | null>(null)
  let previewing = $state(false)
  let previewErrorText = $state<(() => string | null) | null>(null)
  const previewError = $derived(previewErrorText?.() ?? null)

  let previewTimer: number | undefined
  $effect(() => {
    const url = githubUrl.trim()
    window.clearTimeout(previewTimer)
    preview = null
    previewErrorText = null
    if (!fromGithub || url.length < 20) return
    // A pause, not a request per keystroke: the link is pasted whole, but it
    // also gets finished by hand, and every request goes out to GitHub.
    previewTimer = window.setTimeout(() => {
      previewing = true
      void adminApi
        .previewImport(url)
        .then((p) => {
          preview = p
          if (!newName.trim()) newName = p.name
        })
        .catch((cause) => (previewErrorText = () => (explain(cause))))
        .finally(() => (previewing = false))
    }, 500)
    return () => window.clearTimeout(previewTimer)
  })

  async function importFromGithub(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const url = githubUrl.trim()
    if (!url || createBusy || !preview) return
    createBusy = true
    createErrorText = null
    try {
      const done = await adminApi.importSeminar({
        url,
        name: newName.trim() || undefined,
        environment: newEnvironment || null,
      })
      local(await adminApi.listSeminars())
      query = ''
      justCreatedId = done.id
      creating = false
      fromGithub = false
      githubUrl = ''
      newName = ''
      newEnvironment = ''
      preview = null
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      createErrorText = () => (explain(cause))
    } finally {
      createBusy = false
    }
  }
  let newName = $state('')
  let createBusy = $state(false)
  let createErrorText = $state<(() => string | null) | null>(null)
  const createError = $derived(createErrorText?.() ?? null)
  let nameInput = $state<HTMLInputElement | null>(null)
  let justCreatedId = $state<string | null>(null)

  let copiedId = $state<string | null>(null)
  let copyTimer: number | undefined

  let renamingId = $state<string | null>(null)
  let renameValue = $state('')

  /** At most one row is ever explaining itself; a second failure replaces the first. */
  let rowError = $state<{ id: string; message: () => string } | null>(null)
  let openMenuId = $state<string | null>(null)
  /**
   * Where to put the open menu, in window coordinates.
   *
   * The menu cannot stay absolute inside the row: the table sits in a
   * container with `overflow-x: auto`, and per the spec an axis declared
   * `visible` next to a non-`visible` one becomes `auto` itself. Measured in
   * this panel — the container reports `overflowY: "auto"`, although the
   * markup says nothing about Y. Because of this the menu is clipped by the
   * table's bottom edge, and the list itself grows its own scrollbar and
   * looks shorter.
   *
   * `position: fixed` from the button's rectangle knows nothing of clipping.
   */
  let menuStyle = $state('')

  function openMenu(seminar: AdminSeminar, button: HTMLElement): void {
    if (openMenuId === seminar.id) {
      openMenuId = null
      menuStyle = ''
      return
    }
    const box = button.getBoundingClientRect()
    // right, not left: the menu aligns to the button's right edge, as before.
    const right = Math.round(window.innerWidth - box.right)
    const below = window.innerHeight - box.bottom - 8
    const above = box.top - 8
    /*
     * Attach to the side with more room, and cap the height by that side too.
     * The menu's height does not need to be known: below we set top, above
     * we set bottom, and in both cases it grows into the free side. Measured
     * on a 560px window: a hard "always down" pushed the menu 191 pixels past
     * the screen edge, from where the "delete" item can no longer be reached.
     */
    /*
     * transform-origin travels here too, not in the .row-menu class: the menu
     * grows out of its button, and which side that is has already been
     * decided two lines above. A separate variable would only repeat this
     * choice and one day diverge from it; when flipped, the anchor becomes
     * the bottom right corner, and the menu unfolds upwards rather than
     * downwards from an invisible point.
     */
    menuStyle =
      below >= above
        ? `top: ${Math.round(box.bottom + 4)}px; right: ${right}px; max-height: ${Math.round(below)}px; transform-origin: top right`
        : `bottom: ${Math.round(window.innerHeight - box.top + 4)}px; right: ${right}px; max-height: ${Math.round(above)}px; transform-origin: bottom right`
    openMenuId = seminar.id
  }

  let doomed = $state<AdminSeminar | null>(null)
  let deleteBusy = $state(false)
  let deleteErrorText = $state<(() => string | null) | null>(null)
  const deleteError = $derived(deleteErrorText?.() ?? null)
  let cancelButton = $state<HTMLButtonElement | null>(null)

  const live = $derived(seminars.filter((s) => s.status === 'live'))
  const needle = $derived(query.trim().toLowerCase())
  /**
   * Archived seminars are off the list until asked for.
   *
   * The button says "To take it off the list… archive it" and the list did not
   * take it off anything: a term of archived rooms sat between this week's,
   * and the word meant nothing. They are still reachable — a checkbox away,
   * with a count, because archiving is a label and not a deletion.
   */
  let showArchived = $state(false)
  const archivedCount = $derived(seminars.filter((s) => s.archivedAt).length)
  const shown = $derived(
    seminars
      .filter((s) => showArchived || !s.archivedAt)
      .filter((s) => (needle ? s.name.toLowerCase().includes(needle) : true)),
  )
  const canDelete = $derived(adminAuth.isOwner)
  /** Whose seminar this is — checked against createdBy, written with the same name. */
  const me = $derived(adminAuth.me?.teacher ?? null)

  const TABBTN =
    'inline-flex h-7 items-center px-3 text-2xs font-bold uppercase tracking-label text-muted ' +
    'transition-colors duration-100 hover:text-ink focus-visible:outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-accent/50'

  const ITEM = 'flex w-full items-center px-2.5 py-1.5 text-left text-ui transition-colors duration-100'

  /* ----------------------------------------------------------- formatting */

  /**
   * The link this row is about. Not `seminar.url` verbatim: that is built from
   * PUBLIC_URL, and a PUBLIC_URL left on localhost hands the room a link only
   * this machine can open — and costs the teacher their own host seat, because
   * another origin carries neither the staff cookie nor the staff hint. See
   * lib/seminar-link.ts for the rule and what it was measured against.
   */
  const linkOf = (seminar: AdminSeminar): string =>
    seminarLink(seminar.url, location.origin, seminar.id)

  /** `/s/abc` — the half of the URL that is worth reading in a dense row. */
  function pathOf(seminar: AdminSeminar): string {
    return `/s/${seminar.id}`
  }

  function hostPathOf(seminar: AdminSeminar): string {
    try {
      const url = new URL(linkOf(seminar))
      return `${url.host}${url.pathname}`
    } catch {
      return `/s/${seminar.id}`
    }
  }

  function stamp(ts: number): string {
    const date = new Date(ts)
    return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`
  }

  const count = (n: number, noun: string): string => tr(`admin.count.${noun}`, { count: n })

  /**
   * Nobody can act on a dead cookie. Hand it to the shell, which swaps the
   * whole panel for the sign-in screen rather than arguing in a red line.
   *
   * And with a reason: the cookie did arrive here — it was rejected. Without
   * it the sign-in screen told someone whose link was rotated about cookie
   * settings.
   *
   * Lives apart from `explain()` because both translations of a refusal call
   * it — the English one for table rows and the Russian one for the rules
   * window — and switching the screen does not depend on the language.
   */
  function noteDeadCookie(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') {
      void adminAuth.refresh('revoked')
    }
  }

  function explain(cause: unknown): string {
    if (cause instanceof AdminApiError) return cause.message
    return cause instanceof Error ? cause.message : tr("admin.the.server.did.not.respond")
  }

  /* ---------------------------------------------------------------- data */

  /**
   * The list we answer for, not a lagging poll.
   *
   * A response that left before an edit arrives after it and brings back the
   * old name or an archived row — until the next tick, that is, for twenty
   * seconds, in which the teacher manages to press "Archive" a second time.
   * Every local edit moves the counter, and a response started earlier is
   * silently discarded: the server has already accepted the edit, and there
   * is no reason to show yesterday's truth instead.
   */
  let generation = 0

  function local(next: AdminSeminar[]): void {
    seminars = next
    generation += 1
  }

  function patch(id: string, fields: Partial<AdminSeminar>): void {
    local(seminars.map((s) => (s.id === id ? { ...s, ...fields } : s)))
  }

  function replace(updated: AdminSeminar): void {
    local(seminars.map((s) => (s.id === updated.id ? updated : s)))
  }

  /*
   * The sidebar's "Seminars 5" is the length of this list, so it is mirrored
   * from here rather than fetched twice — otherwise the count keeps standing at
   * the number it had before the row you just deleted.
   */
  $effect(() => {
    if (!loading) navCounts.seminars = seminars.length
  })

  async function load(silent = false): Promise<void> {
    if (!silent) loading = true
    const started = generation
    try {
      const list = await adminApi.listSeminars()
      // Something changed on screen while the response was on its way. That
      // edit is newer.
      if (started !== generation) return
      seminars = list
      loadErrorText = null
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      // A poll that fails leaves the list it already has: the screen was right a
      // minute ago, and a banner over live data is worse than data a minute old.
      if (!silent) loadErrorText = () => (explain(cause))
    } finally {
      if (!silent) loading = false
    }
  }

  onMount(() => {
    void load()

    // "8 in the room" is a claim about this second, so it is re-asked. A hidden
    // tab is not looking at the claim and does not need to spend the request.
    const tick = window.setInterval(() => {
      now = Date.now()
      if (document.visibilityState === 'visible') void load(true)
    }, 20_000)

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (doomed) {
        if (!deleteBusy) doomed = null
        return
      }
      openMenuId = null
      menuStyle = ''
    }
    const onClick = () => {
      openMenuId = null
      menuStyle = ''
    }
    // The menu sits in window coordinates, so on scroll it would drift away
    // from its button. Closing it is more honest than dragging it along: a
    // scroll is exactly "I changed my mind".
    //
    // Except for scrolling inside the menu itself: in a short window it is
    // cut to the free space, and the wheel over it is the only way to reach
    // "Delete…". The listener is in the capture phase, so such events arrive
    // here too, and the very first tick closed the menu that had just been
    // reached.
    const onScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest('[role=menu]')) return
      openMenuId = null
      menuStyle = ''
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('click', onClick)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.clearInterval(tick)
      window.clearTimeout(copyTimer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('click', onClick)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  })

  /* -------------------------------------------------------------- create */

  function startCreate(): void {
    /*
     * The inline row stays for the seminar you make in a hurry between two
     * classes. Anything that needs a decision — the room's rules, the oracle,
     * a notebook off GitHub — has a screen of its own, and this hands over to
     * it rather than growing a form inside a table cell.
     */
    if (onfull) {
      onfull()
      return
    }
    creating = true
    if (environments === null) {
      void adminApi
        .listEnvironments()
        .then((r) => {
          environments = r.environments
          /*
           * Preselect the instance's default. There is deliberately no empty
           * "as on the instance" option here: it was a third state and
           * contradicted the promise that a room's environment is chosen once
           * and does not change under it afterwards. An unfilled list is just
           * an empty field that does not tell what the seminar will get.
           */
          if (!newEnvironment) newEnvironment = r.environments.find((e) => e.active)?.name ?? ''
        })
        // No harm: without the list the form simply shows no choice, and the
        // seminar gets the default environment — the same as it always has.
        .catch(() => (environments = []))
    }
    createErrorText = null
  }

  function cancelCreate(): void {
    creating = false
    newName = ''
    createErrorText = null
  }

  // The field lands a paint after the row does, so focus follows the element.
  $effect(() => {
    if (creating) nameInput?.focus()
  })

  /**
   * The row whose Copy the cursor has already been put on. Not $state: this
   * is the effect's memory of itself, and there is nothing to redraw because
   * of it.
   */
  let focused: string | null = null

  /**
   * The row exists before this runs, so the button is really there. Queried
   * rather than bound: the binding would have to live on one row out of many,
   * and every row would carry the branch for the one that was just made.
   */
  $effect(() => {
    const id = justCreatedId
    /*
     * `seminars` is read on purpose, not by accident. A seminar made on the
     * other screen sets this id and then reloads the list, so at the moment
     * the id changes the row does not exist yet, the query finds nothing, and
     * the cursor is left on the body — the teacher then goes hunting for the
     * link this was meant to hand them. Depending on the list as well runs
     * this again once the rows land.
     */
    void seminars.length
    if (!id || id === focused) return
    const button = document.querySelector<HTMLButtonElement>(`[data-copy="${id}"]`)
    if (!button) return
    /*
     * And exactly once. The list poll assigns `seminars` every twenty
     * seconds, and `justCreatedId` does not go away — focus kept returning to
     * Copy again and again: from the search field, from an open rename, which
     * commits on blur and sent half a word into the header for everyone in
     * the room. The row is marked only once the button has been found: before
     * that there is nowhere to land.
     */
    focused = id
    button.focus()
  })

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const name = newName.trim()
    if (!name || createBusy) return

    createBusy = true
    createErrorText = null
    try {
      const seminar = await adminApi.createSeminar({ name, environment: newEnvironment || null })
      // A filter that hides the row you just made would send the teacher
      // hunting for a seminar they are looking straight at.
      query = ''
      local([seminar, ...seminars.filter((s) => s.id !== seminar.id)])
      justCreatedId = seminar.id
      creating = false
      newName = ''
      newEnvironment = ''
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      createErrorText = () => (explain(cause))
    } finally {
      createBusy = false
    }
  }

  /* ---------------------------------------------------------------- link */

  async function copy(seminar: AdminSeminar): Promise<void> {
    try {
      await copyText(linkOf(seminar))
    } catch {
      // Blocked on an insecure origin, which is a normal way to self-host. The
      // link is the point of the click, so it goes on screen instead.
      rowError = { id: seminar.id, message: () => (tr("admin.could.not.copy.the.link.copy.it.manually", { p0: linkOf(seminar) })) }
      return
    }
    if (rowError?.id === seminar.id) rowError = null
    copiedId = seminar.id
    window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => (copiedId = null), 1600)
  }

  /* -------------------------------------------------------------- rename */

  function startRename(seminar: AdminSeminar): void {
    renamingId = seminar.id
    renameValue = seminar.name
    rowError = null
  }

  /**
   * Someone else's room, with people in it right now.
   *
   * One question for three places: renaming, the end-of-class bell and the
   * rules dialog all change, for the same audience in someone else's room,
   * what that audience sees instantly. We ask only when both conditions hold
   * — fixing your own typo is not affected.
   */
  function othersLive(seminar: AdminSeminar): boolean {
    const mine = !seminar.createdBy || seminar.createdBy === me?.name
    return !mine && seminar.liveCount > 0
  }

  /** "There are 12 people in “ML week 3” right now, and Maria set it up". */
  function crowdIn(seminar: AdminSeminar): string {
    const crowd = seminar.liveCount === 1 ? tr("admin.is.1.person") : tr("admin.are.people", { p0: seminar.liveCount })
    return tr("admin.there.in.right.now.and.set.it.up", { p0: crowd, p1: seminar.name, p2: seminar.createdBy ?? tr("admin.unknown.teacher") })
  }

  async function commitRename(seminar: AdminSeminar): Promise<void> {
    const name = renameValue.trim()
    renamingId = null
    if (!name || name === seminar.name) return

    /*
     * Someone else's live room is not touched silently.
     *
     * The seminar's name is in the header for everyone inside right now, and
     * it changes for them instantly: in the middle of a class the heading
     * above the notebook suddenly becomes different. For your own room that
     * is expected — you are the one renaming it. For someone else's, where a
     * class is going on, it is worth asking.
     */
    if (othersLive(seminar)) {
      const ok = window.confirm(
        (tr("admin.the.new.name.appears.in.their.header.immediately", { p0: crowdIn(seminar) }) + " ") +
          tr("admin.rename.it.to", { p0: name }),
      )
      if (!ok) return
    }

    // Safe to paint: a name is one string, and putting the old one back costs
    // the teacher nothing but the correction they were going to make anyway.
    const before = seminar.name
    patch(seminar.id, { name })
    try {
      replace(await adminApi.updateSeminar(seminar.id, { name }))
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      patch(seminar.id, { name: before })
      rowError = { id: seminar.id, message: () => (tr("admin.could.not.rename.the.seminar", { p0: explain(cause) })) }
    }
  }

  /* --------------------------------------------------------------- rules */

  /**
   * The rules of an existing seminar.
   *
   * They used to be set once, at creation: `updateSeminar` was only called
   * with `{name}` or `{archived}`, and a teacher who decided to lock the
   * notebook in last week's room could do nothing — only create a second
   * one.
   *
   * One switch — one request, as in the room itself: the route lays what was
   * sent over the current rules and broadcasts `{t:'rules'}` itself, so an
   * open room learns about it at once.
   */
  let ruling = $state<AdminSeminar | null>(null)
  let rulesBusy = $state(false)
  /**
   * The refusal goes in the dialog itself, not in a table row under the veil.
   *
   * The switch is not painted ahead of time, so on a refusal nothing changes
   * on the screen: an expired cookie looked like "the click did not work",
   * and people clicked again and again while the message waited in a row
   * covered by the veil.
   */
  let rulesErrorText = $state<(() => string | null) | null>(null)
  const rulesError = $derived(rulesErrorText?.() ?? null)

  /* ----------------------------------------------------------- resources */

  /**
   * What the machine has — the same read as in the new class form.
   *
   * Asked for when the settings window opens, not when the list loads: the
   * list is opened on every tab switch, while free memory is needed exactly
   * by whoever came to change it.
   */
  let resources = $state<InstanceResources | null>(null)
  /**
   * The answer is still on its way.
   *
   * The settings window opens from a clean slate every time, and its first
   * frames are frames without numbers: `null` here meant both "don't know
   * yet" and "asked and did not find out", and for both cases the section
   * showed an empty, enabled memory field. While the flag is up,
   * placeholders of the fields' size stand in their place.
   */
  let resourcesLoading = $state(true)
  let memoryBusy = $state(false)
  let memoryErrorText = $state<(() => string | null) | null>(null)
  const memoryError = $derived(memoryErrorText?.() ?? null)

  function readResources(): void {
    // The flag goes up only on the FIRST read: a re-read after saving
    // happens under numbers already drawn, and swapping them for
    // placeholders would make the section blink on every memory change.
    resourcesLoading = resources === null
    void adminApi
      .resources()
      .then((r: InstanceResources) => (resources = r))
      .catch(() => (resources = null))
      .finally(() => (resourcesLoading = false))
  }

  /**
   * Change a room's memory — and it changes right now.
   *
   * The server applies the number to the live container via `docker
   * update`, without restarting the kernel: a teacher whose kernel was just
   * killed for memory adds gigabytes and runs the same cell again, without
   * losing either the seminar's variables or the open terminal. So there is
   * neither a confirmation nor a state-loss warning here — there is nothing
   * to lose.
   */
  async function setMemory(seminar: AdminSeminar, mb: number | null): Promise<void> {
    memoryBusy = true
    memoryErrorText = null
    try {
      const updated = await adminApi.updateSeminar(seminar.id, { memoryMb: mb })
      replace(updated)
      ruling = updated
      // The "how much of the machine is taken" bar is different after this:
      // free memory changed by exactly what the room just took or gave back.
      readResources()
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      memoryErrorText = () =>
        cause instanceof AdminApiError ? cause.message : tr('admin.resources.notSaved')
    } finally {
      memoryBusy = false
    }
  }

  /**
   * Cores — through the same door and the same window as memory.
   *
   * The caveat about threads lives in the hint under the field, not here:
   * the server applies the number to the container right away, but numpy
   * and torch inside an already running kernel keep computing with the old
   * number until a restart.
   */
  async function setCpus(seminar: AdminSeminar, cores: number | null): Promise<void> {
    memoryBusy = true
    memoryErrorText = null
    try {
      const updated = await adminApi.updateSeminar(seminar.id, { cpus: cores })
      replace(updated)
      ruling = updated
      readResources()
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      memoryErrorText = () =>
        cause instanceof AdminApiError ? cause.message : tr('admin.resources.notSaved')
    } finally {
      memoryBusy = false
    }
  }

  async function setRule(seminar: AdminSeminar, patchRules: Partial<RoomRules>): Promise<void> {
    rulesBusy = true
    rulesErrorText = null
    try {
      const updated = await adminApi.updateSeminar(seminar.id, { rules: patchRules })
      replace(updated)
      ruling = updated
    } catch (cause: unknown) {
      /*
       * The reason — in the instance's language and without the server's
       * untranslated tail.
       *
       * This used to be the shared `explain()`, which is English across the
       * whole panel: the Russian footer of this window came out as "The rule
       * was not saved" in Russian followed by "— The server did not respond"
       * — half a phrase in a language found nowhere else in the window
       * (admin-17). The words are in panel.ts, in one list and without the
       * browser; a rejected cookie still leads to the sign-in screen.
       */
      noteDeadCookie(cause)
      rulesErrorText = () => (ruleRefusal(cause instanceof AdminApiError ? cause : null))
    } finally {
      rulesBusy = false
    }
  }

  /**
   * End the class — and reopen it.
   *
   * The same door as the button in the room itself: a teacher who closed the
   * tab and remembered this on the metro should not have to go back into it
   * for a single press. The rules are not rewritten — the server lays the
   * end of class over them and steps back without touching the setting — so
   * the reverse move is right here too and costs exactly one press.
   *
   * Painted ahead of time, like "Archive": it is one field, and putting it
   * back costs the same press the person was about to make anyway.
   */
  async function finish(seminar: AdminSeminar, finished: boolean): Promise<void> {
    /*
     * And the bell — all the more so.
     *
     * Renaming someone else's live room asks, while ending the class — one
     * click in the same menu, right next to it — asked nothing, even though
     * for the same people it changes incomparably more: the rules become
     * teacher-only for everyone at once, and the class loses editing and
     * running in the middle of the session.
     */
    if (othersLive(seminar)) {
      const ok = window.confirm(
        finished
          ? (tr("admin.ending.the.class.disables.editing.and.running.for.students", { p0: crowdIn(seminar) }) + " ") +
            tr("admin.end.the.class.1110")
          : (tr("admin.reopening.the.class.restores.its.configured.access.rules", { p0: crowdIn(seminar) }) + " ") +
            tr("admin.reopen.the.class.1112"),
      )
      if (!ok) return
    }
    const before = seminar.finishedAt
    // This row's previous refusal is about the previous press. Leaving it
    // under a repainted mark would show two opposite truths side by side.
    if (rowError?.id === seminar.id) rowError = null
    patch(seminar.id, { finishedAt: finished ? Date.now() : null })
    try {
      replace(await adminApi.updateSeminar(seminar.id, { finished }))
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      patch(seminar.id, { finishedAt: before })
      rowError = {
        id: seminar.id,
        message: () => (finished
          ? tr("admin.could.not.end.the.class", { p0: explain(cause) })
          : tr("admin.could.not.reopen.the.class", { p0: explain(cause) })),
      }
    }
  }

  async function archive(seminar: AdminSeminar, archived: boolean): Promise<void> {
    const before = seminar.archivedAt
    patch(seminar.id, { archivedAt: archived ? Date.now() : null })
    try {
      replace(await adminApi.updateSeminar(seminar.id, { archived }))
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      patch(seminar.id, { archivedAt: before })
      rowError = { id: seminar.id, message: () => (tr("admin.could.not.change.the.archive.status", { p0: explain(cause) })) }
    }
  }

  /* -------------------------------------------------------------- delete */

  /**
   * The fate of the public page, if the room has one.
   *
   * The server's default is to keep it: a link handed out to the class
   * cannot be recalled, and a 404 where yesterday there was a seminar is
   * worse than a page without a room. But the server declares the question
   * separately, and the panel never asked it — so "delete to take down what
   * was published", exactly the case people come here for, left a copy of
   * the notebook open to everyone. It can be withdrawn later on the courses
   * tab, in the list of pages without a room.
   */
  let dropReading = $state(false)

  function confirmDelete(seminar: AdminSeminar): void {
    doomed = seminar
    deleteErrorText = null
    dropReading = false
  }

  $effect(() => {
    // Focus lands on the way out, never on the button that destroys the room.
    if (doomed) cancelButton?.focus()
  })

  async function destroy(): Promise<void> {
    const target = doomed
    if (!target || deleteBusy) return

    deleteBusy = true
    deleteErrorText = null
    try {
      await adminApi.deleteSeminar(target.id, dropReading)
      local(seminars.filter((s) => s.id !== target.id))
      doomed = null
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      // Already gone: the list is the thing that is wrong, so correct the list
      // rather than asking the owner to delete something that does not exist.
      if (cause instanceof AdminApiError && cause.status === 404) {
        local(seminars.filter((s) => s.id !== target.id))
        doomed = null
      } else {
        deleteErrorText = () => (explain(cause))
      }
    } finally {
      deleteBusy = false
    }
  }
</script>

<AdminPage title={tr("admin.seminars")}>
  {#snippet actions()}
    <!--
      An empty instance gets one path, not three. The search has nothing to
      search and the button in the corner duplicates the one in the middle of
      the page, which is where the eye already is.
    -->
    {#if seminars.length > 0}
    <!--
      On a phone the header is a full-width column.

      The 220px search and the button next to it fit in a line that a 390px
      screen does not have: the rail takes 56, the page margins another 56,
      and 278 is left for everything. The search and "New class" stacked
      under each other anyway, but each at its content width — two short
      stubs at the left edge. The height grows to 44px there too: 34 is a
      size for a mouse, and here people poke with a finger.
    -->
    <div
      class="flex h-[34px] w-[220px] max-w-full items-center gap-2 border border-line bg-canvas px-3
             focus-within:border-accent max-[640px]:h-11 max-[640px]:w-full"
    >
      <Icon name="search" size={13} class="shrink-0 text-faint" />
      <input
        type="search"
        bind:value={query}
        placeholder={tr("admin.search.seminars")}
        aria-label={tr("admin.search.seminars.by.name")}
        class="min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-faint"
      />
    </div>
    {#if archivedCount}
      <label
        class="flex h-[34px] cursor-pointer select-none items-center gap-2 border border-line
               bg-canvas px-3 text-2xs font-bold uppercase tracking-caps text-muted
               hover:text-ink max-[640px]:h-11 max-[640px]:w-full"
        title="{seminars.length - archivedCount} {tr("admin.active")} {archivedCount} {tr("admin.archived")}"
      >
        <input type="checkbox" bind:checked={showArchived} class="accent-accent" />
        {tr("admin.archived.903")}
        <span class="tabular-nums text-faint">{archivedCount}</span>
      </label>
    {/if}
    <button
      type="button"
      onclick={startCreate}
      class="btn-primary h-[34px] gap-2 px-3.5 text-2xs font-bold uppercase tracking-caps
             max-[640px]:h-11 max-[640px]:w-full"
    >
      <Icon name="plus" size={14} />
      {tr("admin.new.seminar")}
    </button>
    {/if}
  {/snippet}

  <!-- Nothing live, no banner. An empty "running now" is a lie with a border. -->
  {#each live as seminar (seminar.id)}
    <!--
      Wrapping, and a floor under the name lane. The plate is three things in a
      row and the row ran out at 860px: RUNNING NOW broke across two lines into
      the sentence beside it, and the seminar name was squeezed past its own
      ellipsis. Three items that wrap onto a second line say the same thing at
      any width; a fixed 74px height is what turned the overflow into an
      overlap, so it is a floor now rather than a lid.
    -->
    <!--
      And a column on a phone.

      A row of three parts can wrap but cannot shrink: the button group on
      the right is `shrink-0`, with a monospace address the full length of the
      host inside it, and at 390px it slid past the right edge — "Open" was
      half visible and could not be pressed. Measured on the test bench: the
      group took 84…430px on a 390 screen. Below 640 the row becomes a column,
      each part full width, and the address shrinks to `/s/…`, because the
      host is known here anyway: the panel is open on it.

      The negative margins stay `-mx-7` at any width — precisely because the
      page margins (AdminPage · px-7) are also the same at all widths. If
      these two numbers drift apart, the plate sticks out past the edge on a
      phone and falls short of it on a desktop.
    -->
    <section
      class="-mx-7 flex min-h-[74px] flex-wrap items-center gap-x-[22px] gap-y-3 border-b
             border-b-line border-l-[3px] border-l-accent bg-raised py-3 pl-[25px] pr-7
             max-[640px]:min-h-0 max-[640px]:flex-col max-[640px]:flex-nowrap
             max-[640px]:items-stretch max-[640px]:gap-y-2.5 max-[640px]:py-3.5"
    >
      <div class="flex min-w-[180px] flex-col gap-[3px] max-[640px]:min-w-0">
        <p
          class="flex items-center gap-[7px] whitespace-nowrap text-2xs font-bold uppercase
                 tracking-label text-accent-text"
        >
          <span class="h-[7px] w-[7px] shrink-0 rounded-full bg-accent"></span>
          {tr("admin.running.now")}
        </p>
        <!-- Two clamped lines, not one: on a phone a single line holds a
             third of a seminar's title, and "Machine learning and data
             anal…" cannot be told from a neighbour that starts the same. -->
        <h2
          class="truncate text-title font-bold tracking-tight text-ink
                 max-[640px]:line-clamp-2 max-[640px]:whitespace-normal"
        >
          {seminar.name}
        </h2>
      </div>

      <!--
        The artboard stacks the faces of the room here. AdminSeminar carries a
        head-count and nothing else, so there is nobody to draw: blank discs
        read as avatars that failed to load, and the roster endpoint answers
        with everyone who ever joined, which is a different set from the one
        this line is counting. The sentence is the honest version of the stack
        until the contract carries the people — see AvatarStack.
      -->
      <!--
        Two clocks, and they go by different words (admin/panel.ts ·
        runningLine): "started" only when the server has said since when
        someone has been in the room. A room is set up a week before the
        class, and "started 6 days ago" under "Running now" was untrue in the
        most visible spot of the panel.
      -->
      <p
        class="shrink-0 text-ui text-muted"
        title="{tr("admin.created.906")} {new Date(seminar.createdAt).toLocaleString(getLocale())}"
      >
        {runningLine(seminar, now)}
      </p>

      <!-- `ml-0` is required in the column: `margin-left: auto` on an item of
           a column flex cancels stretching and pushes the row to the right
           edge — exactly what must not happen here. -->
      <div class="ml-auto flex shrink-0 items-center gap-2.5 max-[640px]:ml-0 max-[640px]:gap-2">
        <button
          type="button"
          onclick={() => copy(seminar)}
          title="{tr("admin.copy")}  {linkOf(seminar)}"
          class={cn(
            'flex h-8 items-center gap-2 border border-line bg-canvas px-3 font-mono text-code',
            'transition-colors duration-100 hover:border-faint hover:text-ink',
            // A finger, not a cursor: 44px of height and all the remaining row width.
            'max-[640px]:h-11 max-[640px]:min-w-0 max-[640px]:flex-1 max-[640px]:justify-between',
            copiedId === seminar.id ? 'text-positive' : 'text-muted',
          )}
        >
          <span class="max-[640px]:hidden">{hostPathOf(seminar)}</span>
          <span class="hidden max-[640px]:block max-[640px]:truncate">{pathOf(seminar)}</span>
          <Icon name={copiedId === seminar.id ? 'check' : 'copy'} size={13} class="shrink-0" />
        </button>
        <a
          href={linkOf(seminar)}
          target="_blank"
          rel="noreferrer"
          class="btn h-8 bg-accent px-3.5 text-2xs font-bold uppercase tracking-caps text-accent-ink
                 hover:brightness-110 max-[640px]:h-11 max-[640px]:shrink-0 max-[640px]:px-4"
        >
          {tr("admin.open")}
        </a>
      </div>
    </section>
  {/each}

  {#if loadError}
    <div class="mt-6 border border-danger/40 bg-surface px-4 py-3">
      <p class="text-ui text-danger">{tr("admin.could.not.load.seminars")} {loadError}</p>
      <button type="button" class="btn-outline mt-2.5" onclick={() => void load()}>{tr("admin.try.again")}</button>
    </div>
  {/if}

  <!-- Flush against the header, as on the artboard: the rule under the topbar
       is the table's own top rule, and a gap there reads as a missing row. -->
  <!--
    The columns after the name are fixed and add up to 466px, and table-fixed
    hands the name whatever is left: at 800px of window that was 42px and at
    768px it was 10px, so the names vanished and the headings printed on top of
    each other. The min-width is those 466px plus a lane a name can be read in.
    It is set where the lane actually dies rather than where it starts to
    tighten — every window that works today still gets no scrollbar — and it
    scrolls inside this box, so the page itself still never moves sideways.
  -->
  <!--
    Below 640 there is no table — there are row cards.

    Six columns hold a 600px minimum and slide sideways in their own scroll:
    at 390px "Date", "Joined", "Status" and — most costly of all — the
    actions button stayed past the edge, and you had to guess to scroll
    sideways in a box that gives no sign that it scrolls.

    The cards are not a second markup but this same one unlocked: `table`,
    `tbody` and `tr` become blocks and flex, `thead` goes away, the cells are
    laid out with `order` — title and menu on the first line, environment,
    date, joined and state on the second. A second markup would mean two
    lists of actions, and one day one of them would fall behind the other —
    and the row menu holds "Delete".
  -->
  <div class="-mx-1 overflow-x-auto px-1">
  <table class="w-full min-w-[600px] table-fixed max-[640px]:block max-[640px]:min-w-0">
    <colgroup class="max-[640px]:hidden">
      <col />
      <col class="w-[132px]" />
      <col class="w-[104px]" />
      <col class="w-[74px]" />
      <col class="w-[116px]" />
      <col class="w-10" />
    </colgroup>
    <thead class={cn('max-[640px]:hidden', shown.length === 0 && !creating && 'sr-only')}>
      <tr class="border-b border-line text-micro font-bold uppercase tracking-label text-muted">
        <th scope="col" class="py-3 text-left">{tr("admin.seminar")}</th>
        <!--
          The environment this room's kernel is ACTUALLY on, which is not always
          the one configured: a seminar that was live through a switch keeps the
          image it came up on until its own kernel restarts. That gap is the
          only reason this column is worth a lane of its own.
        -->
        <th scope="col" class="py-3 text-left">{tr("admin.environment.919")}</th>
        <th scope="col" class="py-3 text-left">{tr("admin.date")}</th>
        <!--
          "Joined", not "People". This column is everyone who ever joined; the
          banner above it counts who is connected right now. Both were labelled
          people, so the same view could read "2 people in the room" beside an
          11 and give the reader no way to tell which number was wrong.
        -->
        <th scope="col" class="py-3 text-right">{tr("admin.joined")}</th>
        <th scope="col" class="py-3 text-right">{tr("admin.status")}</th>
        <th scope="col" class="py-3"><span class="sr-only">{tr("admin.actions")}</span></th>
      </tr>
    </thead>
    <tbody class="max-[640px]:block">
      {#if creating}
        <tr class="border-b border-line-soft bg-surface max-[640px]:block">
          <td colspan="6" class="py-3 max-[640px]:block">
            <!-- Two doors into one room: a blank seminar and a seminar from
                 ready material. A switch, not a second button in the header:
                 this is one "create" action with two sources. -->
            <div class="mb-2.5 flex items-center gap-1">
              <button
                type="button"
                class={cn(TABBTN, !fromGithub && 'bg-raised text-ink')}
                onclick={() => ((fromGithub = false), (preview = null))}
              >
                {tr("admin.blank")}
              </button>
              <button
                type="button"
                class={cn(TABBTN, fromGithub && 'bg-raised text-ink')}
                onclick={() => (fromGithub = true)}
              >
                {tr("admin.from.github")}
              </button>
            </div>

            {#if fromGithub}
              <form class="flex flex-col gap-2.5" onsubmit={importFromGithub}>
                <div class="flex flex-wrap items-center gap-2">
                  <input
                    bind:value={githubUrl}
                    class="field min-w-[420px] flex-1 font-mono text-code-lg
                           max-[640px]:w-full max-[640px]:min-w-0"
                    placeholder="https://github.com/sleep3r/ml_hse/tree/main/week02"
                    autocomplete="off"
                    spellcheck="false"
                    aria-label={tr("admin.github.link.to.a.notebook.or.a.folder")}
                  />
                  <button
                    class="btn-primary"
                    type="submit"
                    disabled={!preview || createBusy}
                  >
                    {#if createBusy}
                      <Icon name="spinner" size={15} class="animate-spin" />
                      {tr("admin.importing")}
                    {:else}
                      {tr("admin.import")}
                    {/if}
                  </button>
                  <button class="btn-ghost" type="button" onclick={cancelCreate}>{tr("admin.cancel")}</button>
                </div>

                <!--
                  The name and environment stand HERE, not inside the preview:
                  they belong to the room being created, not to the link that
                  was read. Hidden behind the preview, they appeared only
                  after a successful read of the repository — and it looked as
                  if there were no choice of environment on import at all.
                -->
                <div class="flex flex-wrap items-center gap-2">
                  <input
                    bind:value={newName}
                    class="field max-w-[380px]"
                    placeholder={tr("admin.name.filled.in.from.the.link")}
                    maxlength={LIMITS.seminarName}
                    autocomplete="off"
                    aria-label={tr("admin.seminar.name")}
                  />
                  {#if environments && environments.length > 1}
                    <select
                      bind:value={newEnvironment}
                      class="field h-[38px] max-w-[240px] font-mono text-code-lg"
                      aria-label={tr("admin.python.environment")}
                    >
                      {#each environments as env (env.name)}
                        <option value={env.name} disabled={env.state !== 'ready'}>
                          {env.name}{env.active ? (" " + tr("admin.default.937")) : ''}{env.state === 'ready'
                            ? ''
                            : (" " + tr("admin.not.built.939"))}
                        </option>
                      {/each}
                    </select>
                  {/if}
                </div>

                {#if previewing}
                  <p class="text-2xs text-muted">{tr("admin.reading.the.repository")}</p>
                {:else if previewError}
                  <p class="text-2xs text-danger">{previewError}</p>
                {:else if preview}
                  <!-- What exactly will arrive. Shown before creation, not after. -->
                  <div class="flex flex-wrap items-center gap-2 text-2xs text-muted">
                    <span class="font-mono text-ink">{preview.notebook}</span>
                    <span>·</span>
                    <span>{preview.cells} {tr("admin.cells")}</span>
                    {#if preview.files.length > 0}
                      <span>·</span>
                      {#each preview.files as f (f.name)}
                        <span class="bg-surface px-2 py-0.5 font-mono text-micro">{f.name}</span>
                      {/each}
                    {/if}
                    <span>·</span>
                    <span class="font-mono">{preview.source}</span>
                    <span>·</span>
                    <span>{tr("admin.outputs.not.imported")}</span>
                  </div>
                  <!--
                    And what will not arrive. On a separate line, not as one
                    more chip in the shared row: listed next to what is
                    brought, these names would read as "also coming". The
                    total is capped the same way as for an upload through the
                    panel (server/src/routes/admin-import.ts ·
                    withinRoomBudget), and learning about the rest after the
                    import is too late — by then the files have already failed
                    to arrive in the new room.
                  -->
                  {#if preview.skipped.length > 0}
                    <div class="flex flex-wrap items-center gap-2 text-2xs text-warning">
                      <span>
                        {tr("admin.count.skippedFiles", { count: preview.skipped.length })}
                      </span>
                      {#each preview.skipped as name (name)}
                        <span
                          class="bg-surface px-2 py-0.5 font-mono text-micro text-muted line-through"
                        >
                          {name}
                        </span>
                      {/each}
                    </div>
                  {/if}
                {/if}
              </form>
            {:else}
            <form class="flex flex-wrap items-center gap-2" onsubmit={create}>
              <input
                bind:this={nameInput}
                bind:value={newName}
                class="field max-w-[380px]"
                placeholder={tr("admin.computer.vision.seminar.25.08")}
                maxlength={LIMITS.seminarName}
                autocomplete="off"
                aria-label={tr("admin.name.of.the.new.seminar")}
              />

              <!--
                The environment is chosen ONCE, here. After that it is this
                room's Python forever: a seminar whose packages changed in the
                middle of a class is worse than a seminar without the newest
                packages.
              -->
              {#if environments && environments.length > 1}
                <select
                  bind:value={newEnvironment}
                  class="field h-[38px] max-w-[220px] font-mono text-code-lg"
                  aria-label={tr("admin.python.environment.for.the.new.seminar")}
                >
                                    {#each environments as env (env.name)}
                    <option value={env.name} disabled={env.state !== 'ready'}>
                      {env.name}{env.active ? ' — default' : ''}{env.state === 'ready' ? '' : ' — not built'}
                    </option>
                  {/each}
                </select>
              {/if}

              <button class="btn-primary" type="submit" disabled={!newName.trim() || createBusy}>
                {#if createBusy}
                  <Icon name="spinner" size={15} class="animate-spin" />
                  {tr("admin.creating")}
                {:else}
                  {tr("admin.create")}
                {/if}
              </button>
              <button class="btn-ghost" type="button" onclick={cancelCreate}>{tr("admin.cancel")}</button>
            </form>
            {/if}
            {#if createError}
              <p class="mt-2 text-ui text-danger">{createError}</p>
            {/if}
          </td>
        </tr>
      {/if}

      {#each shown as seminar (seminar.id)}
        {@const fresh = seminar.id === justCreatedId}
        <!--
          Below 640 a row is a card: `order` gathers it into two lines, and
          the `basis` of the first hands out exactly 100% (the title + 44px
          for the menu), so the other cells wrap instead of shrinking to a
          single letter.
        -->
        <tr
          class={cn(
            'group border-b border-line-soft',
            'max-[640px]:flex max-[640px]:flex-wrap max-[640px]:items-center max-[640px]:py-1',
            fresh && 'bg-accent/10',
          )}
        >
          <td
            class="py-2 pr-4 align-top max-[640px]:order-1 max-[640px]:min-w-0
                   max-[640px]:basis-[calc(100%_-_44px)] max-[640px]:pr-2"
          >
            {#if renamingId === seminar.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                bind:value={renameValue}
                class="field max-w-[380px] max-[640px]:w-full"
                maxlength={LIMITS.seminarName}
                autocomplete="off"
                autofocus
                aria-label="{tr("admin.rename")} {seminar.name}"
                onblur={() => void commitRename(seminar)}
                onkeydown={(event) => {
                  if (event.key === 'Enter') void commitRename(seminar)
                  if (event.key === 'Escape') renamingId = null
                }}
              />
            {:else}
              <!-- The only place where the threshold is named on both sides:
                   `truncate` holds `white-space: nowrap`, and a two-line clamp
                   under it silently stays one line. Two unlike rules are
                   easier to split by width than to argue inside one class. -->
              <a
                href={linkOf(seminar)}
                target="_blank"
                rel="noreferrer"
                class="block text-ui font-semibold text-ink hover:underline
                       max-[640px]:line-clamp-2 min-[641px]:truncate"
              >
                {seminar.name}
              </a>
            {/if}

            <!-- Wraps as whole parts, not word by word: "link not shared yet"
                 broke into four stacked words in a narrow window and made every
                 row in the table four times as tall. -->
            <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <button
                type="button"
                data-copy={seminar.id}
                onclick={() => copy(seminar)}
                title="{tr("admin.copy")}  {linkOf(seminar)}"
                class={cn(
                  // -my-1 py-1: the row's path is 16px of type, which is too small
                  // a thing to aim at. The target grows to 24 and the row does not.
                  'flex -my-1 items-center gap-1.5 py-1 font-mono text-2xs transition-colors duration-100',
                  'hover:text-ink focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/30',
                  // 24 is a target for a mouse. A finger needs 44, and they
                  // come from the target's own height, not the row's: the
                  // negative margin above gives the card back its old height.
                  'max-[640px]:min-h-[44px]',
                  copiedId === seminar.id ? 'text-positive' : 'text-muted',
                )}
              >
                {pathOf(seminar)}
                <!--
                  Three ways in, and none of them is redundant.

                  `hover:` now works only where there is a real cursor
                  (tailwind.config.js · hoverOnlyWhenSupported) — and the
                  "copy" icon was this row's ONLY hint that it can be pressed.
                  On an iPad, where the panel is opened most often, it stopped
                  appearing at all: a tap copied, but there was no way to
                  know. So where there is no hover, the icon is always shown;
                  for the keyboard, focus inside the row shows it — the same
                  trick as in the file tree (FilesPanel.svelte ·
                  group-focus-within).
                -->
                <Icon
                  name={copiedId === seminar.id ? 'check' : 'copy'}
                  size={12}
                  class={cn(
                    'transition-opacity duration-100',
                    copiedId === seminar.id || fresh
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 ' +
                        '[@media(hover:none)]:opacity-100',
                  )}
                />
              </button>
              {#if seminar.status === 'draft'}
                <span class="whitespace-nowrap text-2xs text-muted">{tr("admin.link.not.shared.yet")}</span>
              {/if}
              {#if seminar.archivedAt}
                <span class="whitespace-nowrap text-2xs text-muted"> {tr("admin.archived")}</span>
              {/if}
              <!--
                Who set up the room. It was stored from the very start and
                shown nowhere: on a department's shared instance the list is
                other people's seminars mixed with your own, and "delete"
                stands next to each. Any teacher can still edit — this is one
                department, not tenants — but whose it is is now visible
                before the press.
              -->
              {#if seminar.createdBy}
                <span class="whitespace-nowrap text-2xs text-faint">{tr("admin.by")} {seminar.createdBy}</span>
              {/if}
              <!-- Course and publication go in the same line as the link: they
                   are facts about this seminar, not another column in a table
                   that already has six. -->
              {#each seminar.courses as course (course.id)}
                <!-- `max-w-full truncate`: a course name is someone else's
                     string of any length, and at 360px one of them pushed the
                     card past the edge. -->
                <a
                  class="max-w-full truncate whitespace-nowrap text-2xs text-accent-text"
                  href={`/admin/courses/${course.id}`}
                >
                  · {course.name}
                </a>
              {/each}
              {#if seminar.publication?.state === 'published'}
                <a
                  class="whitespace-nowrap text-2xs text-muted underline decoration-line underline-offset-2"
                  href={`/p/${addressOf(seminar.publication)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {tr("admin.published.978")} {count(seminar.publication.steps, 'step')}
                </a>
              {:else if seminar.publication}
                <span class="whitespace-nowrap text-2xs text-muted">{tr("admin.page.taken.down")}</span>
              {/if}
            </div>

            {#if rowError?.id === seminar.id}
              <p class="mt-1 text-2xs text-danger">{rowError.message()}</p>
            {/if}
          </td>

          <td
            class="py-2 pr-3 align-middle max-[640px]:order-3 max-[640px]:pb-2.5 max-[640px]:pt-0"
          >
            {#if seminar.environment}
              <a
                href="/admin/environments"
                class="truncate font-mono text-code text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
                title="{tr("admin.selected.environment")} {seminar.environment}"
              >
                {seminar.environment}
              </a>
            {:else}
              <!-- No kernel has started here, so there is nothing to report. It
                   will get whatever is configured when somebody presses Run —
                   saying that name now would be a guess dressed as a fact. -->
              <span class="font-mono text-code text-faint" title={tr("admin.no.environment.recorded.for.this.seminar")}>
                —
              </span>
            {/if}
          </td>

          <td
            class="py-2 align-middle text-ui text-muted max-[640px]:order-4 max-[640px]:pb-2.5
                   max-[640px]:pr-3 max-[640px]:pt-0"
          >
            <span title={new Date(seminar.createdAt).toLocaleString(getLocale())}>
              {stamp(seminar.createdAt)}
            </span>
          </td>

          <td
            class="py-2 text-right align-middle font-mono text-code text-ink max-[640px]:order-5
                   max-[640px]:pb-2.5 max-[640px]:pr-3 max-[640px]:pt-0"
          >
            <span title="{people(seminar.totalParticipants)} {tr("admin.joined.in.total")}">
              <!-- On a phone there is no column header, and a bare number
                   next to "base · 19.09" reads as anything at all. The word is
                   the same as in the table header — the column and the
                   caption do not diverge. -->
              <span class="hidden text-2xs font-bold uppercase tracking-caps text-faint max-[640px]:inline">
                {tr("admin.joined")}
              </span>
              {seminar.totalParticipants > 0 ? seminar.totalParticipants : '—'}
            </span>
          </td>

          <td class="py-2 align-middle max-[640px]:order-6 max-[640px]:ml-auto max-[640px]:pb-2.5 max-[640px]:pt-0">
            <div class="flex items-center justify-end gap-2">
              {#if seminar.status === 'finished'}
                <!--
                  The teacher's decision stands where the other three words
                  are, and outranks them: "nobody right now" and "class ended"
                  used to be shown with the one word Ended, so the bell
                  changed nothing in the list. The dot on the left — if
                  someone is in the finished room after all: they are
                  re-reading the review, and that is visible.
                -->
                <span
                  class="chip h-6 gap-1.5 bg-warning/[0.14] px-2 text-2xs font-bold uppercase tracking-caps text-warning"
                  title="{tr("admin.class.ended")} {new Date(
                    seminar.finishedAt ?? 0,
                  ).toLocaleString(getLocale())} {tr("admin.student.editing.and.execution.are.disabled")}"
                >
                  {#if seminar.liveCount > 0}
                    <span
                      class="h-[5px] w-[5px] rounded-full bg-accent"
                      title="{people(seminar.liveCount)} {tr("admin.in.the.room.right.now")}"
                    ></span>
                  {/if}
                  {tr("admin.finished")}
                </span>
              {:else if seminar.status === 'live'}
                <span
                  class="chip h-6 gap-1.5 bg-accent/15 px-2 text-2xs font-bold uppercase tracking-caps text-accent-text"
                >
                  <span class="h-[5px] w-[5px] rounded-full bg-accent"></span>
                  {tr("admin.live.990")}
                  <!-- The head-count only on a phone: there is no "Joined"
                       column next to it there, and "live" without a number
                       does not tell a room with one visitor from a room with
                       a whole cohort. On a desktop the number stands in its
                       own column, and the badge must not carry a second copy
                       of it. -->
                  <span
                    class="hidden tabular-nums max-[640px]:inline"
                    title="{people(seminar.liveCount)} {tr("admin.in.the.room.right.now")}"
                  >
                    · {seminar.liveCount}
                  </span>
                </span>
              {:else if seminar.status === 'draft'}
                <span
                  class="chip h-6 border border-line px-2 text-2xs font-bold uppercase tracking-caps text-muted"
                >
                  {tr("admin.draft")}
                </span>
              {:else}
                <!-- Bare, so the four states share one right-hand lane: an empty
                     room is a fact, not a badge. The word is honest: people
                     came in, and now nobody is there — that does not mean
                     "finished". -->
                <span class="text-2xs font-bold uppercase tracking-caps text-muted">{tr("admin.empty")}</span>
              {/if}
            </div>
          </td>

          <!--
            The menu sits next to the title, on the card's first line, and is
            exactly 44px wide: the title's `basis` above is measured for this
            number.

            `px-0` is required here. A table cell has `padding: 1px` from the
            browser's styles, and nobody removes it: `min-width: auto` on a
            flex item counts by content, which came to 46 instead of 44, and
            234 + 46 > 278 — so the menu button slid onto the card's third
            line, under the date. Measured on the test bench on a 390px screen.
          -->
          <td
            class="py-2 align-middle max-[640px]:order-2 max-[640px]:basis-11 max-[640px]:self-start
                   max-[640px]:px-0"
          >
            <div class="relative flex justify-end">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={openMenuId === seminar.id}
                aria-label="{tr("admin.actions.for")} {seminar.name}"
                onclick={(event) => {
                  event.stopPropagation()
                  openMenu(seminar, event.currentTarget as HTMLElement)
                }}
                class="flex h-8 w-8 items-center justify-center text-faint transition-colors duration-100 hover:bg-raised hover:text-ink max-[640px]:h-11 max-[640px]:w-11"
              >
                <Icon name="more" size={15} />
              </button>

              {#if openMenuId === seminar.id}
                <div
                  role="menu"
                  tabindex="-1"
                  class="row-menu fixed z-50 w-48 overflow-y-auto border border-line bg-canvas p-1 shadow-pop"
                  style={menuStyle}
                >
                  <button role="menuitem" type="button" class="{ITEM} text-ink hover:bg-raised" onclick={() => copy(seminar)}>
                    {tr("admin.copy.link")}
                  </button>
                  <a
                    role="menuitem"
                    href={linkOf(seminar)}
                    target="_blank"
                    rel="noreferrer"
                    class="{ITEM} text-ink hover:bg-raised"
                  >
                    {tr("admin.open.seminar")}
                  </a>
                  <button role="menuitem" type="button" class="{ITEM} text-ink hover:bg-raised" onclick={() => startRename(seminar)}>
                    {tr("admin.rename")}
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    class="{ITEM} text-ink hover:bg-raised"
                    onclick={() => {
                      ruling = seminar
                      memoryErrorText = null
                      // Numbers from the last opening are numbers from the
                      // last minute: since then someone else's room has been
                      // closed and memory freed. The window opens with
                      // placeholders and waits for a fresh answer.
                      resources = null
                      readResources()
                    }}
                  >
                    {tr('admin.seminar.settingsMenu')}
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    class="{ITEM} text-ink hover:bg-raised"
                    onclick={() => void finish(seminar, !seminar.finishedAt)}
                  >
                    {seminar.finishedAt ? tr("admin.reopen.the.class") : tr("admin.end.the.class")}
                  </button>
                  <div class="my-1 border-t border-line-soft"></div>
                  <button
                    role="menuitem"
                    type="button"
                    class="{ITEM} text-ink hover:bg-raised"
                    onclick={() => onpublish?.(seminar.id)}
                  >
                    {seminar.publication ? tr("admin.publish.again") : tr("admin.publish")}
                  </button>
                  {#if seminar.publication?.state === 'published'}
                    <button
                      role="menuitem"
                      type="button"
                      class="{ITEM} text-ink hover:bg-raised"
                      onclick={() => void copyPublished(seminar)}
                    >
                      {tr("admin.copy.public.link")}
                    </button>
                    <button
                      role="menuitem"
                      type="button"
                      class="{ITEM} text-ink hover:bg-raised"
                      onclick={() => void withdraw(seminar, true)}
                    >
                      {tr("admin.take.the.page.down")}
                    </button>
                  {:else if seminar.publication}
                    <button
                      role="menuitem"
                      type="button"
                      class="{ITEM} text-ink hover:bg-raised"
                      onclick={() => void withdraw(seminar, false)}
                    >
                      {tr("admin.put.the.page.back")}
                    </button>
                  {/if}
                  <button
                    role="menuitem"
                    type="button"
                    class="{ITEM} text-ink hover:bg-raised"
                    onclick={() => void archive(seminar, !seminar.archivedAt)}
                  >
                    {seminar.archivedAt ? tr("admin.move.back.to.the.list") : tr("admin.archive")}
                  </button>
                  {#if canDelete}
                    <div class="my-1 border-t border-line-soft"></div>
                    <button
                      role="menuitem"
                      type="button"
                      class="{ITEM} text-danger hover:bg-danger/[0.08]"
                      onclick={() => confirmDelete(seminar)}
                    >
                      {tr("admin.delete")}
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          </td>
        </tr>
      {/each}

      {#if loading && seminars.length === 0}
        <tr class="max-[640px]:block">
          <td colspan="6" class="px-3 py-4 max-[640px]:block"><RowsSkeleton label={tr('admin.loading.seminars')} /></td>
        </tr>
      {:else if shown.length === 0 && !creating}
        <tr class="max-[640px]:block">
          <td colspan="6" class="py-12 text-center max-[640px]:block">
            {#if needle}
              <p class="text-ui text-muted">{tr('admin.seminar.noMatch', { query: query.trim() })}</p>
              <button type="button" class="btn-ghost mt-2" onclick={() => (query = '')}>
                {tr("admin.show.all")} {count(seminars.length, 'seminar')}
              </button>
            {:else if !loadError}
              <p class="text-ui text-muted">{tr("admin.no.seminars.yet")}</p>
              <p class="mt-1 text-ui text-muted">
                {tr("admin.create.a.seminar.and.share.its.link.with.your.students")}
              </p>
              <button type="button" class="btn-primary mt-3" onclick={startCreate}>
                <Icon name="plus" size={15} />
                {tr("admin.new.seminar")}
              </button>
            {/if}
          </td>
        </tr>
      {/if}
    </tbody>
  </table>
  </div>

  {#if seminars.length > 0}
    <p class="mt-4 text-2xs text-muted">
      {#if needle}
        {tr("admin.showing")} {shown.length} {tr("admin.of")} {count(seminars.length, 'seminar')}
      {:else}
        {count(seminars.length, 'seminar')} {tr("admin.total")}
      {/if}
    </p>
  {/if}
</AdminPage>

{#if ruling}
  <!--
    The same list, in the same words, as in the room itself: a setting that is
    named differently in two places is two settings.

    And that is why this window is ENTIRELY RUSSIAN — the heading, the
    warning, the refusal reason in the footer (panel.ts · ruleRefusal) and
    "Done" around the rows — even though the menu it is opened from is
    English, like the whole screen. The decision is written down once, in the
    header of the component for these rows (components/RoomRulesRows.svelte):
    the rule labels live in the ROOM's language, because the same component
    draws the rules console inside the room, and the room is Russian
    throughout. Translating just the frame around Russian rows would make the
    window itself bilingual — exactly what finding admin-17 calls a defect in
    the menu. The menu's bilingualism was fixed where it was: in the row menu
    itself.
  -->
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="seminar-rules-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card flex max-h-full w-full max-w-[560px] flex-col border border-line bg-canvas shadow-pop">
      <div class="flex flex-col gap-1.5 border-b border-line px-5 py-3.5">
        <div class="flex items-baseline gap-3">
          <h2 id="seminar-rules-title" class="min-w-0 truncate text-title font-semibold text-ink">
            {ruling.name}
          </h2>
          <span class="shrink-0 text-2xs text-muted">{tr('admin.seminar.settingsSubtitle')}</span>
        </div>
        <!--
          Someone else's room, with a class going on. There is deliberately no
          confirmation here: there are nine switches, and asking on each one
          would teach people to click through the question. But knowing that
          every switch lands on two hundred people in the middle of someone
          else's class has to come BEFORE the first click.
        -->
        {#if othersLive(ruling)}
          <p class="text-2xs leading-snug text-warning">
            {tr("admin.in.the.room.1023")} {ruling.liveCount}
            {plural(ruling.liveCount, tr("admin.person"), tr("admin.people.1025"), tr("admin.person"))}{tr("admin.created.by")} {ruling.createdBy}{tr("admin.rule.changes.apply.immediately")}
          </p>
        {/if}
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-5">
        <!--
          The class's numbers and the machine's ceiling go into the "Personal
          notebooks" rule row: "as for the class" has to say HOW MUCH that is,
          and the list must not offer what the machine will not give.
        -->
        <RoomRulesRows
          rules={ruling.rules}
          busy={rulesBusy}
          own={{
            roomMemoryMb: ruling.memoryMb ?? resources?.kernel.defaultMemoryMb ?? null,
            roomCpus: ruling.cpus ?? resources?.kernel.defaultCpus ?? null,
            maxMemoryMb: resources?.limits.max ?? null,
            maxCpus: resources?.limits.cpus.max ?? null,
          }}
          onchange={(patch) => void setRule(ruling as AdminSeminar, patch)}
        />

        <!--
          The same section and the same component as in the new class form.

          A setting that is named differently and computed differently in two
          places is two settings; here, on top of that, it applies to a LIVE
          room, and that is exactly why people come here: the kernel was
          killed for memory, the class is going on, and gigabytes have to be
          added now.
        -->
        <div class="border-t border-line-soft py-4">
          <h3 class="text-ui font-semibold text-ink">{tr('admin.resources.title')}</h3>
          <p class="mb-3 mt-1.5 text-2xs text-muted">{tr('admin.resources.description')}</p>
          <Resources
            {resources}
            loading={resourcesLoading}
            environment={ruling.environment ?? ''}
            memoryMb={ruling.memoryMb ?? null}
            cpus={ruling.cpus ?? null}
            busy={memoryBusy}
            refusal={memoryError}
            roomId={ruling.id}
            onmemory={(mb) => void setMemory(ruling as AdminSeminar, mb)}
            oncpus={(cores) => void setCpus(ruling as AdminSeminar, cores)}
          />
        </div>
      </div>
      <div class="flex items-center gap-3 border-t border-line px-5 py-3">
        <p class={cn('min-w-0 flex-1 text-2xs', rulesError ? 'text-danger' : 'text-muted')}>
          {#if rulesError}
            {rulesError}
          {:else}
            {tr("admin.changes.apply.immediately.participants.do.not.need.to.sign.in.aga")}
            <!-- While the class is over, what is chosen here has no effect: the end of
                 class is laid over the rules and does not touch the setting
                 (shared/rules.ts · rulesAfterClass). Without this line the list reads
                 as untrue — in the room everything is teacher-only, while it says
                 otherwise here — and the teacher goes to fix what is not broken. -->
            {#if ruling.finishedAt}
              <span class="text-ink">
                {tr("admin.the.class.has.ended.the.selected.student.permissions.will.take.ef")}
              </span>
            {/if}
          {/if}
        </p>
        <button
          type="button"
          class="btn-primary shrink-0"
          onclick={() => {
            ruling = null
            rulesErrorText = null
          }}
        >
          {tr("admin.done")}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if doomed}
  <!-- Nothing is painted before the server agrees: this is the one action on
       the screen that cannot be put back if the request never lands. -->
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="delete-seminar-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="delete-seminar-title" class="text-title font-semibold text-ink">
        {tr('admin.seminar.deleteHeading', { name: doomed.name })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr("admin.this.deletes.the.notebook")}{count(doomed.cellCount, 'cell')}{tr("admin.and")} {count(
          doomed.fileCount,
          'file',
        )} {tr("admin.in.its.workspace")}
        {#if !doomed.publication}
          {tr("admin.you.cannot.restore.the.seminar.through.colloq.after.deletion")}
        {/if}
      </p>

      <!--
        The publication is the second copy of the notebook: cells and outputs
        given to everyone by a direct link. Promising "there is no second copy"
        next to it would be lying in exactly the case people delete for most
        often: taking down what was published.
      -->
      {#if doomed.publication}
        <label class="mt-3 flex cursor-pointer items-start gap-2.5 border border-line p-3">
          <input
            type="checkbox"
            bind:checked={dropReading}
            disabled={deleteBusy}
            class="mt-0.5 accent-accent"
          />
          <span class="text-ui leading-relaxed text-muted">
            {tr("admin.delete.the.public.page.as.well")}
            <span class="font-mono text-code text-ink">/p/{addressOf(doomed.publication)}</span>{tr("admin.a.second.copy.of.the.notebook.in")} {count(doomed.publication.steps, 'step')}{tr("admin.outputs.included")}
            {#if dropReading}
              {tr("admin.the.link.the.class.was.given.stops.opening")}
            {:else}
              {tr("admin.the.publication.is.retained.with.its.current.visibility")}
            {/if}
          </span>
        </label>
      {/if}
      {#if doomed.liveCount > 0}
        <p class="mt-2 text-ui font-medium text-warning">
          {doomed.liveCount === 1
            ? tr("admin.someone.is.in.the.room.right.now")
            : tr("admin.people.are.in.the.room.right.now", { p0: doomed.liveCount })} {tr("admin.deleting.the.seminar.will.disconnect.them")}
        </p>
      {/if}
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr("admin.archiving.removes.the.seminar.from.the.active.list.and.keeps.its")}
      </p>

      {#if deleteError}
        <p class="mt-3 text-ui text-danger">{tr("admin.could.not.delete.the.seminar")} {deleteError}</p>
      {/if}

      <div class="mt-5 flex justify-end gap-2">
        <button
          bind:this={cancelButton}
          type="button"
          class="btn-outline"
          disabled={deleteBusy}
          onclick={() => (doomed = null)}
        >
          {tr("admin.cancel")}
        </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 active:brightness-95"
          disabled={deleteBusy}
          onclick={() => void destroy()}
        >
          {#if deleteBusy}
            <Icon name="spinner" size={15} class="animate-spin" />
            {tr("admin.deleting")}
          {:else}
            <Icon name="trash" size={15} />
            {tr("admin.delete.seminar")}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}
