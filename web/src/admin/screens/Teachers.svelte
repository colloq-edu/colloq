<script lang="ts">
  /**
   * Who can teach — the staff list, which is really a list of live credentials.
   *
   * A link is never DISPLAYED except in the moment it is minted or rotated —
   * `Teacher` carries `hasLink` and a masked shape, so a screen share in a
   * lecture hall spills nothing. It can still be COPIED afterwards, straight
   * from the server to the clipboard without passing through the DOM, because
   * forcing a rotation on "they lost the link" would kill that person's other
   * devices to solve a problem they did not have.
   *
   * When a link is shown, copying it must be the obvious next act, and closing
   * it must feel like a decision — hence the reveal band, which names what it
   * is, offers one button, and labels its own dismissal "close without copying"
   * until you have.
   *
   * Everything that is not reading the list is owner-only, and the last owner's
   * controls are absent rather than disabled: the server answers 409 either way,
   * and an action you are never allowed to take should not be drawn as one.
   */
  import { onMount } from 'svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { cn, relativeTime } from '@/lib/utils'
  import { LIMITS, SIGN_IN_PATH, type AdminRole, type Teacher } from '@shared/admin'
  import { colorForId } from '@shared/protocol'

  /* The lanes. Declared once so the header and every row cannot drift apart. */
  const COL_ROLE = 'w-[168px] shrink-0 pr-4'
  const COL_LINK = 'w-[322px] shrink-0 pr-5'
  const COL_SEEN = 'w-[130px] shrink-0'
  const COL_MENU = 'w-10 shrink-0'

  /** All a row may ever show of a live link: its shape. */
  const MASKED = `${location.host}${SIGN_IN_PATH}${'·'.repeat(12)}`

  interface Reveal {
    teacherId: string
    name: string
    url: string
    /** A brand-new account reads differently from a link that just replaced one. */
    minted: boolean
  }

  let teachers = $state<Teacher[]>([])
  let listError = $state<string | null>(null)

  let composing = $state(false)
  let draftName = $state('')
  let draftEmail = $state('')
  let creating = $state(false)
  let composeError = $state<string | null>(null)

  /** The link, held in this tab only, for as long as the band stays open. */
  let reveal = $state<Reveal | null>(null)
  let copied = $state(false)
  let copyError = $state<string | null>(null)
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  let linkField = $state<HTMLInputElement | null>(null)

  /** The row whose link was just put on the clipboard, so only that row says so. */
  let copiedRow = $state<string | null>(null)
  let copiedRowTimer: ReturnType<typeof setTimeout> | undefined
  /** Separate from copyError, which lives inside the reveal band and would not be on screen. */
  let rowCopyError = $state<string | null>(null)

  let confirming = $state<{ id: string; kind: 'rotate' | 'remove' } | null>(null)
  /** The row a destructive call is in flight for; nothing else is disabled by it. */
  let acting = $state<string | null>(null)
  let confirmError = $state<string | null>(null)

  let menuId = $state<string | null>(null)
  let roleBusy = $state<string | null>(null)
  /** A refusal with no confirmation band to land in still has to be seen. */
  let rowError = $state<{ id: string; message: string } | null>(null)

  const me = $derived(adminAuth.me?.teacher ?? null)
  const isOwner = $derived(me?.role === 'owner')
  /*
   * Counted from the list rather than read from `adminAuth.me.ownerCount`, so a
   * promotion that has only just painted is already reflected in what the other
   * rows will let you do.
   */
  const ownerCount = $derived(teachers.filter((t) => t.role === 'owner').length)

  /** True for the person the instance cannot afford to lose. */
  const stranded = (t: Teacher): boolean => t.role === 'owner' && ownerCount <= 1

  onMount(() => {
    void load()
    return () => clearTimeout(copyTimer)
  })

  /**
   * A dead cookie is not a message to print, it is a different screen: asking
   * auth to re-read drops the whole panel back to sign-in.
   */
  function report(cause: unknown): string {
    if (cause instanceof AdminApiError) {
      if (cause.reason === 'unauthenticated') void adminAuth.refresh()
      return cause.message
    }
    if (cause instanceof Error) return cause.message
    return 'The server did not answer.'
  }

  async function load(): Promise<void> {
    try {
      teachers = await adminApi.listTeachers()
      listError = null
    } catch (cause: unknown) {
      listError = report(cause)
    }
  }

  function put(updated: Teacher): void {
    teachers = teachers.map((t) => (t.id === updated.id ? updated : t))
  }

  function openComposer(): void {
    composing = true
    composeError = null
    menuId = null
  }

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const name = draftName.trim()
    const email = draftEmail.trim()
    if (!name) return void (composeError = 'A name is required.')
    if (!email) return void (composeError = 'An email address is required — it is how they are identified.')

    creating = true
    composeError = null
    try {
      const minted = await adminApi.createTeacher({ name, email })
      // The list is ordered by creation, so the new row lands at the bottom —
      // which is also where the reveal band it owns will scroll itself into view.
      teachers = [...teachers, minted.teacher]
      composing = false
      draftName = ''
      draftEmail = ''
      show({ teacherId: minted.teacher.id, name: minted.teacher.name, url: minted.signInUrl, minted: true })
    } catch (cause: unknown) {
      composeError = report(cause)
    } finally {
      creating = false
    }
  }

  /**
   * Optimistic, because a role is the one change here that is cheap to be wrong
   * about: it paints, and a refusal puts it back with the server's own sentence.
   * Rotating and removing are not offered the same courtesy — they end sessions.
   */
  async function setRole(t: Teacher, role: AdminRole): Promise<void> {
    if (role === t.role) return
    const before = t.role
    put({ ...t, role })
    roleBusy = t.id
    rowError = null
    try {
      const updated = await adminApi.updateTeacher(t.id, { role })
      put(updated)
      // Demoting yourself takes the controls off this screen; the shell has to
      // hear about it from the server rather than from us.
      if (updated.id === me?.id) void adminAuth.refresh()
    } catch (cause: unknown) {
      put({ ...t, role: before })
      rowError = { id: t.id, message: report(cause) }
    } finally {
      roleBusy = null
    }
  }

  function ask(t: Teacher, kind: 'rotate' | 'remove'): void {
    menuId = null
    confirmError = null
    // Nothing to invalidate and nobody to strand: a first mint needs no warning.
    if (kind === 'rotate' && !t.hasLink) return void rotate(t)
    confirming = { id: t.id, kind }
  }

  async function rotate(t: Teacher): Promise<void> {
    // A first mint runs without a confirmation, so it has no band to fail into.
    const banded = confirming?.id === t.id
    acting = t.id
    confirmError = null
    rowError = null
    try {
      const minted = await adminApi.rotateTeacherLink(t.id)
      put(minted.teacher)
      confirming = null
      show({ teacherId: t.id, name: minted.teacher.name, url: minted.signInUrl, minted: !t.hasLink })
    } catch (cause: unknown) {
      const message = report(cause)
      if (banded) confirmError = message
      else rowError = { id: t.id, message }
    } finally {
      acting = null
    }
  }

  async function remove(t: Teacher): Promise<void> {
    acting = t.id
    confirmError = null
    try {
      await adminApi.deleteTeacher(t.id)
      teachers = teachers.filter((x) => x.id !== t.id)
      confirming = null
      if (reveal?.teacherId === t.id) reveal = null
      // They removed themselves: the server has already cleared the cookie in
      // this browser, so the panel must stop pretending otherwise.
      if (t.id === me?.id) void adminAuth.refresh()
    } catch (cause: unknown) {
      confirmError = report(cause)
    } finally {
      acting = null
    }
  }

  function show(next: Reveal): void {
    reveal = next
    copied = false
    copyError = null
  }

  /*
   * Fetch-then-copy rather than render-then-copy: the key reaches this tab only
   * as the argument to writeText and is never put in the DOM, so the row goes
   * on showing its masked shape even while it is being sent to someone.
   */
  async function copyExisting(t: Teacher): Promise<void> {
    if (acting) return
    acting = t.id
    rowCopyError = null
    try {
      const { signInUrl } = await adminApi.teacherLink(t.id)
      await navigator.clipboard.writeText(signInUrl)
      copiedRow = t.id
      clearTimeout(copiedRowTimer)
      copiedRowTimer = setTimeout(() => (copiedRow = null), 2200)
    } catch (err) {
      // Two very different failures land here — the server refusing, and a
      // browser that will not hand out the clipboard on an insecure origin.
      // Rotating is the way out of the second one, so say which happened.
      rowCopyError =
        err instanceof AdminApiError
          ? err.message
          : `This browser would not take the clipboard. Rotate ${t.name}’s link to see it on screen instead.`
    } finally {
      acting = null
    }
  }

  async function copy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      copied = true
      copyError = null
      // A confirmation that never leaves stops being one.
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => (copied = false), 2200)
    } catch {
      // An insecure origin or a denied permission. The link is on screen and
      // selectable, so say that instead of swallowing it.
      copyError = 'This browser would not take the clipboard. The link is selected — copy it by hand.'
      linkField?.select()
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    if (menuId) return void (menuId = null)
    // Not while the call is in flight: the band is where its answer lands.
    if (confirming && !acting) confirming = null
  }

  /** Focus lands where the typing goes; `autofocus` on an element is not that. */
  function takeFocus(node: HTMLElement): void {
    node.focus()
  }

  /** A link minted for the last row is worthless if it opened below the fold. */
  function bringIntoView(node: HTMLElement): void {
    node.scrollIntoView({ block: 'nearest' })
  }
</script>

<svelte:window onclick={() => (menuId = null)} onkeydown={onKeydown} />

{#snippet addTeacher()}
  <button type="button" class="btn-primary text-2xs font-bold uppercase tracking-caps" onclick={openComposer}>
    <Icon name="plus" size={13} />
    Add a teacher
  </button>
{/snippet}

<!-- A span, not a p: it also has to sit inside the composer's <label>. -->
{#snippet eyebrow(text: string)}
  <span class="block text-micro font-bold uppercase tracking-label text-faint">{text}</span>
{/snippet}

<AdminPage
  title="Who can teach"
  subtitle="Everyone here can create seminars and see the assistant’s settings. Students never appear on this list — they have no account."
  actions={isOwner ? addTeacher : undefined}
>
  {#if composing}
    <form
      onsubmit={create}
      class="my-5 flex flex-wrap items-end gap-3 border border-line bg-surface px-4 py-3.5"
    >
      <label class="min-w-[190px] flex-1">
        {@render eyebrow('Name')}
        <input
          use:takeFocus
          bind:value={draftName}
          maxlength={LIMITS.teacherName}
          placeholder="Ada Lovelace"
          class="field mt-1.5 text-ui"
        />
      </label>
      <label class="min-w-[210px] flex-1">
        {@render eyebrow('Email')}
        <input
          bind:value={draftEmail}
          type="email"
          maxlength={LIMITS.email}
          spellcheck="false"
          placeholder="ada@example.edu"
          class="field mt-1.5 font-mono text-2xs"
        />
      </label>
      <button type="submit" class="btn-primary" disabled={creating}>
        {creating ? 'Minting a link…' : 'Add and mint a link'}
      </button>
      <button type="button" class="btn-ghost" onclick={() => (composing = false)}>Cancel</button>
      {#if composeError}
        <p class="w-full text-ui text-danger">{composeError}</p>
      {/if}
      <p class="w-full text-2xs text-muted">
        They are added as a teacher and their link is minted at once. Promoting them to owner is a
        second, deliberate act.
      </p>
    </form>
  {/if}

  {#if rowCopyError}
    <p role="alert" class="mb-3 border border-danger/40 bg-danger/5 px-4 py-2.5 text-ui text-danger">
      {rowCopyError}
    </p>
  {/if}

  <div class="sticky top-0 z-10 flex h-9 items-center border-b border-line bg-canvas">
    <div class="min-w-0 flex-1 pr-5">{@render eyebrow('Person')}</div>
    <div class={COL_ROLE}>{@render eyebrow('Role')}</div>
    <div class={COL_LINK}>{@render eyebrow('Sign-in link')}</div>
    <div class={COL_SEEN}>{@render eyebrow('Last seen')}</div>
    <div class={COL_MENU}></div>
  </div>

  {#if listError}
    <div class="flex items-center gap-3 py-6">
      <p class="text-ui text-danger">{listError}</p>
      <button type="button" class="btn-outline" onclick={() => void load()}>Try again</button>
    </div>
  {/if}

  {#each teachers as t (t.id)}
    {@const you = t.id === me?.id}
    {@const locked = stranded(t)}
    <div class="flex min-h-[66px] items-center border-b border-line-soft">
      <div class="flex min-w-0 flex-1 items-center gap-3 pr-5">
        <Avatar name={t.name} color={colorForId(t.id)} size="md" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="truncate text-ui-lg font-semibold text-ink">{t.name}</span>
            {#if you}
              <span class="chip bg-accent/10 text-micro font-bold uppercase tracking-label text-accent-text">
                you
              </span>
            {/if}
          </div>
          <p class="truncate font-mono text-2xs text-muted">{t.email}</p>
        </div>
      </div>

      <div class={COL_ROLE}>
        {#if !isOwner}
          <span class="text-ui capitalize text-muted">{t.role}</span>
        {:else if locked}
          <span class="block text-ui font-semibold text-ink">Owner</span>
          <span class="block text-2xs text-muted">last owner · locked</span>
        {:else}
          <div class="relative inline-flex items-center">
            <select
              value={t.role}
              disabled={roleBusy === t.id}
              aria-label="Role for {t.name}"
              onchange={(event) => void setRole(t, event.currentTarget.value as AdminRole)}
              class="cursor-pointer appearance-none bg-transparent pr-5 text-ui text-ink outline-none disabled:opacity-50"
            >
              <option value="owner">Owner</option>
              <option value="teacher">Teacher</option>
            </select>
            <Icon name="chevron-down" size={11} class="pointer-events-none absolute right-0 text-faint" />
          </div>
        {/if}
      </div>

      <div class={cn(COL_LINK, 'min-w-0')}>
        {#if t.hasLink}
          <div class="flex items-center gap-2">
            <p
              class="min-w-0 flex-1 truncate font-mono text-code text-faint"
              title="Only the shape is ever shown. Copy sends the real link to your clipboard."
            >
              {MASKED}
            </p>
            {#if isOwner}
              <button
                type="button"
                disabled={acting === t.id}
                onclick={() => void copyExisting(t)}
                class="inline-flex h-7 w-7 shrink-0 items-center justify-center border
                       border-line text-faint transition-colors duration-100 hover:border-faint
                       hover:text-ink disabled:opacity-50"
                aria-label="Copy {t.name}’s sign-in link"
              >
                <Icon name={copiedRow === t.id ? 'check' : 'copy'} size={13} />
              </button>
            {/if}
          </div>
        {:else if isOwner}
          <button
            type="button"
            disabled={acting === t.id}
            onclick={() => ask(t, 'rotate')}
            class="inline-flex items-center gap-1.5 text-ui font-semibold text-accent-text hover:underline disabled:opacity-50"
          >
            <Icon name="link" size={13} />
            {acting === t.id ? 'Minting…' : 'Mint a link'}
          </button>
        {:else}
          <p class="text-ui text-muted">No link yet</p>
        {/if}
      </div>

      <div class={COL_SEEN}>
        {#if t.lastSeenAt}
          <span class="text-ui text-ink">{relativeTime(t.lastSeenAt)}</span>
        {:else}
          <span class="text-ui text-muted">never</span>
        {/if}
      </div>

      <div class={cn(COL_MENU, 'relative flex justify-end')}>
        {#if isOwner}
          <button
            type="button"
            aria-label="Actions for {t.name}"
            aria-expanded={menuId === t.id}
            onclick={(event) => {
              event.stopPropagation()
              menuId = menuId === t.id ? null : t.id
            }}
            class="p-1 text-faint transition-colors duration-100 hover:bg-raised hover:text-ink"
          >
            <Icon name="more" size={15} />
          </button>
          {#if menuId === t.id}
            <div class="absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden bg-canvas py-1 shadow-pop">
              <button
                type="button"
                onclick={() => ask(t, 'rotate')}
                class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-ui text-ink hover:bg-raised"
              >
                <Icon name="link" size={14} class="text-faint" />
                {t.hasLink ? 'Rotate sign-in link' : 'Mint a sign-in link'}
              </button>
              {#if !locked}
                <button
                  type="button"
                  onclick={() => ask(t, 'remove')}
                  class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-ui text-danger hover:bg-danger/10"
                >
                  <Icon name="trash" size={14} />
                  {you ? 'Remove my account' : 'Remove from staff'}
                </button>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    </div>

    {#if rowError?.id === t.id}
      <p class="border-b border-line-soft py-2.5 pl-11 text-ui text-danger">{rowError.message}</p>
    {/if}

    {#if confirming?.id === t.id}
      <div class="border-b border-line-soft bg-surface py-4 pl-11 pr-4">
        {#if confirming.kind === 'rotate'}
          <p class="text-ui-lg font-semibold text-ink">Rotate {t.name}’s sign-in link?</p>
          <p class="mt-1.5 max-w-[640px] text-ui text-muted">
            The link they hold now stops working the moment you press this, and every session opened
            from it is signed out{you
              ? ' — every browser signed in as you except this tab, which is re-issued'
              : ''}. You get one new link to send, shown once.
          </p>
        {:else}
          <p class="text-ui-lg font-semibold text-ink">
            {you ? 'Remove your own account?' : `Remove ${t.name}?`}
          </p>
          <p class="mt-1.5 max-w-[640px] text-ui text-muted">
            Their sign-in link stops working immediately and every session opened from it ends{you
              ? ', including this one — you would be signed out of the panel'
              : ''}. Seminars they created stay where they are. Adding them back later mints a
            different link.
          </p>
        {/if}
        <div class="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={acting === t.id}
            onclick={() => void (confirming?.kind === 'rotate' ? rotate(t) : remove(t))}
            class="btn border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20"
          >
            {#if acting === t.id}
              Working…
            {:else if confirming.kind === 'rotate'}
              Rotate the link
            {:else}
              Remove {you ? 'my account' : t.name}
            {/if}
          </button>
          <button
            type="button"
            class="btn-ghost"
            disabled={acting === t.id}
            onclick={() => (confirming = null)}
          >
            Cancel
          </button>
          {#if confirmError}
            <p class="text-ui text-danger">{confirmError}</p>
          {/if}
        </div>
      </div>
    {:else if reveal?.teacherId === t.id}
      {@const shown = reveal}
      <div
        use:bringIntoView
        class="enter border-b border-line-soft border-l-2 border-l-accent bg-accent/5 p-4"
      >
        {@render eyebrow(`Sign-in link for ${shown.name} · shown once`)}
        <p class="mt-1.5 max-w-[720px] text-ui text-ink">
          {#if shown.minted}
            {shown.name} is on the staff list. Send them this link however you already talk to them —
            it is the only credential they get, and this is the only time it can be read.
          {:else}
            The old link and everything signed in with it are dead. Send {shown.name} this one — it is
            the only time it can be read.
          {/if}
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <input
            bind:this={linkField}
            readonly
            value={shown.url}
            spellcheck="false"
            aria-label="Sign-in link for {shown.name}"
            onfocus={(event) => event.currentTarget.select()}
            class="field min-w-[280px] max-w-[560px] flex-1 bg-canvas font-mono text-code"
          />
          <button type="button" class="btn-primary" onclick={() => void copy(shown.url)}>
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <button type="button" class="btn-ghost" onclick={() => (reveal = null)}>
            {copied ? 'Done' : 'Close without copying'}
          </button>
        </div>
        {#if copyError}
          <p class="mt-2 text-ui text-danger">{copyError}</p>
        {:else if !copied}
          <p class="mt-2 text-2xs text-muted">
            Once this closes the link is gone for good; the only way to have one again is to rotate it.
          </p>
        {/if}
      </div>
    {/if}
  {/each}

  <div class="flex items-center gap-2.5 py-3.5">
    <Icon name="link" size={13} class="shrink-0 text-faint" />
    <p class="text-2xs text-faint">
      {#if isOwner}
        A link is a credential: rotate it when someone leaves — the old one stops working that second
        — and removing a person kills their link immediately.
      {:else}
        A link is a credential. Adding people, rotating links and removing accounts belong to an
        owner; ask one of them.
      {/if}
    </p>
  </div>

  <div class="flex flex-wrap items-start gap-14 border-t border-line-soft pt-5">
    <div class="min-w-0 max-w-[600px] flex-1">
      {@render eyebrow('Why the links look like that')}
      <p class="mt-1.5 text-2xs text-muted">
        A link is readable once — the moment it is minted or rotated — and is never listed again, so
        a screen share or a screenshot of this page cannot spill one. Copying it then is the only way
        to take it away.
      </p>
    </div>
    <div class="w-[392px]">
      {@render eyebrow(isOwner ? 'Lost your own link' : 'Lost your link')}
      {#if isOwner}
        <p class="mt-1.5 text-2xs text-muted">
          The setup token in <span class="font-mono text-2xs text-accent-text">&lt;DATA_DIR&gt;/setup-token</span>
          still works and signs you in as the founding owner. It is the way back in.
        </p>
      {:else}
        <p class="mt-1.5 text-2xs text-muted">
          Ask an owner to rotate it. The one you hold stops working the moment they do, and they will
          send you the new one.
        </p>
      {/if}
    </div>
  </div>
</AdminPage>
