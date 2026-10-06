<!--
  A signed-in teacher in a room they do not run (Paper U5a).

  Since 0.19 a staff cookie makes its holder host only in the rooms they
  teach: their own rooms and the rooms of their courses. Anywhere else the
  server lets them in like a student, and without a word the room looks
  broken to them: no kernel controls, no rules, no lecture, in a seminar they
  opened from a colleague's link. The strip says whose room it is, who can
  run it, and whom to ask, and gets out of the way.

  «Понятно» hides it for this room in this tab. sessionStorage, not
  localStorage: the next visit is a new day, and the person may have been
  added by then or may have forgotten why the room looks this way. Storage
  can be missing or throw (a private window, blocked site data), so every
  touch is guarded and the strip simply shows again.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { StaffGuest } from '@shared/protocol'
  import { fade } from 'svelte/transition'
  import { staffGuestText } from '@/screens/staff'

  interface Props {
    guest: StaffGuest
    sessionId: string
  }

  let { guest, sessionId }: Props = $props()

  const key = $derived(`colloq:staffGuest:dismissed:${sessionId}`)

  function wasDismissed(name: string): boolean {
    try {
      return sessionStorage.getItem(name) === '1'
    } catch {
      return false
    }
  }

  let dismissed = $state(false)
  $effect.pre(() => {
    dismissed = wasDismissed(key)
  })

  function dismiss(): void {
    dismissed = true
    try {
      sessionStorage.setItem(key, '1')
    } catch {
      /* no storage: hidden until the next load, which is all we can promise */
    }
  }

  const text = $derived(staffGuestText(guest))
</script>

{#if !dismissed}
  <div
    class="flex shrink-0 items-center gap-3.5 border-b border-l-[3px] border-b-line border-l-warning
           bg-warning/[0.08] px-4 py-2.5"
    role="status"
    transition:fade={{ duration: 140 }}
  >
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <p class="text-ui font-semibold leading-snug text-ink">{text.title}</p>
      <p class="text-2xs leading-snug text-muted">{text.body}</p>
    </div>
    <button
      type="button"
      class="press shrink-0 text-2xs font-semibold text-accent-text hover:underline"
      onclick={dismiss}
    >
      {tr('room.ui.929')}
    </button>
  </div>
{/if}
