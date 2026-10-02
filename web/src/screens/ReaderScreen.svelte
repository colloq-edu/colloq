<!--
  Public reading: the course page and a class page.

  No token, no identity, no sockets. This is not a "read-only mode" the
  server would have to enforce but a different thing: behind these pages
  there is no room, no document, no kernel — only what was collected at the
  moment of publishing. So there is not a single button here that could
  change anything, and nothing to fail.

  This screen loads the course or the page once and hands it over: the
  course to CoursePage, the page to ClassPage, which fetches its notebooks
  tab by tab. What stays here is what both share: the splash until there is
  something to show, the two kinds of refusal, and the tab title.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import Splash from '@/components/ui/Splash.svelte'
  import { firstScreenReady } from '@/lib/boot'
  import { tr } from '@shared/i18n'
  import { api, ApiError } from '@/lib/api'
  import CoursePage from '@/components/reader/CoursePage.svelte'
  import ClassPage from '@/components/reader/ClassPage.svelte'
  import { pageHref } from '@/components/reader/links'
  import { ordinal } from '@/lib/course-now'
  import type { PublicCourseView, PublicPage } from '@shared/publish'
  import type { PublicRoute } from '@/lib/routes'

  interface Props {
    course: string | null
    publication: PublicRoute | null
    onnavigate: (path: string) => void
    /** Rewrites the address without a history entry. */
    onreplace: (path: string) => void
  }

  let { course, publication, onnavigate, onreplace }: Props = $props()

  let courseView = $state<PublicCourseView | null>(null)
  let page = $state<PublicPage | null>(null)
  let missing = $state(false)
  /**
   * Not "the page does not exist" but "did not get through": a 500, a dropped
   * connection, a timeout.
   *
   * While these were not told apart from a 404, all of them gave a blank
   * white screen — not a word, not a button, not a hint that a reload helps;
   * a person on the metro read it as "the course was deleted". api.ts
   * prepares the phrase for the person itself; it is enough to show it here.
   */
  let failureRender = $state<() => string | null>(() => null)
  const failure = $derived(failureRender())
  /** "Try again": a counter in the effects' dependencies, not a second way of loading. */
  let attempt = $state(0)

  /**
   * The page's id as a string, not through the route object.
   *
   * The router builds a NEW route object on every address change, including
   * `/p/x/lecture` → `/p/x/seminar`. An effect reading `publication?.id`
   * depends on the object, and every tab switch would cost a GET /api/p/:id —
   * exactly what the `{#key}` in App.svelte promises not to do. A string
   * `$derived` does not wake its dependents while the value stays the same.
   */
  const pubId = $derived(publication?.id ?? null)
  /** The tab in the address, as a string for the same reason. */
  const materialKey = $derived(publication?.key ?? null)

  /*
   * What is NOT on screen is cleared, not left over from the previous address:
   * the price of a mistake here is a page showing something other than what
   * is in the address.
   */
  $effect(() => {
    if (!course) courseView = null
    if (pubId === null) page = null
  })

  /**
   * A refusal: 404 means "no such page", everything else means "did not get
   * through". Different answers, because different actions: the first is
   * final, the second is cured by a button.
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
    missing = false
    failureRender = () => null
    void api
      .course(id)
      .then((body) => {
        if (!cancelled) courseView = body.course
      })
      .catch((err) => {
        if (!cancelled) refused(err)
      })
    return () => {
      cancelled = true
    }
  })

  /** The «Повторить» or reload the page was last fetched for; see the effect below. */
  let fetchedAttempt = -1

  $effect(() => {
    const id = pubId
    const run = attempt
    if (!id) return
    /*
     * The same page under its canonical address (App.svelte · replace) needs
     * no second fetch; «Повторить» and a reload asked by the class page do.
     */
    const known = untrack(() => page)
    if (run === fetchedAttempt && known && (known.address === id || known.id === id)) return
    fetchedAttempt = run
    let cancelled = false
    missing = false
    failureRender = () => null
    void api
      .page(id)
      .then((body) => {
        if (cancelled) return
        page = body.page
        /*
         * An id or a former name in the address (a link from last month's
         * chat): the page's own address replaces it now. Tabs and the
         * materials link to the canonical one, and without this the first tab
         * switch read as another page.
         */
        if (id !== body.page.address) onreplace(pageHref(body.page.address, materialKey))
      })
      .catch((err) => {
        if (!cancelled) refused(err)
      })
    return () => {
      cancelled = true
    }
  })

  /*
   * The reader has something to show when the course or the page has arrived
   * — or when it is already known that they do not exist. Until then the
   * splash from index.html is on screen; removing it earlier means showing
   * the empty ground of the page the person came here for (lib/boot.ts).
   */
  $effect(() => {
    if (missing || courseView !== null || page !== null || failure !== null) firstScreenReady()
  })

  /**
   * The page name in the tab title: «МЛ | сильная группа · Colloq»,
   * «04 · Лики и хаки данных · Colloq».
   *
   * The course page is bookmarked, and a class page is sent around in chats:
   * in bookmarks, the history and the tab switcher all of them used to be
   * called "Colloq". The number goes first on a class page, because that is
   * how a timetable names a class.
   */
  const named = $derived(
    courseView?.name ??
      (page ? (page.n !== null ? `${ordinal(page.n)} · ${page.title}` : page.title) : null),
  )
  $effect(() => {
    document.title = named === null ? 'Colloq' : `${named} · Colloq`
    return () => {
      document.title = 'Colloq'
    }
  })
</script>

{#if missing}
  <div class="flex min-h-screen items-center justify-center bg-canvas px-6">
    <div class="max-w-md text-center">
      <p class="text-title font-semibold text-ink">{tr('room.ui.865')}</p>
      <p class="mt-2 text-ui text-muted">{tr('room.ui.866')}</p>
    </div>
  </div>
{:else if courseView}
  <CoursePage course={courseView} {onnavigate} />
{:else if page}
  <ClassPage {page} {materialKey} {onnavigate} {onreplace} onreload={() => (attempt += 1)} />
{:else}
  <!--
    Empty here happens for two reasons, and they differ: the page is still on
    its way — or did not get through. A blank white screen stood for both, and
    for the second it read as "this course no longer exists".
  -->
  <div class="min-h-screen bg-canvas {failure ? 'flex items-center justify-center px-6' : ''}">
    {#if failure}
      <div class="max-w-md text-center">
        <p class="text-title font-semibold text-ink">{tr('room.ui.884')}</p>
        <p class="mt-2 text-ui text-muted">{failure}</p>
        <button
          class="press mt-3 text-ui font-semibold text-accent-text"
          onclick={() => (attempt += 1)}
        >
          {tr('room.ui.552')}
        </button>
      </div>
    {:else}
      <!-- There is no page at all yet: a splash instead of the screen — the
           same one, in the same place where the shell from index.html drew it,
           so no transition is visible. -->
      <Splash label={tr('room.ui.874')} />
    {/if}
  </div>
{/if}
