<!--
  Public reading: the course page and a published seminar.

  No token, no identity, no sockets. This is not a "read-only mode" the
  server would have to enforce but a different thing: behind these pages
  there is no room, no document, no kernel — only what was collected at the
  moment of publishing. So there is not a single button here that could
  change anything, and nothing to fail.
-->
<script lang="ts">
  import Splash from '@/components/ui/Splash.svelte'
  import { firstScreenReady } from '@/lib/boot'
  import { tr, getLocale } from '@shared/i18n'
  import { api, ApiError } from '@/lib/api'
  import Icon from '@/components/ui/Icon.svelte'
  import PublicNotebook from '@/components/reader/PublicNotebook.svelte'
  import CourseList from '@/components/reader/CourseList.svelte'
  import { plural } from '@/lib/plural'
  import {
    refusedStep,
    type PublicCourseView,
    type PublicSeminar,
    type PublicStep,
  } from '@shared/publish'

  interface Props {
    course: string | null
    publication: { id: string; step: number | null } | null
    onnavigate: (path: string) => void
  }

  let { course, publication, onnavigate }: Props = $props()

  let courseView = $state<PublicCourseView | null>(null)
  let seminar = $state<PublicSeminar | null>(null)
  let step = $state<PublicStep | null>(null)
  let missing = $state(false)
  /** The page is gone altogether: it was withdrawn or deleted while being read. */
  let gone = $state(false)
  /**
   * No such step, but the page exists: an outdated link to a mark or a wrong
   * number.
   *
   * Separate from `gone`, because it is different news and a different road:
   * the seminar is alive, open, and has a first page to go to. Both cases
   * come with a 404, and only the response body tells them apart
   * (`refusedStep` in shared/publish.ts). While the reader looked at the bare
   * status, `/p/<id>/999` printed "this page of the seminar no longer exists
   * — it was republished": news of something irreparable about a live,
   * untouched publication.
   */
  let noSuchStep = $state(false)
  /**
   * Not "the page does not exist" but "did not get through": a 500, a dropped
   * connection, a timeout.
   *
   * While these were not told apart from a 404, all of them gave
   * `missing === false` and a blank white screen — not a word, not a button,
   * not a hint that a reload helps; a person on the metro read it as "the
   * course was deleted". api.ts prepares the phrase for the person itself; it
   * is enough to show it here.
   */
  let failureRender = $state<() => string | null>(() => null)
  const failure = $derived(failureRender())
  /** "Try again": a counter in the effects' dependencies, not a second way of loading. */
  let attempt = $state(0)
  let loading = $state(true)

  /*
   * The step lives in the address: `/p/x9tb4kwm/3184`. The browser's "Back"
   * must return to the previous step, not throw the person off the page —
   * people walk back and forth through steps comparing "before" and "after".
   */
  const wanted = $derived(publication?.step ?? null)

  /**
   * The publication id — as a string, not through the prop itself.
   *
   * `readPublicRoute` in the router builds a NEW object on every address
   * change, including `/p/x/3` → `/p/x/4`. The effects below read
   * `publication?.id`, that is, depended on the object, and every step cost
   * an extra GET /api/p/:id — exactly what the `{#key}` key in App.svelte
   * promised not to do ("do not reload the seminar on every step"). A string
   * `$derived` does not wake its dependents while the value stays the same —
   * and the promise starts being kept.
   */
  const pubId = $derived(publication?.id ?? null)

  /*
   * What is NOT on screen is cleared, not left over from the previous address.
   *
   * The router rebuilds this screen by the view key (App.svelte), and since
   * that key was fixed a course should no longer arrive here under a
   * publication address. But the `{:else if courseView}` branch in the markup
   * comes before `{:else if seminar}`, and the price of a mistake here is a
   * page showing something other than what is in the address. The screen
   * takes care of it itself: gone from the props — cleared.
   */
  $effect(() => {
    if (!course) courseView = null
    if (pubId === null) {
      seminar = null
      step = null
      gone = false
      noSuchStep = false
    }
  })

  /**
   * A refusal: 404 means "no such page", everything else means "did not get
   * through".
   *
   * Different answers, because different actions: the first is final, the
   * second is cured by a button.
   */
  function refused(err: unknown): void {
    if (err instanceof ApiError && err.status === 404) missing = true
    else failureRender = () => (err instanceof Error ? tr(err.message) : tr('room.ui.887'))
  }

  $effect(() => {
    const id = course
    void attempt
    if (!id) return
    let cancelled = false
    loading = true
    missing = false
    failureRender = () => (null)
    void api
      .course(id)
      .then((body) => {
        if (!cancelled) courseView = body.course
      })
      .catch((err) => {
        if (!cancelled) refused(err)
      })
      .finally(() => {
        if (!cancelled) loading = false
      })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    const id = pubId
    void attempt
    if (!id) return
    let cancelled = false
    missing = false
    failureRender = () => (null)
    void api
      .publication(id)
      .then((body) => {
        if (!cancelled) seminar = body.seminar
      })
      .catch((err) => {
        if (!cancelled) refused(err)
      })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    const id = pubId
    const seq = wanted
    void attempt
    if (!id) return
    let cancelled = false
    loading = true
    /*
     * The previous step is cleared BEFORE the new one loads.
     *
     * It used to stay — and on moving to a step that no longer exists (the
     * seminar was republished without this mark) the reader silently saw the
     * previous notebook under the new address. A lying page is worse than an
     * empty one.
     */
    step = null
    gone = false
    noSuchStep = false
    void api
      .step(id, seq)
      .then((body) => {
        if (!cancelled) step = body.step
      })
      .catch((err) => {
        if (cancelled) return
        if (!(err instanceof ApiError)) return refused(err)
        /*
         * Which of the two 404s it is — the body decides, not the code.
         *
         * `gone` on any 404 meant "it was republished", for a wrong number too;
         * yet the page is alive, and the way out of it leads elsewhere. An
         * unknown body (a proxy stub, someone else's answer) means "I do not
         * know", not "no": we show the refusal with a "Try again" button, as
         * for a dropped connection.
         */
        const what = refusedStep(err.status, err.message)
        if (what === 'publication') gone = true
        else if (what === 'step') noSuchStep = true
        else if (err.status === 404) failureRender = () => (tr('room.ui.888'))
        else refused(err)
      })
      .finally(() => {
        if (!cancelled) loading = false
      })
    return () => {
      cancelled = true
    }
  })

  /*
   * The reader has something to show when the course or the publication has
   * arrived — or when it is already known that they do not exist (`missing`,
   * a refusal). Until then the splash from index.html is on screen; removing
   * it earlier means showing the empty ground of the page the person came
   * here for (lib/boot.ts).
   */
  $effect(() => {
    if (missing || courseView !== null || seminar !== null || failure !== null) firstScreenReady()
  })

  /*
   * Only the step that is really open is marked. It used to fall back to the
   * first — and the rail showed step 01 in bold, although the screen was
   * empty or showed something else.
   */
  const current = $derived(step?.seq ?? null)
  /** Where to send people from a vanished step: the first — every publication has it. */
  const first = $derived(seminar?.steps[0]?.seq ?? null)
  /**
   * Whether the reader is on the last step — the download label depends on
   * it.
   *
   * While there is no step (loading, a wrong number, the publication was
   * withdrawn), we assume the last one: at that moment the link goes without
   * `?step=`, and without it the server serves exactly the last step. The
   * label and the file say the same thing at every second of the page's life.
   */
  const onLast = $derived(current === null || current === seminar?.steps.at(-1)?.seq)
  /* A rail of one step is furniture. In the first semester that is the usual case. */
  const railed = $derived((seminar?.steps.length ?? 0) > 1)

  function go(seq: number): void {
    if (!pubId) return
    onnavigate(`/p/${pubId}/${seq}`)
  }

  /**
   * The page name in the tab title.
   *
   * The course page gets bookmarked — it says so right under the list, and it
   * is the only Colloq address a person saves. In bookmarks, in the history
   * and in the tab switcher all twelve courses and all their seminars were
   * called the same: "Colloq". The statically exported page sets `<title>`
   * (publish/render.ts), the SPA did not — the same address opened
   * differently.
   */
  const named = $derived(courseView?.name ?? seminar?.title ?? null)
  $effect(() => {
    document.title = named === null ? 'Colloq' : `${named} · Colloq`
    return () => {
      document.title = 'Colloq'
    }
  })

  /**
   * The step strip on a phone: the marked step brings itself into view.
   *
   * The strip scrolls sideways, and there can be eleven steps: opening a link
   * to the seventh, a person would see the first three and no sign that they
   * are on the seventh. Instantly, without smoothing: this is not a gesture
   * but the page's state when it opens.
   */
  let strip = $state<HTMLElement | null>(null)
  $effect(() => {
    const at = current
    const root = strip
    if (!root || at === null) return
    root
      .querySelector<HTMLElement>(`[data-step="${at}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center' })
  })

  const dateLong = (at: number): string =>
    new Date(at).toLocaleDateString(getLocale(), { day: 'numeric', month: 'long', year: 'numeric' })
  const clock = (at: number): string =>
    new Date(at).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })
</script>

{#if missing}
  <div class="flex min-h-screen items-center justify-center bg-canvas px-6">
    <div class="max-w-md text-center">
      <p class="text-title font-semibold text-ink">{tr('room.ui.865')}</p>
      <p class="mt-2 text-ui text-muted"> {tr('room.ui.866')} </p>
    </div>
  </div>
{:else if courseView}
  <CourseList course={courseView} {onnavigate} />
{:else if seminar && seminar.state === 'withdrawn'}
  <!-- Never a 404 for a link a student was given: the page answers that it
       was withdrawn and leads up, to the course. -->
  <div class="flex min-h-screen items-center justify-center bg-canvas px-6">
    <div class="max-w-md text-center">
      <p class="text-title font-semibold text-ink">{tr('room.ui.867')}</p>
      {#if seminar.course}
        <button
          class="mt-3 text-ui font-semibold text-accent-text"
          onclick={() => onnavigate(`/c/${seminar!.course!.id}`)}
        >
          {seminar.course.name}
        </button>
      {/if}
    </div>
  </div>
{:else if seminar}
  <div class="min-h-screen bg-canvas">
    <header class="border-b border-line px-6 pb-6 pt-10 sm:px-16">
      <h1 class="text-marquee-sm font-black leading-tight tracking-tight text-ink sm:text-marquee">
        {seminar.title}
      </h1>
      <p class="mt-2 flex flex-wrap items-baseline gap-x-2 text-ui text-muted">
        {#if seminar.course}
          <button
            class="font-semibold text-accent-text"
            onclick={() => onnavigate(`/c/${seminar!.course!.id}`)}
          >
            {seminar.course.name}
          </button>
        {/if}
        <!-- "Page" in the singular is not a typo: one marked moment is one
             page (the publish window says the same). The typo was in the
             plural: "5 шага", "11 шага". -->
        <span> {tr('room.ui.868')} {dateLong(seminar.publishedAt)} ·
          {seminar.steps.length}
          {plural(seminar.steps.length, tr('room.ui.713'), tr('room.ui.714'), tr('room.ui.715'))}
        </span>
      </p>
    </header>

    <!--
      The step rail on a phone — as a strip, not a column.

      The side rail below is declared `hidden … sm:flex`: on a phone it does
      not exist at all, and the page had no other way to move between steps —
      no buttons, no list. Meanwhile the header honestly said "6 steps", and a
      publication of six came down to the first: the rest were reachable only
      by editing the address. And yet public pages are the only Colloq
      addresses people open from a phone, and the static export of the same
      publication keeps the rail on a narrow screen (render.ts,
      `@media(max-width:860px)`): the SPA was worse than the static page.

      A strip, not a stack: eleven steps in a column are a screen to scroll
      through to reach the notebook, on every step. Sticky: having gone down
      the notebook, people move to the next step from where they finished
      reading.
    -->
    {#if railed}
      <nav
        bind:this={strip}
        class="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-line bg-canvas
               px-6 sm:hidden"
        aria-label={tr('room.ui.869')}
      >
        {#each seminar.steps as heading, index (heading.seq)}
          {@const on = heading.seq === current}
          <button
            data-step={heading.seq}
            class="press flex shrink-0 items-baseline gap-2 border-b-2 py-3 pr-3
                   {on ? 'border-accent' : 'border-transparent'}"
            aria-current={on ? 'step' : undefined}
            onclick={() => go(heading.seq)}
          >
            <span class="font-mono text-2xs {on ? 'text-accent-text' : 'text-faint'}">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span class="whitespace-nowrap text-ui {on ? 'font-semibold text-ink' : 'text-muted'}">
              {heading.label}
            </span>
          </button>
        {/each}
      </nav>
    {/if}

    <div class="flex items-start">
      {#if railed}
        <nav
          class="sticky top-0 hidden w-[300px] shrink-0 flex-col self-start border-r border-line
                 py-6 pl-6 pr-5 sm:flex sm:pl-16"
          aria-label={tr('room.ui.869')}
        >
          <p class="pb-3 text-micro font-bold uppercase tracking-caps text-muted">{tr('room.ui.869')}</p>
          {#each seminar.steps as heading (heading.seq)}
            {@const on = heading.seq === current}
            <button
              class="press flex gap-3 border-l-[3px] py-2 pl-3 pr-2 text-left transition-colors duration-100
                     {on ? 'border-accent bg-surface' : 'border-transparent hover:bg-surface/60'}"
              aria-current={on ? 'step' : undefined}
              onclick={() => go(heading.seq)}
            >
              <span class="w-5 shrink-0 font-mono text-2xs {on ? 'text-accent-text' : 'text-faint'}">
                {String(seminar.steps.indexOf(heading) + 1).padStart(2, '0')}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-ui leading-snug {on ? 'font-semibold text-ink' : 'text-muted'}">
                  {heading.label}
                </span>
                <span class="mt-0.5 block font-mono text-2xs text-muted">
                  {clock(heading.at)} · {heading.cellCount}
                </span>
              </span>
            </button>
          {/each}
        </nav>
      {/if}

      <main class="min-w-0 flex-1 px-6 py-7 sm:px-11">
        <div class="max-w-[820px] border-l-[3px] border-accent bg-surface px-4 py-3">
          <p class="text-ui leading-relaxed text-muted"> {tr('room.ui.871')} </p>
          {#if railed}
            <p class="mt-1.5 text-ui leading-relaxed text-muted"> {tr('room.ui.872')} </p>
          {/if}
          <p class="mt-1.5 text-ui leading-relaxed text-muted"> {tr('room.ui.873')} </p>
        </div>

        {#if step}
          <div class="mt-8 max-w-[820px]">
            <PublicNotebook cells={step.cells} publication={seminar.id} />
          </div>
        {:else if loading}
          <!-- The page is already drawn — header, step rail — and only the
               step's notebook is on its way: a pane splash, centered in that
               place. -->
          <Splash size="pane" label={tr('room.ui.874')} />
        {:else if noSuchStep}
          <!--
            The seminar is alive, but this mark is not in it. There are two
            reasons, and the server does not tell them apart: the seminar was
            republished (same address, the marks changed) or the number is
            wrong. So we should speak of what is known: there is no such page,
            the link is old or has a typo. The previous text chose one half of
            the truth for the reader — "it was republished" — and said it even
            to someone who simply got a digit wrong.

            The way out has to be on the page: a publication of one step has no
            rail at all, and there was nothing to get out with.
          -->
          <p class="mt-8 text-ui text-muted">
            {#if wanted === null} {tr('room.ui.875')} {:else} {tr('room.ui.876')} {/if}
            {#if first !== null}
              <button class="press font-semibold text-accent-text" onclick={() => go(first)}> {tr('room.ui.877')} </button>
            {/if}
          </p>
        {:else if gone}
          <!--
            The publication disappeared while being read: withdrawn or deleted
            (`publication not found`). The words are the same as on the
            withdrawn page above, because for the reader it is the same event;
            the way out from here is not the first step — it is gone too — but
            the course.
          -->
          <p class="mt-8 text-ui text-muted"> {tr('room.ui.878')} {#if seminar.course}
              <button
                class="press font-semibold text-accent-text"
                onclick={() => onnavigate(`/c/${seminar!.course!.id}`)}
              >
                {seminar.course.name}
              </button>
            {/if}
          </p>
        {:else if failure}
          <p class="mt-8 text-ui text-muted">
            {failure}
            <button class="font-semibold text-accent-text" onclick={() => (attempt += 1)}> {tr('room.ui.552')} </button>
          </p>
        {/if}

        <!--
          The link serves the step being viewed, and says what exactly is in the
          file.

          There used to be one link for all steps, and the server built from it
          the notebook of the LAST step: a reader comparing "before" and "after"
          on step 2 of 5 — exactly the person the step lives in the address
          for — carried away the state of step 5 and found out only on opening
          the file. Now the step travels in `?step=` (routes/courses.ts →
          notebookOfStep): an unknown number there answers with the last step,
          not a 404, so the link cannot break.

          The server always strips outputs: the file is meant as "code to run
          on your own machine", and without outputs it opens anywhere and
          weighs kilobytes. This promise is also written right next to it, not
          discovered after the download.
        -->
        <div class="mt-10 border-t border-line pt-5">
          <p class="flex items-center gap-2 text-ui text-muted">
            <Icon name="download" size={13} />
            <a
              class="font-semibold text-accent-text"
              href={`/api/p/${seminar.id}/notebook.ipynb${current === null ? '' : `?step=${current}`}`}
            > {tr('room.ui.879')} </a>
          </p>
          <p class="mt-1.5 text-ui text-muted">
            {!railed
              ? tr('room.ui.880')
              : onLast
                ? tr('room.ui.881')
                : tr('room.ui.882')} {tr('room.ui.883')} </p>
        </div>
      </main>
    </div>
  </div>
{:else}
  <!--
    Empty here happens for two reasons, and they differ: the page is still on
    its way — or did not get through. A blank white screen stood for both, and
    for the second it read as "this course no longer exists": not a word, not
    a button, and the only way out is a reload the page says nothing about.
  -->
  <div class="min-h-screen bg-canvas {failure ? 'flex items-center justify-center px-6' : ''}">
    {#if failure}
      <div class="max-w-md text-center">
        <p class="text-title font-semibold text-ink">{tr('room.ui.884')}</p>
        <p class="mt-2 text-ui text-muted">{failure}</p>
        <button
          class="mt-3 text-ui font-semibold text-accent-text"
          onclick={() => (attempt += 1)}
        > {tr('room.ui.552')} </button>
      </div>
    {:else}
      <!-- There is no page at all yet: a splash instead of the screen — the
           same one, in the same place where the shell from index.html drew it,
           so no transition is visible. -->
      <Splash label={tr('room.ui.874')} />
    {/if}
  </div>
{/if}
