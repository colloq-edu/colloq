<script lang="ts">
  import { onMount } from 'svelte'
  import AdminShell, { type AdminTab } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Oracle from '@/admin/screens/Oracle.svelte'
  import Environments from '@/admin/screens/Environments.svelte'
  import Seminars from '@/admin/screens/Seminars.svelte'
  import Teachers from '@/admin/screens/Teachers.svelte'
  import SignInScreen from '@/screens/SignInScreen.svelte'
  import { readEntryCredential, SPENT_PATH } from '@/admin/entry'

  /**
   * Sub-routing for /admin. It keeps its own copy of the path rather than
   * taking one from App, because the key exchange below has to rewrite the URL
   * with replaceState — which fires no popstate for anyone else to hear.
   */
  let path = $state(location.pathname)

  const exchanging = $derived(readEntryCredential(path) !== null)
  const tab = $derived<AdminTab>(
    path.startsWith('/admin/oracle')
      ? 'oracle'
      : path.startsWith('/admin/teachers')
        ? 'teachers'
        : path.startsWith('/admin/environments')
          ? 'environments'
          : 'seminars',
  )

  onMount(() => {
    const onPop = () => (path = location.pathname)
    window.addEventListener('popstate', onPop)

    // replaceState, never push: a spent credential must not sit in the address
    // bar, and must not be one Back press away either.
    const spend = () => {
      history.replaceState({}, '', SPENT_PATH)
      path = SPENT_PATH
    }

    const credential = readEntryCredential(location.pathname)
    if (credential?.kind === 'key') {
      void adminAuth.signInWithKey(credential.value).finally(spend)
    } else if (credential?.kind === 'token') {
      const setupToken = credential.value
      void adminAuth
        .signInWithToken(setupToken)
        .then(async (signedIn) => {
          if (signedIn) return
          // A token cannot sign anyone in until the instance has an owner, and
          // claiming needs a name and an email this link does not carry. So the
          // token is carried into the form rather than spent on a request that
          // was always going to fail — the person types two fields instead of
          // also transcribing thirty-two characters.
          //
          // The reload is not optional: the sign-in screen draws nothing until
          // it knows whether the instance is claimed, and a failed exchange
          // leaves that unknown. Without this the first-run link opened an
          // empty page — measured, not guessed.
          adminAuth.offerSetupToken(setupToken)
          await adminAuth.refresh()
          // 409 here means "not claimed yet", which is exactly the state the
          // card below is for. Leaving it as an error would tell a person
          // following the printed link that they did something wrong.
          adminAuth.error = null
        })
        .finally(spend)
    } else {
      void adminAuth.load()
    }

    return () => window.removeEventListener('popstate', onPop)
  })

  function navigate(next: string): void {
    if (next !== location.pathname) history.pushState({}, '', next)
    path = next
  }
</script>

{#if !adminAuth.ready || exchanging}
  <!-- The answer takes a few milliseconds. A spinner for that is a flash of
       anxiety, not information — the ground paints and the panel lands on it. -->
  <div class="h-full bg-canvas"></div>
{:else if !adminAuth.me}
  <SignInScreen />
{:else}
  <AdminShell {tab} {navigate}>
    {#if tab === 'environments'}
      <Environments />
    {:else if tab === 'oracle'}
      <Oracle />
    {:else if tab === 'teachers'}
      <Teachers />
    {:else}
      <Seminars />
    {/if}
  </AdminShell>
{/if}
