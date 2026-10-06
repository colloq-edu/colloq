<script lang="ts">
  import RowsSkeleton from '@/components/ui/RowsSkeleton.svelte'
  import { tr, getLocale } from '@shared/i18n'
  import { onMount } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Check from '@/admin/ui/Check.svelte'
  import EmptyState from '@/admin/ui/EmptyState.svelte'
  import SearchField from '@/admin/ui/SearchField.svelte'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { people, ruleRefusal, runningLine } from '@/admin/panel'
  import { localDay, twoDigits } from '@/admin/course-plan'
  import { courseColor } from '@/admin/course-color'
  import {
    SCOPE_KEY,
    folderCounts,
    groupRows,
    inFolder,
    matches,
    phaseForTabs,
    railCourses,
    readScope,
    seatsOf,
    tabCounts,
    type Folder,
    type ListRow,
    type StatusTab,
  } from '@/admin/seminar-list'
  import { seminarLink } from '@/lib/seminar-link'
  import { cn } from '@/lib/utils'
  import {
    LIMITS,
    type AdminSeminar,
    type InstanceResources,
    type ListScope,
    type MemberTeacher,
    type TeacherRef,
    type TeacherWithCourses,
  } from '@shared/admin'
  import { MAX_COURSE_NAME, type Course } from '@shared/publish'
  import { formatDay } from '@shared/class-day'
  import { colorForId } from '@shared/protocol'
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
   *
   * Since 0.19 the list is the viewer's, not the instance's: a teacher gets
   * the rooms they teach (their own and their courses'), an owner gets the
   * same by default and the whole instance behind «Все». It is read the way
   * a teacher thinks about it — folders on the left (all, outside any course,
   * each course, the archive), what is on now / ahead / behind in the tabs,
   * and rows grouped by course. Which room lands where is decided in
   * admin/seminar-list.ts, so every number on the screen comes from one place.
   */

  let seminars = $state<AdminSeminar[]>([])
  /**
   * The courses for the rail and the group headers: names, teachers, and the
   * rows that give a room its «05» and its class day.
   *
   * An owner always reads every course, whichever scope the rooms are in: a
   * room the owner teaches can sit in a course the owner does not, and
   * without that course's rows the room lost its number and its class day on
   * «Мои». The rail still lists only the owner's courses there (`rail`).
   */
  let courses = $state<Course[]>([])
  let loading = $state(true)
  let loadErrorText = $state<(() => string | null) | null>(null)
  const loadError = $derived(loadErrorText?.() ?? null)
  let query = $state('')
  /** Ticks with the poll below so "started 12 min ago" does not freeze at 12. */
  let now = $state(Date.now())
  /**
   * «Сегодня» for the tabs and the date column. The browser's day: the list
   * has no single instance day to ask for (the course screen asks per
   * course), and a day's difference at midnight in another zone moves a row
   * between two tabs, not out of the list.
   */
  const today = $derived(localDay(now))

  interface Props {
    /**
     * Hands over to the full New seminar screen; `folder` is the course id
     * (or 'none' for «Без курса») the form should start on.
     */
    onfull?: (folder?: string | null) => void
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
    /**
     * The panel's router: a course from a group header, a new room already
     * aimed at a course (/admin/new?course=<id>), a course just created from
     * the rail. Optional so the screen still renders without it; the links
     * then fall back to the plain New seminar step.
     */
    navigate?: (path: string) => void
  }

  let { onfull, arrived = null, onarrived, onpublish, navigate }: Props = $props()

  /* --------------------------------------------------------------- scope */

  const owner = $derived(adminAuth.isOwner)
  /**
   * «Мои» or «Все» — an owner's choice, remembered on this browser.
   *
   * Only an owner has the toggle; for a teacher this is always 'mine', and
   * readScope says so even when the browser remembers 'all' from a time this
   * person was an owner, so they never ask for a list the server refuses.
   */
  let scope = $state<ListScope>(
    readScope(() => localStorage.getItem(SCOPE_KEY), adminAuth.isOwner),
  )
  /**
   * The «Все» number while «Мои» is open. Known only once «Все» has been
   * loaded in this tab: counting the whole instance just to print one figure
   * is the very request the scoped list exists to avoid. Until then the
   * toggle shows the word without a number rather than a guess.
   */
  let allCount = $state<number | null>(null)

  function chooseScope(next: ListScope): void {
    if (scope === next) return
    scope = next
    try {
      localStorage.setItem(SCOPE_KEY, next)
    } catch {
      // A private window or blocked storage: the choice holds for this tab.
    }
    // A course folder from the other scope may not exist in this one.
    folder = 'all'
    // A response for the old scope is about a different list.
    generation += 1
    void load()
  }

  /* ------------------------------------------------------------- folders */

  let folder = $state<Folder>('all')
  let tab = $state<StatusTab>('all')

  const seats = $derived(seatsOf(courses))
  const counts = $derived(folderCounts(seminars))
  const rail = $derived(
    railCourses(scope === 'all' ? courses : courses.filter((c) => c.mine !== false), seminars),
  )
  const courseById = $derived(new Map(courses.map((course) => [course.id, course])))
  /** «Мои N»: rooms the viewer teaches, whichever scope is loaded. */
  const mineCount = $derived(seminars.filter((s) => s.mine && !s.archivedAt).length)

  const needle = $derived(query.trim().toLowerCase())
  /** The folder's rooms, before search and tab: the footer's "of N". */
  const folderRooms = $derived(seminars.filter((s) => inFolder(s, folder)))
  const searched = $derived(folderRooms.filter((s) => matches(s, needle)))
  const tabs = $derived(tabCounts(searched, seats, today))
  const shown = $derived(
    tab === 'all' ? searched : searched.filter((s) => phaseForTabs(s, seats, today) === tab),
  )
  const groups = $derived(groupRows(shown, rail, seats, folder, today))

  /*
   * A folder that is no longer there is not left selected over an empty list.
   * The archive empties when its last room is moved back; a course leaves
   * the rail when the scope changes or the viewer is taken off it.
   */
  $effect(() => {
    if (loading) return
    if (folder === 'archive' && counts.archive === 0) folder = 'all'
    else if (folder.startsWith('course:') && !rail.some((c) => `course:${c.id}` === folder)) folder = 'all'
  })

  /**
   * A teacher nobody has put anywhere yet (U5b): no course and no room. The
   * screen says what will happen and offers the two ways forward, instead of
   * a rail of empty folders over an empty table.
   */
  const untouched = $derived(
    !loading && !loadError && !owner && seminars.length === 0 && courses.length === 0,
  )

  /**
   * Open the New seminar form aimed at a course, or at no course ('none').
   * &from=list: the form was opened from this list, so the way back after
   * creating is the list with the new room highlighted, not the course page
   * (AdminScreen.svelte · newRoomFrom).
   */
  function newIn(course: string): void {
    if (navigate) navigate(`/admin/new?course=${encodeURIComponent(course)}&from=list`)
    else onfull?.(course)
  }

  function startCreate(): void {
    if (onfull) onfull()
    else navigate?.('/admin/new')
  }

  /*
   * «+ Новый курс» right in the rail: a name is all a course needs to exist,
   * and the course screen is where the rest of it (plan, teachers, address)
   * is set up, so creating lands there.
   */
  let newCourseOpen = $state(false)
  let newCourseName = $state('')
  let newCourseBusy = $state(false)
  let newCourseErrorText = $state<(() => string) | null>(null)
  const newCourseError = $derived(newCourseErrorText?.() ?? null)

  async function createCourse(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const name = newCourseName.trim()
    if (!name || newCourseBusy) return
    newCourseBusy = true
    newCourseErrorText = null
    try {
      const course = await adminApi.createCourse({ name })
      if (navCounts.courses !== null) navCounts.courses += 1
      newCourseOpen = false
      newCourseName = ''
      if (navigate) navigate(`/admin/courses/${course.id}`)
      else void load()
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      newCourseErrorText = () => tr('admin.seminars.list.folder.newCourseFailed', { reason: explain(cause) })
    } finally {
      newCourseBusy = false
    }
  }

  function openNewCourse(): void {
    newCourseOpen = true
    newCourseErrorText = null
  }

  /* ---------------------------------------------------------------- rows */

  /** The class day as a row prints it: «сегодня», «вс, 18 окт», a year when not this one. */
  function dayLabel(row: ListRow): string {
    if (row.day === today) return tr('admin.seminars.list.row.today')
    return formatDay(row.day, getLocale(), { year: row.day.slice(0, 4) !== today.slice(0, 4) })
  }

  /** Whether a room teacher is the signed-in person. By id: names are not unique. */
  const isMe = (ref: TeacherRef): boolean => ref.id === me?.id

  /**
   * «автор: Лера В.» — or «вы». `createdBy` is a display name written at
   * creation, so «вы» needs the id as well: a namesake must not read as you.
   */
  function authorOf(seminar: AdminSeminar): string | null {
    if (!seminar.createdBy) return null
    const mine = seminar.createdBy === me?.name && seminar.teachers.some(isMe)
    return mine ? tr('admin.seminars.list.row.you') : seminar.createdBy
  }

  /** The room's other own teachers: everyone in room_teachers but the author. */
  function coTeachersOf(seminar: AdminSeminar): string[] {
    let authorSkipped = false
    const out: string[] = []
    for (const ref of seminar.teachers) {
      if (!authorSkipped && seminar.createdBy !== null && ref.name === seminar.createdBy) {
        authorSkipped = true
        continue
      }
      out.push(isMe(ref) ? tr('admin.seminars.list.row.you') : ref.name)
    }
    return out
  }

  /** «ведут: …» on a course group: the course's teachers, by name. */
  function courseTeachers(id: string): string[] {
    return (courseById.get(id)?.teachers ?? []).map((t) => t.name)
  }

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
      local(await adminApi.listSeminars(scope))
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
    // The folder and the tab are filters too: a new room is in «Все
    // занятия» and, before its class, under «Предстоят» — not necessarily in
    // the course or the tab that happened to be open.
    folder = 'all'
    tab = 'all'
    justCreatedId = arrived
    void load()
    onarrived?.()
  })

  let justCreatedId = $state<string | null>(null)

  let copiedId = $state<string | null>(null)
  let copyTimer: number | undefined

  let renamingId = $state<string | null>(null)
  let renameValue = $state('')

  /** At most one row is ever explaining itself; a second failure replaces the first. */
  let rowError = $state<{ id: string; message: () => string } | null>(null)
  /**
   * What happens to the class page after «Завершить занятие» pressed here:
   * the room's own dialog is not on this screen, so the row says it — and
   * offers the page screen when there is no page yet.
   */
  let rowNote = $state<{ id: string; message: () => string; publish: boolean } | null>(null)
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

  /**
   * The running banner: live rooms the viewer teaches. On an owner's «Все»
   * this keeps the plate to the owner's own classes — a dozen live rooms
   * across a university are the «Идут» tab's job, not a stack of banners
   * pushing the list below the fold.
   */
  const live = $derived(seminars.filter((s) => s.status === 'live' && s.mine))
  const canDelete = $derived(adminAuth.isOwner)
  /** The signed-in teacher: «вы» in the rows and in the teachers' chips. */
  const me = $derived(adminAuth.me?.teacher ?? null)

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
   * The sidebar's "Seminars 5" is this list's own number, so it is mirrored
   * from here rather than fetched twice — otherwise the count keeps standing
   * at the number it had before the row you just deleted. It is the «Мои»
   * number without the archive, the same figure the rail's toggle shows: an
   * owner looking at «Все» still sees how many classes are theirs, and the
   * shell counts the same way when this screen is not open (AdminShell).
   */
  $effect(() => {
    if (!loading) navCounts.seminars = mineCount
  })

  async function load(silent = false): Promise<void> {
    if (!silent) loading = true
    const started = generation
    const asked = scope
    try {
      /*
       * The courses ride along: the rail, the group headers and every row's
       * «05» come from them. Their failure costs the grouping its names and
       * numbers, not the list, so it does not fail the rooms.
       */
      const [list, courseList] = await Promise.all([
        adminApi.listSeminars(asked),
        adminApi.listCourses(owner ? 'all' : 'mine').catch(() => null),
      ])
      // Something changed on screen while the response was on its way. That
      // edit is newer.
      if (started !== generation || asked !== scope) return
      seminars = list
      if (courseList) courses = courseList
      if (asked === 'all') allCount = list.filter((s) => !s.archivedAt).length
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
      if (pickerOpen) {
        pickerOpen = false
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
    // "Someone else's" is now a fact from the server, not a name comparison:
    // a room the viewer does not teach. Only an owner's «Все» lists those.
    return !seminar.mine && seminar.liveCount > 0
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
    if (rowNote?.id === seminar.id) rowNote = null
    try {
      const updated = await adminApi.updateSeminar(seminar.id, { finished })
      replace(updated)
      const after = finished ? updated.afterClass : undefined
      if (after === 'offer') {
        rowNote = { id: seminar.id, message: () => tr('admin.seminar.finishedOffer'), publish: true }
      } else if (after === 'waiting') {
        rowNote = { id: seminar.id, message: () => tr('admin.seminar.finishedWaiting'), publish: false }
      } else if (after === 'refreshing') {
        rowNote = { id: seminar.id, message: () => tr('admin.seminar.finishedRefreshing'), publish: false }
      }
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

  /* ------------------------------------------------------------- settings */

  function openSettings(seminar: AdminSeminar): void {
    ruling = seminar
    memoryErrorText = null
    // Numbers from the last opening are numbers from the last minute: since
    // then someone else's room has been closed and memory freed. The window
    // opens with placeholders and waits for a fresh answer.
    resources = null
    readResources()
    hosts = null
    hostsErrorText = null
    pickerOpen = false
    pickerQuery = ''
    readHosts(seminar.id)
  }

  /* ---------------------------------------------------------------- hosts */

  /**
   * «Ведущие»: the room's own teachers (room_teachers).
   *
   * Read when the window opens, not carried by the list: the list has names
   * only, and the chips need emails for the picker and the server's own
   * order. The course's teachers are not here — they run the room through
   * the course, and the line under the chips names them.
   */
  let hosts = $state<MemberTeacher[] | null>(null)
  let hostsBusy = $state(false)
  let hostsErrorText = $state<(() => string) | null>(null)
  const hostsError = $derived(hostsErrorText?.() ?? null)
  /**
   * Everyone on the staff list, for the picker; asked for on first open, and
   * again on the next open after a failure (`staffFailed`): an empty list
   * kept from a failed request would read as «everyone already teaches it».
   */
  let staff = $state<TeacherWithCourses[] | null>(null)
  let staffFailed = $state(false)
  let pickerOpen = $state(false)
  let pickerQuery = $state('')

  const refsOf = (list: readonly MemberTeacher[]): TeacherRef[] =>
    list.map((t) => ({ id: t.id, name: t.name }))

  const candidates = $derived.by(() => {
    if (!staff || !hosts) return []
    const taken = new Set(hosts.map((t) => t.id))
    const q = pickerQuery.trim().toLowerCase()
    return staff
      .filter((t) => !taken.has(t.id))
      .filter((t) => !q || t.name.toLowerCase().includes(q) || t.email.toLowerCase().includes(q))
      .slice(0, 8)
  })
  /** Whether anyone at all is left to add, search aside. */
  const anyoneLeft = $derived(
    staff !== null && hosts !== null && staff.some((t) => !hosts!.some((h) => h.id === t.id)),
  )

  /** «Через курс «…» ведут: …» for each course that seats the room. */
  const viaCourses = $derived(
    (ruling?.courses ?? [])
      .map((ref) => ({ id: ref.id, name: ref.name, teachers: courseTeachers(ref.id) }))
      .filter((c) => c.teachers.length > 0),
  )

  function readHosts(id: string): void {
    void adminApi
      .roomTeachers(id)
      .then((list) => {
        if (ruling?.id === id) hosts = list
      })
      .catch((cause: unknown) => {
        noteDeadCookie(cause)
        if (ruling?.id === id) {
          hostsErrorText = () => tr('admin.seminars.list.hosts.failed', { reason: explain(cause) })
        }
      })
  }

  function openPicker(): void {
    pickerOpen = !pickerOpen
    pickerQuery = ''
    if (staff === null) {
      staffFailed = false
      void adminApi
        .listTeachers()
        .then((list) => (staff = list))
        .catch((cause: unknown) => {
          noteDeadCookie(cause)
          staffFailed = true
          hostsErrorText = () => tr('admin.seminars.list.hosts.failed', { reason: explain(cause) })
        })
    }
  }

  /** The new list of teachers lands in the window and in the row under it. */
  function settleHosts(id: string, list: MemberTeacher[]): void {
    hosts = list
    const teachers = refsOf(list)
    patch(id, { teachers })
    if (ruling?.id === id) ruling = { ...ruling, teachers }
  }

  async function addHost(staffId: string): Promise<void> {
    const room = ruling
    if (!room || hostsBusy) return
    hostsBusy = true
    hostsErrorText = null
    try {
      settleHosts(room.id, await adminApi.addRoomTeacher(room.id, staffId))
      pickerOpen = false
      pickerQuery = ''
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      hostsErrorText = () => tr('admin.seminars.list.hosts.failed', { reason: explain(cause) })
    } finally {
      hostsBusy = false
    }
  }

  /**
   * Take someone off the room. The server keeps the last own teacher of a
   * room outside any course (409, said in the window) unless an owner asks.
   * Taking yourself off may take the room out of your list — and out of the
   * window — so that case re-reads the list rather than patching a row the
   * viewer may no longer be allowed to see. An owner keeps the window (they
   * still see the room) but re-reads too: the row's `mine`, «Мои N» and the
   * sidebar count all change with it.
   */
  async function removeHost(staffId: string): Promise<void> {
    const room = ruling
    if (!room || hostsBusy) return
    hostsBusy = true
    hostsErrorText = null
    try {
      const list = await adminApi.removeRoomTeacher(room.id, staffId)
      if (staffId === me?.id && !owner) {
        ruling = null
        void load()
      } else {
        settleHosts(room.id, list)
        if (staffId === me?.id) void load()
      }
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      hostsErrorText = () => tr('admin.seminars.list.hosts.failed', { reason: explain(cause) })
    } finally {
      hostsBusy = false
    }
  }
</script>

<AdminPage title={tr("admin.seminars")} subtitle={tr('admin.seminars.lede')}>
  {#snippet actions()}
    <!--
      An empty instance gets one path, not three. The search has nothing to
      search and the button in the corner duplicates the one in the middle of
      the page, which is where the eye already is.
    -->
    {#if seminars.length > 0}
    <!--
      On a phone the header is a full-width column.

      The search and the button next to it fit in a line that a 390px screen
      does not have: the rail takes 56, the page margins another 56, and 278
      is left for everything. Stacked at their content widths they were two
      short stubs at the left edge, so each takes the whole line there, at
      the panel's 44px finger height. The search is the panel's shared field
      (admin/ui/SearchField), the same box the competitions tab has.

      The «Архив» checkbox that stood between them is a folder in the rail
      now: a place you go to, rather than a filter people forgot was on.
    -->
    <SearchField
      label={tr("admin.search.seminars.by.name")}
      placeholder={tr("admin.search.seminars")}
      bind:value={query}
      class="max-[640px]:w-full"
    />
    <button
      type="button"
      onclick={startCreate}
      class="btn-primary btn-caps gap-2 px-4 max-[640px]:h-11 max-[640px]:w-full"
    >
      <Icon name="plus" size={14} />
      {tr("admin.new.seminar")}
    </button>
    {/if}
  {/snippet}

  {#if untouched}
    <!--
      U5b: a teacher nobody has added anywhere yet. Not "no classes yet" over
      an empty table: the honest answer is that courses come from other
      people, and a room outside any course is theirs to make right now.
    -->
    <section class="mt-7 border border-line bg-surface p-7 max-[640px]:p-5">
      <h2 class="text-title font-bold text-ink">{tr('admin.seminars.list.empty.title')}</h2>
      <p class="mt-2.5 max-w-[620px] text-ui leading-relaxed text-muted">
        {tr('admin.seminars.list.empty.hint')}
      </p>
      <!-- «Создать курс» opens the name field right here (the rail's own
           form, `createCourse`), which lands on the new course: sending a
           newcomer to an empty courses list to find the create button again
           was one step too many. -->
      {#if newCourseOpen}
        <form class="mt-5 flex max-w-[480px] flex-col gap-2" onsubmit={createCourse}>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            bind:value={newCourseName}
            class="field"
            placeholder={tr('admin.seminars.list.folder.newCourseName')}
            aria-label={tr('admin.seminars.list.folder.newCourseName')}
            maxlength={MAX_COURSE_NAME}
            autocomplete="off"
            autofocus
            onkeydown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                newCourseOpen = false
              }
            }}
          />
          <div class="flex items-center gap-2">
            <button type="submit" class="btn-primary" disabled={!newCourseName.trim() || newCourseBusy}>
              {#if newCourseBusy}<Icon name="spinner" size={14} class="animate-spin" />{/if}
              {tr('admin.seminars.list.folder.newCourseCreate')}
            </button>
            <button type="button" class="btn-ghost" onclick={() => (newCourseOpen = false)}>
              {tr('admin.cancel')}
            </button>
          </div>
          {#if newCourseError}
            <p class="text-2xs text-danger" role="alert">{newCourseError}</p>
          {/if}
        </form>
      {:else}
        <div class="mt-5 flex flex-wrap gap-2.5">
          <button type="button" class="btn-primary btn-caps gap-2 px-4 max-[640px]:h-11" onclick={() => newIn('none')}>
            {tr('admin.seminars.list.empty.room')}
          </button>
          <button type="button" class="btn-outline max-[640px]:h-11" onclick={openNewCourse}>
            {tr('admin.seminars.list.empty.course')}
          </button>
        </div>
      {/if}
    </section>
  {:else}
  <!--
    Two columns: the folders and the list. The pair is pulled over the page's
    own margins (-mx-7) so the rail's rule runs from the header to the
    bottom the way the artboard draws it, and each column puts the 28px back
    on its own side.

    Below 1100 the rail goes on top as a row of chips. At 1024 the panel's
    own sidebar plus a 248px rail left the table 540px, under its 600px
    floor, and the list scrolled sideways inside a laptop screen.
  -->
  <div class="-mx-7 flex min-h-full max-[1099px]:flex-col">
    <nav
      aria-label={tr('admin.seminars.list.folders.label')}
      class="w-[248px] shrink-0 border-r border-line py-5 pl-7 pr-4
             max-[1099px]:w-auto max-[1099px]:border-b max-[1099px]:border-r-0 max-[1099px]:px-7
             max-[1099px]:py-3"
    >
      <div class="sticky top-5 flex flex-col gap-5 max-[1099px]:static max-[1099px]:gap-3">
        {#if owner}
          <!-- Only an owner has a choice to make here: a teacher's list is
               always their own, and a toggle with one live side is noise. -->
          <div
            role="group"
            aria-label={tr('admin.seminars.list.scope.label')}
            class="flex border border-brand max-[1099px]:w-fit"
          >
            {#each [{ value: 'mine', label: tr('admin.seminars.list.scope.mine'), n: loading && scope === 'mine' ? null : mineCount }, { value: 'all', label: tr('admin.seminars.list.scope.all'), n: scope === 'all' && !loading ? counts.all : allCount }] as side (side.value)}
              {@const on = scope === side.value}
              <button
                type="button"
                aria-pressed={on}
                class={cn(
                  'flex h-8 flex-1 items-center justify-center gap-1.5 px-4 text-ui transition-colors duration-100',
                  'max-[640px]:h-11',
                  on ? 'bg-brand font-bold text-white' : 'text-brand hover:bg-raised',
                )}
                onclick={() => chooseScope(side.value as ListScope)}
              >
                {side.label}
                {#if side.n !== null}
                  <span class={cn('font-mono text-2xs font-normal tabular-nums', on ? 'text-white/70' : 'text-muted')}>{side.n}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}

        <!--
          One list of folders. On a desktop it is a column with a «Мои
          курсы» heading; on a narrow screen the same buttons wrap into a
          row of chips and the heading steps aside — the squares still say
          which ones are courses.
        -->
        <ul class="flex flex-col gap-0.5 max-[1099px]:flex-row max-[1099px]:flex-wrap max-[1099px]:gap-1.5">
          {#snippet folderButton(key: Folder, label: string, n: number, swatch: string | null)}
            {@const on = folder === key}
            <li class="min-w-0">
              <button
                type="button"
                aria-current={on ? 'true' : undefined}
                class={cn(
                  'flex min-h-[34px] w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-ui text-ink',
                  'transition-colors duration-100 hover:bg-raised',
                  'max-[1099px]:w-auto max-[1099px]:border max-[1099px]:border-line max-[640px]:min-h-[44px]',
                  on && 'bg-raised font-bold max-[1099px]:border-ink',
                )}
                onclick={() => (folder = key)}
              >
                {#if swatch}
                  <span class="h-2 w-2 shrink-0" style:background={swatch}></span>
                {/if}
                <span class="min-w-0 flex-1 leading-[18px]">{label}</span>
                <span class={cn('shrink-0 font-mono text-2xs tabular-nums text-muted', on && 'font-bold')}>{n}</span>
              </button>
            </li>
          {/snippet}

          {@render folderButton('all', tr('admin.seminars.list.folder.all'), counts.all, null)}
          {@render folderButton('none', tr('admin.seminars.list.folder.none'), counts.none, null)}

          <li class="px-2.5 pb-1.5 pt-4 max-[1099px]:hidden">
            <span class="admin-label">
              {owner && scope === 'all'
                ? tr('admin.seminars.list.folder.courses')
                : tr('admin.seminars.list.folder.myCourses')}
            </span>
          </li>
          {#each rail as course (course.id)}
            {@render folderButton(
              `course:${course.id}`,
              course.name,
              counts.courses.get(course.id) ?? 0,
              courseColor(course.id),
            )}
          {/each}

          <li class="min-w-0">
            {#if newCourseOpen}
              <form class="flex flex-col gap-1.5 px-2.5 py-1.5" onsubmit={createCourse}>
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  bind:value={newCourseName}
                  class="field"
                  placeholder={tr('admin.seminars.list.folder.newCourseName')}
                  aria-label={tr('admin.seminars.list.folder.newCourseName')}
                  maxlength={MAX_COURSE_NAME}
                  autocomplete="off"
                  autofocus
                  onkeydown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation()
                      newCourseOpen = false
                    }
                  }}
                />
                <div class="flex items-center gap-2">
                  <button type="submit" class="btn-primary" disabled={!newCourseName.trim() || newCourseBusy}>
                    {#if newCourseBusy}<Icon name="spinner" size={14} class="animate-spin" />{/if}
                    {tr('admin.seminars.list.folder.newCourseCreate')}
                  </button>
                  <button type="button" class="btn-ghost" onclick={() => (newCourseOpen = false)}>
                    {tr('admin.cancel')}
                  </button>
                </div>
                {#if newCourseError}
                  <p class="text-2xs text-danger" role="alert">{newCourseError}</p>
                {/if}
              </form>
            {:else}
              <button
                type="button"
                class="flex min-h-[34px] items-center px-2.5 text-ui text-accent-text hover:underline max-[640px]:min-h-[44px]"
                onclick={openNewCourse}
              >
                {tr('admin.seminars.list.folder.newCourse')}
              </button>
            {/if}
          </li>

          {#if counts.archive > 0}
            <li class="mt-3 border-t border-line pt-3 max-[1099px]:mt-0 max-[1099px]:border-t-0 max-[1099px]:pt-0">
              <ul>
                {@render folderButton('archive', tr('admin.seminars.list.folder.archive'), counts.archive, null)}
              </ul>
            </li>
          {/if}
        </ul>

        <p class="border-t border-line px-2.5 pt-3 text-2xs text-muted max-[1099px]:hidden">
          {owner ? tr('admin.seminars.list.folder.noteOwner') : tr('admin.seminars.list.folder.noteTeacher')}
        </p>
      </div>
    </nav>

    <div class="min-w-0 flex-1 px-7">
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
        <p class="admin-label flex items-center gap-[7px] whitespace-nowrap text-accent-text">
          <span class="h-[7px] w-[7px] shrink-0 rounded-full bg-accent"></span>
          {tr("admin.running.now")}
        </p>
        <!-- Two clamped lines, not one: on a phone a single line holds a
             third of a seminar's title, and "Machine learning and data
             anal…" cannot be told from a neighbour that starts the same. -->
        <h2
          class="truncate text-title font-semibold text-ink
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
            'flex h-10 items-center gap-2 border border-line bg-canvas px-3 font-mono text-2xs',
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
          class="btn btn-caps bg-accent px-4 text-accent-ink hover:brightness-110 max-[640px]:h-11
                 max-[640px]:shrink-0"
        >
          {tr("admin.open")}
        </a>
      </div>
    </section>
  {/each}

  {#if loadError}
    <div class="flex flex-wrap items-center gap-3 py-4">
      <p class="min-w-0 flex-1 text-ui text-danger" role="alert">
        {tr("admin.could.not.load.seminars")} {loadError}
      </p>
      <button type="button" class="btn-outline shrink-0" onclick={() => void load()}>
        {tr("admin.try.again")}
      </button>
    </div>
  {/if}

      <!--
        The tabs: on now, ahead, behind. Counted over the open folder and the
        search, so «Предстоят 2» is two rows you will see when you press it.
      -->
      <div
        role="tablist"
        aria-label={tr('admin.seminars.list.tabs.label')}
        class="mt-4 flex items-center gap-6 overflow-x-auto border-b border-line max-[640px]:gap-4"
      >
        {#each [{ value: 'all', label: tr('admin.seminars.list.tab.all') }, { value: 'running', label: tr('admin.seminars.list.tab.running') }, { value: 'upcoming', label: tr('admin.seminars.list.tab.upcoming') }, { value: 'past', label: tr('admin.seminars.list.tab.past') }] as item (item.value)}
          {@const on = tab === item.value}
          <button
            type="button"
            role="tab"
            aria-selected={on}
            class={cn(
              '-mb-px flex shrink-0 items-baseline gap-1.5 whitespace-nowrap border-b-[3px] pb-2.5 pt-2 text-ui',
              'transition-colors duration-100 max-[640px]:min-h-[44px]',
              on ? 'border-ink font-bold text-ink' : 'border-transparent text-muted hover:text-ink',
            )}
            onclick={() => (tab = item.value as StatusTab)}
          >
            {item.label}
            <span class="font-mono text-2xs tabular-nums">{tabs[item.value as StatusTab]}</span>
          </button>
        {/each}
      </div>

      <!--
        The columns after the name are fixed and add up to 392px, and
        table-fixed hands the name whatever is left. The min-width is those
        pixels plus a lane a name can be read in; below it the table scrolls
        inside this box, so the page itself never moves sideways.
      -->
      <!--
        Below 640 there is no table — there are row cards.

        The cards are not a second markup but this same one unlocked: `table`,
        `tbody` and `tr` become blocks and flex, `thead` goes away, the cells are
        laid out with `order` — title and menu on the first line, number,
        date, joined and state on the second. A second markup would mean two
        lists of actions, and one day one of them would fall behind the other —
        and the row menu holds "Delete".

        One `tbody` per group: a group is a header row and its rooms, and the
        header is a row of the same table so its rule lines up with theirs.
      -->
      <div class="-mx-1 overflow-x-auto px-1">
      <table class="w-full min-w-[600px] table-fixed max-[640px]:block max-[640px]:min-w-0">
        <colgroup class="max-[640px]:hidden">
          <col class="w-11" />
          <col />
          <col class="w-[110px]" />
          <col class="w-[74px]" />
          <col class="w-[124px]" />
          <col class="w-10" />
        </colgroup>
        <!--
          The artboard has no column headings: the group header is the line
          above the rows, and the date, the head-count and the badge read on
          their own. They stay for a screen reader, which reads a table by
          its headings.
        -->
        <thead class={cn('max-[640px]:hidden', 'sr-only')}>
          <tr>
            <th scope="col">{tr('admin.seminars.list.row.number')}</th>
            <th scope="col">{tr("admin.seminar")}</th>
            <th scope="col">{tr("admin.date")}</th>
            <!--
              "Joined", not "People". This column is everyone who ever joined; the
              banner above it counts who is connected right now.
            -->
            <th scope="col">{tr("admin.joined")}</th>
            <th scope="col">{tr("admin.status")}</th>
            <th scope="col">{tr("admin.actions")}</th>
          </tr>
        </thead>
        {#each groups as group (group.key)}
          <tbody class="max-[640px]:block">
            <tr class="max-[640px]:block">
              <td colspan="6" class="pt-5 max-[640px]:block">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink pb-2.5">
                  {#if group.course}
                    {@const course = group.course}
                    {@const teachers = courseTeachers(course.id)}
                    <!-- The course's square: the same colour as its folder here, its
                         card on «Новое занятие» and its chip on «Преподаватели»
                         (admin/course-color.ts). -->
                    <span class="h-2.5 w-2.5 shrink-0" style:background={courseColor(course.id)}></span>
                    <h2 class="min-w-0 max-w-full truncate text-title font-bold text-ink">{course.name}</h2>
                    <span class="font-mono text-2xs tabular-nums text-muted">{group.rows.length}</span>
                    {#if teachers.length > 0}
                      <span class="min-w-0 text-ui text-muted">
                        {tr('admin.seminars.list.group.teach', { names: teachers.join(', ') })}
                      </span>
                    {/if}
                    <span class="flex-1"></span>
                    <a
                      href={`/admin/courses/${course.id}`}
                      class="text-ui text-accent-text hover:underline max-[640px]:py-2.5"
                      onclick={(event) => {
                        if (!navigate || event.metaKey || event.ctrlKey || event.shiftKey) return
                        event.preventDefault()
                        navigate(`/admin/courses/${course.id}`)
                      }}
                    >
                      {tr('admin.seminars.list.group.course')}
                    </a>
                    {#if folder !== 'archive'}
                      <button
                        type="button"
                        class="text-ui text-accent-text hover:underline max-[640px]:py-2.5"
                        onclick={() => newIn(course.id)}
                      >
                        {tr('admin.seminars.list.group.add')}
                      </button>
                    {/if}
                  {:else}
                    <span class="h-2.5 w-2.5 shrink-0 border-[1.5px] border-dashed border-faint"></span>
                    <h2 class="text-title font-bold text-ink">{tr('admin.seminars.list.folder.none')}</h2>
                    <span class="font-mono text-2xs tabular-nums text-muted">{group.rows.length}</span>
                    <!-- Not on an owner's «Все»: there the group holds every room
                         outside courses, not only rooms "seen by their author". -->
                    {#if !(owner && scope === 'all')}
                      <span class="min-w-0 text-ui text-muted">{tr('admin.seminars.list.group.noneHint')}</span>
                    {/if}
                    <span class="flex-1"></span>
                    {#if folder !== 'archive'}
                      <button
                        type="button"
                        class="text-ui text-accent-text hover:underline max-[640px]:py-2.5"
                        onclick={() => newIn('none')}
                      >
                        {tr('admin.seminars.list.group.addNone')}
                      </button>
                    {/if}
                  {/if}
                </div>
              </td>
            </tr>
            {#if group.rows.length === 0}
              <tr class="border-b border-line max-[640px]:block">
                <td colspan="6" class="py-3.5 text-ui text-muted max-[640px]:block">
                  {tr('admin.seminars.list.group.empty')}
                </td>
              </tr>
            {/if}
      {#each group.rows as row (`${group.key}:${row.seminar.id}`)}
        {@const seminar = row.seminar}
        {@const fresh = seminar.id === justCreatedId}
        {@const author = authorOf(seminar)}
        {@const others = coTeachersOf(seminar)}
        <!--
          Below 640 a row is a card: `order` gathers it into two lines, and
          the `basis` of the first hands out exactly 100% (the title + 44px
          for the menu), so the other cells wrap instead of shrinking to a
          single letter.
        -->
        <tr
          class={cn(
            'group border-b border-line',
            'max-[640px]:flex max-[640px]:flex-wrap max-[640px]:items-center max-[640px]:py-1',
            fresh && 'bg-accent/10',
          )}
        >
          <!--
            «05»: the room's number in this course's plan, the same two digits
            the course page prints. Empty outside a course — a number there
            would be a position in nothing. On a phone it opens the card's
            second line, in front of the date it belongs with.
          -->
          <td
            class="py-3.5 pr-2 align-top font-mono text-ui text-muted max-[640px]:order-3 max-[640px]:pb-2.5
                   max-[640px]:pt-0 {row.n === null ? 'max-[640px]:hidden' : ''}"
            title={row.n !== null ? tr('admin.seminars.list.row.number') : undefined}
          >
            {row.n !== null ? twoDigits(row.n) : ''}
          </td>
          <td
            class="py-3.5 pr-4 align-top max-[640px]:order-1 max-[640px]:min-w-0
                   max-[640px]:basis-[calc(100%_-_44px)] max-[640px]:py-2 max-[640px]:pr-2"
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
                class="admin-row-title block hover:underline max-[640px]:line-clamp-2
                       min-[641px]:truncate"
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
                  'admin-meta flex -my-1 items-center gap-1.5 py-1 font-mono transition-colors duration-100',
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
                <span class="admin-meta whitespace-nowrap">{tr("admin.link.not.shared.yet")}</span>
              {/if}
              {#if seminar.archivedAt}
                <span class="admin-meta whitespace-nowrap">{tr("admin.archived")}</span>
              {/if}
              <!--
                Who set up the room, and who else runs it. The list used to
                say "by Maria" and stop: on a shared instance that was the
                only hint whose room it was. Now the room's own teachers are
                a fact on the server (room_teachers), so the line names them
                — and says «вы» where it is you, by id, not by a name that a
                namesake shares.
              -->
              {#if author}
                <span class="admin-meta whitespace-nowrap">{tr('admin.seminars.list.row.author', { name: author })}</span>
              {/if}
              {#if others.length > 0}
                <span class="admin-meta">
                  {author ? '· ' : ''}{others.length === 1
                    ? tr('admin.seminars.list.row.coTeachOne', { names: others[0] })
                    : tr('admin.seminars.list.row.coTeachMany', { names: others.join(', ') })}
                </span>
              {/if}
              {#if seminar.liveCount > 0}
                <span class="admin-meta whitespace-nowrap">· {tr('admin.seminars.list.row.inRoom', { count: seminar.liveCount })}</span>
              {/if}
              <!-- The course is the group this row is drawn under, so it is
                   not repeated here; the page is a fact about this room. -->
              {#if seminar.publication?.state === 'published'}
                <!-- The page link the course table draws (Courses.svelte · c-page):
                     the same words, the same dashed accent, so a page reads as one
                     thing on both lists. The dot stays outside the underline. -->
                <span class="admin-meta whitespace-nowrap">
                  ·
                  <a
                    class="border-b border-dashed border-accent-text text-accent-text"
                    href={`/p/${addressOf(seminar.publication)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {tr('admin.course.page.page', { count: seminar.publication.materials })}
                  </a>
                </span>
              {:else if seminar.publication}
                <span class="admin-meta whitespace-nowrap">{tr("admin.page.taken.down")}</span>
              {/if}
            </div>

            {#if rowError?.id === seminar.id}
              <p class="mt-1 text-ui text-danger" role="alert">{rowError.message()}</p>
            {/if}
            {#if rowNote?.id === seminar.id}
              {@const note = rowNote}
              <p class="mt-1 flex flex-wrap items-baseline gap-x-2 text-2xs text-muted" role="status">
                <span>{note.message()}</span>
                {#if note.publish}
                  <button type="button" class="admin-link" onclick={() => onpublish?.(seminar.id)}>
                    {tr('admin.seminar.choosePage')}
                  </button>
                {/if}
              </p>
            {/if}
          </td>

          <td
            class="py-3.5 align-middle text-ui text-muted max-[640px]:order-4 max-[640px]:pb-2.5
                   max-[640px]:pr-3 max-[640px]:pt-0"
          >
            <!-- The plan's day when the course has one for this row (a
                 timetable fact), else the room's own: when it was finished,
                 or made. «сегодня» reads faster than today's date. -->
            <span
              class={row.planned ? 'text-ink' : ''}
              title={new Date(seminar.createdAt).toLocaleString(getLocale())}
            >
              {dayLabel(row)}
            </span>
          </td>

          <td
            class="admin-num py-3.5 text-right align-middle max-[640px]:order-5 max-[640px]:pb-2.5
                   max-[640px]:pr-3 max-[640px]:pt-0"
          >
            <span title="{people(seminar.totalParticipants)} {tr("admin.joined.in.total")}">
              <!-- On a phone there is no column header, and a bare number
                   next to "base · 19.09" reads as anything at all. The word is
                   the same as in the table header — the column and the
                   caption do not diverge. -->
              <span class="admin-label hidden font-sans max-[640px]:inline">
                {tr("admin.joined")}
              </span>
              {seminar.totalParticipants > 0 ? seminar.totalParticipants : '—'}
            </span>
          </td>

          <td class="py-3.5 align-middle max-[640px]:order-6 max-[640px]:ml-auto max-[640px]:pb-2.5 max-[640px]:pt-0">
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
                <!-- The state words are the panel's badge (competitions/Badge), the
                     same 14px caps as a competition's state; the dot stays beside
                     it, not inside a hand-built chip. And the same tones as a
                     competition's (admin/competitions.ts · stateTone): live is
                     accent, a draft is warning, finished is neutral: one
                     "draft" in two colours on two neighbouring tabs read as
                     two different states. -->
                <span
                  class="inline-flex items-center gap-1.5"
                  title="{tr("admin.class.ended")} {new Date(
                    seminar.finishedAt ?? 0,
                  ).toLocaleString(getLocale())} {tr("admin.student.editing.and.execution.are.disabled")}"
                >
                  {#if seminar.liveCount > 0}
                    <span
                      class="h-[5px] w-[5px] shrink-0 rounded-full bg-accent"
                      title="{people(seminar.liveCount)} {tr("admin.in.the.room.right.now")}"
                    ></span>
                  {/if}
                  <Badge word={tr("admin.seminars.list.badge.finished")} tone="neutral" />
                </span>
              {:else if seminar.status === 'live'}
                <span class="inline-flex items-center gap-1.5">
                  <span class="h-[5px] w-[5px] shrink-0 rounded-full bg-accent"></span>
                  <Badge word={tr("admin.seminars.list.badge.running")} tone="accent" />
                  <!-- The head-count only on a phone: there is no "Joined"
                       column next to it there, and "live" without a number
                       does not tell a room with one visitor from a room with
                       a whole cohort. On a desktop the number stands in its
                       own column, and the badge must not carry a second copy
                       of it. -->
                  <span
                    class="admin-num hidden max-[640px]:inline"
                    title="{people(seminar.liveCount)} {tr("admin.in.the.room.right.now")}"
                  >
                    · {seminar.liveCount}
                  </span>
                </span>
              {:else if row.phase === 'upcoming'}
                <!-- Ahead: the plan's day is today or later, or nobody has
                     opened the room yet. An outline, not a fill — nothing is
                     happening in it, and the artboard draws it as a frame. -->
                <Badge word={tr("admin.seminars.list.badge.upcoming")} tone="neutral" form="outline" />
              {:else}
                <!-- Bare, so the four states share one right-hand lane: a past
                     room nobody ended is a fact, not a badge. «Прошло», not
                     «Пусто»: under «Завершены» a column of «пусто» read as
                     rooms with nothing in them, while the day simply passed
                     without anyone pressing «Завершить занятие». -->
                <span class="admin-label">{tr("admin.seminars.list.badge.past")}</span>
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
            class="py-3.5 align-middle max-[640px]:order-2 max-[640px]:basis-11 max-[640px]:self-start
                   max-[640px]:px-0 max-[640px]:py-2"
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
                class="admin-icon-btn max-[640px]:h-11 max-[640px]:w-11"
              >
                <Icon name="more" size={15} />
              </button>

              {#if openMenuId === seminar.id}
                <!-- 272px rather than the competitions' 240: at the panel's 16px
                     «Копировать ссылку на публикацию» is 269px and broke in two. -->
                <div
                  role="menu"
                  tabindex="-1"
                  class="row-menu admin-menu fixed z-50 w-[272px] overflow-y-auto"
                  style={menuStyle}
                >
                  <button role="menuitem" type="button" class="admin-menu-item" onclick={() => copy(seminar)}>
                    {tr("admin.copy.link")}
                  </button>
                  <a
                    role="menuitem"
                    href={linkOf(seminar)}
                    target="_blank"
                    rel="noreferrer"
                    class="admin-menu-item"
                  >
                    {tr("admin.open.seminar")}
                  </a>
                  <button role="menuitem" type="button" class="admin-menu-item" onclick={() => startRename(seminar)}>
                    {tr("admin.rename")}
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    class="admin-menu-item"
                    onclick={() => openSettings(seminar)}
                  >
                    {tr('admin.seminar.settingsMenu')}
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    class="admin-menu-item"
                    onclick={() => void finish(seminar, !seminar.finishedAt)}
                  >
                    {seminar.finishedAt ? tr("admin.reopen.the.class") : tr("admin.end.the.class")}
                  </button>
                  <div class="admin-menu-sep"></div>
                  <button
                    role="menuitem"
                    type="button"
                    class="admin-menu-item"
                    onclick={() => onpublish?.(seminar.id)}
                  >
                    {tr('admin.course.menu.page')}
                  </button>
                  {#if seminar.publication?.state === 'published'}
                    <button
                      role="menuitem"
                      type="button"
                      class="admin-menu-item"
                      onclick={() => void copyPublished(seminar)}
                    >
                      {tr("admin.copy.public.link")}
                    </button>
                    <button
                      role="menuitem"
                      type="button"
                      class="admin-menu-item"
                      onclick={() => void withdraw(seminar, true)}
                    >
                      {tr("admin.take.the.page.down")}
                    </button>
                  {:else if seminar.publication}
                    <button
                      role="menuitem"
                      type="button"
                      class="admin-menu-item"
                      onclick={() => void withdraw(seminar, false)}
                    >
                      {tr("admin.put.the.page.back")}
                    </button>
                  {/if}
                  <button
                    role="menuitem"
                    type="button"
                    class="admin-menu-item"
                    onclick={() => void archive(seminar, !seminar.archivedAt)}
                  >
                    {seminar.archivedAt ? tr("admin.move.back.to.the.list") : tr("admin.archive")}
                  </button>
                  {#if canDelete}
                    <div class="admin-menu-sep"></div>
                    <button
                      role="menuitem"
                      type="button"
                      class="admin-menu-item text-danger"
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
          </tbody>
        {/each}

        {#if loading && seminars.length === 0}
          <tbody class="max-[640px]:block">
            <tr class="max-[640px]:block">
              <td colspan="6" class="px-3 py-4 max-[640px]:block"><RowsSkeleton label={tr('admin.loading.seminars')} /></td>
            </tr>
          </tbody>
        {:else if groups.length === 0}
          <tbody class="max-[640px]:block">
            <tr class="max-[640px]:block">
              <td colspan="6" class="max-[640px]:block">
                {#if needle || tab !== 'all'}
                  <!-- A filter hides everything: say which one, and undo both,
                       since the tab is as easy to forget as the search. -->
                  <EmptyState title={needle ? tr('admin.seminar.noMatch', { query: query.trim() }) : tr('admin.seminars.list.group.empty')}>
                    <button
                      type="button"
                      class="btn-ghost"
                      onclick={() => {
                        query = ''
                        tab = 'all'
                      }}
                    >
                      {tr("admin.show.all")} {count(folderRooms.length, 'seminar')}
                    </button>
                  </EmptyState>
                {:else if !loadError}
                  <EmptyState
                    title={tr("admin.no.seminars.yet")}
                    hint={tr("admin.create.a.seminar.and.share.its.link.with.your.students")}
                  >
                    <button type="button" class="btn-primary" onclick={startCreate}>
                      <Icon name="plus" size={14} />
                      {tr("admin.new.seminar")}
                    </button>
                  </EmptyState>
                {/if}
              </td>
            </tr>
          </tbody>
        {/if}
      </table>
      </div>

      {#if folderRooms.length > 0}
        <p class="admin-meta py-3.5">
          {#if needle || tab !== 'all'}
            {tr("admin.showing")} {shown.length} {tr("admin.of")} {count(folderRooms.length, 'seminar')}
          {:else}
            {count(folderRooms.length, 'seminar')} {tr("admin.total")}
          {/if}
        </p>
      {/if}
    </div>
  </div>
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
    <!-- 640, not 560: in the panel the rule switches are 16 px (RoomRulesRows ·
         .admin-ui), and at 560 a three-way switch left its explanation a
         column a few words wide. -->
    <div class="dialog-card flex max-h-full w-full max-w-[640px] flex-col border border-line bg-canvas shadow-pop">
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
          «Ведущие»: who runs this room besides its course. Chips with ×, and
          a picker over the staff list. Mostly for rooms outside any course,
          where these people are the only ones who see the room at all; for a
          course room the line under the chips names the course's teachers,
          who need no chip — they run it through the course.

          First in the window: who runs the room decides who may change
          everything below it, and at the bottom of nine rules and the
          resources nobody scrolled to it.
        -->
        <div class="border-b border-line-soft py-4">
          <h3 class="text-ui font-semibold text-ink">{tr('admin.seminars.list.hosts.title')}</h3>
          <p class="mb-3 mt-1.5 text-2xs text-muted">{tr('admin.seminars.list.hosts.hint')}</p>

          {#if hosts === null && !hostsError}
            <p class="text-2xs text-muted">{tr('admin.seminars.list.hosts.loading')}</p>
          {:else if hosts}
            <div class="flex flex-wrap items-center gap-2">
              {#each hosts as host (host.id)}
                <span class="flex h-9 items-center gap-2 border border-line bg-canvas pl-1.5 pr-1 max-[640px]:h-11">
                  <Avatar name={host.name} color={colorForId(host.id)} size="xs" />
                  <span class="text-ui font-semibold text-ink">{host.name}</span>
                  {#if host.id === me?.id}
                    <span class="text-micro text-muted">{tr('admin.seminars.list.hosts.you')}</span>
                  {/if}
                  <button
                    type="button"
                    class="admin-icon-btn h-7 w-7 max-[640px]:h-9 max-[640px]:w-9"
                    aria-label={tr('admin.seminars.list.hosts.remove', { name: host.name })}
                    disabled={hostsBusy}
                    onclick={() => void removeHost(host.id)}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </span>
              {:else}
                <span class="text-2xs text-muted">{tr('admin.seminars.list.hosts.none')}</span>
              {/each}

              <div>
                <button
                  type="button"
                  aria-expanded={pickerOpen}
                  class="flex h-9 items-center border border-dashed border-accent-text px-3 text-ui text-accent-text
                         hover:bg-accent/5 max-[640px]:h-11"
                  disabled={hostsBusy}
                  onclick={openPicker}
                >
                  {tr('admin.seminars.list.hosts.add')}
                </button>
              </div>
            </div>
            {#if pickerOpen}
              <!-- In the flow of the dialog body rather than floating: the
                   body scrolls and clips, and a popover over it would be
                   cut at the dialog's bottom edge. -->
              <div class="mt-2 w-full max-w-[420px] border border-line bg-canvas">
                <div class="border-b border-line p-2.5">
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    bind:value={pickerQuery}
                    class="field"
                    placeholder={tr('admin.seminars.list.hosts.search')}
                    aria-label={tr('admin.seminars.list.hosts.search')}
                    autocomplete="off"
                    autofocus
                  />
                </div>
                {#if staff === null}
                  {#if !staffFailed}
                    <p class="px-3 py-2.5 text-2xs text-muted">{tr('admin.seminars.list.hosts.loading')}</p>
                  {/if}
                {:else if !anyoneLeft}
                  <p class="px-3 py-2.5 text-2xs text-muted">{tr('admin.seminars.list.hosts.everyone')}</p>
                {:else if candidates.length === 0}
                  <p class="px-3 py-2.5 text-2xs text-muted">{tr('admin.seminars.list.hosts.nobody')}</p>
                {:else}
                  <ul class="max-h-[240px] overflow-y-auto">
                    {#each candidates as person (person.id)}
                      <li class="flex items-center gap-2.5 border-b border-line-soft px-3 py-2 last:border-b-0">
                        <Avatar name={person.name} color={colorForId(person.id)} size="xs" />
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-ui font-semibold text-ink">{person.name}</span>
                          <span class="block truncate font-mono text-micro text-muted">{person.email}</span>
                        </span>
                        <button
                          type="button"
                          class="admin-link shrink-0 max-[640px]:min-h-[44px]"
                          disabled={hostsBusy}
                          onclick={() => void addHost(person.id)}
                        >
                          {tr('admin.seminars.list.hosts.addOne')}
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/if}
          {/if}

          {#each viaCourses as via (via.id)}
            <p class="mt-2.5 text-2xs text-muted">
              {tr('admin.seminars.list.hosts.viaCourse', { course: via.name, names: via.teachers.join(', ') })}
            </p>
          {/each}
          {#if hostsError}
            <p class="mt-2.5 text-2xs text-danger" role="alert">{hostsError}</p>
          {/if}
        </div>
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
    <div class="dialog-card w-full max-w-[460px] border border-line bg-canvas p-5 shadow-pop">
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
          <span class="mt-1 flex">
            <Check bind:checked={dropReading} disabled={deleteBusy} size={16} />
          </span>
          <span class="text-ui leading-relaxed text-muted">
            {tr("admin.delete.the.public.page.as.well")}
            <span class="font-mono text-2xs text-ink">/p/{addressOf(doomed.publication)}</span>{tr('admin.seminar.pageCopy', { count: doomed.publication.materials })}
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
          class="btn-danger-solid"
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
