<!--
  The course page: the one Colloq address people bookmark.

  A student opens it a dozen times a semester, and every time with one of
  two questions: what was last time (the slides, the notebook) and what is
  next. So those two answers come first, as blocks with their links, and the
  semester plan follows as a list: past rows lead to their pages, future rows
  say their day, the «сегодня» line sits between the two, and months head the
  list the way a timetable does.

  A document, not a dashboard: thin rules, no cards, no radius. From 1024 px
  the two blocks and the course link move to a 380 px rail beside the list;
  below that everything stacks in reading order.

  Every date decision comes from lib/course-now.ts with the server's
  `today`: the browser's zone never decides what «сегодня» is.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import { storedTokens } from '@/lib/identity'
  import ReaderBar from './ReaderBar.svelte'
  import CopyLink from './CopyLink.svelte'
  import MaterialLinks from './MaterialLinks.svelte'
  import { wideScreen } from './wide.svelte'
  import { pageHref, plainClick } from './links'
  import {
    coursePlan,
    courseMonths,
    courseNow,
    courseTally,
    courseWeekday,
    courseYears,
    monthName,
    ordinal,
    pastLabel,
    rowNote,
    shortDay,
    upcomingLabel,
    weekdayPhrase,
    type ListEntry,
  } from '@/lib/course-now'
  import {
    MAX_DOOR_TOKENS,
    type PublicClass,
    type PublicCourseView,
    type RoomDoor,
  } from '@shared/publish'

  interface Props {
    course: PublicCourseView
    onnavigate: (path: string) => void
  }

  let { course, onnavigate }: Props = $props()

  const wide = wideScreen()
  const today = $derived(course.today)
  const now = $derived(courseNow(course.classes, today))
  const list = $derived(coursePlan(course.classes, today))
  const tally = $derived(courseTally(course.classes, today))

  /** «показать весь план»: once unfolded, the plan stays whole for this visit. */
  let unfolded = $state(false)
  const entries = $derived(
    list.folded && !unfolded ? list.entries.slice(0, list.folded.from) : list.entries,
  )

  const years = $derived(courseYears(course.classes))
  /** «33 занятия · по воскресеньям · сентябрь — май · курс завершён», a part per line break. */
  const meta = $derived.by(() => {
    const parts = [tr('room.course.count', { count: tally.classes })]
    const weekday = courseWeekday(course.classes)
    if (weekday !== null) parts.push(weekdayPhrase(weekday))
    const months = courseMonths(course.classes)
    if (months) {
      parts.push(
        tr('room.course.span', {
          from: monthName(Number(months.first.slice(5, 7)), null),
          to: monthName(Number(months.last.slice(5, 7)), null),
        }),
      )
    }
    if (now?.over) parts.push(tr('room.course.over'))
    return parts
  })
  /** «3 с материалами · 30 впереди». */
  const counted = $derived(
    [
      tally.pages > 0 ? tr('room.course.withMaterials', { count: tally.pages }) : null,
      tally.ahead > 0 ? tr('room.course.ahead', { count: tally.ahead }) : null,
    ]
      .filter(Boolean)
      .join(' · '),
  )
  /** «Январь — май: ещё 17 занятий». */
  const foldedText = $derived.by(() => {
    const folded = list.folded
    if (!folded) return ''
    const first = monthName(Number(folded.first.slice(5, 7)), null)
    const last = monthName(Number(folded.last.slice(5, 7)), null)
    const range = first === last ? first : tr('room.course.span', { from: first, to: last })
    const text = tr('room.course.more', { range, count: folded.classes })
    return text.charAt(0).toUpperCase() + text.slice(1)
  })

  const coursePath = $derived(`/c/${course.slug ?? course.id}`)

  /*
   * «Войти в комнату» on the day of a class, while it is on. The course
   * never names its rooms; the row's door (POST /api/c/:id/room) answers with
   * the address only for a browser that was in that room, for staff, or when
   * the teacher opened it to everyone, and says whether the class is still on.
   * Asked only for today's row with a room behind it.
   */
  const todayKey = $derived.by(() => {
    const up = now?.upcoming
    if (up?.kind !== 'today') return null
    return up.row.state === 'room' || up.row.state === 'page' ? up.row.key : null
  })
  let door = $state<RoomDoor | null>(null)

  $effect(() => {
    const key = todayKey
    const id = course.id
    door = null
    if (!key) return
    let cancelled = false
    api
      .courseRoomDoor(id, key, storedTokens(MAX_DOOR_TOKENS))
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

  /** The room of today's class, only while the class is on. */
  const liveRoom = $derived(door?.room?.live ? door.room : null)

  function follow(event: MouseEvent, path: string): void {
    if (!plainClick(event)) return
    event.preventDefault()
    onnavigate(path)
  }

  /** Line 2 of a row, as parts: the accent ones are mono caps. */
  function lineParts(entry: Extract<ListEntry, { kind: 'row' }>): { text: string; accent: boolean }[] {
    const note = rowNote(entry.row, today, { next: entry.next, withDate: !wide.current })
    const parts: { text: string; accent: boolean }[] = []
    if (note.chip) parts.push({ text: tr('room.course.today'), accent: true })
    if (note.date) parts.push({ text: note.date, accent: false })
    if (note.next) parts.push({ text: note.next, accent: true })
    if (note.text) parts.push({ text: note.text, accent: false })
    return parts
  }

  /** The day column of a wide row: the date, or the legacy week text of an undated row. */
  function dayText(row: PublicClass): string {
    return row.day ? shortDay(row.day) : (row.when ?? '')
  }
</script>

{#snippet chevron()}
  <span class="flex w-6 shrink-0 justify-end pt-1 text-accent lg:pt-1" aria-hidden="true">
    <Icon name="chevron-right" size={16} strokeWidth={2.6} />
  </span>
{/snippet}

{#snippet title(n: number | null, text: string, linked: boolean)}
  <span class="flex min-w-0 items-baseline gap-2.5">
    {#if n !== null}
      <span class="shrink-0 font-mono text-[14px] leading-7 {linked ? 'text-ink' : 'text-muted'}">
        {ordinal(n)}
      </span>
    {/if}
    <span class="min-w-0 text-head font-bold text-ink">{text}</span>
  </span>
{/snippet}

{#snippet upcomingBlock()}
  {#if now?.upcoming}
    {@const up = now.upcoming}
    {@const page = up.row.page}
    {@const live = up.kind === 'today' ? liveRoom : null}
    <section
      class="-mx-4 flex flex-col gap-2.5 border-t-2 border-brand bg-surface px-4 pb-[22px] pt-5
             dark:border-accent sm:-mx-6 sm:px-6 lg:mx-0 lg:p-6"
    >
      <p class="flex items-center gap-2 font-mono text-micro uppercase tracking-label text-accent-text">
        {#if live}<span class="h-1.5 w-1.5 shrink-0 bg-accent" aria-hidden="true"></span>{/if}
        <span>{live ? tr('room.course.todayLive', { day: shortDay(up.row.day) }) : upcomingLabel(up)}</span>
      </p>
      {#if page}
        <a
          href={pageHref(page.address)}
          class="-my-1 flex min-h-11 items-center justify-between gap-3"
          onclick={(event) => follow(event, pageHref(page.address))}
        >
          {@render title(up.row.n, up.row.title, true)}
          <span class="shrink-0 text-accent" aria-hidden="true">
            <Icon name="chevron-right" size={16} strokeWidth={2.6} />
          </span>
        </a>
      {:else}
        {@render title(up.row.n, up.row.title, false)}
      {/if}
      {#if live}
        <!-- A full load, in this tab: the room is its own app. -->
        <a
          href={live.path}
          class="press mt-1 flex h-12 shrink-0 items-center justify-center gap-2.5 bg-brand px-3
                 text-[13px] font-bold uppercase leading-4 tracking-caps text-white
                 hover:brightness-110 dark:bg-primary dark:text-primary-ink"
        >
          <span>{tr('room.course.enter')}</span>
          <Icon name="arrow-right" size={16} strokeWidth={2.2} class="shrink-0" />
        </a>
      {/if}
      {#if up.kind === 'today' && !page}
        <p class="text-ui-lg text-muted">{tr('room.course.afterClass')}</p>
      {:else if up.kind !== 'today' && up.row.about}
        <p class="text-ui-lg text-muted">{up.row.about}</p>
      {/if}
      {#if page}
        <div class="pt-1">
          {#if up.kind !== 'today'}
            <p class="pb-2 font-mono text-micro uppercase tracking-label text-muted">
              {tr('room.course.beforeClass')}
            </p>
          {/if}
          <MaterialLinks
            address={page.address}
            materials={page.materials}
            zipBytes={page.zipBytes}
            onSurface
            {onnavigate}
          />
        </div>
      {/if}
    </section>
  {/if}
{/snippet}

{#snippet pastBlock()}
  <!-- On the evening of a class its own block carries the materials; this
       one keeps only the way to the previous page (`brief`), so the rail
       does not list two sets of links one under the other. -->
  {#if now?.past}
    {@const past = now.past}
    {@const page = past.row.page}
    {@const brief = !!now.upcoming?.row.page && now.upcoming.kind === 'today'}
    <section class="flex flex-col pt-8 lg:pt-0">
      <div class="border-b-2 border-ink pb-3">
        <p class="font-mono text-micro uppercase tracking-label text-muted">{pastLabel(past)}</p>
      </div>
      {#if page}
        <a
          href={pageHref(page.address)}
          class="flex min-h-11 items-center justify-between gap-3 pb-3 pt-4"
          onclick={(event) => follow(event, pageHref(page.address))}
        >
          {@render title(past.row.n, past.row.title, true)}
          <span class="shrink-0 text-accent" aria-hidden="true">
            <Icon name="chevron-right" size={16} strokeWidth={2.6} />
          </span>
        </a>
        {#if !brief}
          <MaterialLinks
            address={page.address}
            materials={page.materials}
            zipBytes={page.zipBytes}
            {onnavigate}
          />
        {/if}
      {:else}
        <div class="pb-1 pt-4">{@render title(past.row.n, past.row.title, false)}</div>
        <p class="text-ui-lg text-muted">
          {past.row.state === 'closed' ? tr('room.course.none') : tr('room.course.noneYet')}
        </p>
        {#if past.latest?.page}
          {@const latest = past.latest}
          {@const href = pageHref(latest.page!.address)}
          <a
            {href}
            class="flex min-h-11 items-center text-ui-lg text-accent-text"
            onclick={(event) => follow(event, href)}
          >
            {tr('room.course.latest', {
              title: latest.n !== null ? `${ordinal(latest.n)} · ${latest.title}` : latest.title,
            })}
          </a>
        {/if}
      {/if}
    </section>
  {/if}
{/snippet}

{#snippet linkBlock()}
  <section class="flex flex-col gap-2.5 pb-14 pt-8 lg:p-0">
    <div class="border-b-2 border-ink pb-3">
      <p class="font-mono text-micro uppercase tracking-label text-muted">{tr('room.course.link')}</p>
    </div>
    <CopyLink path={coursePath} />
    <p class="text-[14px] leading-[21px] text-muted">{tr('room.course.note')}</p>
  </section>
{/snippet}

{#snippet rowBody(entry: Extract<ListEntry, { kind: 'row' }>, linked: boolean)}
  {@const row = entry.row}
  {@const parts = lineParts(entry)}
  {#if entry.today}
    <span class="absolute inset-y-0 -left-4 w-0.5 bg-accent sm:-left-6 lg:-left-4" aria-hidden="true"
    ></span>
  {/if}
  <span
    class="shrink-0 font-mono {wide.current
      ? 'w-14 text-[14px] leading-6'
      : 'w-8 text-[13px] leading-[22px]'} {linked ? 'text-ink' : 'text-faint'}"
  >
    {row.n !== null ? ordinal(row.n) : ''}
  </span>
  {#if wide.current}
    <span class="w-28 shrink-0 text-[15px] leading-6 text-muted">{dayText(row)}</span>
  {/if}
  <span class="flex min-w-0 flex-1 flex-col gap-1">
    <span
      class="{wide.current ? 'text-title' : 'text-[17px] leading-[22px]'}
             {linked ? 'font-semibold text-ink' : 'text-muted'}"
    >
      {row.title}
    </span>
    {#if parts.length > 0}
      <span
        class="{wide.current ? 'text-[14px] leading-5' : 'text-[13px] leading-[18px]'} text-muted"
      >
        {#each parts as part, i (i)}
          {#if i > 0}<span aria-hidden="true">{' · '}</span>{/if}
          {#if part.accent}
            <span class="font-mono text-[11px] uppercase tracking-label text-accent-text">
              {part.text}
            </span>
          {:else}
            <span>{part.text}</span>
          {/if}
        {/each}
      </span>
    {/if}
  </span>
  {#if linked}
    {@render chevron()}
  {:else}
    <span class="w-6 shrink-0" aria-hidden="true"></span>
  {/if}
{/snippet}

<div class="min-h-screen bg-canvas">
  <ReaderBar crumb={tr('room.course.top')} wide={wide.current} {onnavigate} />

  <div
    class="mx-auto w-full max-w-[1440px] px-4 sm:px-6 lg:flex lg:items-start lg:gap-20 lg:px-10
           lg:pb-24 lg:pt-16"
  >
    <main class="min-w-0 flex-1">
      <div class="flex flex-col gap-3 pb-7 pt-7 lg:gap-5 lg:pb-14 lg:pt-0">
        <p class="font-mono text-micro uppercase tracking-label text-accent-text">
          {years ? tr('room.course.labelYears', { years }) : tr('room.course.top')}
        </p>
        <h1
          class="text-[36px] font-black leading-[38px] tracking-[-0.03em] text-ink sm:text-marquee
                 lg:text-[72px] lg:leading-[72px] lg:tracking-[-0.04em]"
        >
          {course.name}
        </h1>
        {#if course.blurb}
          <p class="max-w-[640px] text-[16px] leading-6 text-muted lg:text-[18px] lg:leading-7">
            {course.blurb}
          </p>
        {/if}
        <!-- Each part keeps its words together: «сентябрь — май» broken after the
             dash reads as two facts. -->
        <p class="pt-1 font-mono text-micro uppercase tracking-label text-muted lg:pt-0">
          {#each meta as part, i (i)}
            {#if i > 0}<span aria-hidden="true">{' · '}</span>{/if}<span class="whitespace-nowrap"
              >{part}</span
            >
          {/each}
        </p>
      </div>

      {#if !wide.current}
        {@render upcomingBlock()}
        {@render pastBlock()}
      {/if}

      <section class="pt-11 lg:pt-0" aria-labelledby="course-classes">
        <div class="flex items-end justify-between gap-3 border-b-2 border-ink pb-3">
          <h2
            id="course-classes"
            class="text-[13px] font-black uppercase leading-4 tracking-section text-ink"
          >
            {tr('room.course.classes')}
          </h2>
          {#if counted}
            <p class="text-right font-mono text-micro uppercase tracking-caps text-muted">{counted}</p>
          {/if}
        </div>

        {#if course.classes.length === 0}
          <p class="pb-10 pt-5 text-title text-muted">{tr('room.course.empty')}</p>
        {:else}
          <ol>
            {#each entries as entry (entry.key)}
              {#if entry.kind === 'month'}
                <li
                  class="border-b border-line pb-2 pt-6 font-mono text-micro uppercase tracking-label
                         text-muted lg:pb-2.5 lg:pt-7"
                >
                  {monthName(entry.month, entry.year)}
                </li>
              {:else if entry.kind === 'now'}
                <li class="flex items-center gap-3 pt-3.5" aria-label={tr('room.course.todayAt', { day: shortDay(today) })}>
                  <span class="shrink-0 font-mono text-[11px] uppercase leading-4 tracking-label text-accent-text">
                    {tr('room.course.todayAt', { day: shortDay(today) })}
                  </span>
                  <span class="h-0.5 flex-1 bg-accent" aria-hidden="true"></span>
                </li>
              {:else if entry.row.state === 'pause'}
                {@const row = entry.row}
                <!-- A break in the timetable: no number, no link, hatched so it
                     reads as a gap and not as a class nobody published. -->
                <li
                  class="flex items-center border-b border-line py-3 text-[15px] leading-[22px] text-faint
                         [background-image:repeating-linear-gradient(135deg,rgb(var(--line)/0.45)_0_1px,transparent_1px_7px)]"
                >
                  <span class="{wide.current ? 'w-14' : 'w-8'} shrink-0" aria-hidden="true"></span>
                  {#if wide.current}
                    <span class="w-28 shrink-0">{dayText(row)}</span>
                    <span class="min-w-0 flex-1">{tr('room.course.pause', { title: row.title })}</span>
                  {:else}
                    <span class="min-w-0 flex-1">
                      {tr('room.course.pause', { title: row.title })}{dayText(row)
                        ? ` · ${dayText(row)}`
                        : ''}
                    </span>
                  {/if}
                </li>
              {:else if entry.row.page}
                {@const href = pageHref(entry.row.page.address)}
                <li class="relative border-b border-line">
                  <a
                    {href}
                    class="flex min-h-[60px] items-start transition-colors duration-100
                           hover:bg-surface/70 {wide.current ? 'py-[18px]' : 'py-3.5'}"
                    onclick={(event) => follow(event, href)}
                  >
                    {@render rowBody(entry, true)}
                  </a>
                </li>
              {:else}
                <li
                  class="relative flex min-h-[60px] items-start border-b border-line
                         {wide.current ? 'py-[18px]' : 'py-3.5'}"
                >
                  {@render rowBody(entry, false)}
                </li>
              {/if}
            {/each}
          </ol>
          {#if list.folded && !unfolded}
            <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-5">
              <p class="text-[15px] leading-[22px] text-muted">{foldedText}</p>
              <button
                type="button"
                class="press -my-2 flex h-11 items-center text-[15px] leading-[22px] text-accent-text"
                onclick={() => (unfolded = true)}
              >
                <span class="border-b border-dashed border-current">{tr('room.course.showAll')}</span>
              </button>
            </div>
          {/if}
        {/if}
      </section>

      {#if !wide.current}
        {@render linkBlock()}
      {/if}
    </main>

    {#if wide.current}
      <aside class="flex w-[380px] shrink-0 flex-col gap-8 pt-2">
        {@render upcomingBlock()}
        {@render pastBlock()}
        {@render linkBlock()}
      </aside>
    {/if}
  </div>
</div>
