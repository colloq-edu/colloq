<script lang="ts">
  import Splash from '@/components/ui/Splash.svelte'
  import { firstScreenReady } from '@/lib/boot'
  import { onMount } from 'svelte'
  import AdminShell, { type AdminTab } from '@/admin/AdminShell.svelte'
  import NewSeminar from '@/admin/screens/NewSeminar.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Oracle from '@/admin/screens/Oracle.svelte'
  import Environments from '@/admin/screens/Environments.svelte'
  import Seminars from '@/admin/screens/Seminars.svelte'
  import Courses from '@/admin/screens/Courses.svelte'
  import Competitions from '@/admin/screens/Competitions.svelte'
  import Publish from '@/admin/screens/Publish.svelte'
  import Teachers from '@/admin/screens/Teachers.svelte'
  import SignInScreen from '@/screens/SignInScreen.svelte'
  import { readEntryCredential, SPENT_PATH } from '@/admin/entry'

  /**
   * Sub-routing for /admin. It keeps its own copy of the path rather than
   * taking one from App, because the key exchange below has to rewrite the URL
   * with replaceState — which fires no popstate for anyone else to hear.
   */
  let path = $state(location.pathname)

  /*
   * Not a route. Creating is a step inside the seminars tab rather than a place
   * you can be sent to: a half-filled form behind a URL is a form somebody
   * returns to expecting their answers to still be there.
   */
  let makingSeminar = $state(false)
  /** The seminar just made on the New seminar screen, handed to the list. */
  let arrived = $state<string | null>(null)

  /*
   * The exchange is happening right now.
   *
   * A state, not "the key is still in the address": a key that did not get
   * through is deliberately not spent (below), the address stays the same —
   * and a screen that waited for the key to vanish from the address stayed
   * empty forever. A blank page without words is exactly what the sign-in
   * screen's "Could not reach the panel" branch exists for.
   */
  let exchanging = $state(readEntryCredential(location.pathname) !== null)
  /**
   * A key that did not get through.
   *
   * The server never saw it, so it is intact and still in the address. "Try
   * again" on the sign-in screen re-reads the instance state — and if the
   * server is back, the attempt has to be repeated: otherwise a teacher with a
   * working link is greeted by a form asking for a setup token they do not
   * have.
   */
  let pendingKey = $state<string | null>(null)
  /**
   * A setup token that did not get through — for the same reason and with
   * the same right.
   *
   * The key was taught not to be spent on a dropped connection, but the token
   * kept being spent unconditionally: `.finally(spend)`. To a person there is
   * no difference — both links look single-use and both vanish from the
   * address bar — and on top of that the token is put into the first-run form
   * only on an explicit `unclaimed`. So after "Try again" a teacher with a
   * working link got an empty field and thirty-two characters to copy from
   * somewhere.
   */
  let pendingToken = $state<string | null>(null)
  let retriedEntry = false
  const tab = $derived<AdminTab>(
    path.startsWith('/admin/oracle')
      ? 'oracle'
      : path.startsWith('/admin/teachers')
        ? 'teachers'
        : path.startsWith('/admin/environments')
          ? 'environments'
          : path.startsWith('/admin/competitions')
            ? 'competitions'
            : path.startsWith('/admin/courses')
              ? 'courses'
              : 'seminars',
  )

  /*
   * The open course is in the address, unlike the seminar creation form:
   * people come back here, share this link with a colleague, and "Back" must
   * lead to the course list, not out of the panel.
   */
  const openCourse = $derived(/^\/admin\/courses\/([A-Za-z0-9_-]{1,64})/.exec(path)?.[1] ?? null)
  /*
   * A competition and the tab of its console are an address too, for the
   * same reason: people send a colleague a link to "Leaderboard · both", and
   * open "Settings" in the middle of a class and come back to them. `new` is
   * not a competition but the creation form: it opens over the list and
   * leaves no address behind.
   */
  const competitionRoute = $derived(
    /^\/admin\/competitions\/([A-Za-z0-9_-]{1,64})(?:\/(board|entrants|settings))?/.exec(path),
  )
  const openCompetition = $derived(competitionRoute?.[1] ?? null)
  const competitionTab = $derived(
    (competitionRoute?.[2] ?? 'submissions') as 'submissions' | 'board' | 'entrants' | 'settings',
  )
  /* Publishing is an address too: it is the screen where a decision is made. */
  const publishing = $derived(/^\/admin\/publish\/([A-Za-z0-9_-]{1,64})/.exec(path)?.[1] ?? null)

  // replaceState, never push: a spent credential must not sit in the address
  // bar, and must not be one Back press away either.
  function spend(): void {
    history.replaceState({}, '', SPENT_PATH)
    path = SPENT_PATH
  }

  /*
   * The key is spent only if the server saw it.
   *
   * There used to be an unconditional `.finally(spend)` here: the address bar
   * was rewritten on an ordinary dropped connection too — the Wi-Fi blinked,
   * the train went into a tunnel — and the link that was the only way into
   * the panel vanished forever after one failed request. Spending a revoked
   * key is right (it is dead anyway), but one that did not get through is
   * not.
   */
  async function useKey(key: string): Promise<void> {
    exchanging = true
    pendingKey = null
    try {
      const signedIn = await adminAuth.signInWithKey(key)
      if (signedIn || adminAuth.state) spend()
      // The server was not heard at all: the key is intact and worth trying again.
      else pendingKey = key
    } finally {
      exchanging = false
    }
  }

  /**
   * The setup token — by the key's rule above.
   *
   * `adminAuth.state` here is exactly "the server answered": `#authenticate`
   * reads the instance state even on a refusal (see auth.svelte.ts), so it is
   * empty exactly when the server was not heard at all.
   */
  async function useToken(setupToken: string): Promise<void> {
    exchanging = true
    pendingToken = null
    try {
      const signedIn = await adminAuth.signInWithToken(setupToken)
      if (signedIn) {
        spend()
        return
      }
      // 409 here means "not claimed yet", which is exactly the state the card
      // below is for. Leaving it as an error would tell a person following the
      // printed link that they did something wrong.
      //
      // Everything else — a revoked token, a typo in the link — has to be put
      // into words. Any error used to be swallowed, and a dead token was
      // silently put into the form, where it came to light only after
      // pressing "Sign in".
      const unclaimed = adminAuth.errorReason === 'unclaimed'
      const said = adminAuth.error
      const reason = adminAuth.errorReason

      // The reload is not optional: the sign-in screen draws nothing until it
      // knows whether the instance is claimed, and a failed exchange leaves
      // that unknown. Without this the first-run link opened an empty page —
      // measured, not guessed.
      await adminAuth.refresh()

      if (unclaimed) {
        // A token cannot sign anyone in until the instance has an owner, and
        // claiming needs a name and an email this link does not carry. So the
        // token is carried into the form rather than spent on a request that
        // was always going to fail — the person types two fields instead of
        // also transcribing thirty-two characters.
        adminAuth.offerSetupToken(setupToken)
      } else if (adminAuth.error === null) {
        // A successful refresh clears the error internally, so it is put back
        // here by hand. If refresh has a complaint of its own, it is newer —
        // and that one stays.
        adminAuth.error = said
        adminAuth.errorReason = reason
      }

      // The server was not heard at all: the token is intact, and the address is not spent.
      if (!adminAuth.state) {
        pendingToken = setupToken
        return
      }
      spend()
    } finally {
      exchanging = false
    }
  }

  $effect(() => {
    const reachable = adminAuth.state !== null
    const signedIn = adminAuth.me !== null
    if (retriedEntry || exchanging || !reachable || signedIn) return
    // Once: a second failure is no longer "the server has not come up", and
    // there is no point spinning requests under a screen with a "Try again"
    // button.
    if (pendingKey) {
      retriedEntry = true
      void useKey(pendingKey)
      return
    }
    if (pendingToken) {
      retriedEntry = true
      void useToken(pendingToken)
    }
  })

  /*
   * The panel has something to show when it knows what to show: the instance
   * state has arrived and the key from the address has been exchanged. Until
   * that moment the splash from index.html is on screen, and removing it
   * earlier means uncovering emptiness under it (lib/boot.ts).
   */
  $effect(() => {
    if (adminAuth.ready && !exchanging) firstScreenReady()
  })

  onMount(() => {
    const onPop = () => {
      path = location.pathname
      makingSeminar = false
    }
    window.addEventListener('popstate', onPop)

    const credential = readEntryCredential(location.pathname)
    if (credential?.kind === 'key') {
      void useKey(credential.value)
    } else if (credential?.kind === 'token') {
      void useToken(credential.value)
    } else {
      void adminAuth.load()
    }

    return () => window.removeEventListener('popstate', onPop)
  })

  function navigate(next: string): void {
    if (next !== location.pathname) history.pushState({}, '', next)
    path = next
    /*
     * Any navigation means leaving the "New class" form.
     *
     * The form is not a route (see `makingSeminar`), and navigating to the
     * same `/admin` — from the logo or from the "Classes" row — does not
     * change the address. Without this line a click on them with the form
     * open did nothing, and going to "Courses" and back returned to the same
     * form: the flag survived the tab change.
     */
    makingSeminar = false
  }
</script>

{#if !adminAuth.ready || exchanging}
  <!--
    A splash, not a panel skeleton: until the server answers it is not even
    known what will be here — the panel or the sign-in form — and the skeleton
    drew the header and rows of one that might not turn up. The same splash as
    in index.html, at the same coordinates: the shell leaves right onto it
    (lib/boot.ts).
  -->
  <Splash />
{:else if !adminAuth.me}
  <SignInScreen />
{:else}
  <AdminShell {tab} {navigate}>
    {#if publishing}
      <Publish sessionId={publishing} {navigate} />
    {:else if tab === 'courses'}
      <Courses open={openCourse} {navigate} />
    {:else if tab === 'competitions'}
      <Competitions open={openCompetition} tab={competitionTab} {navigate} />
    {:else if tab === 'environments'}
      <Environments />
    {:else if tab === 'oracle'}
      <Oracle />
    {:else if tab === 'teachers'}
      <Teachers />
    {:else if makingSeminar}
      <NewSeminar
          ondone={(createdId) => {
            makingSeminar = false
            /*
             * Back to the list with the link, not into the room.
             *
             * Walking straight in feels like the finish, and it is how a class
             * starts late: the address is what the teacher needs in that second,
             * and finding it means leaving the room they were just dropped into.
             * The list puts the new seminar on top with the cursor on its Copy.
             */
            arrived = createdId ?? null
          }}
        />
    {:else}
      <!-- The landing is one-shot: an `arrived` left hanging reset the search
           again and highlighted the same room as new on every return to the
           tab — and every twenty seconds stole focus in its favor. -->
      <Seminars
        onfull={() => (makingSeminar = true)}
        {arrived}
        onarrived={() => (arrived = null)}
        onpublish={(id) => navigate(`/admin/publish/${id}`)}
      />
    {/if}
  </AdminShell>
{/if}
