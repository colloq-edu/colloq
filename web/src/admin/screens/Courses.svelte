<!--
  Courses: the list and a single course.

  A course is an address the class is given in the first week, and nothing
  else is given after that. So it has neither an archive nor hiding, and
  deletion lives inside the course itself and names the link it breaks.

  A single course is a table of its classes: the number, the class day, the
  title students see and, in the «Страница» column, whether the class left a
  page. That column is where a forgotten publish shows up by itself: a room
  whose day has passed without a page says so in the warning colour.
-->
<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Check from '@/admin/ui/Check.svelte'
  import EmptyState from '@/admin/ui/EmptyState.svelte'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import Avatar from '@/components/ui/Avatar.svelte'
  import { colorForId } from '@shared/protocol'
  import {
    AdminApiError,
    addressHolderOf,
    adminApi,
    publishRefusal,
    type AdminPublication,
  } from '@/lib/adminApi'
  import { copyText } from '@/lib/clipboard'
  import { daysBetween, formatDay, isClassDay } from '@shared/class-day'
  import {
    MAX_CLASS_ABOUT,
    MAX_COURSE_BLURB,
    MAX_COURSE_NAME,
    slugOk,
    studentTitle,
    suggestSlug,
    type AddressHolder,
    type Course,
    type CourseItem,
  } from '@shared/publish'
  import { LIMITS, type AdminSeminar, type ListScope, type TeacherRef, type TeacherWithCourses } from '@shared/admin'
  import {
    addableStaff,
    canRemoveMember,
    invitePrefill,
    looksLikeEmail,
    orderMembers,
    pickerRooms,
    reachableSignIn,
    readCourseScope,
    saveCourseScope,
    selfRemoval,
    seminarScopeFor,
    teacherLine,
  } from '@/admin/course-teachers'
  import {
    applyDraft,
    courseTally,
    draftOf,
    localDay,
    nextPlanDay,
    pageState,
    plannedRow,
    putPlanned,
    putRow,
    roomChoices,
    rowNumbers,
    seatSeminar,
    twoDigits,
    type PageState,
    type PlannedTarget,
    type RowDraft,
    type RowTarget,
  } from '@/admin/course-plan'
  import { tick } from 'svelte'

  interface Props {
    /** The open course, if the address names one. */
    open: string | null
    /** A row id to open in the row editor (?edit=, from «Изменить в курсе»). */
    edit?: string | null
    navigate: (path: string) => void
  }

  let { open, edit = null, navigate }: Props = $props()

  let courses = $state<Course[]>([])
  let course = $state<Course | null>(null)
  let seminars = $state<AdminSeminar[]>([])
  let errorText = $state<(() => string | null) | null>(null)
  const error = $derived(errorText?.() ?? null)
  let busy = $state(false)
  let creating = $state(false)
  let draftName = $state('')
  let copied = $state<string | null>(null)
  let adding = $state(false)
  /** Course requested, no answer yet: an empty area is not an answer. */
  let loadingOne = $state(false)
  /**
   * The instance's «сегодня» (adminApi.courseToday): what «прошло», the
   * today line and «через 2 дня» are counted from. The browser's own day
   * stands in until it arrives, and if it never does.
   */
  let today = $state(localDay(Date.now()))
  /** A word after an action on a row: «Страница обновлена · 4 материала». */
  let notice = $state<{ text: () => string; tone: 'ok' | 'warn'; href?: string } | null>(null)

  const explain = (cause: unknown): string => {
    // This screen cannot deal with a dead cookie: the shell replaces the whole
    // panel with the sign-in screen. With a reason — the cookie arrived and
    // was rejected.
    if (cause instanceof AdminApiError) return cause.message
    return tr("admin.could.not.complete.the.request.try.again")
  }

  /** The address read out loud: the name if one was given, otherwise the id. */
  const addressOf = (item: { id: string; slug: string | null }): string => item.slug ?? item.id

  /*
   * «Мои / Все» — the owner's switch, as on «Занятия» (Paper U1).
   *
   * A teacher's list is what they teach, and that is all the server gives
   * them. An owner's default is the same «Мои»: on a university's instance
   * the forty courses of other departments are not what an owner who also
   * teaches opens this screen for. «Все» is a press away and remembered in
   * this browser. Both lists come in one go for an owner, so both segments
   * carry a count and switching is instant; the side navigation counts
   * «Мои» either way (AdminShell.svelte · navCounts).
   */
  const browserStorage = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage)
  let scope = $state<ListScope>(readCourseScope(adminAuth.isOwner, browserStorage))
  let mineCourses = $state<Course[]>([])
  let allCourses = $state<Course[] | null>(null)
  /** The switch is drawn only once the role is known to be an owner's. */
  const showScope = $derived(adminAuth.isOwner)
  /** Which room list the open course was drawn from (course-teachers.ts · seminarScopeFor). */
  let seminarScope = $state<ListScope>('mine')

  function chooseScope(next: ListScope): void {
    if (next === scope) return
    scope = next
    saveCourseScope(next, browserStorage)
    courses = next === 'all' && allCourses ? allCourses : mineCourses
    // «Все» without its list (the role was not known yet when the screen
    // loaded, or that request failed): ask now rather than show «Мои» under it.
    if (next === 'all' && !allCourses) void loadList()
  }

  async function loadList(): Promise<void> {
    try {
      const owner = adminAuth.isOwner
      // The role can arrive after the screen: a stored «Все» is honoured
      // once it is known that this is an owner (and never sent otherwise).
      scope = readCourseScope(owner, browserStorage)
      const [mine, all] = await Promise.all([
        adminApi.listCourses('mine'),
        owner ? adminApi.listCourses('all') : Promise.resolve(null),
      ])
      mineCourses = mine
      allCourses = all
      courses = scope === 'all' && all ? all : mine
      navCounts.courses = mine.length
      await loadOrphans()
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
    }
  }

  async function loadOne(id: string): Promise<void> {
    loadingOne = true
    try {
      course = await adminApi.course(id)
      errorText = null
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      // There is no course at this address — the branch below says so in
      // words; before, there was an empty area in its place.
      course = null
      errorText = () => (explain(cause))
      return
    } finally {
      loadingOne = false
    }
    void adminApi
      .courseToday(course.id)
      .then((day) => {
        if (isClassDay(day)) today = day
      })
      .catch(() => {})
    const opened = course
    members = opened.teachers ?? []
    // The full rows (address, role) for the chips' titles; the course itself
    // already carried the names, so the strip is drawn before this lands.
    void adminApi
      .courseTeachers(opened.id)
      .then((list) => {
        if (course?.id === opened.id) members = list
      })
      .catch(() => {})
    try {
      // The seminar list feeds the pickers and the withdrawn/finished marks:
      // without it the course screen stays whole, and declaring the course
      // not found because of it would be wrong.
      const me = adminAuth.me?.teacher.id ?? null
      const teaches = (opened.teachers ?? []).some((member) => member.id === me)
      scope = readCourseScope(adminAuth.isOwner, browserStorage)
      seminarScope = seminarScopeFor(adminAuth.isOwner, scope, teaches)
      seminars = await adminApi.listSeminars(seminarScope)
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
    }
  }

  /*
   * One load per opening, not two.
   *
   * There used to be an `onMount` next to it with the same two calls: the
   * effect runs right after mounting, so every screen went for its list
   * twice — two `listCourses` and two `listPublications`, and for a course
   * two `course` and two `listSeminars`, the very one that parses the
   * notebook snapshot of every non-live room. On top of that, two answers to
   * one `course` raced each other.
   */
  $effect(() => {
    const id = open
    if (id) void loadOne(id)
    else {
      course = null
      void loadList()
    }
  })

  async function create(): Promise<void> {
    const name = draftName.trim()
    // busy is checked, not only set: the button greys out on it, but Enter
    // with auto-repeat does not, and half a second of holding it created five
    // identical courses, each with its own address.
    if (!name || busy) return
    busy = true
    try {
      const made = await adminApi.createCourse({ name })
      draftName = ''
      creating = false
      navigate(`/admin/courses/${made.id}`)
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
    } finally {
      busy = false
    }
  }

  /**
   * One order — one request, with a version check.
   *
   * A mismatch is not an error but a race: another teacher reordered this
   * course while the screen held it in its old state. The response carries
   * the list as it is now.
   *
   * The outcome of the write comes as a word, not as nothing: the plan row
   * form needs to know whether to clear what was typed. Success — clear it;
   * a race (409) — close it, because there is already a different list
   * under the form; a network failure — keep it, so you can press again
   * instead of retyping the topic.
   */
  async function writeItems(items: CourseItem[]): Promise<'ok' | 'conflict' | 'failed'> {
    // busy is checked, not only set: "Remove row" and "Add seminar" grey out
    // on it, but two quick presses manage to go out with the same `rev`, and
    // the second came back as "someone else has changed this course" — about
    // your own double click.
    if (!course || busy) return 'failed'
    busy = true
    errorText = null
    try {
      course = await adminApi.setCourseItems(course.id, course.rev, items)
      return 'ok'
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      if (cause instanceof AdminApiError && cause.status === 409) {
        /*
         * Re-read first, then speak. It used to be the other way round, and a
         * successful `loadOne` clears the error by itself — so the "please
         * repeat the change" phrase went out before it could be seen: the
         * list silently became a different one, and the teacher's edit
         * vanished without a single word.
         */
        await loadOne(course.id)
        errorText = () => (tr("admin.another.user.changed.the.course.the.current.version.will.load.ple"))
        return 'conflict'
      }
      errorText = () => (explain(cause))
      return 'failed'
    } finally {
      busy = false
    }
  }

  function move(index: number, by: -1 | 1): void {
    if (!course) return
    const next = [...course.items]
    const to = index + by
    if (to < 0 || to >= next.length) return
    ;[next[index], next[to]] = [next[to], next[index]]
    closeRowForms()
    void writeItems(next)
  }

  function drop(index: number): void {
    if (!course) return
    closeRowForms()
    void writeItems(course.items.filter((_, i) => i !== index))
  }

  function add(sessionId: string): void {
    if (!course) return
    const session = seminars.find((s) => s.id === sessionId)
    if (!session) return
    adding = false
    void writeItems([
      ...course.items,
      { kind: 'seminar', sessionId, name: session.name, publication: null },
    ])
  }

  /* --------------------------------------------------------- row forms */

  /**
   * The forms on the rows — one at a time.
   *
   * `plan` is a new topic at the bottom of the list; `rowForm` edits an
   * existing row in its place (title, day, «о чём», and the break mark of a
   * plan row). Two open at once would hold two row indexes, and after the
   * first save the second would point to the wrong place.
   *
   * An edit knows what the row WAS (course-plan.ts · RowTarget): a row index
   * after someone else's reordering is a different week, and editing that
   * one instead of yours would silently spoil the plan.
   */
  let plan = $state<{ draft: RowDraft } | null>(null)
  let rowForm = $state<{ target: RowTarget; draft: RowDraft } | null>(null)
  /** The plan row a class is being chosen to replace. */
  let seating = $state<PlannedTarget | null>(null)
  let titleInput = $state<HTMLInputElement | null>(null)

  const blankPlan = (items: readonly CourseItem[]): { draft: RowDraft } => ({
    draft: { title: '', day: nextPlanDay(items), about: '', pause: false },
  })

  /**
   * Reordering or removing a row shifts the indexes, and forms open on rows
   * are closed: an edit by a shifted index would edit a neighbour. The new
   * topic at the bottom holds no index and keeps what was typed.
   */
  function closeRowForms(): void {
    rowForm = null
    seating = null
    menu = null
  }

  async function openPlan(): Promise<void> {
    if (!course) return
    closeRowForms()
    adding = false
    expanded = true
    plan = blankPlan(course.items)
    await tick()
    titleInput?.focus()
  }

  async function openRow(at: number): Promise<void> {
    const row = course?.items[at]
    if (!row) return
    plan = null
    seating = null
    adding = false
    menu = null
    rowForm = { target: { at, was: row }, draft: draftOf(row) }
    await tick()
    titleInput?.focus()
  }

  async function savePlan(): Promise<void> {
    const form = plan
    if (!course || !form || busy) return
    const { title, day, about, pause } = form.draft
    const row = plannedRow(title, '', { day, about, pause })
    if (!row) {
      titleInput?.focus()
      return
    }
    const next = putPlanned(course.items, row, null)!
    /*
     * A semester plan is typed in one go — fifteen topics in a single
     * sitting. The form stays open, the cursor goes back to the topic, and
     * the day moves on a week: otherwise every week would cost an extra
     * press of «Тема по плану» and a date typed by hand.
     *
     * The form empties IMMEDIATELY, not on the response. On the response it
     * went like this: Enter, the cursor stays, the next topic gets typed
     * onto the end of the previous one, and the response arriving wipes
     * both — on a slow link that is seconds, and what was typed vanished
     * silently. And "Cancel" in the middle of a write reopened the form when
     * the response arrived.
     *
     * If it did not get written (a failure, a 409), what was typed comes
     * back, provided nothing has been typed into the empty form yet and it
     * has not been closed: there is no reason to retype a topic because of
     * the network, and what has been started must not be overwritten.
     */
    const typed = { ...form.draft }
    const writing = writeItems(next)
    plan = blankPlan(next)
    const fresh = plan
    await tick()
    titleInput?.focus()
    if ((await writing) === 'ok') return
    if (plan === fresh && !fresh.draft.title && !fresh.draft.about) plan = { draft: typed }
  }

  async function saveRow(): Promise<void> {
    const form = rowForm
    if (!course || !form || busy) return
    const row = applyDraft(form.target.was, form.draft)
    if (!row) {
      titleInput?.focus()
      return
    }
    const next = putRow(course.items, form.target, row)
    if (!next) {
      rowForm = null
      errorText = () => tr('admin.course.planRowMoved')
      return
    }
    // The edit closes after a race too: there is already a different list under it.
    if ((await writeItems(next)) !== 'failed') rowForm = null
  }

  function openSeat(at: number): void {
    const row = course?.items[at]
    if (row?.kind !== 'planned') return
    plan = null
    rowForm = null
    adding = false
    menu = null
    seating = seating?.at === at ? null : { at, was: row }
  }

  async function seat(sessionId: string): Promise<void> {
    const target = seating
    const session = seminars.find((s) => s.id === sessionId)
    if (!course || !target || !session || busy) return
    const next = seatSeminar(course.items, target, session)
    if (!next) {
      seating = null
      errorText = () => tr('admin.course.planRowMoved')
      return
    }
    if ((await writeItems(next)) !== 'failed') seating = null
  }

  function formKeys(event: KeyboardEvent, save: () => void, cancel: () => void): void {
    // An Enter that confirms IME composition is not "Save": the topic would
    // go out half-typed.
    if (event.isComposing) return
    if (event.key === 'Enter') save()
    if (event.key === 'Escape') cancel()
  }

  /** Rooms already in this course: a room is put into a course once. */
  const inCourse = $derived(
    new Set(course?.items.flatMap((i) => (i.kind === 'seminar' ? [i.sessionId] : [])) ?? []),
  )
  /**
   * The rooms the pickers may offer: what the server listed for this viewer
   * and they teach (course-teachers.ts · pickerRooms). The full list
   * `seminars` still feeds the table, which has to name the rooms of a
   * course an owner opened without teaching it.
   */
  const pickable = $derived(
    pickerRooms(seminars, seminarScope === 'all' && scope === 'all'),
  )
  /** Seminars that are not in this course yet, newest first. */
  const addable = $derived(roomChoices(pickable, null, inCourse))
  const seatChoices = $derived(
    seating ? roomChoices(pickable, isClassDay(seating.was.day) ? seating.was.day : null, inCourse) : [],
  )

  /* -------------------------------------------------------- the table */

  const seminarById = $derived(new Map(seminars.map((s) => [s.id, s])))
  const numbers = $derived(course ? rowNumbers(course.items) : [])

  function stateOf(item: CourseItem): PageState {
    const room = item.kind === 'seminar' ? seminarById.get(item.sessionId) : undefined
    return pageState(item, {
      today,
      finished: room?.status === 'finished' || Boolean(room?.finishedAt),
      withdrawn: room?.publication?.state === 'withdrawn',
    })
  }

  /** The next class: today's, or the first dated after it. */
  const nextIndex = $derived(
    course?.items.findIndex(
      (item) => !(item.kind === 'planned' && item.pause) && isClassDay(item.day) && item.day >= today,
    ) ?? -1,
  )
  /**
   * Where the «СЕГОДНЯ» line goes: before the first row dated after today,
   * when no class falls on today itself (then that row says «сегодня»).
   */
  const lineAt = $derived.by(() => {
    if (!course || course.items.some((item) => item.day === today)) return -1
    if (!course.items.some((item) => isClassDay(item.day))) return -1
    const first = course.items.findIndex((item) => isClassDay(item.day) && item.day > today)
    return first === -1 ? course.items.length : first
  })

  /**
   * The plan's far end, folded.
   *
   * Thirty-three rows, of which the teacher this week needs the last held
   * one and the next three: everything after them that is still only a plan
   * folds into «Дальше ещё 26 строк по плану». Only plan rows fold — a room
   * or a page never hides — and an open form unfolds the list.
   */
  let expanded = $state(false)
  const cut = $derived.by(() => {
    if (!course) return 0
    const items = course.items
    let last = -1
    items.forEach((item, i) => {
      if (item.kind !== 'planned') last = i
    })
    const end = Math.max(last, nextIndex) + 4
    const tail = items.slice(end)
    return tail.length >= 5 && tail.every((item) => item.kind === 'planned') ? end : items.length
  })
  const folded = $derived(!expanded && course !== null && cut < course.items.length)
  const shownCount = $derived(course ? (folded ? cut : course.items.length) : 0)

  /** The first plan row still ahead: the one a room is created for this week. */
  const nextPlanIndex = $derived(
    course?.items.findIndex(
      (item) =>
        item.kind === 'planned' && !item.pause && (!isClassDay(item.day) || item.day >= today),
    ) ?? -1,
  )

  /**
   * Whether a plan row shows «Создать комнату» · «Поставить занятие» inline:
   * the next plan row and any whose day has already gone by (a class held
   * without a room in its row). Rows further ahead keep them in the ⋯ menu,
   * so thirty rows do not shout the same two actions.
   */
  function actionable(index: number): boolean {
    const item = course?.items[index]
    if (item?.kind !== 'planned') return false
    if (isClassDay(item.day) && item.day < today) return true
    return nextPlanIndex === -1 || index <= nextPlanIndex
  }

  function nextLabel(day: string): string {
    const gap = daysBetween(today, day)
    if (gap <= 0) return tr('admin.course.isToday')
    if (gap === 1) return tr('admin.course.nextTomorrow')
    return tr('admin.course.nextIn', { count: gap })
  }

  function tallyText(items: readonly CourseItem[]): string {
    const tally = courseTally(items)
    return [
      tally.pages > 0 || (tally.rooms === 0 && tally.planned === 0)
        ? tr('admin.course.tally.pages', { count: tally.pages })
        : null,
      tally.rooms > 0 ? tr('admin.course.tally.rooms', { count: tally.rooms }) : null,
      tally.planned > 0 ? tr('admin.course.tally.planned', { count: tally.planned }) : null,
    ]
      .filter(Boolean)
      .join(' · ')
  }

  /* --------------------------------------------------------- the row menu */

  /**
   * The ⋯ menu of a row, in window coordinates.
   *
   * The menu cannot stay absolute inside the row: the page body scrolls
   * (overflow: auto) and clips it at the bottom edge. `position: fixed`
   * from the button's rectangle knows nothing of clipping, and it attaches
   * to the side with more room (Seminars.svelte · openMenu, measured there).
   */
  let menu = $state<{ index: number; style: string } | null>(null)

  function openMenu(index: number, button: HTMLElement): void {
    if (menu?.index === index) {
      menu = null
      return
    }
    const box = button.getBoundingClientRect()
    const right = Math.round(window.innerWidth - box.right)
    const below = window.innerHeight - box.bottom - 8
    const above = box.top - 8
    // The origin rides with the side: `row-menu` unfolds from the corner at
    // the button, and a menu flipped above it grows upwards (admin/motion.css).
    const style =
      below >= above
        ? `top: ${Math.round(box.bottom + 4)}px; right: ${right}px; max-height: ${Math.round(below)}px; transform-origin: top right`
        : `bottom: ${Math.round(window.innerHeight - box.top + 4)}px; right: ${right}px; max-height: ${Math.round(above)}px; transform-origin: bottom right`
    menu = { index, style }
  }

  function closeMenu(): void {
    menu = null
  }

  /** The student's address of a row's page, if it has one. */
  function pageAddress(item: CourseItem): string | null {
    if (item.kind === 'planned' || !item.publication) {
      const room = item.kind === 'seminar' ? seminarById.get(item.sessionId) : undefined
      return room?.publication ? addressOf(room.publication) : null
    }
    return addressOf(item.publication)
  }

  function openAsStudent(item: CourseItem): void {
    if (!course) return
    const page = pageAddress(item)
    window.open(page ? `/p/${page}` : `/c/${addressOf(course)}`, '_blank', 'noopener')
  }

  /** «Страница занятия…» of a row: by the room, or by the page itself when the room is gone. */
  function pageScreen(item: CourseItem, extra = ''): string | null {
    if (!course) return null
    const back = `from=course:${course.id}${extra}`
    if (item.kind === 'seminar') return `/admin/publish/${item.sessionId}?${back}`
    if (item.kind === 'gone' && item.publication) return `/admin/publish/${item.publication.id}?${back}`
    return null
  }

  async function refresh(item: CourseItem): Promise<void> {
    if (item.kind !== 'seminar' || busy) return
    menu = null
    busy = true
    notice = null
    errorText = null
    try {
      const result = await adminApi.refreshPage(item.sessionId)
      const count = result.page.materials.length
      notice = { text: () => tr('admin.course.refreshed', { count }), tone: 'ok' }
      if (course) await loadOne(course.id)
    } catch (cause) {
      const refusal = publishRefusal(cause)
      const href = pageScreen(item) ?? undefined
      notice =
        refusal?.kind === 'unconfirmed'
          ? { text: () => tr('admin.course.refreshHeld'), tone: 'warn', href }
          : refusal?.kind === 'no selection'
            ? { text: () => tr('admin.course.refreshNoPick'), tone: 'warn', href }
            : { text: () => tr('admin.course.refreshFailed', { reason: explain(cause) }), tone: 'warn', href }
    } finally {
      busy = false
    }
  }

  async function setShown(item: CourseItem, published: boolean): Promise<void> {
    if (item.kind !== 'seminar' || busy || !course) return
    menu = null
    busy = true
    errorText = null
    try {
      if (published) await adminApi.republish(item.sessionId)
      else await adminApi.withdraw(item.sessionId)
    } catch (cause) {
      errorText = () => explain(cause)
      busy = false
      return
    }
    busy = false
    await loadOne(course.id)
  }

  $effect(() => {
    if (!menu) return
    const close = () => (menu = null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    // Scrolling inside the menu itself is reaching its last item, not "I changed my mind".
    const onScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest('[role=menu]')) return
      close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  })

  /**
   * Copy — or show the link in words.
   *
   * `copyText` throws where the clipboard is closed (the panel over http on
   * another host is the usual way to run a department's instance). This
   * refusal used to go off as an unhandled promise: "Copied" did not appear,
   * there was no link on the screen, and the press looked like nothing.
   */
  async function copy(text: string, key: string): Promise<void> {
    try {
      await copyText(text)
    } catch {
      errorText = () => (tr("admin.could.not.copy.the.link.copy.it.manually", { p0: text }))
      return
    }
    copied = key
    setTimeout(() => (copied = copied === key ? null : copied), 1600)
  }

  /**
   * Drafts of the course fields.
   *
   * A suggestion from the title — only when there is no name yet: putting it
   * over the one the person chose would mean rewriting someone else's
   * decision every time the screen opens.
   *
   * The key is the course id, not the object itself: `course` is reassigned
   * by the server's response after every reordering of rows, and an effect
   * that depended on the object wiped a typed but unsaved address — together
   * with the "Save address" button that was about to save it.
   */
  let slugDraft = $state('')
  let nameDraft = $state('')
  let blurbDraft = $state('')
  let drafted: string | null = null

  $effect(() => {
    const open = course
    if (!open) {
      drafted = null
      return
    }
    if (drafted === open.id) return
    drafted = open.id
    // The row forms belong to the course: a row index from a neighbouring
    // course would point at someone else's week here.
    plan = null
    rowForm = null
    seating = null
    menu = null
    expanded = false
    notice = null
    slugDraft = open.slug ?? suggestSlug(open.name)
    nameDraft = open.name
    blurbDraft = open.blurb ?? ''
  })

  /*
   * «Изменить в курсе» from the class page arrives as ?edit=<row id>: the
   * row's form opens once the course is here, once per arrival — reopening
   * it after every save would trap the teacher in it.
   */
  let editedFor: string | null = null
  $effect(() => {
    const shown = course
    const row = edit
    if (!shown || !row) return
    const key = `${shown.id}:${row}`
    if (editedFor === key) return
    editedFor = key
    const at = shown.items.findIndex((item) => item.id === row)
    if (at === -1) return
    expanded = true
    void openRow(at)
  })

  /**
   * The name that was refused, and who holds it.
   *
   * "The address "ml-2025" is already taken" is a dead end if the holder is
   * not named: there is no course with that address in the list, it was
   * renamed to "ml-2025-fall", and it holds the former name for the sake of
   * a link written in last year's group chat. Such a name the owner releases
   * themselves (server/src/publish/store.ts · releaseFormerSlug); someone
   * else's live address they do not, and there will be no button for it.
   * While the server says nothing about the holder, the screen behaves as
   * before: it repeats the refusal phrase.
   */
  let held = $state<{ slug: string; holder: AddressHolder } | null>(null)
  /** Step two: releasing a former address is irreversible, so it is asked aloud. */
  let askingSlug = $state(false)

  async function saveSlug(): Promise<void> {
    if (!course || busy) return
    const next = slugDraft.trim().toLowerCase()
    if (next && !slugOk(next)) {
      errorText = () => (tr("admin.address.3.64.lowercase.latin.letters.digits.or.dashes.start.and.e"))
      return
    }
    busy = true
    errorText = null
    held = null
    try {
      await adminApi.setSlug('course', course.id, next || null)
      await loadOne(course.id)
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
      const holder = addressHolderOf(cause)
      if (holder?.former && next) held = { slug: next, holder }
    } finally {
      busy = false
    }
  }

  /**
   * Release a former address and take it — as one decision.
   *
   * One, because it is released precisely to give that name to your own
   * course: two presses in a row would leave a "the name belongs to nobody"
   * state in between, in which anyone else can take it.
   */
  async function releaseSlug(): Promise<void> {
    if (!held || busy) return
    const { holder, slug: freed } = held
    busy = true
    errorText = null
    try {
      await adminApi.releaseFormerSlug(holder.kind, holder.id, freed)
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
      return
    } finally {
      busy = false
    }
    held = null
    askingSlug = false
    slugDraft = freed
    await saveSlug()
  }

  /**
   * Your own former name — the one this course holds.
   *
   * A second path to the same action, and it is needed not by the one who
   * was refused the name but by the owner: the course "ML 2025", renamed to
   * "ml-2025-fall", keeps "ml-2025" for itself forever — a link with it is
   * written in last year's group chat — and next year's course cannot be
   * given that name. There was nowhere to see that it is this very course
   * that holds it: there is no row with that address in the list at all.
   * The list arrives together with the course (server/src/routes/courses.ts
   * · former).
   */
  let dropping = $state<string | null>(null)
  /** This course's former names — from the server, along with the course. */
  const former = $derived(course?.former ?? [])

  async function dropFormer(): Promise<void> {
    const open = course
    const name = dropping
    if (!open || !name || busy) return
    busy = true
    errorText = null
    try {
      await adminApi.releaseFormerSlug('course', open.id, name)
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
      return
    } finally {
      busy = false
    }
    dropping = null
    // Re-read the course instead of removing the name from the list in
    // place: the server counts the former names, and a second copy of that
    // answer would diverge from it on the very first refusal.
    await loadOne(open.id)
  }
  /**
   * The course's title and caption.
   *
   * They were nowhere: a course created with a typo in its title kept it
   * forever, and the whole class saw the typo on the public page.
   */
  const detailsChanged = $derived(
    Boolean(course) &&
      (nameDraft.trim() !== course?.name || blurbDraft.trim() !== (course?.blurb ?? '')),
  )

  async function saveDetails(): Promise<void> {
    const open = course
    if (!open || busy) return
    const name = nameDraft.trim()
    if (!name) {
      errorText = () => (tr("admin.enter.a.course.name"))
      return
    }
    busy = true
    errorText = null
    try {
      const saved = await adminApi.updateCourse(open.id, { name, blurb: blurbDraft.trim() || null })
      course = saved
      /*
       * The drafts come from the server's response, not from what was typed.
       *
       * The server cuts the caption at `MAX_COURSE_BLURB`, and after saving
       * what was saved is shorter than what was typed: `detailsChanged`
       * stayed true, the "Save changes" button did not grey out, and people
       * pressed it again and again. The effect above does not touch them — it
       * is keyed by `open.id`, and the course is the same.
       */
      nameDraft = saved.name
      blurbDraft = saved.blurb ?? ''
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
    } finally {
      busy = false
    }
  }

  /**
   * Deleting the course — right here, and it names the link it breaks.
   *
   * The seminars themselves and their pages stay: a course is an order and
   * an address, not storage. What breaks is exactly what the class was
   * dictated in the first week.
   */
  let doomed = $state(false)

  async function destroy(): Promise<void> {
    const open = course
    if (!open || busy) return
    busy = true
    errorText = null
    try {
      await adminApi.deleteCourse(open.id)
      doomed = false
      navigate('/admin/courses')
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
    } finally {
      busy = false
    }
  }

  /**
   * Pages that no longer have a room.
   *
   * Deleting a seminar keeps the reading page by default: a link that has
   * been handed out cannot be recalled. But after that the page disappeared
   * from the panel entirely — every other publication route asks for it by
   * seminar — and it could only be withdrawn by editing the database. Here
   * it is visible and can be withdrawn.
   */
  let orphans = $state<AdminPublication[]>([])
  let orphanBusy = $state<string | null>(null)

  async function loadOrphans(): Promise<void> {
    try {
      orphans = (await adminApi.listPublications()).filter((p) => p.orphaned)
    } catch {
      // No harm: this is an addendum to the course list, not the list itself.
      orphans = []
    }
  }

  async function actOnOrphan(id: string, what: () => Promise<void>): Promise<void> {
    orphanBusy = id
    errorText = null
    try {
      await what()
      await loadOrphans()
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
    } finally {
      orphanBusy = null
    }
  }

  /* ------------------------------------------- «Ведут»: the course's people */

  /**
   * The course's teachers, as the strip under the header draws them (Paper
   * U2). Kept apart from `course`: the item and detail writes answer with
   * the course without its people, and a strip that emptied after every
   * reordering of rows would say nobody teaches it.
   */
  let members = $state<(TeacherRef & { email?: string })[]>([])
  const meId = $derived(adminAuth.me?.teacher.id ?? null)
  const shownMembers = $derived(orderMembers(members, meId))
  /** Whether a chip's × is drawn at all (course-teachers.ts · canRemoveMember). */
  const removable = $derived(canRemoveMember(members.length, adminAuth.isOwner))

  /** The staff list for the search, fetched when the popover first opens. */
  let staff = $state<TeacherWithCourses[] | null>(null)
  let picking = $state<'search' | 'invite' | null>(null)
  let query = $state('')
  let inviteEmail = $state('')
  let inviteName = $state('')
  /*
   * A new address needs a name (the server refuses one without it); an
   * address already on the staff list keeps its person's name, so the field
   * may stay empty. Decided here, before the round trip, from the list the
   * search already loaded.
   */
  const inviteKnown = $derived.by(() => {
    const email = inviteEmail.trim().toLowerCase()
    return !!email && (staff ?? []).some((t) => t.email.toLowerCase() === email)
  })
  const inviteReady = $derived(!!inviteEmail.trim() && (inviteKnown || !!inviteName.trim()))
  /** The prefill carried the address: the name is what is left to type. */
  let inviteFocusName = $state(false)
  let teamBusy = $state(false)
  let teamErrorText = $state<(() => string) | null>(null)
  const teamError = $derived(teamErrorText?.() ?? null)
  /**
   * A new colleague's sign-in link, held in this tab only for as long as
   * the band stays open: the server hands it out once (InviteTeacherResponse).
   */
  let invited = $state<{ name: string; url: string } | null>(null)
  let inviteCopied = $state(false)
  let inviteCopyFailed = $state(false)
  let inviteLinkField = $state<HTMLInputElement | null>(null)

  const offered = $derived(staff ? addableStaff(staff, members, query) : null)

  /**
   * The strip belongs to a course: another course's half-typed invite must
   * not follow you there. Keyed by the id, not the object — `course` is
   * reassigned by every write's answer, and that must not close the band
   * holding a link shown once.
   */
  const openId = $derived(course?.id ?? null)
  $effect(() => {
    void openId
    picking = null
    query = ''
    invited = null
    teamErrorText = null
  })

  function failTeam(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
    teamErrorText = () => explain(cause)
  }

  async function openPicker(): Promise<void> {
    if (picking) {
      picking = null
      return
    }
    picking = 'search'
    query = ''
    teamErrorText = null
    // Re-read on every opening: someone added a minute ago on the Teachers
    // screen, or by a colleague's invitation, belongs in the search now.
    try {
      staff = await adminApi.listTeachers()
    } catch (cause) {
      staff ??= []
      failTeam(cause)
    }
  }

  async function addMember(person: TeacherWithCourses): Promise<void> {
    const open = course
    if (!open || teamBusy) return
    teamBusy = true
    teamErrorText = null
    try {
      members = await adminApi.addCourseTeacher(open.id, person.id)
      picking = null
      notice = { text: () => tr('admin.course.teachers.added', { name: person.name }), tone: 'ok' }
    } catch (cause) {
      failTeam(cause)
    } finally {
      teamBusy = false
    }
  }

  function openInvite(): void {
    const typed = invitePrefill(query)
    inviteEmail = typed.email
    inviteName = typed.name
    inviteFocusName = !!typed.email && !typed.name
    teamErrorText = null
    picking = 'invite'
  }

  async function invite(): Promise<void> {
    const open = course
    if (!open || teamBusy) return
    const email = inviteEmail.trim()
    if (!looksLikeEmail(email)) {
      teamErrorText = () => tr('admin.course.teachers.badEmail')
      return
    }
    teamBusy = true
    teamErrorText = null
    try {
      const answer = await adminApi.inviteCourseTeacher(open.id, { email, name: inviteName.trim() })
      members = answer.teachers
      picking = null
      const name = answer.teacher.name
      if (answer.signInUrl) {
        inviteCopied = false
        inviteCopyFailed = false
        invited = { name, url: reachableSignIn(answer.signInUrl, location.origin) }
      } else {
        // Someone already on the staff: their link is a credential, and the
        // server never hands it to whoever typed their address. They know how
        // to sign in; the screen says so instead of offering nothing to copy.
        notice = { text: () => tr('admin.course.teachers.existing', { name }), tone: 'ok' }
      }
    } catch (cause) {
      failTeam(cause)
    } finally {
      teamBusy = false
    }
  }

  async function copyInvite(url: string): Promise<void> {
    try {
      await copyText(url)
      inviteCopied = true
      inviteCopyFailed = false
    } catch {
      // The link is on screen and selectable: say so and select it.
      inviteCopyFailed = true
      inviteLinkField?.select()
    }
  }

  /**
   * Removing a chip. Removing yourself is asked first, and the question
   * names its price: a teacher loses the course and its rooms on the spot
   * (the server closes their open room sockets too), an owner only stops
   * being one of its teachers.
   */
  async function removeMember(member: TeacherRef): Promise<void> {
    const open = course
    if (!open || teamBusy) return
    const self = member.id === meId
    if (self) {
      const key = selfRemoval(adminAuth.isOwner) === 'loses' ? 'admin.course.teachers.leave' : 'admin.course.teachers.leaveOwner'
      if (!window.confirm(tr(key, { name: open.name }))) return
    }
    teamBusy = true
    teamErrorText = null
    try {
      members = await adminApi.removeCourseTeacher(open.id, member.id)
    } catch (cause) {
      failTeam(cause)
      return
    } finally {
      teamBusy = false
    }
    if (self && !adminAuth.isOwner) navigate('/admin/courses')
  }

  $effect(() => {
    if (!picking) return
    const close = () => (picking = null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  })

  /** Focus lands where the typing goes, each time the popover changes face. */
  function takeFocus(node: HTMLElement, wanted = true): void {
    if (wanted) node.focus()
  }

  /*
   * The panel's shared vocabulary (index.css · the teacher's panel), the one
   * the competition screens speak: `admin-label` for a column and a field
   * caption, `admin-menu-item` for a menu row, `admin-link` for an action in
   * a line of text. Nothing is spelled here by hand, so a course row and a
   * competition row cannot drift apart again.
   */
  // On the canvas, not the surface: the row form is a surface band, and a
  // surface field on it would be a border with nothing inside.
  const INPUT = 'field bg-canvas'
</script>

<!--
  The fields of a row — the same for a new plan topic and for editing any
  row. The topic of a plan row is required (the server refuses without
  it); the day, the «о чём» line and the break mark are not.
-->
{#snippet rowFields(
  draft: RowDraft,
  planned: boolean,
  when: string | null,
  saveLabel: string,
  save: () => void,
  cancel: () => void,
)}
  <div class="row-form flex flex-col gap-[18px] border-b border-t border-dashed border-b-line border-t-line bg-surface [border-bottom-style:solid]">
    <div class="flex flex-wrap items-start gap-4">
      <label class="flex min-w-[200px] flex-1 flex-col gap-1.5">
        <span class="admin-label">{planned ? tr('admin.course.field.topic') : tr('admin.course.field.title')}</span>
        <input
          bind:this={titleInput}
          class={INPUT}
          maxlength={MAX_COURSE_NAME}
          bind:value={draft.title}
          onkeydown={(event) => formKeys(event, save, cancel)}
        />
      </label>
      <label class="flex w-[220px] max-w-full flex-col gap-1.5">
        <span class="admin-label">{tr('admin.course.field.day')}</span>
        <input
          type="date"
          class="{INPUT} font-mono"
          bind:value={draft.day}
          onkeydown={(event) => formKeys(event, save, cancel)}
        />
        <!-- The week the timetable gave this row, until a day replaces it. -->
        {#if !draft.day && when}
          <span class="admin-meta">{tr('admin.course.field.whenLegacy', { when })}</span>
        {/if}
      </label>
    </div>
    <!-- The textarea is the panel's field itself, so it takes the field's
         frame and focus halo; the count sits under it, as a field's help does. -->
    <label class="flex flex-col gap-1.5">
      <span class="admin-label">{tr('admin.course.field.about')}</span>
      <textarea
        class="{INPUT} min-h-16 resize-none"
        rows="2"
        maxlength={MAX_CLASS_ABOUT}
        bind:value={draft.about}
        onkeydown={(event) => {
          if (event.key === 'Escape') cancel()
        }}
      ></textarea>
      <span class="admin-meta self-end font-mono">{draft.about.length} / {MAX_CLASS_ABOUT}</span>
    </label>
    <div class="flex flex-wrap items-center justify-between gap-4">
      {#if planned}
        <label class="flex cursor-pointer items-center gap-2.5">
          <Check size={16} bind:checked={draft.pause} />
          <span class="text-ui text-ink">{tr('admin.course.field.pause')}</span>
        </label>
      {:else}
        <span></span>
      {/if}
      <div class="flex items-center gap-2">
        <button type="button" class="btn-ghost" onclick={cancel}>
          {tr('admin.cancel')}
        </button>
        <!-- A form's save, not the page's action: sentence case, as every
             save in the panel. -->
        <button
          type="button"
          class="btn-primary"
          disabled={busy || (planned && !draft.title.trim())}
          onclick={save}
        >
          {saveLabel}
        </button>
      </div>
    </div>
  </div>
{/snippet}

<!--
  Rooms to put into a row, nearest to its day first, each with its day and
  state: in week twelve the right room is the one held that Sunday, not the
  twelfth button named «Семинар».
-->
{#snippet roomPicker(
  question: string,
  choices: ReturnType<typeof roomChoices>,
  pick: (id: string) => void,
  cancel: () => void,
)}
  <div class="picker border-b border-line bg-surface">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 pb-2.5">
      <p class="min-w-0 flex-1 text-2xs text-muted">{question}</p>
      <button type="button" class="btn-ghost shrink-0" onclick={cancel}>
        {tr('admin.cancel')}
      </button>
    </div>
    {#if choices.length === 0}
      <p class="text-ui text-muted">{tr("admin.no.seminars.available.to.add")}</p>
    {:else}
      <ul class="flex max-h-[320px] flex-col overflow-y-auto border border-line bg-canvas">
        {#each choices as choice (choice.seminar.id)}
          <li class="border-b border-line-soft last:border-b-0">
            <!-- The control height (40, 44 on a phone): a row to press, beside
                 the 40 px «Отмена» above it. -->
            <button
              type="button"
              class="flex min-h-10 w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-left transition-colors
                     duration-quick hover:bg-raised disabled:text-faint max-[640px]:min-h-11"
              disabled={busy}
              onclick={() => pick(choice.seminar.id)}
            >
              <span class="min-w-0 flex-1 truncate text-ui text-ink">{choice.seminar.name}</span>
              {#if choice.fits}
                <Badge word={tr('admin.course.fits')} tone="positive" case="lower" />
              {/if}
              <span class="admin-meta shrink-0">
                {formatDay(choice.day, getLocale())} · {tr(`admin.course.status.${choice.seminar.status}`)}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/snippet}

{#if !open}
  <AdminPage
    title={tr("admin.courses")}
    subtitle={tr("admin.group.seminars.on.a.course.page.and.set.their.order")}
  >
    {#snippet actions()}
      <!-- «Мои / Все», the owner's switch, drawn as on «Занятия» (Paper U1):
           two joined segments, the chosen one filled, each with its count. -->
      {#if showScope}
        <div class="flex h-10 shrink-0 border border-primary max-[640px]:w-full" role="group" aria-label={tr('admin.course.scope.label')}>
          {#each [['mine', mineCourses.length], ['all', allCourses?.length ?? null]] as const as [value, count] (value)}
            {@const on = scope === value}
            <button
              type="button"
              aria-pressed={on}
              class="flex min-w-[88px] flex-1 items-center justify-center gap-2 px-4 text-ui transition-colors duration-quick
                     {on ? 'bg-primary font-semibold text-primary-ink' : 'bg-canvas text-ink hover:bg-surface'}"
              onclick={() => chooseScope(value)}
            >
              {tr(`admin.course.scope.${value}`)}
              {#if count !== null}
                <span class="font-mono text-2xs {on ? 'text-primary-ink/75' : 'text-muted'}">{count}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
      <!-- The competitions list's «+ НОВОЕ СОРЕВНОВАНИЕ», word for word in classes. -->
      <button
        type="button"
        class="btn-primary btn-caps gap-2 px-4 max-[640px]:w-full"
        onclick={() => (creating = true)}
      >
        <Icon name="plus" size={14} />
        {tr("admin.new.course")}
      </button>
    {/snippet}

    <!-- No padding of its own: AdminPage already has one, and the rows start
         at the title's edge, as the competitions list does. -->
    <div class="py-4">
      {#if error}
        <p class="pb-4 text-ui text-danger" role="alert">{error}</p>
      {/if}

      {#if creating}
        <div class="mb-5 flex flex-wrap items-center gap-3 border border-line bg-surface px-4 py-3">
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="{INPUT} min-w-0 flex-[3_1_240px]"
            placeholder={tr("admin.course.name")}
            maxlength={MAX_COURSE_NAME}
            autofocus
            bind:value={draftName}
            onkeydown={(event) => {
              if (event.key === 'Enter') void create()
              if (event.key === 'Escape') creating = false
            }}
          />
          <button type="button" class="btn-primary shrink-0" disabled={busy} onclick={() => void create()}>
            {tr("admin.create")}
          </button>
          <button type="button" class="btn-ghost shrink-0" onclick={() => (creating = false)}>
            {tr("admin.cancel")}
          </button>
        </div>
      {/if}

      {#if courses.length === 0 && !creating}
        <!-- «Нет курсов» means three different things now: a fresh instance,
             a teacher nobody has added anywhere, an owner who teaches none of
             the courses there are. Each is told what to do next. -->
        <EmptyState
          title={tr("admin.no.courses.yet")}
          hint={scope === 'mine' && (allCourses?.length ?? 0) > 0
            ? tr('admin.course.list.ownerMineEmpty')
            : !adminAuth.isOwner
              ? tr('admin.course.list.mineEmpty')
              : tr("admin.create.a.course.and.add.seminars.students.will.see.the.list.and.l")}
        />
      {/if}

      {#each courses as item (item.id)}
        <!-- flex-wrap and basis-48: with the "planned" count the tally line is
             longer than the room left on a phone, and without wrapping it
             stuck out past the edge while the course title shrank to zero. -->
        <div class="admin-list-row flex-wrap gap-x-5 gap-y-1">
          <button
            type="button"
            class="min-w-0 flex-1 basis-48 text-left"
            onclick={() => navigate(`/admin/courses/${item.id}`)}
          >
            <p class="admin-row-title">{item.name}</p>
            <!-- The address printed is the same one dictated to the class: the
                 point of a name is that it is the link, not a second address
                 next to it. -->
            <p class="admin-meta mt-1 font-mono">/c/{addressOf(item)}</p>
            <!-- Who teaches it: on «Все» this is how an owner tells a
                 colleague's course from their own, and a course nobody
                 teaches any more says so in the warning colour. -->
            {#if item.teachers}
              {@const line = teacherLine(item.teachers)}
              <p class="mt-1 text-2xs {line.names ? 'text-muted' : 'text-warning'}">
                {#if !line.names}
                  {tr('admin.course.list.nobody')}
                {:else if line.more > 0}
                  {tr('admin.course.list.teachersMore', { names: line.names, count: line.more })}
                {:else}
                  {tr('admin.course.list.teachers', { names: line.names })}
                {/if}
              </p>
            {/if}
          </button>
          <p class="shrink-0 text-2xs text-muted">{tallyText(item.items)}</p>
        </div>
      {/each}

      <!--
        Pages without a room. The server serves them, but they were visible
        nowhere in the panel — a page left behind by a deleted seminar could
        only be withdrawn by editing the database. The actions are links in
        the row rather than four framed buttons: the list is a footnote to the
        courses, and a row of buttons would outshout the courses above it.
      -->
      {#if orphans.length > 0}
        <section class="mt-10">
          <div class="admin-section">
            <h2 class="admin-section-title">{tr("admin.pages.without.a.room")}</h2>
          </div>
          <p class="mt-2.5 max-w-xl text-2xs text-muted">
            {tr("admin.the.seminar.was.deleted.but.its.publication.was.kept.you.can.with")}
          </p>
          {#each orphans as page (page.id)}
            <div class="admin-list-row flex-wrap gap-y-1">
              <div class="min-w-0 flex-1 basis-48">
                <p class="truncate text-ui text-ink">{page.title}</p>
                <p class="admin-meta mt-1 font-mono">
                  /p/{addressOf(page)} · {tr('admin.course.page.page', { count: page.materials })}
                  {page.state === 'withdrawn' ? (" " + tr("admin.withdrawn")) : ''}
                </p>
              </div>
              <a class="admin-link shrink-0" href={`/p/${addressOf(page)}`} target="_blank" rel="noreferrer">
                {tr("admin.open")}
              </a>
              <!-- What is on it can still be taken off one material at a
                   time: the class page screen, opened by the page's own id. -->
              <button
                type="button"
                class="admin-link shrink-0"
                onclick={() => navigate(`/admin/publish/${page.id}?from=courses`)}
              >
                {tr('admin.course.menu.page')}
              </button>
              {#if page.state === 'published'}
                <button
                  type="button"
                  class="admin-link shrink-0"
                  disabled={orphanBusy === page.id}
                  onclick={() => void actOnOrphan(page.id, () => adminApi.withdrawPublication(page.id))}
                >
                  {tr("admin.withdraw.page")}
                </button>
              {:else}
                <button
                  type="button"
                  class="admin-link shrink-0"
                  disabled={orphanBusy === page.id}
                  onclick={() => void actOnOrphan(page.id, () => adminApi.restorePublication(page.id))}
                >
                  {tr("admin.restore.page")}
                </button>
                <!-- Erasing is for the owner only and only for a withdrawn
                     page: a withdrawn one can be restored, an erased one
                     cannot, and the tombstone in the course loses its link. -->
                {#if adminAuth.isOwner}
                  <button
                    type="button"
                    class="admin-link shrink-0 text-danger"
                    disabled={orphanBusy === page.id}
                    onclick={() => {
                      if (!window.confirm(tr("admin.permanently.delete.page.p.it.cannot.be.restored.through.colloq", { p0: addressOf(page) }))) return
                      void actOnOrphan(page.id, () => adminApi.erasePublication(page.id))
                    }}
                  >
                    {tr("admin.delete.permanently")}
                  </button>
                {/if}
              {/if}
            </div>
          {/each}
        </section>
      {/if}
    </div>
  </AdminPage>
{:else if course}
  {@const shown = course}
  <AdminPage title={shown.name}>
    {#snippet eyebrow()}
      <a
        class="hover:text-ink"
        href="/admin/courses"
        onclick={(event) => {
          event.preventDefault()
          navigate('/admin/courses')
        }}
      >
        {tr('admin.courses')} /
      </a>
    {/snippet}
    {#snippet lede()}
      <!-- The address copied is the same one read out loud: /c/<name> if a
           name was given. Otherwise the id went into the chat, and the class
           ended up with two different addresses for the same course. -->
      <span class="font-mono text-2xs text-ink">{location.host}/c/{addressOf(shown)}</span>
      <a class="admin-link" href={`/c/${addressOf(shown)}`} target="_blank" rel="noreferrer">
        {tr('admin.course.openPage')}
      </a>
      <button
        type="button"
        class="admin-link"
        onclick={() => void copy(`${location.origin}/c/${addressOf(shown)}`, 'link')}
      >
        {copied === 'link' ? tr('admin.copied') : tr('admin.course.copyLink')}
      </button>
      <span class="h-3.5 w-px self-center bg-line" aria-hidden="true"></span>
      <span class="text-2xs text-muted">{tallyText(shown.items)}</span>
    {/snippet}
    {#snippet actions()}
      <button
        type="button"
        class="btn-outline gap-2 whitespace-nowrap max-[640px]:grow"
        disabled={busy}
        onclick={() => void openPlan()}
      >
        <Icon name="plus" size={14} />
        {tr('admin.course.addPlanned')}
      </button>
      <!-- The page's own action, spelled as every page's is («+ НОВЫЙ КУРС»,
           «+ НОВОЕ СОРЕВНОВАНИЕ»): putting a class into the course is what
           this screen is opened for. -->
      <button
        type="button"
        class="btn-primary btn-caps gap-2 whitespace-nowrap px-4 max-[640px]:grow"
        aria-expanded={adding}
        onclick={() => {
          closeRowForms()
          plan = null
          adding = !adding
        }}
      >
        <Icon name="plus" size={14} />
        {tr('admin.course.addRoom')}
      </button>
    {/snippet}

    <!--
      «ВЕДУТ» — the course's people, right under its header (Paper U2): the
      chips, «+ Добавить преподавателя» with its search and invitation, and on
      the right what being one of them means. Full-bleed like the header
      above it (the page body pads by px-7, hence -mx-7).
    -->
    <section
      class="-mx-7 border-b border-line bg-surface px-7 py-3.5"
      aria-label={tr('admin.course.teachers.label')}
    >
      <div class="flex flex-wrap items-center gap-2.5">
        <span class="admin-label pr-1.5">{tr('admin.course.teachers.label')}</span>
        {#each shownMembers as member (member.id)}
          {@const you = member.id === meId}
          <span
            class="flex h-8 max-w-full items-center gap-2 border border-line bg-canvas pl-1 {removable || you ? 'pr-2' : 'pr-2.5'}"
            title={member.email}
          >
            <Avatar name={member.name} color={colorForId(member.id)} size="sm" />
            <span class="truncate text-ui font-semibold text-ink">{member.name}</span>
            {#if you}
              <span class="text-2xs text-muted">{tr('admin.course.teachers.you')}</span>
            {/if}
            {#if removable}
              <button
                type="button"
                class="-my-1 flex h-7 w-6 shrink-0 items-center justify-center text-faint transition-colors duration-quick hover:text-danger disabled:opacity-50"
                aria-label={tr('admin.course.teachers.remove', { name: member.name })}
                disabled={teamBusy}
                onclick={() => void removeMember(member)}
              >
                <Icon name="x" size={12} />
              </button>
            {/if}
          </span>
        {:else}
          <span class="text-2xs text-warning">{tr('admin.course.teachers.nobody')}</span>
        {/each}

        <div class="relative">
          <button
            type="button"
            class="flex h-8 items-center border border-dashed border-accent-text px-3 text-ui font-semibold text-accent-text
                   transition-colors duration-quick hover:bg-canvas"
            aria-expanded={picking !== null}
            aria-haspopup="dialog"
            onclick={(event) => {
              event.stopPropagation()
              void openPicker()
            }}
          >
            {tr('admin.course.teachers.add')}
          </button>

          {#if picking}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              role="dialog"
              tabindex="-1"
              aria-label={tr('admin.course.teachers.add')}
              class="row-menu absolute left-0 top-[calc(100%+8px)] z-40 flex w-[400px] max-w-[calc(100vw-32px)] flex-col border border-ink bg-canvas shadow-pop"
              style="transform-origin: top left"
              onclick={(event) => event.stopPropagation()}
            >
              {#if picking === 'search'}
                <div class="border-b border-line p-2.5">
                  <input
                    use:takeFocus
                    class="field w-full"
                    placeholder={tr('admin.course.teachers.search')}
                    aria-label={tr('admin.course.teachers.search')}
                    bind:value={query}
                    onkeydown={(event) => {
                      if (event.isComposing) return
                      if (event.key === 'Enter' && offered?.shown.length === 1) void addMember(offered.shown[0])
                    }}
                  />
                </div>
                {#if offered === null}
                  <p class="px-3 py-3 text-2xs text-muted">{tr('admin.course.teachers.loading')}</p>
                {:else if offered.shown.length === 0}
                  <p class="px-3 py-3 text-2xs text-muted">
                    <!-- «Все уже в курсе» only when there was a staff list to say it of:
                         a failed fetch leaves an empty one, and its error is below. -->
                    {query.trim() || (staff?.length ?? 0) === 0 ? tr('admin.course.teachers.notFound') : tr('admin.course.teachers.everyoneIn')}
                  </p>
                {:else}
                  <ul class="max-h-[264px] overflow-y-auto">
                    {#each offered.shown as person (person.id)}
                      <li>
                        <button
                          type="button"
                          class="flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-quick hover:bg-surface disabled:opacity-60"
                          disabled={teamBusy}
                          onclick={() => void addMember(person)}
                        >
                          <Avatar name={person.name} color={colorForId(person.id)} size="sm" />
                          <span class="flex min-w-0 flex-1 flex-col">
                            <span class="truncate text-ui font-semibold text-ink">{person.name}</span>
                            <span class="admin-meta truncate font-mono">
                              {person.email}{#if adminAuth.isOwner}
                                · {person.courses.length > 0
                                  ? tr('admin.course.teachers.courses', { count: person.courses.length })
                                  : tr('admin.course.teachers.noCourses')}{/if}
                            </span>
                          </span>
                          <span class="shrink-0 text-2xs font-bold text-accent-text">{tr('admin.course.teachers.addOne')}</span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                  {#if offered.more > 0}
                    <p class="px-3 pb-2 text-2xs text-faint">{tr('admin.course.teachers.more', { count: offered.more })}</p>
                  {/if}
                {/if}
                <p class="border-t border-line px-3 py-2.5 text-2xs leading-relaxed text-muted">
                  {tr('admin.course.teachers.inviteLead')}
                  <button type="button" class="admin-link" onclick={openInvite}>{tr('admin.course.teachers.inviteLink')}</button>
                  {tr('admin.course.teachers.inviteTail')}
                </p>
              {:else}
                <form
                  class="flex flex-col gap-3 p-3"
                  onsubmit={(event) => {
                    event.preventDefault()
                    void invite()
                  }}
                >
                  <p class="admin-label text-primary">{tr('admin.course.teachers.inviteLink')}</p>
                  <label class="flex flex-col gap-1.5">
                    <span class="admin-label">{tr('admin.course.teachers.email')}</span>
                    <input
                      use:takeFocus={!inviteFocusName}
                      type="email"
                      class="field w-full"
                      maxlength={LIMITS.email}
                      autocomplete="off"
                      placeholder="name@university.ru"
                      bind:value={inviteEmail}
                    />
                  </label>
                  <label class="flex flex-col gap-1.5">
                    <span class="admin-label">{tr('admin.course.teachers.name')}</span>
                    <input
                      use:takeFocus={inviteFocusName}
                      class="field w-full"
                      maxlength={LIMITS.teacherName}
                      autocomplete="off"
                      bind:value={inviteName}
                    />
                    <span class="admin-meta">{tr('admin.course.teachers.nameHint')}</span>
                  </label>
                  <div class="flex items-center justify-end gap-2">
                    <button type="button" class="btn-ghost" onclick={() => (picking = 'search')}>
                      {tr('admin.course.teachers.back')}
                    </button>
                    <button type="submit" class="btn-primary" disabled={teamBusy || !inviteReady}>
                      {tr('admin.course.teachers.invite')}
                    </button>
                  </div>
                </form>
              {/if}
              {#if teamError}
                <p class="border-t border-line px-3 py-2 text-2xs text-danger" role="alert">{teamError}</p>
              {/if}
            </div>
          {/if}
        </div>

        <span class="min-w-0 flex-1 max-[900px]:hidden"></span>
        <p class="max-w-[300px] text-right text-2xs text-muted max-[900px]:basis-full max-[900px]:max-w-none max-[900px]:text-left">
          {tr('admin.course.teachers.note')}
        </p>
      </div>

      {#if teamError && !picking}
        <p class="mt-2 text-2xs text-danger" role="alert">{teamError}</p>
      {/if}

      <!-- The new colleague's link, shown once (the Teachers screen's band, in
           this strip): copying it is the obvious next act. -->
      {#if invited}
        {@const shownLink = invited}
        <div class="enter mt-3 border-l-2 border-l-accent bg-accent/5 p-4">
          <p class="admin-label text-primary">{tr('admin.course.teachers.linkFor', { name: shownLink.name })}</p>
          <p class="mt-1.5 max-w-[720px] text-ui text-ink">{tr('admin.course.teachers.invited', { name: shownLink.name })}</p>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <input
              bind:this={inviteLinkField}
              readonly
              value={shownLink.url}
              spellcheck="false"
              aria-label={tr('admin.course.teachers.linkFor', { name: shownLink.name })}
              onfocus={(event) => event.currentTarget.select()}
              class="field min-w-[240px] max-w-[560px] flex-1 bg-canvas font-mono"
            />
            <button type="button" class="btn-primary" onclick={() => void copyInvite(shownLink.url)}>
              <Icon name={inviteCopied ? 'check' : 'copy'} size={14} />
              {inviteCopied ? tr('admin.copied') : tr('admin.copy.link')}
            </button>
            <button type="button" class="btn-ghost" onclick={() => (invited = null)}>
              {inviteCopied ? tr('admin.done') : tr('admin.close.without.copying')}
            </button>
          </div>
          {#if inviteCopyFailed}
            <p class="mt-2 text-ui text-danger" role="alert">{tr('admin.could.not.copy.the.link.it.is.selected.copy.it.manually')}</p>
          {:else if !inviteCopied}
            <p class="admin-meta mt-2">{tr('admin.course.teachers.linkLater')}</p>
          {/if}
        </div>
      {/if}
    </section>

    <div class="pt-2">
      {#if error}
        <p class="py-3 text-ui text-danger" role="alert">{error}</p>
      {/if}
      {#if notice}
        <p
          class="my-3 flex flex-wrap items-baseline gap-x-3 border-l-2 bg-surface px-3 py-2 text-ui
                 {notice.tone === 'ok' ? 'border-positive text-ink' : 'border-warning text-ink'}"
          role="status"
        >
          <span>{notice.text()}</span>
          {#if notice.href}
            {@const href = notice.href}
            <button type="button" class="admin-link" onclick={() => navigate(href)}>{tr('admin.course.menu.page')}</button>
          {/if}
        </p>
      {/if}

      <!--
        The table sits in a container with its own width: the breakpoints go
        by the width of the list itself, not the window, because the panel's
        menu takes a different width on different screens.
      -->
      <div class="course-rows">
        <!-- A column head sits on a hairline, as the competitions list's does
             (.admin-list-head); the heavy ink rule is a section's. -->
        <div class="course-grid course-head items-center border-b border-line py-2.5">
          <span class="admin-label">{tr('admin.course.col.n')}</span>
          <span class="admin-label">{tr('admin.course.col.day')}</span>
          <span class="admin-label">{tr('admin.course.col.class')}</span>
          <span class="admin-label">{tr('admin.course.col.page')}</span>
          <span></span>
        </div>

        {#if adding}
          {@render roomPicker(tr('admin.course.addQuestion'), addable, add, () => (adding = false))}
        {/if}

        <!-- What is on a class page is changed on the class page: a link of
             its own under the address, not only an item in the row menu. -->
        {#snippet editPage(item: CourseItem)}
          {#if pageScreen(item)}
            <button
              type="button"
              class="admin-link mt-0.5 flex items-center gap-1.5"
              onclick={() => {
                const href = pageScreen(item)
                if (href) navigate(href)
              }}
            >
              <Icon name="pencil" size={13} />
              {tr('admin.course.page.edit')}
            </button>
          {/if}
        {/snippet}

        {#each shown.items.slice(0, shownCount) as item, index (index)}
          {@const state = stateOf(item)}
          {@const n = numbers[index]}
          {@const day = isClassDay(item.day) ? item.day : null}
          {@const room = item.kind === 'seminar' ? seminarById.get(item.sessionId) : undefined}
          {@const address = pageAddress(item)}
          {@const isNext = index === nextIndex}
          {@const editing = rowForm?.target.at === index}
          {@const strong = state === 'page' || state === 'early' || state === 'missing' || state === 'room' || state === 'withdrawn'}
          {#if index === lineAt}
            <div class="flex items-center gap-3 pb-0.5 pt-3.5">
              <span class="admin-label shrink-0 text-accent-text">
                {tr('admin.course.today', { day: formatDay(today, getLocale()) })}
              </span>
              <span class="h-0.5 flex-1 bg-accent"></span>
            </div>
          {/if}
          <div
            class="course-grid course-row py-3.5 {editing || (isNext && item.kind === 'planned') ? 'bg-surface' : ''}
                   {editing ? '' : 'border-b border-line'}"
          >
            <span class="c-n admin-num {state === 'page' || state === 'early' ? '' : 'text-faint'}">
              {n === null ? '' : twoDigits(n)}
            </span>
            <span class="c-day text-2xs text-muted">
              {#if day}
                {formatDay(day, getLocale())}
              {:else if item.when}
                <span class="admin-meta">{item.when}</span>
              {:else}
                —
              {/if}
            </span>
            <div class="c-title flex min-w-0 flex-col items-start gap-1.5 pr-6">
              <button
                type="button"
                class="text-left {strong ? 'admin-row-title' : isNext ? 'text-ui text-ink' : 'text-ui text-muted'}"
                onclick={() => void openRow(index)}
              >
                {studentTitle(item)}
              </button>
              {#if item.kind === 'seminar'}
                <!-- The room under the title: the title is what students
                     read, the chip is which room it is. -->
                <span class="flex max-w-full items-center gap-1.5 bg-surface px-2 py-0.5">
                  <svg class="shrink-0 text-faint" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
                    <path d="M0.5 3.5h9" stroke="currentColor" />
                  </svg>
                  <span class="admin-meta truncate">{room?.name ?? item.name}</span>
                </span>
              {:else if item.kind === 'gone'}
                <span class="admin-meta bg-surface px-2 py-0.5">{tr('admin.course.roomGone')}</span>
              {:else if isNext && day}
                <span class="admin-label text-accent-text">{nextLabel(day)}</span>
              {/if}
            </div>
            <div class="c-page flex min-w-0 flex-col items-start gap-1">
              {#if state === 'page' || state === 'early'}
                {#if address}
                  <a
                    class="admin-link font-semibold"
                    href={`/p/${address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {#if item.kind === 'seminar' && item.publication}
                      {tr(state === 'early' ? 'admin.course.page.early' : 'admin.course.page.page', { count: item.publication.materials })}
                    {:else}
                      {tr('admin.course.page.bare')}
                    {/if}
                  </a>
                  <span class="admin-meta break-all font-mono">/p/{address}</span>
                {/if}
                {@render editPage(item)}
              {:else if state === 'withdrawn'}
                <span class="text-2xs text-muted">{tr('admin.course.page.withdrawn')}</span>
                {#if address}<span class="admin-meta break-all font-mono">/p/{address}</span>{/if}
                {@render editPage(item)}
              {:else if state === 'missing'}
                <!-- The one state that asks for something: the class is over
                     and nothing was published. -->
                <button
                  type="button"
                  class="press flex items-center gap-2 bg-warning/[0.12] px-2.5 py-1 text-left text-2xs font-semibold text-warning"
                  onclick={() => {
                    const href = pageScreen(item)
                    if (href) navigate(href)
                  }}
                >
                  <svg class="shrink-0" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M6 1.2L11 10.5H1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                    <path d="M6 4.6v3M6 8.6v.9" stroke="currentColor" stroke-width="1.3" />
                  </svg>
                  {tr('admin.course.page.missing')}
                </button>
              {:else if state === 'room'}
                <span class="text-2xs text-muted">{tr('admin.course.page.room')}</span>
                <button
                  type="button"
                  class="admin-link"
                  onclick={() => {
                    const href = pageScreen(item)
                    if (href) navigate(href)
                  }}
                >
                  {tr('admin.course.menu.page')}
                </button>
              {:else if state === 'plan'}
                <span class="text-2xs {isNext ? 'text-muted' : 'text-faint'}">{tr('admin.course.page.plan')}</span>
                {#if actionable(index)}
                  <span class="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      class="admin-link"
                      onclick={() => navigate(`/admin/new?course=${shown.id}&row=${item.id ?? ''}`)}
                      disabled={!item.id}
                    >
                      {tr('admin.course.createRoom')}
                    </button>
                    <span class="text-2xs text-faint" aria-hidden="true">·</span>
                    <button
                      type="button"
                      class="admin-link"
                      disabled={busy}
                      aria-expanded={seating?.at === index}
                      onclick={() => openSeat(index)}
                    >
                      {tr('admin.course.seat')}
                    </button>
                  </span>
                {/if}
              {:else if state === 'pause'}
                <span class="text-2xs text-faint">{tr('admin.course.page.pause')}</span>
              {:else}
                <span class="text-2xs text-faint">{tr('admin.course.page.gone')}</span>
              {/if}
            </div>
            <div class="c-menu flex justify-end">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={menu?.index === index}
                aria-label={tr('admin.course.menu.label', { name: studentTitle(item) })}
                class="admin-icon-btn {menu?.index === index ? 'bg-raised text-ink' : ''}"
                onclick={(event) => {
                  event.stopPropagation()
                  openMenu(index, event.currentTarget as HTMLElement)
                }}
              >
                <Icon name="more" size={15} />
              </button>
              {#if menu?.index === index}
                {@const hasPage = Boolean(address) || room?.publication != null}
                {@const withdrawn = state === 'withdrawn'}
                <div
                  role="menu"
                  tabindex="-1"
                  class="row-menu admin-menu fixed z-50 w-[240px] overflow-y-auto"
                  style={menu.style}
                  onclick={(event) => event.stopPropagation()}
                  onkeydown={(event) => {
                    if (event.key === 'Escape') closeMenu()
                  }}
                >
                  {#if item.kind === 'seminar' || (item.kind === 'gone' && item.publication)}
                    <button
                      role="menuitem"
                      type="button"
                      class="admin-menu-item"
                      onclick={() => {
                        const href = pageScreen(item)
                        closeMenu()
                        if (href) navigate(href)
                      }}
                    >
                      {tr('admin.course.menu.page')}
                    </button>
                  {/if}
                  {#if item.kind === 'seminar' && hasPage}
                    <!-- Not for a withdrawn page: a rebuild is not a restore, and «Вернуть
                         страницу» below is the one way back (the server refuses too). -->
                    {#if !withdrawn}
                      <button role="menuitem" type="button" class="admin-menu-item" disabled={busy} onclick={() => void refresh(item)}>
                        {tr('admin.course.menu.refresh')}
                      </button>
                    {/if}
                    <button
                      role="menuitem"
                      type="button"
                      class="admin-menu-item"
                      onclick={() => {
                        const href = pageScreen(item, '&focus=address')
                        closeMenu()
                        if (href) navigate(href)
                      }}
                    >
                      {tr('admin.course.menu.address')}
                    </button>
                  {/if}
                  {#if item.kind === 'planned' && !item.pause}
                    <button
                      role="menuitem"
                      type="button"
                      class="admin-menu-item"
                      disabled={!item.id}
                      onclick={() => {
                        closeMenu()
                        navigate(`/admin/new?course=${shown.id}&row=${item.id ?? ''}`)
                      }}
                    >
                      {tr('admin.course.createRoom')}
                    </button>
                    <button
                      role="menuitem"
                      type="button"
                      class="admin-menu-item"
                      onclick={() => openSeat(index)}
                    >
                      {tr('admin.course.seat')}
                    </button>
                  {/if}
                  <button
                    role="menuitem"
                    type="button"
                    class="admin-menu-item"
                    onclick={() => {
                      closeMenu()
                      openAsStudent(item)
                    }}
                  >
                    {tr('admin.course.menu.asStudent')}
                  </button>
                  {#if item.kind === 'seminar' && hasPage}
                    <div class="admin-menu-sep"></div>
                    {#if withdrawn}
                      <button role="menuitem" type="button" class="admin-menu-item" disabled={busy} onclick={() => void setShown(item, true)}>
                        {tr('admin.course.menu.restore')}
                      </button>
                    {:else}
                      <button
                        role="menuitem"
                        type="button"
                        class="admin-menu-item text-danger"
                        disabled={busy}
                        onclick={() => void setShown(item, false)}
                      >
                        {tr('admin.course.menu.withdraw')}
                      </button>
                    {/if}
                  {/if}
                  <div class="admin-menu-sep"></div>
                  <button
                    role="menuitem"
                    type="button"
                    class="admin-menu-item"
                    onclick={() => void openRow(index)}
                  >
                    {tr('admin.course.menu.edit')}
                  </button>
                  <!-- While a row is being edited it does not move: a moved
                       edit would be saved into someone else's position. -->
                  <button
                    role="menuitem"
                    type="button"
                    class="admin-menu-item"
                    disabled={index === 0 || busy}
                    onclick={() => move(index, -1)}
                  >
                    {tr('admin.course.menu.up')}
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    class="admin-menu-item"
                    disabled={index === shown.items.length - 1 || busy}
                    onclick={() => move(index, 1)}
                  >
                    {tr('admin.course.menu.down')}
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    class="admin-menu-item text-danger"
                    disabled={busy}
                    onclick={() => drop(index)}
                  >
                    {tr('admin.course.menu.remove')}
                  </button>
                </div>
              {/if}
            </div>
          </div>

          {#if editing && rowForm}
            {@const form = rowForm}
            {@render rowFields(
              form.draft,
              item.kind === 'planned',
              item.when || null,
              tr('admin.save'),
              () => void saveRow(),
              () => (rowForm = null),
            )}
          {/if}

          <!-- The class picker sits right under the row, not above the list:
               in a semester plan the week you need is far down, and a panel
               at the top ended up off screen from the button that opened it. -->
          {#if seating && seating.at === index}
            {@render roomPicker(
              tr('admin.course.seatQuestion', { name: seating.was.name }),
              seatChoices,
              (id) => void seat(id),
              () => (seating = null),
            )}
          {/if}
        {/each}

        {#if lineAt === shown.items.length && !folded}
          <div class="flex items-center gap-3 pb-0.5 pt-3.5">
            <span class="admin-label shrink-0 text-accent-text">
              {tr('admin.course.today', { day: formatDay(today, getLocale()) })}
            </span>
            <span class="h-0.5 flex-1 bg-accent"></span>
          </div>
        {/if}

        {#if folded}
          <div class="flex flex-wrap items-center justify-between gap-3 py-3.5">
            <span class="text-2xs text-muted">
              {tr('admin.course.moreRows', { count: shown.items.length - shownCount })}
            </span>
            <button type="button" class="admin-link" onclick={() => (expanded = true)}
            >
              {tr('admin.course.showAll', { count: shown.items.length })}
            </button>
          </div>
        {/if}

        {#if shown.items.length === 0 && !plan}
          <EmptyState title={tr("admin.this.course.has.no.seminars.yet")} />
        {/if}

        <!--
          A new topic goes at the bottom of the list, where it will end up,
          with the day a week after the last one. The form stays open until
          "Cancel": a plan is typed in one go.
        -->
        {#if plan}
          {@const form = plan}
          {@render rowFields(
            form.draft,
            true,
            null,
            tr('admin.course.addToPlan'),
            () => void savePlan(),
            () => (plan = null),
          )}
        {/if}
      </div>

      <p class="admin-meta py-3.5">{tr('admin.course.planHint')}</p>

      <!--
        The course's own settings — title, caption, address — under its
        classes: they are set once, the table is opened every week.
      -->
      <section class="mt-8 flex flex-col gap-4">
        <div class="admin-section">
          <h2 class="admin-section-title">{tr('admin.course.settings')}</h2>
        </div>

        <!--
          Title and caption — in the same place as the address: a course with
          a typo in its title could not be fixed anywhere, and the whole class
          sees it.
        -->
        <div class="flex flex-wrap items-center gap-2">
          <input
            class="field w-[280px] max-w-full"
            maxlength={MAX_COURSE_NAME}
            aria-label={tr("admin.course.name")}
            bind:value={nameDraft}
            onkeydown={(event) => {
              if (event.key === 'Enter') void saveDetails()
            }}
          />
          <input
            class="field w-auto min-w-[220px] flex-1"
            placeholder={tr("admin.short.course.description.optional")}
            maxlength={MAX_COURSE_BLURB}
            aria-label={tr("admin.course.description")}
            bind:value={blurbDraft}
            onkeydown={(event) => {
              if (event.key === 'Enter') void saveDetails()
            }}
          />
          {#if detailsChanged}
            <button
              type="button"
              class="btn-primary shrink-0"
              disabled={busy}
              onclick={() => void saveDetails()}
            >
              {tr("admin.save.changes")}
            </button>
          {/if}
        </div>

        <!--
          The course address is what gets dictated to the class and written on
          the board. So it is edited right here rather than hidden in settings:
          eight random characters are harder to remember than "ml-strong", and
          people ask for them to be repeated more often.
        -->
        <div class="flex flex-wrap items-center gap-2">
          <!-- The host inside the frame, as the competition editor's /k/: one
               field, the address read as one line. -->
          <div class="admin-affix w-[400px] max-w-full">
            <span class="shrink-0 font-mono text-2xs text-muted">{location.host}/c/</span>
            <input
              placeholder={shown.id}
              maxlength={64}
              bind:value={slugDraft}
              onkeydown={(event) => {
                if (event.key === 'Enter') void saveSlug()
              }}
            />
          </div>
          {#if slugDraft.trim() !== (shown.slug ?? '')}
            <button type="button" class="btn-primary" disabled={busy} onclick={() => void saveSlug()}>
              {tr("admin.save.address")}
            </button>
          {/if}
          <!-- The name is held not by a live address but by the memory of a
               link that was handed out — and that is the only kind of "taken"
               the owner resolves themselves. The button sits right by the
               field: looking for it elsewhere on the screen means not finding
               it at all. -->
          {#if held}
            <button
              type="button"
              class="btn-outline"
              disabled={busy}
              onclick={() => (askingSlug = true)}
            >
              {tr("admin.release.previous.address")}
            </button>
          {/if}
          {#if shown.slug}
            <span class="admin-meta">{tr("admin.the.old.address.c")}{shown.id} {tr("admin.also.works")}</span>
          {/if}
        </div>

        {#if held}
          <p class="admin-meta max-w-[640px]">
            <span class="font-mono text-ink">/c/{held.slug}</span> {tr("admin.the.previous.address.of.the")}
            {held.holder.kind === 'course' ? tr("admin.course") : tr("admin.page")}
            {#if held.holder.name}«{held.holder.name}»{/if}{tr("admin.after.transfer.this.link.will.open.the.current.course.instead.of")}
          </p>
        {/if}

        <!--
          Former names — under the same field where they were changed.

          Renaming does not cancel a link that has been handed out: the old name
          stays this course's address forever — and holds it against everyone
          else too. Next year's course got "The address "ml-2025" is the former
          name of the course "ML 2025"", and there was nowhere to see that the
          name is held HERE: there is no row with that address in the course
          list. The cost of releasing is named next to the button, not only in
          the question after it.
        -->
        {#if former.length > 0}
          <div class="max-w-[640px] border border-line bg-surface">
            <div class="border-b border-line px-4 py-2.5">
              <p class="admin-label text-primary">{tr("admin.previous.addresses")}</p>
              <p class="admin-meta mt-0.5">
                {tr("admin.these.links.open.the.current.course.releasing.an.address.stops.it")}
              </p>
            </div>
            {#each former as name (name)}
              <div class="flex items-center gap-3 border-b border-line-soft px-4 py-2 last:border-b-0">
                <span class="min-w-0 flex-1 truncate font-mono text-2xs text-ink">/c/{name}</span>
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
        {/if}

        <!-- Deletion lives inside the course itself and names the link it
             breaks: the seminars and their pages stay, what breaks is the
             address the class was dictated in the first week. -->
        <div class="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <p class="min-w-0 flex-1 basis-[240px] text-2xs text-muted">
            {tr("admin.deleting.the.course.removes.the.seminar.list.its.order.and.the.ad")}
            <span class="font-mono">/c/{addressOf(shown)}</span>{tr("admin.seminars.and.published.pages.will.be.kept")}
          </p>
          <!-- Destructive outside a dialog: the panel's red frame, as «Завершить
               сейчас» on a live competition. The dialog then asks. -->
          <button type="button" class="btn-danger shrink-0" onclick={() => (doomed = true)}>
            {tr("admin.delete.course")}
          </button>
        </div>
      </section>
    </div>
  </AdminPage>
{:else}
  <!--
    The course at this address did not open. A course address is given to the
    class and shared with colleagues, so people will come here by a stale one
    — and there used to be an empty area here without a single word and with
    no way back.
  -->
  <AdminPage title={tr("admin.course.218")}>
    {#if loadingOne}
      <p class="py-16 text-center text-ui text-muted">{tr("admin.opening.course")}</p>
    {:else}
      <EmptyState
        title={tr("admin.could.not.open.course")}
        hint={error ?? tr("admin.check.the.address.or.return.to.the.course.list")}
      >
        <button type="button" class="btn-primary" onclick={() => navigate('/admin/courses')}>
          {tr("admin.all.courses")}
        </button>
      </EmptyState>
    {/if}
  </AdminPage>
{/if}

{#if doomed && course}
  {@const going = course}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="delete-course-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="delete-course-title" class="text-title font-semibold text-ink">
        {tr('admin.course.deleteHeading', { name: going.name })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr("admin.the.link")} <span class="font-mono text-ink">/c/{addressOf(going)}</span> {tr("admin.will.no.longer.open.the.course.the.seminar.list.and.its.order.wil")}
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (doomed = false)}>
          {tr("admin.cancel")}
        </button>
        <button
          type="button"
          class="btn-danger-solid"
          disabled={busy}
          onclick={() => void destroy()}
        >
          {busy ? tr("admin.deleting") : tr("admin.delete.course.230")}
        </button>
      </div>
    </div>
  </div>
{/if}

<!--
  Releasing a former address — with a question, not a single press.

  The only irreversible thing here besides deleting the course: the link
  written in last year's group chat answers 404 after this, and there is
  nothing to bring it back with. Hence a second step, and the cost in it is
  named by that very address.
-->
{#if askingSlug && held}
  {@const going = held}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="release-slug-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="release-slug-title" class="text-title font-semibold text-ink">
        {tr('admin.course.releaseHeading', { address: going.slug })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr("admin.it.currently.leads.to.the")}
        {going.holder.kind === 'course' ? tr("admin.course.234") : tr("admin.page.235")}
        {#if going.holder.name}«{going.holder.name}»{/if}{tr("admin.after.transfer.this.link.will.open.the.current.course.instead.of")}
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (askingSlug = false)}>
          {tr("admin.cancel")}
        </button>
        <button
          type="button"
          class="btn-danger-solid"
          disabled={busy}
          onclick={() => void releaseSlug()}
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

  Here it is released not in order to take it right away: the name is freed
  for everyone, and the only thing that happens for sure is that the link
  with it stops opening. Hence a different question, and the button is named
  with a different verb.
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
        {tr('admin.course.releaseHeading', { address: going })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr("admin.this.link.will.stop.opening.the.current.course.another.course.may")}
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
   * The course table: № | День | Занятие | Страница | ⋯.
   *
   * The breakpoints are the width of the list itself (a container), not the
   * window: at md the panel's menu takes 236px, and a 768 window leaves the
   * list less room than a 640 window with the narrow menu. Below 640px of
   * list the row stacks — number on the left, then the title, the day and
   * the page state under each other, the menu on the right — and the
   * header row goes, since nothing lines up under it any more.
   */
  .course-rows {
    container-type: inline-size;
  }

  .course-grid {
    display: grid;
    grid-template-columns: 56px 120px minmax(0, 1fr) 340px 44px;
    align-items: start;
  }

  .row-form,
  .picker {
    padding: 20px 44px 24px 176px;
  }

  @container (max-width: 1000px) {
    .course-grid {
      grid-template-columns: 44px 104px minmax(0, 1fr) 232px 44px;
    }

    .row-form,
    .picker {
      padding-left: 148px;
    }
  }

  @container (max-width: 640px) {
    .course-head {
      display: none;
    }

    .course-grid {
      grid-template-columns: 36px minmax(0, 1fr) 44px;
      grid-template-areas:
        'n title menu'
        'n day menu'
        'n page menu';
      row-gap: 4px;
    }

    .c-n {
      grid-area: n;
    }

    .c-title {
      grid-area: title;
      padding-right: 0;
    }

    .c-day {
      grid-area: day;
    }

    .c-page {
      grid-area: page;
      margin-top: 4px;
    }

    .c-menu {
      grid-area: menu;
    }

    .row-form,
    .picker {
      padding: 16px 12px 20px;
    }
  }
</style>
