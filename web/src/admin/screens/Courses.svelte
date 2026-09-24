<!--
  Courses: the list and a single course.

  A course is an address the class is given in the first week, and nothing
  else is given after that. So it has neither an archive nor hiding, and
  deletion lives inside the course itself and names the link it breaks.
-->
<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { AdminApiError, addressHolderOf, adminApi, type AdminPublication } from '@/lib/adminApi'
  import { copyText } from '@/lib/clipboard'
  import { plural } from '@/lib/plural'
  import {
    MAX_COURSE_BLURB,
    MAX_COURSE_NAME,
    MAX_PLANNED_WHEN,
    slugOk,
    suggestSlug,
    type AddressHolder,
    type Course,
    type CourseItem,
  } from '@shared/publish'
  import type { AdminSeminar } from '@shared/admin'
  import {
    courseTally,
    plannedRow,
    putPlanned,
    seatSeminar,
    type PlannedTarget,
  } from '@/admin/course-plan'
  import { tick } from 'svelte'

  interface Props {
    /** The open course, if the address names one. */
    open: string | null
    navigate: (path: string) => void
  }

  let { open, navigate }: Props = $props()

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

  const explain = (cause: unknown): string => {
    // This screen cannot deal with a dead cookie: the shell replaces the whole
    // panel with the sign-in screen. With a reason — the cookie arrived and
    // was rejected.
    if (cause instanceof AdminApiError) {

      return cause.message
    }
    return tr("admin.could.not.complete.the.request.try.again")
  }

  /** The address read out loud: the name if one was given, otherwise the id. */
  const addressOf = (item: { id: string; slug: string | null }): string => item.slug ?? item.id

  async function loadList(): Promise<void> {
    try {
      courses = await adminApi.listCourses()
      navCounts.courses = courses.length
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
    try {
      // The seminar list is needed only by the "Add seminar" button: without
      // it the course screen stays whole, and declaring the course not found
      // because of it would be wrong.
      seminars = await adminApi.listSeminars()
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

  /**
   * Plan rows — right inside the course list.
   *
   * One form per screen: a new topic (at the bottom, `target: null`) or an
   * edit of an existing one (in the row's place). Two open at once would
   * hold two row indexes, and after the first save the second would point
   * to the wrong place.
   *
   * An edit knows what the row WAS (course-plan.ts · PlannedTarget): a row
   * index after someone else's reordering is a different week, and renaming
   * that one instead of yours would silently spoil the plan.
   */
  let plan = $state<{ target: PlannedTarget | null; name: string; when: string } | null>(null)
  /** The plan row a class is being chosen to replace. */
  let seating = $state<PlannedTarget | null>(null)
  let planTopic = $state<HTMLInputElement | null>(null)

  const planReady = $derived(plan !== null && plannedRow(plan.name, plan.when) !== null)

  /**
   * Reordering or removing a row shifts the indexes, and forms open on rows
   * are closed: an edit by a shifted index would edit a neighbour. The new
   * topic at the bottom holds no index and keeps what was typed.
   */
  function closeRowForms(): void {
    if (plan?.target) plan = null
    seating = null
  }

  async function openPlan(at: number | null): Promise<void> {
    const row = at === null ? null : course?.items[at]
    seating = null
    adding = false
    plan =
      row?.kind === 'planned' && at !== null
        ? { target: { at, was: row }, name: row.name, when: row.when }
        : { target: null, name: '', when: '' }
    await tick()
    planTopic?.focus()
  }

  async function savePlan(): Promise<void> {
    const draft = plan
    if (!course || !draft || busy) return
    const row = plannedRow(draft.name, draft.when)
    if (!row) {
      planTopic?.focus()
      return
    }
    const next = putPlanned(course.items, row, draft.target)
    if (!next) {
      plan = null
      errorText = () => tr('admin.course.planRowMoved')
      return
    }
    // The edit closes after a race too: there is already a different list
    // under it.
    if (draft.target) {
      if ((await writeItems(next)) !== 'failed') plan = null
      return
    }
    /*
     * A semester plan is typed in one go — fifteen topics in a single
     * sitting. The form stays open, the cursor goes back to the topic:
     * otherwise every week would cost an extra press of "+ Planned topic".
     *
     * The form empties IMMEDIATELY, not on the response. On the response it
     * went like this: Enter in the week field, the cursor stays there, the
     * next topic gets typed onto the end of the week ("1–7 SepTrees"), and
     * the response arriving wipes both lines — on a slow link that is
     * seconds, and what was typed vanished silently. And "Cancel" in the
     * middle of a write reopened the form when the response arrived.
     *
     * If it did not get written (a failure, a 409), what was typed comes
     * back, provided nothing has been typed into the empty form yet and it
     * has not been closed: there is no reason to retype a topic because of
     * the network, and what has been started must not be overwritten.
     */
    const typed = { name: draft.name, when: draft.when }
    const writing = writeItems(next)
    plan = { target: null, name: '', when: '' }
    const fresh = plan
    await tick()
    planTopic?.focus()
    if ((await writing) === 'ok') return
    if (plan === fresh && !fresh.name && !fresh.when) plan = { target: null, ...typed }
  }

  function openSeat(at: number): void {
    const row = course?.items[at]
    if (row?.kind !== 'planned') return
    plan = null
    adding = false
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

  function planKeys(event: KeyboardEvent): void {
    // An Enter that confirms IME composition is not "Add": the topic would
    // go out half-typed.
    if (event.isComposing) return
    if (event.key === 'Enter') void savePlan()
    if (event.key === 'Escape') plan = null
  }

  /** Seminars that are not in this course yet. */
  const addable = $derived(
    seminars.filter(
      (s) => !course?.items.some((i) => i.kind === 'seminar' && i.sessionId === s.id),
    ),
  )

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
    // The plan row form belongs to the course: a row index from a
    // neighbouring course would point at someone else's week here.
    plan = null
    seating = null
    slugDraft = open.slug ?? suggestSlug(open.name)
    nameDraft = open.name
    blurbDraft = open.blurb ?? ''
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

  const ROW = 'flex items-center gap-4 border-t border-line py-2.5'
  const ARROW =
    'flex h-8 w-8 items-center justify-center border border-line text-muted transition-colors ' +
    'duration-100 hover:border-faint hover:text-ink disabled:border-line-soft disabled:text-faint'
</script>

<!--
  The plan row fields — the same ones for a new topic and for editing an
  existing one. The topic is required (the server refuses without it), the
  week is not: a "for later" topic may not have a week yet.
-->
{#snippet planForm(label: string)}
  {#if plan}
    <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <input
        bind:this={planTopic}
        class="h-9 min-w-0 flex-[3_1_200px] border border-line bg-canvas px-3 text-ui text-ink
               placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
        placeholder={tr('admin.course.plannedTopic')}
        aria-label={tr('admin.course.plannedTopic')}
        maxlength={MAX_COURSE_NAME}
        bind:value={plan.name}
        onkeydown={planKeys}
      />
      <input
        class="h-9 min-w-0 flex-[1_1_150px] border border-line bg-canvas px-3 text-ui text-ink
               placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
        placeholder={tr('admin.course.plannedWhen')}
        aria-label={tr('admin.course.plannedWhenLabel')}
        maxlength={MAX_PLANNED_WHEN}
        bind:value={plan.when}
        onkeydown={planKeys}
      />
      <div class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          class="btn-primary h-9 px-3 text-2xs"
          disabled={busy || !planReady}
          onclick={() => void savePlan()}
        >
          {label}
        </button>
        <button type="button" class="btn-ghost h-9 px-3 text-2xs" onclick={() => (plan = null)}>
          {tr('admin.cancel')}
        </button>
      </div>
    </div>
  {/if}
{/snippet}

{#if !open}
  <AdminPage
    title={tr("admin.courses")}
    subtitle={tr("admin.group.seminars.on.a.course.page.and.set.their.order")}
  >
    {#snippet actions()}
      <button type="button" class="btn-primary" onclick={() => (creating = true)}>{tr("admin.new.course")}</button>
    {/snippet}

    <!-- Its own padding only from sm up: AdminPage already has one, and on a
         phone the double padding ate almost a third of the width under the
         course list. -->
    <div class="py-6 sm:px-8">
      {#if error}
        <p class="pb-4 text-ui text-danger">{error}</p>
      {/if}

      {#if creating}
        <div class="mb-5 flex items-center gap-3 border border-line bg-surface px-4 py-3">
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="h-9 min-w-0 flex-1 border border-line bg-canvas px-3 text-ui text-ink"
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
        <div class="py-16 text-center">
          <p class="text-title font-semibold text-ink">{tr("admin.no.courses.yet")}</p>
          <p class="mx-auto mt-2 max-w-sm text-ui text-muted">
            {tr("admin.create.a.course.and.add.seminars.students.will.see.the.list.and.l")}
          </p>
        </div>
      {/if}

      {#each courses as item (item.id)}
        {@const tally = courseTally(item.items)}
        <!-- flex-wrap and basis-48: with the "planned" count the tally line is
             longer than the room left on a phone, and without wrapping it
             stuck out past the edge while the course title shrank to zero. -->
        <div class="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line py-3.5">
          <button
            type="button"
            class="min-w-0 flex-1 basis-48 text-left"
            onclick={() => navigate(`/admin/courses/${item.id}`)}
          >
            <p class="text-ui-lg font-semibold text-ink">{item.name}</p>
            <!-- The address printed is the same one dictated to the class: the
                 point of a name is that it is the link, not a second address
                 next to it. -->
            <p class="mt-0.5 font-mono text-2xs text-muted">/c/{addressOf(item)}</p>
          </button>
          <p class="shrink-0 text-ui text-muted">
            {tally.published} {tr("admin.published")} {tally.waiting} {tr("admin.not.yet")}
            {#if tally.planned > 0}{tr('admin.course.plannedCount', { count: tally.planned })}{/if}
          </p>
        </div>
      {/each}

      <!--
        Pages without a room. The server serves them and `make site` publishes
        them, but they were visible nowhere in the panel — a page left behind
        by a deleted seminar could only be withdrawn by editing the database.
      -->
      {#if orphans.length > 0}
        <div class="mt-8 border-t border-line pt-5">
          <p class="text-ui font-semibold text-ink">{tr("admin.pages.without.a.room")}</p>
          <p class="mt-1 max-w-xl text-2xs leading-relaxed text-muted">
            {tr("admin.the.seminar.was.deleted.but.its.publication.was.kept.you.can.with")}
          </p>
          {#each orphans as page (page.id)}
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line py-3">
              <div class="min-w-0 flex-1">
                <p class="truncate text-ui text-ink">{page.title}</p>
                <p class="mt-0.5 font-mono text-2xs text-muted">
                  /p/{addressOf(page)} · {page.steps}
                  {plural(page.steps, tr("admin.step"), tr("admin.steps"), tr("admin.steps.143"))}
                  {page.state === 'withdrawn' ? (" " + tr("admin.withdrawn")) : ''}
                </p>
              </div>
              <a class="shrink-0 text-ui text-accent-text" href={`/p/${addressOf(page)}`} target="_blank" rel="noreferrer">
                {tr("admin.open")}
              </a>
              {#if page.state === 'published'}
                <button
                  type="button"
                  class="shrink-0 text-ui font-semibold text-muted hover:text-ink"
                  disabled={orphanBusy === page.id}
                  onclick={() => void actOnOrphan(page.id, () => adminApi.withdrawPublication(page.id))}
                >
                  {tr("admin.withdraw.page")}
                </button>
              {:else}
                <button
                  type="button"
                  class="shrink-0 text-ui font-semibold text-muted hover:text-ink"
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
                    class="shrink-0 text-ui font-semibold text-danger"
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
        </div>
      {/if}
    </div>
  </AdminPage>
{:else if course}
  {@const shown = course}
  <AdminPage title={shown.name}>
    {#snippet actions()}
      <!-- The address copied is the same one read out loud: /c/<name> if a
           name was given. Otherwise the id went into the chat, and the class
           ended up with two different addresses for the same course. -->
      <button
        type="button"
        class="btn-ghost"
        onclick={() => void copy(`${location.origin}/c/${addressOf(shown)}`, 'link')}
      >
        {copied === 'link' ? tr("admin.copied") : tr("admin.copy.link")}
      </button>
      <a class="btn-ghost" href={`/c/${addressOf(shown)}`} target="_blank" rel="noreferrer">
        {tr("admin.open.course.page")}
      </a>
      <button type="button" class="btn-primary" onclick={() => (adding = !adding)}>
        {tr("admin.add.seminar")}
      </button>
    {/snippet}

    <div class="py-6 sm:px-8">
      <button
        type="button"
        class="mb-5 text-ui text-muted transition-colors hover:text-ink"
        onclick={() => navigate('/admin/courses')}
      >
        {tr("admin.all.courses")}
      </button>

      <!--
        Title and caption — in the same place as the address: a course with a
        typo in its title could not be fixed anywhere, and the whole class
        sees it.
      -->
      <div class="flex flex-wrap items-center gap-2 pb-4">
        <input
          class="h-9 w-[280px] max-w-full border border-line bg-canvas px-3 text-ui text-ink
                 focus:outline-none focus:ring-2 focus:ring-accent/40"
          maxlength={MAX_COURSE_NAME}
          aria-label={tr("admin.course.name")}
          bind:value={nameDraft}
          onkeydown={(event) => {
            if (event.key === 'Enter') void saveDetails()
          }}
        />
        <input
          class="h-9 min-w-[220px] flex-1 border border-line bg-canvas px-3 text-ui text-ink
                 placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
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
            class="btn-primary h-9 shrink-0 px-3 text-2xs"
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
      <div class="flex flex-wrap items-center gap-2 pb-5">
        <span class="font-mono text-2xs text-muted">{location.host}/c/</span>
        <input
          class="h-9 w-[220px] border border-line bg-canvas px-2 font-mono text-2xs text-ink
                 placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
          placeholder={shown.id}
          maxlength={64}
          bind:value={slugDraft}
          onkeydown={(event) => {
            if (event.key === 'Enter') void saveSlug()
          }}
        />
        {#if slugDraft.trim() !== (shown.slug ?? '')}
          <button type="button" class="btn-primary h-9 px-3 text-2xs" disabled={busy} onclick={() => void saveSlug()}>
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
            class="btn-outline h-9 px-3 text-2xs"
            disabled={busy}
            onclick={() => (askingSlug = true)}
          >
            {tr("admin.release.previous.address")}
          </button>
        {/if}
        {#if shown.slug}
          <span class="text-2xs text-muted">{tr("admin.the.old.address.c")}{shown.id} {tr("admin.also.works")}</span>
        {/if}
      </div>

      {#if held}
        <p class="max-w-[640px] pb-5 text-2xs leading-snug text-muted">
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
        <div class="mb-5 max-w-[640px] border border-line bg-surface">
          <div class="border-b border-line px-4 py-2.5">
            <p class="text-ui font-semibold text-ink">{tr("admin.previous.addresses")}</p>
            <p class="mt-0.5 text-2xs leading-snug text-muted">
              {tr("admin.these.links.open.the.current.course.releasing.an.address.stops.it")}
            </p>
          </div>
          {#each former as name (name)}
            <div class="flex items-center gap-3 border-b border-line-soft px-4 py-2 last:border-b-0">
              <span class="min-w-0 flex-1 truncate font-mono text-2xs text-ink">/c/{name}</span>
              <button
                type="button"
                class="btn-outline h-9 shrink-0 px-3 text-2xs"
                disabled={busy}
                onclick={() => (dropping = name)}
              >
                {tr("admin.release")}
              </button>
            </div>
          {/each}
        </div>
      {/if}

      {#if error}
        <p class="pb-4 text-ui text-danger">{error}</p>
      {/if}

      <!--
        A statement, not a switch: nothing controls the course's visibility,
        and drawing a toggle for it would promise a choice that does not exist.
      -->
      <div class="mb-6 flex flex-wrap items-start gap-x-7 gap-y-2 border-y border-line py-4">
        <div class="w-[220px] shrink-0">
          <p class="text-ui font-semibold text-ink">{tr("admin.what.students.see")}</p>
          <p class="mt-0.5 text-2xs leading-snug text-muted">
            {tr("admin.the.page.is.accessible.by.link.without.signing.in")}
          </p>
        </div>
        <!-- basis: without it flex-1 stayed in the row next to the caption at
             a width of thirty pixels and stuck out past the edge, instead of
             moving down. -->
        <p class="min-w-0 max-w-[640px] flex-1 basis-[260px] text-ui leading-relaxed text-muted">
          {tr("admin.the.course.page.shows.seminar.names.in.the.chosen.order.and.links")}
        </p>
      </div>

      {#if adding}
        <div class="mb-5 border border-line bg-surface p-3">
          {#if addable.length === 0}
            <p class="text-ui text-muted">{tr("admin.no.seminars.available.to.add")}</p>
          {:else}
            <div class="flex flex-wrap gap-2">
              {#each addable as session (session.id)}
                <button
                  type="button"
                  class="border border-line bg-canvas px-3 py-1.5 text-ui text-ink transition-colors
                         hover:border-faint disabled:text-faint"
                  disabled={busy}
                  onclick={() => add(session.id)}
                >
                  {session.name}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!--
        The list sits in a container with its own width: the 290px
        "Publication" column and the arrows did not fit next to the title even
        on a tablet with the menu open, and on a phone the title squeezed into
        a column with the publication text lying on top of it. The breakpoint
        goes by the width of the list itself, not the window: the panel's menu
        takes a different width on different screens.
      -->
      <div class="course-rows">
      <div class="flex items-center gap-4 pb-2">
        <span class="w-[26px] shrink-0"></span>
        <span class="flex-1 text-micro font-bold uppercase tracking-caps text-muted">{tr("admin.seminar")}</span>
        <span class="course-head-state w-[290px] shrink-0 text-micro font-bold uppercase tracking-caps text-muted">
          {tr("admin.publication")}
        </span>
        <span class="w-[60px] shrink-0"></span>
      </div>

      {#each shown.items as item, index (index)}
        {@const editing = plan?.target?.at === index}
        <div class="course-row {ROW}">
          <span class="w-[26px] shrink-0 font-mono text-2xs text-faint">
            {String(index + 1).padStart(2, '0')}
          </span>
          {#if editing}
            {@render planForm(tr('admin.save'))}
          {:else if item.kind === 'planned'}
            <!--
              A plan row: topic and week, and three actions on it. "Assign
              class" is the main one and is therefore in the accent colour,
              like "Publish" on a class: that is the whole life of such a row
              — a week has passed, the room takes its place, the week
              numbering does not shift.
            -->
            <div class="course-name min-w-0 flex-1">
              <p class="text-ui text-ink">{item.name}</p>
              <p class="mt-0.5 text-2xs text-muted">
                {tr("admin.planned")}{item.when ? ` · ${item.when}` : ''}
              </p>
            </div>
            <div class="course-state flex w-[290px] shrink-0 items-baseline gap-3">
              <button
                type="button"
                class="whitespace-nowrap text-ui font-semibold text-accent-text disabled:text-faint"
                disabled={busy}
                aria-expanded={seating?.at === index}
                onclick={() => openSeat(index)}
              >
                {tr('admin.course.seat')}
              </button>
              <button
                type="button"
                class="whitespace-nowrap text-ui font-semibold text-muted hover:text-ink disabled:text-faint"
                disabled={busy}
                onclick={() => void openPlan(index)}
              >
                {tr('admin.course.editPlanned')}
              </button>
              <button
                type="button"
                class="whitespace-nowrap text-ui font-semibold text-muted hover:text-ink disabled:text-faint"
                disabled={busy}
                onclick={() => drop(index)}
              >
                {tr('admin.course.removePlanned')}
              </button>
            </div>
          {:else if item.kind === 'gone'}
            <div class="course-name min-w-0 flex-1">
              <p class="text-ui text-muted">{item.name}</p>
              <p class="mt-0.5 text-2xs text-muted">
                {tr("admin.seminar.deleted.position.in.list.kept")}
              </p>
            </div>
            <div class="course-state flex w-[290px] shrink-0 items-baseline gap-3">
              <!-- "Nothing to publish" is true only when there is no page. The
                   room was deleted but the reading page remained: otherwise
                   there is no way to reach it from the course, even though
                   the course is the only address the class is given. -->
              {#if item.publication}
                <a
                  class="text-ui text-accent-text"
                  href={`/p/${addressOf(item.publication)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {tr("admin.open.saved.publication")}
                </a>
              {:else}
                <span class="text-ui text-muted">{tr("admin.no.publication")}</span>
              {/if}
              <button
                type="button"
                class="text-ui font-semibold text-muted hover:text-ink disabled:text-faint"
                disabled={busy}
                onclick={() => drop(index)}
              >
                {tr("admin.remove.row")}
              </button>
            </div>
          {:else}
            <div class="course-name min-w-0 flex-1">
              <p class="text-ui font-semibold text-ink">{item.name}</p>
              <p class="mt-0.5 font-mono text-2xs text-muted">/s/{item.sessionId}</p>
            </div>
            <div class="course-state flex w-[290px] shrink-0 items-baseline gap-3">
              {#if item.publication}
                <a
                  class="text-ui text-accent-text"
                  href={`/p/${addressOf(item.publication)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {tr("admin.published.203")} {item.publication.steps}
                  {plural(item.publication.steps, tr("admin.step"), tr("admin.steps"), tr("admin.steps.206"))}
                </a>
              {:else}
                <span class="text-ui text-muted">{tr("admin.not.published.yet")}</span>
                <button
                  type="button"
                  class="text-ui font-semibold text-accent-text"
                  onclick={() => navigate(`/admin/publish/${item.sessionId}`)}
                >
                  {tr("admin.publish")}
                </button>
              {/if}
            </div>
          {/if}
          <!-- While a row is being edited it has no arrows: a moved edit would
               be saved into someone else's position. -->
          {#if !editing}
            <div class="course-moves flex w-[60px] shrink-0 items-center justify-end gap-1">
              <button
                type="button"
                class={ARROW}
                disabled={index === 0 || busy}
                aria-label={tr("admin.move.up")}
                onclick={() => move(index, -1)}
              >
                <Icon name="chevron-up" size={11} />
              </button>
              <button
                type="button"
                class={ARROW}
                disabled={index === shown.items.length - 1 || busy}
                aria-label={tr("admin.move.down")}
                onclick={() => move(index, 1)}
              >
                <Icon name="chevron-down" size={11} />
              </button>
            </div>
          {/if}
        </div>

        <!-- The class picker sits right under the row, not above the list: in
             a semester plan the week you need is far down, and a panel at the
             top ended up off screen from the button that opened it. -->
        {#if seating && seating.at === index}
          {@const place = seating}
          <div class="mb-2.5 ml-[42px] border border-line bg-surface p-3">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 pb-2.5">
              <p class="min-w-0 flex-1 text-2xs leading-snug text-muted">
                {tr('admin.course.seatQuestion', { name: place.was.name })}
              </p>
              <button
                type="button"
                class="shrink-0 text-2xs font-semibold text-muted hover:text-ink"
                onclick={() => (seating = null)}
              >
                {tr('admin.cancel')}
              </button>
            </div>
            {#if addable.length === 0}
              <p class="text-ui text-muted">{tr("admin.no.seminars.available.to.add")}</p>
            {:else}
              <div class="flex flex-wrap gap-2">
                {#each addable as session (session.id)}
                  <button
                    type="button"
                    class="border border-line bg-canvas px-3 py-1.5 text-ui text-ink transition-colors
                           hover:border-faint disabled:text-faint"
                    disabled={busy}
                    onclick={() => void seat(session.id)}
                  >
                    {session.name}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      {/each}

      {#if shown.items.length === 0 && !(plan && !plan.target)}
        <p class="border-t border-line py-8 text-center text-ui text-muted">
          {tr("admin.this.course.has.no.seminars.yet")}
        </p>
      {/if}

      <!--
        A new topic goes at the bottom of the list, where it will end up, and
        with the number it will get. The button stands in the row's place, not
        in the header: a plan is typed in one go, and the form stays open
        until "Cancel" is pressed.
      -->
      {#if plan && !plan.target}
        <div class="course-row {ROW}">
          <span class="w-[26px] shrink-0 font-mono text-2xs text-faint">
            {String(shown.items.length + 1).padStart(2, '0')}
          </span>
          {@render planForm(tr('admin.course.addToPlan'))}
        </div>
      {:else}
        <div class="border-t border-line py-2.5 pl-[42px]">
          <button
            type="button"
            class="text-ui font-semibold text-accent-text hover:brightness-110 disabled:text-faint"
            disabled={busy}
            onclick={() => void openPlan(null)}
          >
            {tr('admin.course.addPlanned')}
          </button>
        </div>
      {/if}
      </div>

      <p class="border-t border-line pt-4 text-2xs leading-relaxed text-muted">
        {tr("admin.use.the.arrows.to.reorder.seminars.the.new.order.appears.when.the")}
        {tr('admin.course.planHint')}
      </p>

      <!-- Deletion lives inside the course itself and names the link it
           breaks: the seminars and their pages stay, what breaks is the
           address the class was dictated in the first week. -->
      <div class="mt-8 flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <p class="min-w-0 flex-1 text-2xs text-muted">
          {tr("admin.deleting.the.course.removes.the.seminar.list.its.order.and.the.ad")}
          <span class="font-mono">/c/{addressOf(shown)}</span>{tr("admin.seminars.and.published.pages.will.be.kept")}
        </p>
        <button
          type="button"
          class="shrink-0 text-ui font-semibold text-danger hover:brightness-110"
          onclick={() => (doomed = true)}
        >
          {tr("admin.delete.course")}
        </button>
      </div>
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
    <div class="px-8 py-16 text-center">
      {#if loadingOne}
        <p class="text-ui text-muted">{tr("admin.opening.course")}</p>
      {:else}
        <p class="text-title font-semibold text-ink">{tr("admin.could.not.open.course")}</p>
        <p class="mx-auto mt-2 max-w-sm text-ui text-muted">
          {error ?? tr("admin.check.the.address.or.return.to.the.course.list")}
        </p>
        <button type="button" class="btn-primary mt-4" onclick={() => navigate('/admin/courses')}>
          {tr("admin.all.courses")}
        </button>
      {/if}
    </div>
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
          class="btn bg-danger text-white hover:brightness-110 disabled:opacity-40"
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
          class="btn bg-danger text-white hover:brightness-110 disabled:opacity-40"
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
          class="btn bg-danger text-white hover:brightness-110 disabled:opacity-40"
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
   * The narrow list: the title on its own line, the publication and arrows
   * below it.
   *
   * The breakpoint is the width of the list itself (container), not the
   * window: at md the panel's menu takes 236px, and a 768 window leaves the
   * list less room than a 640 window with the narrow menu. 559px is the
   * number, the 290 "Publication" column, the arrows and at least some room
   * for the title.
   */
  .course-rows {
    container-type: inline-size;
  }

  @container (max-width: 559px) {
    /* The number sits by the title, not midway between the two lines:
       centred, it read as the publication line's number. */
    .course-row {
      flex-wrap: wrap;
      align-items: flex-start;
      row-gap: 0.5rem;
    }

    /* A 26px number and a 16px gap — the title takes the rest of the first line. */
    .course-name {
      flex-basis: calc(100% - 42px);
    }

    .course-state {
      order: 1;
      flex: 1 1 0%;
      width: auto;
      min-width: 0;
      margin-left: 42px;
      flex-wrap: wrap;
      row-gap: 0.25rem;
    }

    .course-moves {
      order: 2;
    }

    .course-head-state {
      display: none;
    }
  }
</style>
