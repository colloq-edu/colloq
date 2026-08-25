<script lang="ts">
  import { onMount } from 'svelte'
  import MarkPicker from '@/components/join/MarkPicker.svelte'
  import AvatarStack from '@/components/ui/AvatarStack.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import Poster from '@/components/ui/Poster.svelte'
  import { api } from '@/lib/api'
  import { MARKS, freeMark, markName } from '@/lib/marks'
  import {
    loadHostToken,
    loadIdentity,
    loadProfile,
    saveIdentity,
    type StoredIdentity,
  } from '@/lib/identity'
  import type { Participant, SessionInfo } from '@shared/protocol'

  interface Props {
    session: SessionInfo
    onjoined: (identity: StoredIdentity) => void
  }

  let { session, onjoined }: Props = $props()

  const profile = loadProfile()
  // Derived, not read once: App hands this screen a fresh session object when
  // the room's name arrives, and the identity belongs to the room, not to the
  // first render of it.
  const mine = $derived(loadIdentity(session.id))

  let name = $state(profile.name)
  // Provisional: the room has not answered yet and the card has to paint now.
  // The roster corrects it below if this one turns out to be spoken for.
  let mark = $state(freeMark(new Map(), profile.avatar))
  let picked = $state(false)
  let picking = $state(false)
  let roster = $state<Participant[]>([])
  let busy = $state(false)
  let error = $state<string | null>(null)
  let nameInput = $state<HTMLInputElement | null>(null)

  /*
   * mark → colour of whoever is wearing it, minus the id the join below is about
   * to re-use. Whatever participantId we send cannot be the participant standing
   * in our way; App only routes a browser with no identity here, so this is the
   * guard on that pair agreeing rather than a path a student walks every day.
   */
  const taken = $derived(
    new Map(
      roster
        .filter((person) => person.avatar && person.id !== mine?.participantId)
        .map((person) => [person.avatar as string, person.color]),
    ),
  )
  const host = $derived(roster.find((person) => person.role === 'host') ?? null)

  /*
   * The only timestamp a seminar has is when its room was opened — there is no
   * scheduled start in the product yet. It is written the way the artboard
   * draws it, in mono, and deliberately not localised: "25.08 · 18:10" is a
   * blackboard note, not a date field.
   */
  const stamp = $derived.by(() => {
    const at = new Date(session.createdAt)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${pad(at.getDate())}.${pad(at.getMonth() + 1)} · ${pad(at.getHours())}:${pad(at.getMinutes())}`
  })

  /*
   * The button names the person only while the picker is open. That is the
   * artboard's own logic and it is the right one: with forty marks on screen
   * the button has to say which of them is about to become you.
   */
  const label = $derived(picking && name.trim() ? `Join as ${name.trim()}` : 'Join the seminar')

  onMount(() => {
    nameInput?.focus()
    // A returning student can overwrite the remembered name with one keystroke.
    if (name) nameInput?.select()

    /*
     * Who is already here — for the stack on the poster, and for the mark. The
     * form is complete before this lands and stays usable if it never does: a
     * room you cannot count is still a room you can walk into.
     */
    void api
      .listParticipants(session.id)
      .then((body) => {
        roster = body.participants
        // Correct the provisional mark, never the student's own choice.
        if (!picked && taken.has(mark)) mark = freeMark(taken, profile.avatar)
      })
      .catch(() => {
        /* offline or slow; the poster simply says nothing about the room */
      })
  })

  function pick(next: string): void {
    mark = next
    picked = true
  }

  async function join(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const who = name.trim()
    if (!who) {
      error = 'Enter a name so the room knows who you are'
      nameInput?.focus()
      return
    }
    if (busy) return

    busy = true
    error = null
    try {
      const result = await api.join(session.id, {
        name: who,
        avatar: mark,
        // Both are what keeps a refresh from turning one person into two, and
        // the teacher into a plain participant.
        participantId: mine?.participantId ?? null,
        hostToken: loadHostToken(session.id),
      })
      const identity: StoredIdentity = {
        sessionId: session.id,
        participantId: result.participant.id,
        token: result.token,
        name: result.participant.name,
        avatar: result.participant.avatar,
        color: result.participant.color,
        role: result.participant.role,
      }
      saveIdentity(identity)
      onjoined(identity)
    } catch (cause: unknown) {
      error = cause instanceof Error ? cause.message : 'Could not join the seminar'
      busy = false
    }
  }
</script>

{#snippet meta()}
  <span class="font-mono">{stamp}</span>
  {#if host}
    <span class="h-4 w-px shrink-0 bg-brand-2" aria-hidden="true"></span>
    <span>{host.name}</span>
  {/if}
{/snippet}

{#snippet inside()}
  <div class="flex items-center gap-3.5">
    <!-- Sliced to four rather than capped at four: the count is spelled out in
         words right beside the stack, and a "+13" chip would say it twice. -->
    <AvatarStack
      people={roster.slice(0, 4)}
      max={4}
      size={28}
      ring="rgb(var(--brand))"
      tone="onDark"
    />
    <span>
      {roster.length}
      {roster.length === 1 ? 'person is' : 'people are'} already inside
    </span>
  </div>
{/snippet}

<div class="flex h-full">
  <!--
    The poster is the seminar; the column beside it is the paperwork. It leaves
    on a narrow window rather than squeezing — a phone that gets half a poster
    and half a form gets neither.
  -->
  <Poster
    eyebrow="You’re joining"
    title={session.name || '\u00a0'}
    {meta}
    footer={roster.length > 0 ? inside : undefined}
    width="hidden w-3/5 lg:flex"
  />

  <div class="min-w-0 flex-1 overflow-y-auto px-6 sm:px-10 lg:px-14">
    <form
      class="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-6 py-12"
      onsubmit={join}
    >
      <!-- The poster is gone at this width and the seminar it names is not
           allowed to go with it: a student on a phone still has to see which
           room the link opened. Same content, re-set at a size that fits. -->
      <div class="flex flex-col gap-2 lg:hidden">
        <p class="text-2xs font-bold uppercase tracking-label text-faint">You’re joining</p>
        <h1 class="text-balance text-display font-black text-ink">
          {session.name || '\u00a0'}
        </h1>
        <div class="flex flex-wrap items-center gap-3.5 text-ui text-muted">
          <span class="font-mono">{stamp}</span>
          {#if host}
            <span class="h-4 w-px shrink-0 bg-line" aria-hidden="true"></span>
            <span>{host.name}</span>
          {/if}
        </div>
      </div>

      <div class="flex flex-col gap-2.5">
        <label
          for="join-name"
          class="text-2xs font-bold uppercase tracking-label text-faint"
        >
          Your name
        </label>
        <!-- A ruled box on the page's own ground, not a filled surface: on this
             screen the field is the only thing the student has to fill in. -->
        <input
          id="join-name"
          bind:this={nameInput}
          bind:value={name}
          class="w-full border border-line bg-canvas px-4 py-3 text-head font-semibold
                 text-ink placeholder:font-normal placeholder:text-faint focus:border-accent"
          placeholder="Alex"
          maxlength={40}
          autocomplete="name"
          aria-invalid={error ? 'true' : undefined}
          oninput={() => (error = null)}
        />
        {#if error}
          <p class="text-ui text-danger" role="alert">{error}</p>
        {/if}
      </div>

      <div class="flex flex-col gap-2.5">
        <div class="flex items-baseline gap-2.5">
          <span class="text-2xs font-bold uppercase tracking-label text-faint">Your mark</span>
          {#if picking}
            <span class="ml-auto text-2xs text-faint">
              {MARKS.length} marks{taken.size > 0 ? ` · ${taken.size} taken` : ''}
            </span>
          {/if}
        </div>

        {#if picking}
          <MarkPicker value={mark} {taken} onpick={pick} onclose={() => (picking = false)} />
        {:else}
          <div class="flex items-center gap-3.5 border border-line bg-surface p-3">
            <!-- The one saturated thing in the column. The colour a person
                 actually gets is minted with their id at join time, so this
                 stands in with the brand's own signal colour rather than
                 guessing at one. -->
            <span
              class="flex h-14 w-14 shrink-0 items-center justify-center rounded-full
                     bg-accent text-display leading-none"
              aria-hidden="true"
            >
              {mark}
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <p class="text-ui-lg font-semibold text-ink">The {markName(mark)} is yours</p>
              <p class="text-2xs text-muted">
                Picked from the ones nobody in this room has taken, so your cursor is always
                yours.
              </p>
            </div>
            <button
              type="button"
              class="flex h-9 shrink-0 items-center gap-2 border border-line bg-canvas px-3
                     text-ui font-semibold text-ink hover:border-faint"
              onclick={() => (picking = true)}
            >
              <Icon name="restart" size={13} />
              Change
            </button>
          </div>
        {/if}
      </div>

      <button
        class="flex h-14 w-full items-center justify-center gap-2.5 bg-primary text-ui-lg
               font-bold uppercase tracking-label text-primary-ink transition-opacity
               duration-100 hover:opacity-90 disabled:opacity-40"
        type="submit"
        disabled={busy || !name.trim()}
      >
        {#if picking && name.trim()}
          <!-- The button's own ink, thinned: accent on this button would be the
               accent it is already painted with in dark. -->
          <span
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full
                   bg-primary-ink/20 text-ui-lg leading-none"
            aria-hidden="true"
          >
            {mark}
          </span>
        {/if}
        <span class="min-w-0 truncate">{busy ? 'Joining…' : label}</span>
        {#if busy}
          <Icon name="spinner" size={16} class="shrink-0 animate-spin" />
        {:else}
          <Icon name="arrow-right" size={16} strokeWidth={2.4} class="shrink-0" />
        {/if}
      </button>

      {#if !picking}
        <p class="text-ui text-muted">
          No account, no email. The link is the seminar — close the tab and the same link
          brings you back.
        </p>
      {/if}
    </form>
  </div>
</div>
