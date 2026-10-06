<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  /**
   * Who can teach — the staff list, which is really a list of live credentials.
   *
   * A link is never DISPLAYED except in the moment it is minted or rotated —
   * `Teacher` carries `hasLink` and a masked shape, so a screen share in a
   * lecture hall spills nothing. It can still be COPIED afterwards, straight
   * from the server to the clipboard without passing through the DOM, because
   * forcing a rotation on "they lost the link" would kill that person's other
   * devices to solve a problem they did not have.
   *
   * When a link is shown, copying it must be the obvious next act, and closing
   * it must feel like a decision — hence the reveal band, which names what it
   * is, offers one button, and labels its own dismissal "close without copying"
   * until you have.
   *
   * Everything that is not reading the list is owner-only, and the last owner's
   * controls are absent rather than disabled: the server answers 409 either way,
   * and an action you are never allowed to take should not be drawn as one.
   */
  import { onMount } from 'svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { cn, relativeTime } from '@/lib/utils'
  import { LIMITS, SIGN_IN_PATH, type AdminRole, type Teacher, type TeacherRef, type TeacherWithCourses } from '@shared/admin'
  import type { Course } from '@shared/publish'
  import { courseColor } from '@/admin/course-color'
  import { addableCourses, coursesCell, joinCourses, withCourse, withoutCourse } from '@/admin/staff-courses'
  import { colorForId } from '@shared/protocol'
  import { copyText } from '@/lib/clipboard'
  import { seminarLink } from '@/lib/seminar-link'

  /* The lanes. Declared once so the header and every row cannot drift apart. */
  /*
   * The lanes give way in order, and the name is not first in it. They used to
   * be shrink-0, so the only flexible thing in the row was the person — at
   * 900px that left the name 0px while a masked link nobody can read kept all
   * 322 of its own. Each lane now states the width it wants and the width it
   * can be argued down to; the name states a floor of its own (below) so the
   * argument reaches the link before it reaches the person.
   */
  /*
   * Below 640 there are no lanes — there is a card.
   *
   * Five lanes hold a 600px minimum, and at 390px the register slid sideways
   * into page scroll: "Sign-in link", "Last seen" and both buttons — copying
   * the link (492…524) and the row menu (652…684) — stayed past the edge on a
   * 390 screen. Measured on the test bench.
   *
   * `order-1` here means the card's second and following lines: the person
   * and the menu stay on the first (default `order`), while role, link and
   * last seen move under them, each full width. The first line's width is
   * measured for the menu button — 44px — and the two numbers must agree.
   *
   * The space between lanes is the shared rows' gap (admin-list-head,
   * admin-list-row), the same 16px every list in the panel has; the card
   * drops its column gap, or the menu would no longer fit beside the person.
   * The six floors and the five gaps come to the list's 766px minimum
   * (160 + 156 + 150 + 84 + 96 + 40 + 5 × 16); the courses lane (0.19) took
   * 150 of it, and its chips wrap onto a second line rather than shrink. The role floor is the role field
   * itself — the Russian "Teacher" with its chevron is 156px, and a select
   * cannot end in an ellipsis, it just cuts the word — while the link lane
   * gives way down to its copy button: the masked link is a shape, not
   * something read.
   */
  const PHONE_LANE = 'max-[640px]:order-1 max-[640px]:w-full max-[640px]:min-w-0'
  const COL_ROLE = `w-[168px] min-w-[156px] ${PHONE_LANE}`
  /*
   * The courses lane (0.19) was paid for by the link and «last seen» lanes,
   * not by the person: at 1440 the masked link kept 322px and the name was
   * cut to «Алекса…». The link is a shape nobody reads; 220 still shows its
   * host and the dots.
   */
  const COL_COURSES = `w-[280px] min-w-[150px] ${PHONE_LANE}`
  const COL_LINK = `w-[220px] min-w-[84px] ${PHONE_LANE}`
  const COL_SEEN = `w-[150px] min-w-[96px] ${PHONE_LANE}`
  const COL_MENU = 'w-10 shrink-0 max-[640px]:w-11'
  /** The person's own floor — an avatar, a name worth reading. */
  const COL_PERSON =
    'min-w-[160px] flex-1 max-[640px]:min-w-0 max-[640px]:basis-[calc(100%_-_44px)] ' +
    'max-[640px]:pr-2'

  /** All a row may ever show of a live link: its shape. */
  const MASKED = `${location.host}${SIGN_IN_PATH}${'·'.repeat(12)}`

  /**
   * The sign-in link — built from an address a colleague can open.
   *
   * The server builds it from PUBLIC_URL, and a PUBLIC_URL left on localhost
   * hands the chat a link that cannot be opened from any other machine;
   * meanwhile the mask in the row is drawn from `location.host`, so the form
   * and the content diverge. For the seminar link this rule is already
   * written and measured (lib/seminar-link.ts) — the start of the address is
   * taken from there too, so the rule stays one for both links, while the
   * path stays the server's: the key is in it.
   */
  function reachable(signInUrl: string): string {
    try {
      const chosen = new URL(seminarLink(signInUrl, location.origin, 'x'))
      const link = new URL(signInUrl)
      return `${chosen.origin}${link.pathname}${link.search}`
    } catch {
      // The operator sets PUBLIC_URL, and it can be anything at all.
      return signInUrl
    }
  }

  interface Reveal {
    teacherId: string
    name: string
    url: string
    /** A brand-new account reads differently from a link that just replaced one. */
    minted: boolean
  }

  let teachers = $state<TeacherWithCourses[]>([])
  let listErrorText = $state<(() => string | null) | null>(null)
  const listError = $derived(listErrorText?.() ?? null)

  let composing = $state(false)
  let draftName = $state('')
  let draftEmail = $state('')
  let creating = $state(false)
  /** The courses ticked on the add form: the new teacher lands in them at once. */
  let draftCourses = $state<string[]>([])
  let composeErrorText = $state<(() => string | null) | null>(null)
  const composeError = $derived(composeErrorText?.() ?? null)

  /** The link, held in this tab only, for as long as the band stays open. */
  let reveal = $state<Reveal | null>(null)
  let copied = $state(false)
  let copyErrorText = $state<(() => string | null) | null>(null)
  const copyError = $derived(copyErrorText?.() ?? null)
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  let linkField = $state<HTMLInputElement | null>(null)

  /** The row whose link was just put on the clipboard, so only that row says so. */
  let copiedRow = $state<string | null>(null)
  let copiedRowTimer: ReturnType<typeof setTimeout> | undefined
  /** Separate from copyError, which lives inside the reveal band and would not be on screen. */
  let rowCopyErrorText = $state<(() => string | null) | null>(null)
  const rowCopyError = $derived(rowCopyErrorText?.() ?? null)

  let confirming = $state<{ id: string; kind: 'rotate' | 'remove' } | null>(null)
  /** The row a destructive call is in flight for; nothing else is disabled by it. */
  let acting = $state<string | null>(null)
  let confirmErrorText = $state<(() => string | null) | null>(null)
  const confirmError = $derived(confirmErrorText?.() ?? null)

  let menuId = $state<string | null>(null)
  let roleBusy = $state<string | null>(null)
  /**
   * Editing the name and address, opened as a band right in the row.
   *
   * A typo in a surname used to be cured only by "delete and create again": a
   * new link, lost authorship of seminars and a person thrown out of the
   * panel for the sake of one letter. The draft is kept apart from
   * `teachers`, so an abandoned edit does not repaint the row.
   */
  let newSetupToken = $state<string | null>(null)
  let setupTokenErrorText = $state<(() => string | null) | null>(null)
  const setupTokenError = $derived(setupTokenErrorText?.() ?? null)
  let rotatingSetup = $state(false)
  /** Shown once — so it must be copyable without selecting it with the mouse. */
  let copiedSetup = $state(false)
  let copiedSetupTimer: ReturnType<typeof setTimeout> | undefined

  let editing = $state<{ id: string; name: string; email: string } | null>(null)
  let savingEdit = $state(false)
  /** A refusal with no confirmation band to land in still has to be seen. */
  let rowError = $state<{ id: string; message: () => string } | null>(null)

  const me = $derived(adminAuth.me?.teacher ?? null)
  const isOwner = $derived(me?.role === 'owner')
  /*
   * Counted from the list rather than read from `adminAuth.me.ownerCount`, so a
   * promotion that has only just painted is already reflected in what the other
   * rows will let you do.
   */
  const ownerCount = $derived(teachers.filter((t) => t.role === 'owner').length)

  /** True for the person the instance cannot afford to lose. */
  const stranded = (t: Teacher): boolean => t.role === 'owner' && ownerCount <= 1

  /* ---------------------------------------------------------- the courses */

  /*
   * «Курсы»: who teaches what (Paper U4).
   *
   * Since 0.19 a teacher sees only the courses they teach, so this column is
   * where an owner sees that a new colleague is still in none — and an empty
   * panel is what that colleague is looking at. An owner changes it right
   * here, through the same course routes the course's «Ведут» strip uses;
   * there is no separate staff-to-course API to drift from them.
   */
  /** Every course on the instance, for the owner's pickers; null until read (or for a teacher). */
  let allCourses = $state<Course[] | null>(null)
  /** The person whose «+ курс» picker is open. */
  let coursePicker = $state<string | null>(null)
  let courseQuery = $state('')
  /** `${teacherId}:${courseId}` while that membership is being written. */
  let courseBusy = $state<string | null>(null)
  const pickable = $derived.by(() => {
    const person = teachers.find((t) => t.id === coursePicker)
    return person && allCourses ? addableCourses(allCourses, person.courses, courseQuery) : []
  })

  async function loadCourses(): Promise<void> {
    if (!isOwner) return
    try {
      allCourses = await adminApi.listCourses('all')
    } catch {
      allCourses = null
    }
  }

  function openPicker(t: TeacherWithCourses): void {
    menuId = null
    courseQuery = ''
    coursePicker = coursePicker === t.id ? null : t.id
    if (!allCourses) void loadCourses()
  }

  async function addCourse(t: TeacherWithCourses, course: TeacherRef): Promise<void> {
    courseBusy = `${t.id}:${course.id}`
    rowError = null
    try {
      await adminApi.addCourseTeacher(course.id, t.id)
      teachers = teachers.map((x) => (x.id === t.id ? withCourse(x, course) : x))
      coursePicker = null
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      rowError = { id: t.id, message: () => report(cause) }
    } finally {
      courseBusy = null
    }
  }

  /*
   * No confirmation: one click on «+ курс» puts it back, and the server
   * re-checks the person's open rooms at once either way.
   */
  async function removeCourse(t: TeacherWithCourses, course: TeacherRef): Promise<void> {
    courseBusy = `${t.id}:${course.id}`
    rowError = null
    try {
      await adminApi.removeCourseTeacher(course.id, t.id)
      teachers = teachers.map((x) => (x.id === t.id ? withoutCourse(x, course.id) : x))
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      rowError = { id: t.id, message: () => report(cause) }
    } finally {
      courseBusy = null
    }
  }

  function toggleDraftCourse(id: string): void {
    draftCourses = draftCourses.includes(id) ? draftCourses.filter((x) => x !== id) : [...draftCourses, id]
  }

  onMount(() => {
    void load()
    void loadCourses()
    return () => clearTimeout(copyTimer)
  })

  /**
   * A dead cookie is not a message to print, it is a different screen: asking
   * auth to re-read drops the whole panel back to sign-in.
   */
  function report(cause: unknown): string {
    if (cause instanceof AdminApiError) {
      // With a reason: the cookie arrived here and was rejected — the link was
      // rotated or the person removed from the staff. The sign-in screen will
      // say exactly that, not something about cookies.

      return cause.message
    }
    if (cause instanceof Error) return cause.message
    return tr("admin.the.server.did.not.answer")
  }

  async function load(): Promise<void> {
    try {
      teachers = await adminApi.listTeachers()
      loaded = true
      listErrorText = null
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      listErrorText = () => (report(cause))
    }
  }

  /*
   * The number in the side navigation comes from here, as for seminars and
   * courses: the shell asks for the list itself only while it does not know
   * it, and after a person is added or removed it is this screen that knows
   * the truth.
   */
  let loaded = $state(false)
  $effect(() => {
    if (loaded) navCounts.teachers = teachers.length
  })

  /** A row from a call that answers with the bare Teacher: the courses it does not carry stay. */
  function put(updated: Teacher): void {
    teachers = teachers.map((t) => (t.id === updated.id ? { ...t, ...updated } : t))
  }

  function openComposer(): void {
    composing = true
    composeErrorText = null
    menuId = null
    draftCourses = []
    if (!allCourses) void loadCourses()
  }

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const name = draftName.trim()
    const email = draftEmail.trim()
    if (!name) return void (composeErrorText = () => (tr("admin.a.name.is.required")))
    if (!email) return void (composeErrorText = () => (tr("admin.enter.an.email.address")))

    creating = true
    composeErrorText = null
    try {
      const minted = await adminApi.createTeacher({ name, email })
      /*
       * Into the ticked courses, after the person exists: the link is the
       * part that matters, and a course refused here does not undo it — it
       * is said on the row, where «+ курс» is.
       */
      const ticked = (allCourses ?? [])
        .filter((course) => draftCourses.includes(course.id))
        .map((course) => ({ id: course.id, name: course.name }))
      const { joined, failed } = await joinCourses(ticked, (courseId) =>
        adminApi.addCourseTeacher(courseId, minted.teacher.id),
      )
      // The list is ordered by creation, so the new row lands at the bottom —
      // which is also where the reveal band it owns will scroll itself into view.
      teachers = [...teachers, { ...minted.teacher, courses: joined }]
      if (failed.length > 0) {
        const names = failed.map((course) => course.name).join(', ')
        rowError = { id: minted.teacher.id, message: () => tr('admin.teachers.coursesNotJoined', { names }) }
      }
      composing = false
      draftName = ''
      draftEmail = ''
      draftCourses = []
      show({
        teacherId: minted.teacher.id,
        name: minted.teacher.name,
        url: reachable(minted.signInUrl),
        minted: true,
      })
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      composeErrorText = () => (report(cause))
    } finally {
      creating = false
    }
  }

  /**
   * Optimistic, because a role is the one change here that is cheap to be wrong
   * about: it paints, and a refusal puts it back with the server's own sentence.
   * Rotating and removing are not offered the same courtesy — they end sessions.
   */
  async function setRole(t: Teacher, role: AdminRole): Promise<void> {
    if (role === t.role) return
    const before = t.role
    put({ ...t, role })
    roleBusy = t.id
    rowError = null
    try {
      const updated = await adminApi.updateTeacher(t.id, { role })
      put(updated)
      // Demoting yourself takes the controls off this screen; the shell has to
      // hear about it from the server rather than from us.
      if (updated.id === me?.id) void adminAuth.refresh()
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      put({ ...t, role: before })
      rowError = { id: t.id, message: () => (report(cause)) }
    } finally {
      roleBusy = null
    }
  }

  async function rotateSetup(): Promise<void> {
    rotatingSetup = true
    setupTokenErrorText = null
    copiedSetup = false
    try {
      const { token } = await adminApi.rotateSetupToken()
      newSetupToken = token
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      setupTokenErrorText = () => (report(cause))
    } finally {
      rotatingSetup = false
    }
  }

  async function copySetupToken(token: string): Promise<void> {
    try {
      await copyText(token)
      copiedSetup = true
      clearTimeout(copiedSetupTimer)
      copiedSetupTimer = setTimeout(() => (copiedSetup = false), 2200)
    } catch {
      // An insecure origin — the usual way to host this yourself.
      setupTokenErrorText = () => (tr("admin.could.not.copy.the.token.select.it.and.copy.it.manually"))
    }
  }

  function startEdit(t: Teacher): void {
    menuId = null
    confirming = null
    rowError = null
    editing = { id: t.id, name: t.name, email: t.email }
  }

  async function saveEdit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const draft = editing
    if (!draft) return
    const name = draft.name.trim()
    const email = draft.email.trim()
    if (!name) return void (rowError = { id: draft.id, message: () => (tr("admin.a.name.is.required")) })
    if (!email) {
      return void (rowError = {
        id: draft.id,
        message: () => (tr("admin.enter.an.email.address")),
      })
    }

    savingEdit = true
    rowError = null
    try {
      const updated = await adminApi.updateTeacher(draft.id, { name, email })
      put(updated)
      editing = null
      // Your own name is in the panel header — the shell learns it from the
      // server.
      if (updated.id === me?.id) void adminAuth.refresh()
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      rowError = { id: draft.id, message: () => (report(cause)) }
    } finally {
      savingEdit = false
    }
  }

  function ask(t: Teacher, kind: 'rotate' | 'remove'): void {
    menuId = null
    confirmErrorText = null
    // Nothing to invalidate and nobody to strand: a first mint needs no warning.
    if (kind === 'rotate' && !t.hasLink) return void rotate(t)
    confirming = { id: t.id, kind }
  }

  async function rotate(t: Teacher): Promise<void> {
    // A first mint runs without a confirmation, so it has no band to fail into.
    const banded = confirming?.id === t.id
    acting = t.id
    confirmErrorText = null
    rowError = null
    try {
      const minted = await adminApi.rotateTeacherLink(t.id)
      put(minted.teacher)
      confirming = null
      show({
        teacherId: t.id,
        name: minted.teacher.name,
        url: reachable(minted.signInUrl),
        minted: !t.hasLink,
      })
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      const message = () => report(cause)
      if (banded) confirmErrorText = message
      else rowError = { id: t.id, message }
    } finally {
      acting = null
    }
  }

  async function remove(t: Teacher): Promise<void> {
    acting = t.id
    confirmErrorText = null
    try {
      await adminApi.deleteTeacher(t.id)
      teachers = teachers.filter((x) => x.id !== t.id)
      confirming = null
      if (reveal?.teacherId === t.id) reveal = null
      // They removed themselves: the server has already cleared the cookie in
      // this browser, so the panel must stop pretending otherwise. And it has
      // to be told as what it was — their own decision, not a cookie failure.
      if (t.id === me?.id) void adminAuth.refresh('removed-self')
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      confirmErrorText = () => (report(cause))
    } finally {
      acting = null
    }
  }

  function show(next: Reveal): void {
    reveal = next
    copied = false
    copyErrorText = null
  }

  /*
   * Fetch-then-copy rather than render-then-copy: the key reaches this tab only
   * as the argument to writeText and is never put in the DOM, so the row goes
   * on showing its masked shape even while it is being sent to someone.
   */
  async function copyExisting(t: Teacher): Promise<void> {
    if (acting) return
    acting = t.id
    rowCopyErrorText = null
    try {
      const { signInUrl } = await adminApi.teacherLink(t.id)
      await copyText(reachable(signInUrl))
      copiedRow = t.id
      clearTimeout(copiedRowTimer)
      copiedRowTimer = setTimeout(() => (copiedRow = null), 2200)
    } catch (err) {
      // Two very different failures land here — the server refusing, and a
      // browser that will not hand out the clipboard on an insecure origin.
      // Rotating is the way out of the second one, so say which happened.
      rowCopyErrorText = () => (err instanceof AdminApiError
          ? err.message
          : tr("admin.could.not.copy.s.link.try.again.replacing.the.link.will.show.a.ne", { p0: t.name }))
    } finally {
      acting = null
    }
  }

  async function copy(url: string): Promise<void> {
    try {
      await copyText(url)
      copied = true
      copyErrorText = null
      // A confirmation that never leaves stops being one.
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => (copied = false), 2200)
    } catch {
      // An insecure origin or a denied permission. The link is on screen and
      // selectable, so say that instead of swallowing it.
      copyErrorText = () => (tr("admin.could.not.copy.the.link.it.is.selected.copy.it.manually"))
      linkField?.select()
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    if (menuId) return void (menuId = null)
    if (coursePicker) return void (coursePicker = null)
    if (editing) return void (editing = null)
    // Not while the call is in flight: the band is where its answer lands.
    if (confirming && !acting) confirming = null
  }

  /** Focus lands where the typing goes; `autofocus` on an element is not that. */
  function takeFocus(node: HTMLElement): void {
    node.focus()
  }

  /** A link minted for the last row is worthless if it opened below the fold. */
  function bringIntoView(node: HTMLElement): void {
    node.scrollIntoView({ block: 'nearest' })
  }
</script>

<svelte:window onclick={() => ((menuId = null), (coursePicker = null))} onkeydown={onKeydown} />

{#snippet addTeacher()}
  <button
    type="button"
    class="btn-primary btn-caps gap-2 px-4 max-[640px]:w-full"
    onclick={openComposer}
  >
    <Icon name="plus" size={14} />
    {tr("admin.add.a.teacher")}
  </button>
{/snippet}

<!-- A span, not a p: it also has to sit inside the composer's <label>. -->
{#snippet eyebrow(text: string)}
  <span class="admin-label block">{text}</span>
{/snippet}

<!--
  The same caption, but inside the card and only on a phone.

  The lanes' header is hidden there, and "never" or a masked row of dots
  without a caption does not say what is "never" or what the dots are. The
  words are the same as in the header — a lane and its caption must not
  diverge.
-->
{#snippet lane(text: string)}
  <span class="mb-1 hidden max-[640px]:block">{@render eyebrow(text)}</span>
{/snippet}

<!--
  The «Курсы» cell (Paper U4): chips with the course's colour square; for an
  owner a × on each and a dashed «+ курс» that opens a small picker of the
  courses this person does not teach yet.
-->
{#snippet coursesOf(t: TeacherWithCourses)}
  {@const cell = coursesCell(t, isOwner)}
  {#if cell.kind === 'owner'}
    <span class="text-2xs text-muted">
      {cell.teaches === null
        ? tr('admin.teachers.seesAll')
        : `${tr('admin.teachers.seesAll')} · ${tr('admin.teachers.teaches', { count: cell.teaches })}`}
    </span>
  {:else}
    <div class="flex flex-wrap items-center gap-1.5">
      {#if cell.kind === 'chips'}
        {#each cell.courses as course (course.id)}
          <span class="inline-flex max-w-full items-center gap-1.5 border border-line py-[3px] pl-2 text-micro text-ink {isOwner ? 'pr-1' : 'pr-2'}">
            <span class="h-[7px] w-[7px] shrink-0" style:background={courseColor(course.id)}></span>
            <span class="truncate">{course.name}</span>
            {#if isOwner}
              <button
                type="button"
                class="admin-icon-btn h-4 w-4 text-faint hover:text-danger"
                disabled={courseBusy === `${t.id}:${course.id}`}
                aria-label={tr('admin.teachers.removeFromCourse', { name: t.name, course: course.name })}
                onclick={() => void removeCourse(t, course)}
              >
                <Icon name="x" size={10} />
              </button>
            {/if}
          </span>
        {/each}
      {:else if cell.kind === 'none'}
        <span class="text-2xs text-warning">{tr('admin.teachers.noCourses')}</span>
      {:else}
        <span class="text-2xs text-faint">—</span>
      {/if}
      {#if isOwner}
        <button
          type="button"
          class="border border-dashed border-accent-text px-2 py-[3px] text-micro text-accent-text hover:bg-accent/5"
          aria-haspopup="listbox"
          aria-expanded={coursePicker === t.id}
          onclick={(event) => {
            event.stopPropagation()
            openPicker(t)
          }}
        >
          + {tr('admin.teachers.addCourse')}
        </button>
      {/if}
    </div>
    {#if coursePicker === t.id}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        role="dialog"
        tabindex="-1"
        aria-label={tr('admin.teachers.pickCourse', { name: t.name })}
        class="admin-menu absolute left-0 top-full z-20 mt-1 w-[300px] max-w-[calc(100vw-32px)] p-2"
        onclick={(event) => event.stopPropagation()}
      >
        {#if allCourses === null}
          <p class="px-2 py-1.5 text-2xs text-muted">{tr('admin.teachers.loadingCourses')}</p>
        {:else}
          {#if allCourses.length > 6}
            <input
              use:takeFocus
              bind:value={courseQuery}
              class="field mb-1.5 h-9"
              placeholder={tr('admin.teachers.findCourse')}
              aria-label={tr('admin.teachers.findCourse')}
            />
          {/if}
          <div class="max-h-[240px] overflow-y-auto" role="listbox" aria-label={tr('admin.teachers.courses')}>
            {#each pickable as course (course.id)}
              <button
                type="button"
                role="option"
                aria-selected="false"
                disabled={courseBusy !== null}
                class="admin-menu-item flex w-full items-center gap-2"
                onclick={() => void addCourse(t, course)}
              >
                <span class="h-[7px] w-[7px] shrink-0" style:background={courseColor(course.id)}></span>
                <span class="min-w-0 flex-1 truncate text-left">{course.name}</span>
                {#if courseBusy === `${t.id}:${course.id}`}
                  <Icon name="spinner" size={12} class="animate-spin text-faint" />
                {/if}
              </button>
            {:else}
              <p class="px-2 py-1.5 text-2xs text-muted">
                {allCourses.length === 0
                  ? tr('admin.teachers.noCoursesYet')
                  : courseQuery.trim()
                    ? tr('admin.teachers.noCourseMatches')
                    : tr('admin.teachers.inEveryCourse')}
              </p>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
{/snippet}

<AdminPage
  title={tr("admin.who.can.teach")}
  subtitle={tr("admin.manage.teacher.accounts.and.sign.in.links.teachers.can.create.sem")}
  actions={isOwner ? addTeacher : undefined}
>
  {#if composing}
    <form
      onsubmit={create}
      class="my-5 flex flex-wrap items-end gap-3 border border-line bg-surface px-4 py-3.5"
    >
      <label class="min-w-[190px] flex-1">
        {@render eyebrow(tr("admin.name"))}
        <input
          use:takeFocus
          bind:value={draftName}
          maxlength={LIMITS.teacherName}
          placeholder={tr("admin.ada.lovelace")}
          class="field mt-1.5"
        />
      </label>
      <label class="min-w-[210px] flex-1">
        {@render eyebrow(tr("admin.email"))}
        <input
          bind:value={draftEmail}
          type="email"
          maxlength={LIMITS.email}
          spellcheck="false"
          placeholder="ada@example.edu"
          class="field mt-1.5 font-mono"
        />
      </label>
      <button type="submit" class="btn-primary" disabled={creating}>
        {creating ? tr("admin.creating.a.link") : tr("admin.add.teacher")}
      </button>
      <button type="button" class="btn-ghost" onclick={() => (composing = false)}>{tr("admin.cancel")}</button>
      <!-- Optional: a teacher may be added first and seated later, from the
           row's «+ курс» or from the course's «Ведут». -->
      {#if allCourses && allCourses.length > 0}
        <fieldset class="w-full">
          <legend class="admin-label">{tr('admin.teachers.composeCourses')}</legend>
          <div class="mt-1.5 flex flex-wrap gap-1.5">
            {#each allCourses as course (course.id)}
              {@const on = draftCourses.includes(course.id)}
              <button
                type="button"
                aria-pressed={on}
                onclick={() => toggleDraftCourse(course.id)}
                class={cn(
                  'inline-flex items-center gap-1.5 border px-2 py-[3px] text-micro',
                  on ? 'border-accent bg-accent/10 text-ink' : 'border-line bg-canvas text-muted hover:border-faint',
                )}
              >
                <span class="h-[7px] w-[7px] shrink-0" style:background={courseColor(course.id)}></span>
                {course.name}
                {#if on}<Icon name="check" size={11} class="text-accent-text" />{/if}
              </button>
            {/each}
          </div>
        </fieldset>
      {/if}
      {#if composeError}
        <p class="w-full text-ui text-danger" role="alert">{composeError}</p>
      {/if}
      <p class="admin-meta w-full">
        {tr("admin.this.creates.a.teacher.account.and.a.sign.in.link.you.can.change")}
      </p>
    </form>
  {/if}

  {#if rowCopyError}
    <p role="alert" class="mb-3 border border-danger/40 bg-danger/5 px-4 py-3 text-ui text-danger">
      {rowCopyError}
    </p>
  {/if}

  <!--
    The sum of every lane's floor and the gaps between them. Past it the list
    scrolls sideways in the page body rather than collapsing further — and it is
    the row that scrolls, so the rules under the rows run the full width of what
    they are ruling. The notes below the list stay at the window's own width:
    they are prose, and prose should never need scrolling to read.
  -->
  <div class="min-w-[766px] max-[640px]:min-w-0">
  <!-- The lanes' header goes away together with the lanes: the captions move
       into the cards themselves, in the same words (see `lane` below). -->
  <!-- min-h-fit outgrows the fixed 36px: the head takes the shared list head's
       padded height, and a caption folded onto two lines in a narrow lane
       grows the head instead of spilling over the page header above it. -->
  <div
    class="admin-list-head sticky top-0 z-10 flex h-9 items-center border-b border-line bg-canvas
           max-[640px]:hidden min-h-fit"
  >
    <div class={COL_PERSON}>{@render eyebrow(tr("admin.person.1127"))}</div>
    <div class={COL_ROLE}>{@render eyebrow(tr("admin.role.1128"))}</div>
    <div class={COL_COURSES}>{@render eyebrow(tr("admin.teachers.courses"))}</div>
    <div class={COL_LINK}>{@render eyebrow(tr("admin.sign.in.link"))}</div>
    <div class={COL_SEEN}>{@render eyebrow(tr("admin.last.seen"))}</div>
    <div class={COL_MENU}></div>
  </div>

  {#if listError}
    <div class="flex flex-wrap items-center gap-3 py-4">
      <p class="min-w-0 flex-1 text-ui text-danger" role="alert">{listError}</p>
      <button type="button" class="btn-outline shrink-0" onclick={() => void load()}>
        {tr("admin.try.again")}
      </button>
    </div>
  {/if}

  {#each teachers as t (t.id)}
    {@const you = t.id === me?.id}
    {@const locked = stranded(t)}
    <div
      class="admin-list-row min-h-[66px] items-center border-b border-line-soft max-[640px]:flex-wrap
             max-[640px]:items-start max-[640px]:gap-x-0 max-[640px]:gap-y-2.5 max-[640px]:py-3"
    >
      <div class={cn(COL_PERSON, 'flex items-center gap-3')}>
        <Avatar name={t.name} color={colorForId(t.id)} size="md" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="admin-row-title truncate">{t.name}</span>
            {#if you}
              <Badge word={tr("admin.you")} tone="accent" />
            {/if}
          </div>
          <p class="admin-meta truncate font-mono">{t.email}</p>
        </div>
      </div>

      <div class={COL_ROLE}>
        {@render lane(tr("admin.role.1128"))}
        {#if !isOwner}
          <span class="text-ui capitalize text-muted">{tr(`admin.role.${t.role}`)}</span>
        {:else if locked}
          <span class="block text-ui text-ink">{tr("admin.owner")}</span>
          <span class="admin-meta flex items-center gap-1.5">
            <Icon name="lock" size={12} class="shrink-0" />
            {tr("admin.last.owner.role.required")}
          </span>
        {:else}
          <!-- max-w-full: at the lane's floor the field gives way and cuts its
               word rather than lying across the link beside it. -->
          <div class="relative inline-flex max-w-full items-center">
            <select
              value={t.role}
              disabled={roleBusy === t.id}
              aria-label="{tr("admin.role.for")} {t.name}"
              onchange={(event) => void setRole(t, event.currentTarget.value as AdminRole)}
              class="field w-auto max-w-full cursor-pointer appearance-none pr-8 disabled:opacity-50"
            >
              <option value="owner">{tr("admin.owner")}</option>
              <option value="teacher">{tr("admin.teacher")}</option>
            </select>
            <Icon name="chevron-down" size={12} class="pointer-events-none absolute right-3 text-faint" />
          </div>
        {/if}
      </div>

      <div class={cn(COL_COURSES, 'relative')}>
        {@render lane(tr("admin.teachers.courses"))}
        {@render coursesOf(t)}
      </div>

      <div class={COL_LINK}>
        {@render lane(tr("admin.sign.in.link"))}
        {#if t.hasLink}
          <div class="flex items-center gap-2">
            <p
              class="admin-meta min-w-0 flex-1 truncate font-mono"
              title={tr("admin.the.link.is.masked.here.copy.puts.the.full.sign.in.link.on.your.c")}
            >
              {MASKED}
            </p>
            {#if isOwner}
              <button
                type="button"
                disabled={acting === t.id}
                onclick={() => void copyExisting(t)}
                class="admin-icon-btn border border-line hover:border-faint max-[640px]:h-11
                       max-[640px]:w-11"
                aria-label={tr('admin.teacher.copyLinkLabel', { name: t.name })}
              >
                <Icon name={copiedRow === t.id ? 'check' : 'copy'} size={15} />
              </button>
            {/if}
          </div>
        {:else if isOwner}
          <button
            type="button"
            disabled={acting === t.id}
            onclick={() => ask(t, 'rotate')}
            class="admin-link inline-flex items-center gap-1.5"
          >
            <Icon name="link" size={14} />
            {acting === t.id ? tr("admin.creating") : tr("admin.create.a.link")}
          </button>
        {:else}
          <p class="text-2xs text-muted">{tr("admin.no.link.yet")}</p>
        {/if}
      </div>

      <div class={COL_SEEN}>
        {@render lane(tr("admin.last.seen"))}
        <!-- 15, the secondary cell's step: a course row's day, a competition's
             deadline, a class's date. 16 is the row's title. -->
        {#if t.lastSeenAt}
          <span class="text-2xs text-ink">{relativeTime(t.lastSeenAt)}</span>
        {:else}
          <span class="text-2xs text-muted">{tr("admin.never")}</span>
        {/if}
      </div>

      <div class={cn(COL_MENU, 'relative flex justify-end')}>
        {#if isOwner}
          <button
            type="button"
            aria-label="{tr("admin.actions.for")} {t.name}"
            aria-haspopup="menu"
            aria-expanded={menuId === t.id}
            onclick={(event) => {
              event.stopPropagation()
              menuId = menuId === t.id ? null : t.id
            }}
            class="admin-icon-btn max-[640px]:h-11 max-[640px]:w-11"
          >
            <Icon name="more" size={15} />
          </button>
          {#if menuId === t.id}
            <div
              role="menu"
              tabindex="-1"
              class="row-menu admin-menu absolute right-0 top-full z-20 mt-1 w-[280px]"
            >
              <button
                type="button"
                role="menuitem"
                onclick={() => startEdit(t)}
                class="admin-menu-item flex items-center gap-2.5"
              >
                <Icon name="pencil" size={14} class="text-faint" />
                {tr("admin.edit.name.and.email")}
              </button>
              <button
                type="button"
                role="menuitem"
                onclick={() => ask(t, 'rotate')}
                class="admin-menu-item flex items-center gap-2.5"
              >
                <Icon name="link" size={14} class="text-faint" />
                {t.hasLink ? tr("admin.rotate.sign.in.link") : tr("admin.create.a.sign.in.link")}
              </button>
              {#if !locked}
                <button
                  type="button"
                  role="menuitem"
                  onclick={() => ask(t, 'remove')}
                  class="admin-menu-item flex items-center gap-2.5 text-danger"
                >
                  <Icon name="trash" size={14} />
                  {you ? tr("admin.remove.my.account") : tr("admin.remove.from.staff")}
                </button>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    </div>

    {#if rowError?.id === t.id}
      <p class="border-b border-line-soft py-2.5 pl-11 text-ui text-danger">{rowError.message()}</p>
    {/if}

    {#if editing?.id === t.id}
      <form
        onsubmit={(event) => void saveEdit(event)}
        class="flex flex-wrap items-end gap-3 border-b border-line-soft bg-surface py-4 pl-11 pr-4"
      >
        <label class="min-w-[180px] flex-1">
          {@render eyebrow(tr("admin.name"))}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            bind:value={editing.name}
            maxlength={LIMITS.teacherName}
            class="field mt-1.5"
          />
        </label>
        <label class="min-w-[210px] flex-1">
          {@render eyebrow(tr("admin.email"))}
          <input
            bind:value={editing.email}
            type="email"
            maxlength={LIMITS.email}
            spellcheck="false"
            class="field mt-1.5 font-mono"
          />
        </label>
        <button type="submit" class="btn-primary" disabled={savingEdit}>
          {savingEdit ? tr("admin.saving") : tr("admin.save")}
        </button>
        <button type="button" class="btn-ghost" onclick={() => (editing = null)}>{tr("admin.cancel")}</button>
        <p class="admin-meta w-full">
          {tr("admin.this.updates.their.name.and.email.their.sign.in.link.stays.the.sa")}
        </p>
      </form>
    {/if}

    {#if confirming?.id === t.id}
      <div class="border-b border-line-soft bg-surface py-4 pl-11 pr-4">
        {#if confirming.kind === 'rotate'}
          <p class="text-title font-semibold text-ink">
            {tr('admin.teacher.rotateHeading', { name: t.name })}
          </p>
          <p class="mt-1.5 max-w-[640px] text-ui text-muted">
            {tr("admin.the.old.link.will.stop.working.and.their.signed.in.sessions.will")}{you
              ? tr("admin.except.this.browser.session.which.will.be.renewed")
              : ''}{tr("admin.a.new.link.will.appear.here.for.you.to.share")}
          </p>
        {:else}
          <p class="text-title font-semibold text-ink">
            {you ? tr("admin.remove.your.own.account") : tr("admin.remove.1171", { p0: t.name })}
          </p>
          <p class="mt-1.5 max-w-[640px] text-ui text-muted">
            {tr("admin.their.sign.in.link.will.stop.working.and.their.signed.in.sessions")}{you
              ? tr("admin.including.this.one")
              : ''}{tr("admin.their.seminars.will.remain.adding.them.again.creates.a.new.accoun")}
          </p>
        {/if}
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={acting === t.id}
            onclick={() => void (confirming?.kind === 'rotate' ? rotate(t) : remove(t))}
            class="btn-danger"
          >
            {#if acting === t.id}
              {tr("admin.working")}
            {:else if confirming.kind === 'rotate'}
              {tr("admin.rotate.the.link")}
            {:else}
              {tr("admin.remove")} {you ? tr("admin.my.account") : t.name}
            {/if}
          </button>
          <button
            type="button"
            class="btn-ghost"
            disabled={acting === t.id}
            onclick={() => (confirming = null)}
          >
            {tr("admin.cancel")}
          </button>
          {#if confirmError}
            <p class="text-ui text-danger" role="alert">{confirmError}</p>
          {/if}
        </div>
      </div>
    {:else if reveal?.teacherId === t.id}
      {@const shown = reveal}
      <div
        use:bringIntoView
        class="enter border-b border-line-soft border-l-2 border-l-accent bg-accent/5 p-4"
      >
        {@render eyebrow(tr("admin.sign.in.link.for.shown.once", { p0: shown.name }))}
        <!--
          What this says has to match what the page can actually do. The link is
          shown here once and never displayed again — but the copy button in the
          row still puts it on your clipboard, so "gone for good" would be the
          screen lying about itself, and the note at the foot of this page says
          the opposite.
        -->
        <p class="mt-1.5 max-w-[720px] text-ui text-ink">
          {#if shown.minted}
            {shown.name} {tr("admin.is.on.the.staff.list.share.this.personal.sign.in.link.with.them")}
          {:else}
            {tr("admin.the.old.link.has.been.replaced.share.this.new.sign.in.link.with")} {shown.name}.
          {/if}
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <input
            bind:this={linkField}
            readonly
            value={shown.url}
            spellcheck="false"
            aria-label="{tr("admin.sign.in.link.for")} {shown.name}"
            onfocus={(event) => event.currentTarget.select()}
            class="field min-w-[280px] max-w-[560px] flex-1 bg-canvas font-mono"
          />
          <button type="button" class="btn-primary" onclick={() => void copy(shown.url)}>
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            {copied ? tr('admin.copied') : tr("admin.copy.link")}
          </button>
          <button type="button" class="btn-ghost" onclick={() => (reveal = null)}>
            {copied ? tr("admin.done") : tr("admin.close.without.copying")}
          </button>
        </div>
        {#if copyError}
          <p class="mt-2 text-ui text-danger" role="alert">{copyError}</p>
        {:else if !copied}
          <p class="admin-meta mt-2">
            {tr("admin.after.closing.this.message.use.the.copy.button.on.their.row.to.co")}
          </p>
        {/if}
      </div>
    {/if}
  {/each}
  </div>

  <div class="flex items-center gap-2.5 py-3.5">
    <Icon name="link" size={14} class="shrink-0 text-faint" />
    <p class="admin-meta">
      {#if isOwner}
        {tr("admin.anyone.with.a.personal.link.can.sign.in.to.that.account.replace.a")}
      {:else}
        {tr("admin.anyone.with.a.personal.link.can.sign.in.to.that.account.contact.a")}
      {/if}
    </p>
  </div>

  <!--
    The setup token is the fourth door into the panel, and this screen said
    nothing about it.

    It signs whoever comes in as the longest-standing owner and is printed by
    `make host` on every run: it is in the terminal history, in projector
    screenshots and in the chats it was forwarded to. There was no way to
    revoke it — and "rotate it when someone leaves" above referred to
    teachers' links and said nothing about this door.
  -->
  {#if isOwner}
    <!--
      `basis-full` below 640, and without it the paragraph was one word wide.

      `flex-1` is `flex-basis: 0`, that is, the text asks for ZERO width and
      grows into the rest. The button next to it is `shrink-0` and at 390px
      took 230 of 250: no wrap happened (zero fits in any space), the text got
      eight pixels and folded into a column a word per line, and the capital
      "Setup token" caption, wider than those eight, printed over the button.
      Asking for the full width moves the button down — which is where it
      belongs.
    -->
    <section class="mt-6">
      <div class="admin-section">
        <h2 class="admin-section-title">{tr("admin.setup.token")}</h2>
      </div>
      <div class="flex flex-wrap items-start gap-3 py-3.5">
        <div class="min-w-0 max-w-[600px] flex-1 max-[640px]:basis-full">
          <!--
            The token is printed by `make host`, reading it from the file — not
            by the server: the server goes quiet as soon as the instance has an
            owner, and this block is visible only to the owner. The promise "the
            next run will print it" was true exactly where nobody reads it.
          -->
          <p class="text-2xs text-muted">
            {tr("admin.the.setup.token.signs.anyone.holding.it.in.as.the.longest.standin")}
            <span class="font-mono text-2xs text-accent-text">&lt;DATA_DIR&gt;/setup-token</span>.
          </p>
          {#if newSetupToken}
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <p class="min-w-0 break-all font-mono text-2xs text-ink">{newSetupToken}</p>
              <button
                type="button"
                class="btn-ghost shrink-0"
                onclick={() => void copySetupToken(newSetupToken ?? '')}
              >
                {copiedSetup ? tr('admin.copied') : tr("admin.copy")}
              </button>
            </div>
            <p class="mt-1 text-2xs text-muted">
              {tr("admin.the.token.is.also.available.through")} <span class="font-mono">make host</span>{tr("admin.which.reads.it.from")}
              <span class="font-mono text-2xs text-accent-text">&lt;DATA_DIR&gt;/setup-token</span>{tr("admin.the.server.logs.it.only.before.the.first.owner.is.created")}
            </p>
          {:else if setupTokenError}
            <p class="mt-2 text-ui text-danger" role="alert">{setupTokenError}</p>
          {/if}
        </div>
        <button
          type="button"
          class="btn-outline shrink-0 max-[640px]:h-11 max-[640px]:w-full max-[640px]:justify-center"
          disabled={rotatingSetup}
          onclick={() => void rotateSetup()}
        >
          {rotatingSetup ? tr("admin.rotating") : tr("admin.rotate.setup.token")}
        </button>
      </div>
    </section>
  {/if}

  <!-- The same story as with the token above: two columns with a 56px gap are
       a story about a desktop. On a phone they stack under each other, and so
       they do on a narrow desktop: the 320px basis is what makes the row wrap
       before the left note is squeezed into a column a few words wide. -->
  <div class="mt-6 flex flex-wrap items-start gap-x-14 gap-y-8 max-[640px]:gap-x-0 max-[640px]:gap-y-6">
    <section class="min-w-0 max-w-[600px] flex-1 basis-[320px] max-[640px]:basis-full">
      <div class="admin-section">
        <h2 class="admin-section-title">{tr("admin.masked.sign.in.links")}</h2>
      </div>
      <p class="mt-3.5 text-2xs text-muted">
        {tr("admin.the.list.masks.sign.in.links.a.newly.created.or.replaced.link.is")}
      </p>
    </section>
    <section class="w-[392px] max-[640px]:w-full">
      <div class="admin-section">
        <h2 class="admin-section-title">
          {isOwner ? tr("admin.lost.your.own.link") : tr("admin.lost.your.link")}
        </h2>
      </div>
      {#if isOwner}
        <p class="mt-3.5 text-2xs text-muted">
          {tr("admin.the.setup.token.in")} <span class="font-mono text-2xs text-accent-text">&lt;DATA_DIR&gt;/setup-token</span>
          {tr("admin.signs.you.in.as.the.longest.standing.current.owner")}
        </p>
      {:else}
        <p class="mt-3.5 text-2xs text-muted">
          {tr("admin.ask.an.owner.to.copy.and.share.your.current.link.if.it.may.have.r")}
        </p>
      {/if}
    </section>
  </div>
</AdminPage>
