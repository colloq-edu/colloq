<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { api } from '@/lib/api'
  import {
    listHostedSessions,
    loadProfile,
    saveHostToken,
    saveIdentity,
  } from '@/lib/identity'
  import { relativeTime } from '@/lib/utils'
  import type { SessionInfo } from '@shared/protocol'

  interface Props {
    onCreated: (sessionId: string) => void
  }

  let { onCreated }: Props = $props()

  let name = $state('')
  let hostName = $state(loadProfile().name)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let copied = $state(false)
  let created = $state<{ session: SessionInfo; link: string } | null>(null)
  let hosted = $state<SessionInfo[]>(listHostedSessions())

  let nameInput = $state<HTMLInputElement | null>(null)
  let linkInput = $state<HTMLInputElement | null>(null)
  let copyTimer: number | undefined

  const recent = $derived(
    hosted.filter((entry) => entry.id !== created?.session.id).slice(0, 6),
  )
  const ready = $derived(name.trim().length > 0 && hostName.trim().length > 0 && !busy)

  /**
   * Who may open a seminar is the instance's call now. A server that cannot
   * answer counts as open: shutting every visitor out because one request
   * failed is a worse failure than the one it would be guarding against.
   */
  const gate = $derived.by(() => {
    if (!adminAuth.ready) return 'unknown'
    const instance = adminAuth.state
    if (!instance || instance.openSeminarCreation || adminAuth.me) return 'open'
    return instance.claimed ? 'staff' : 'unclaimed'
  })

  onMount(() => {
    void adminAuth.load()
    return () => window.clearTimeout(copyTimer)
  })

  // The form now lands a paint after the page does, so focus follows the input
  // rather than the mount — once, or every keystroke would drag it back.
  let focused = false
  $effect(() => {
    if (nameInput && !focused) {
      focused = true
      nameInput.focus()
    }
  })

  // The link is the product; put the cursor on it the moment it exists.
  $effect(() => {
    if (created && linkInput) linkInput.select()
  })

  async function createSeminar(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const seminar = name.trim()
    const teacher = hostName.trim()
    if (!seminar || !teacher || busy) return

    busy = true
    error = null
    try {
      const { session, hostToken } = await api.createSession(seminar)
      saveHostToken(session, hostToken)

      // The teacher is host and participant in one step, so "Open seminar"
      // walks straight into the room instead of back through a name prompt.
      const joined = await api.join(session.id, { name: teacher, hostToken })
      saveIdentity({
        sessionId: session.id,
        participantId: joined.participant.id,
        token: joined.token,
        name: joined.participant.name,
        avatar: joined.participant.avatar,
        color: joined.participant.color,
        role: joined.participant.role,
      })

      created = { session, link: `${location.origin}/s/${session.id}` }
      hosted = listHostedSessions()
    } catch (cause: unknown) {
      error = cause instanceof Error ? cause.message : 'Could not create the seminar'
    } finally {
      busy = false
    }
  }

  async function copyLink(): Promise<void> {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.link)
    } catch {
      // Clipboard is blocked on insecure origins — leave the link selected instead.
      linkInput?.select()
      return
    }
    copied = true
    window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => (copied = false), 1600)
  }

  function openRecent(event: MouseEvent, id: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    onCreated(id)
  }
</script>

<div class="h-full overflow-y-auto">
  <div class="mx-auto flex min-h-full w-full max-w-[420px] flex-col justify-center px-5 py-12">
    <div class="flex items-center gap-2">
      <span class="flex h-7 w-7 items-center justify-center bg-accent text-accent-ink">
        <Icon name="logo" size={16} />
      </span>
      <span class="text-title font-semibold tracking-tight text-ink">Colloq</span>
    </div>
    <p class="mt-3 text-ui-lg leading-relaxed text-muted">
      One link, one live notebook, one assistant. Create a seminar and everyone in the room is
      inside it seconds later — no accounts, nothing to install.
    </p>

    {#if created}
      {@const room = created}
      <div class="mt-7 animate-fade-up">
        <div
          class="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-label text-positive"
        >
          <Icon name="check" size={14} />
          Seminar created
        </div>
        <h1 class="mt-2 truncate text-title font-semibold tracking-tight text-ink">
          {room.session.name}
        </h1>
        <p class="mt-1 text-ui-lg leading-relaxed text-muted">
          Share this link. Whoever opens it types a name and lands in the notebook.
        </p>

        <div class="mt-4 flex gap-2">
          <input
            bind:this={linkInput}
            class="field font-mono text-code"
            value={room.link}
            readonly
            aria-label="Seminar link"
          />
          <button class="btn-primary min-w-[104px] shrink-0" onclick={copyLink}>
            <Icon name={copied ? 'check' : 'copy'} size={16} />
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>

        <button class="btn-outline mt-2.5 w-full" onclick={() => onCreated(room.session.id)}>
          Open seminar
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
    {:else if gate === 'open'}
      <form class="mt-7 space-y-3" onsubmit={createSeminar}>
        <div>
          <label
            for="seminar-name"
            class="mb-1.5 block text-2xs font-semibold uppercase tracking-label text-faint"
          >
            Seminar
          </label>
          <input
            id="seminar-name"
            bind:this={nameInput}
            bind:value={name}
            class="field"
            placeholder="Computer Vision Seminar — 25.08"
            maxlength={80}
            autocomplete="off"
          />
        </div>
        <div>
          <label
            for="host-name"
            class="mb-1.5 block text-2xs font-semibold uppercase tracking-label text-faint"
          >
            Your name
          </label>
          <input
            id="host-name"
            bind:value={hostName}
            class="field"
            placeholder="Alex"
            maxlength={40}
            autocomplete="name"
          />
        </div>

        {#if error}
          <p class="text-ui text-danger">{error}</p>
        {/if}

        <button class="btn-primary w-full" type="submit" disabled={!ready}>
          {#if busy}
            <Icon name="spinner" size={16} class="animate-spin" />
            Creating…
          {:else}
            Create seminar
          {/if}
        </button>
      </form>
    {:else if gate !== 'unknown'}
      <p class="mt-7 animate-fade-up border border-line bg-surface px-4 py-3 text-ui-lg leading-relaxed text-muted">
        {#if gate === 'unclaimed'}
          This Colloq has not been set up yet.
          <a href="/admin" class="font-medium text-accent-text hover:underline">Set it up</a>
          to open the first seminar.
        {:else}
          Seminars are opened by teaching staff here. If you were sent a seminar link, open that
          instead —
          <a href="/admin" class="font-medium text-accent-text hover:underline">sign in</a>
          if you teach on this instance.
        {/if}
      </p>
    {/if}

    {#if recent.length > 0}
      <section class="mt-10">
        <h2 class="text-2xs font-semibold uppercase tracking-label text-faint">
          Your recent seminars
        </h2>
        <ul class="mt-2 divide-y divide-line-soft border-y border-line-soft">
          {#each recent as entry (entry.id)}
            <li>
              <a
                href="/s/{entry.id}"
                onclick={(event) => openRecent(event, entry.id)}
                class="group flex items-center gap-3 py-2.5 text-ui-lg focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/15"
              >
                <span
                  class="min-w-0 flex-1 truncate text-muted transition-colors duration-100 group-hover:text-ink"
                >
                  {entry.name}
                </span>
                <span class="shrink-0 text-2xs text-faint">{relativeTime(entry.createdAt)}</span>
                <Icon
                  name="chevron-right"
                  size={14}
                  class="shrink-0 text-faint opacity-0 transition-opacity duration-100 group-hover:opacity-100"
                />
              </a>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
</div>
