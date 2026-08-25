<script lang="ts">
  import { onMount } from 'svelte'
  import AdminShell, { type AdminTab } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Assistant from '@/admin/screens/Assistant.svelte'
  import Seminars from '@/admin/screens/Seminars.svelte'
  import Teachers from '@/admin/screens/Teachers.svelte'
  import SignInScreen from '@/screens/SignInScreen.svelte'

  /**
   * Sub-routing for /admin. It keeps its own copy of the path rather than
   * taking one from App, because the key exchange below has to rewrite the URL
   * with replaceState — which fires no popstate for anyone else to hear.
   */
  const KEY_PATH = /^\/admin\/k\/([A-Za-z0-9_-]{1,128})\/?$/

  let path = $state(location.pathname)

  const exchanging = $derived(KEY_PATH.test(path))
  const tab = $derived<AdminTab>(
    path.startsWith('/admin/assistant')
      ? 'assistant'
      : path.startsWith('/admin/teachers')
        ? 'teachers'
        : 'seminars',
  )

  onMount(() => {
    const onPop = () => (path = location.pathname)
    window.addEventListener('popstate', onPop)

    const key = KEY_PATH.exec(location.pathname)?.[1] ?? null
    if (key) {
      void adminAuth.signInWithKey(key).finally(() => {
        // replaceState, never push: a spent credential must not sit in the
        // address bar, and must not be one Back press away either.
        history.replaceState({}, '', '/admin')
        path = '/admin'
      })
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
    {#if tab === 'assistant'}
      <Assistant />
    {:else if tab === 'teachers'}
      <Teachers />
    {:else}
      <Seminars />
    {/if}
  </AdminShell>
{/if}
