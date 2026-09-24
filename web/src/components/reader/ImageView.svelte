<!--
  An image from the seminar folder.

  A separate component for the sake of one line that was missing: a file in the
  room has no open address. Everything in the folder is served either with a
  header carrying the participant's token or with a one-time ticket in the query
  string — and `<img>` can do neither on its own. A tag with a direct address
  got a 401 and drew what every broken `<img>` draws: the file name from `alt`.
  It looked like "images don't open", and that was the truth.

  The ticket is obtained the same way as for a download: the token goes out as a
  header, what comes back is a right to ONE file for five minutes, and that is
  what travels in the address.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { api } from '@/lib/api'
  import { getSessionState } from '@/lib/session.svelte'
  import { baseOf } from '@shared/paths'

  interface Props {
    path: string
  }

  let { path }: Props = $props()

  const session = getSessionState()

  let src = $state<string | null>(null)
  let failedRender = $state<() => string | null>(() => null)
  const failed = $derived(failedRender())

  $effect(() => {
    const wanted = path
    let alive = true
    src = null
    failedRender = () => (null)
    void api
      .fileTicket(session.session.id, wanted, session.token)
      .then(({ token }) => {
        if (!alive) return
        src = api.fileUrl(session.session.id, wanted, token)
      })
      .catch((err: unknown) => {
        if (!alive) return
        failedRender = () => (err instanceof Error ? tr(err.message) : tr('room.ui.717'))
      })
    return () => {
      alive = false
    }
  })
</script>

<div class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface p-6">
  {#if failed}
    <p class="max-w-sm text-center text-ui text-muted">{failed}</p>
  {:else if src}
    <!--
      `object-contain` and both ceilings: a screenshot from a retina display is
      3000 pixels wide, and without them it would stretch the column and push
      the page sideways.
    -->
    <img
      {src}
      alt={baseOf(path)}
      class="max-h-full max-w-full object-contain"
      onerror={() => (failedRender = () => tr('room.extra.296', { p0: baseOf(path) }))}
    />
  {:else}
    <p class="text-ui text-muted">{tr('room.ui.716')} {baseOf(path)}…</p>
  {/if}
</div>
