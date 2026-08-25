<script lang="ts">
  import { onMount } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { cn } from '@/lib/utils'
  import { LIMITS, type AdminSeminar } from '@shared/admin'

  /**
   * The seminar list, and the one thing a teacher comes here to do: get the
   * link. It is on every row as a button, it is on the running banner, and it
   * is focused the moment a seminar is created — because the alternative is
   * opening a room to find its address, which is how a class starts late.
   */

  let seminars = $state<AdminSeminar[]>([])
  let loading = $state(true)
  let loadError = $state<string | null>(null)
  let query = $state('')
  /** Ticks with the poll below so "started 12 min ago" does not freeze at 12. */
  let now = $state(Date.now())

  let creating = $state(false)
  let newName = $state('')
  let createBusy = $state(false)
  let createError = $state<string | null>(null)
  let nameInput = $state<HTMLInputElement | null>(null)
  let justCreatedId = $state<string | null>(null)

  let copiedId = $state<string | null>(null)
  let copyTimer: number | undefined

  let renamingId = $state<string | null>(null)
  let renameValue = $state('')

  /** At most one row is ever explaining itself; a second failure replaces the first. */
  let rowError = $state<{ id: string; message: string } | null>(null)
  let openMenuId = $state<string | null>(null)

  let doomed = $state<AdminSeminar | null>(null)
  let deleteBusy = $state(false)
  let deleteError = $state<string | null>(null)
  let cancelButton = $state<HTMLButtonElement | null>(null)

  const live = $derived(seminars.filter((s) => s.status === 'live'))
  const needle = $derived(query.trim().toLowerCase())
  const shown = $derived(
    needle ? seminars.filter((s) => s.name.toLowerCase().includes(needle)) : seminars,
  )
  const canDelete = $derived(adminAuth.isOwner)

  const ITEM = 'flex w-full items-center px-2.5 py-1.5 text-left text-ui transition-colors duration-100'

  /* ----------------------------------------------------------- formatting */

  /** `/s/abc` — the half of the URL that is worth reading in a dense row. */
  function pathOf(seminar: AdminSeminar): string {
    try {
      return new URL(seminar.url).pathname
    } catch {
      // publicUrl is operator-configured and can be anything; the id is not.
      return `/s/${seminar.id}`
    }
  }

  function hostPathOf(seminar: AdminSeminar): string {
    try {
      const url = new URL(seminar.url)
      return `${url.host}${url.pathname}`
    } catch {
      return `/s/${seminar.id}`
    }
  }

  function stamp(ts: number): string {
    const date = new Date(ts)
    return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`
  }

  /**
   * How long the room has been going. createdAt is the only clock the contract
   * carries — a live seminar is one somebody made for the class they are in, so
   * "created" and "started" are the same minute in every case but a stale room.
   */
  function startedAgo(from: number, at: number): string {
    const minutes = Math.max(0, Math.round((at - from) / 60_000))
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes} min ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} h ago`
    const days = Math.floor(hours / 24)
    return days === 1 ? 'yesterday' : `${days} days ago`
  }

  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
  const people = (n: number): string => (n === 1 ? '1 person' : `${n} people`)

  function explain(cause: unknown): string {
    if (cause instanceof AdminApiError) {
      // Nobody can act on a dead cookie. Hand it to the shell, which swaps the
      // whole panel for the sign-in screen rather than arguing in a red line.
      if (cause.reason === 'unauthenticated') void adminAuth.refresh()
      return cause.message
    }
    return cause instanceof Error ? cause.message : 'The server did not respond'
  }

  /* ---------------------------------------------------------------- data */

  function patch(id: string, fields: Partial<AdminSeminar>): void {
    seminars = seminars.map((s) => (s.id === id ? { ...s, ...fields } : s))
  }

  function replace(updated: AdminSeminar): void {
    seminars = seminars.map((s) => (s.id === updated.id ? updated : s))
  }

  /*
   * The sidebar's "Seminars 5" is the length of this list, so it is mirrored
   * from here rather than fetched twice — otherwise the count keeps standing at
   * the number it had before the row you just deleted.
   */
  $effect(() => {
    if (!loading) navCounts.seminars = seminars.length
  })

  async function load(silent = false): Promise<void> {
    if (!silent) loading = true
    try {
      seminars = await adminApi.listSeminars()
      loadError = null
    } catch (cause: unknown) {
      // A poll that fails leaves the list it already has: the screen was right a
      // minute ago, and a banner over live data is worse than data a minute old.
      if (!silent) loadError = explain(cause)
    } finally {
      if (!silent) loading = false
    }
  }

  onMount(() => {
    void load()

    // "8 in the room" is a claim about this second, so it is re-asked. A hidden
    // tab is not looking at the claim and does not need to spend the request.
    const tick = window.setInterval(() => {
      now = Date.now()
      if (document.visibilityState === 'visible') void load(true)
    }, 20_000)

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (doomed) {
        if (!deleteBusy) doomed = null
        return
      }
      openMenuId = null
    }
    const onClick = () => (openMenuId = null)

    window.addEventListener('keydown', onKey)
    window.addEventListener('click', onClick)
    return () => {
      window.clearInterval(tick)
      window.clearTimeout(copyTimer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('click', onClick)
    }
  })

  /* -------------------------------------------------------------- create */

  function startCreate(): void {
    creating = true
    createError = null
  }

  function cancelCreate(): void {
    creating = false
    newName = ''
    createError = null
  }

  // The field lands a paint after the row does, so focus follows the element.
  $effect(() => {
    if (creating) nameInput?.focus()
  })

  /**
   * The row exists before this runs, so the button is really there. Queried
   * rather than bound: the binding would have to live on one row out of many,
   * and every row would carry the branch for the one that was just made.
   */
  $effect(() => {
    const id = justCreatedId
    if (!id) return
    document.querySelector<HTMLButtonElement>(`[data-copy="${id}"]`)?.focus()
  })

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const name = newName.trim()
    if (!name || createBusy) return

    createBusy = true
    createError = null
    try {
      const seminar = await adminApi.createSeminar({ name })
      // A filter that hides the row you just made would send the teacher
      // hunting for a seminar they are looking straight at.
      query = ''
      seminars = [seminar, ...seminars.filter((s) => s.id !== seminar.id)]
      justCreatedId = seminar.id
      creating = false
      newName = ''
    } catch (cause: unknown) {
      createError = explain(cause)
    } finally {
      createBusy = false
    }
  }

  /* ---------------------------------------------------------------- link */

  async function copy(seminar: AdminSeminar): Promise<void> {
    try {
      await navigator.clipboard.writeText(seminar.url)
    } catch {
      // Blocked on an insecure origin, which is a normal way to self-host. The
      // link is the point of the click, so it goes on screen instead.
      rowError = { id: seminar.id, message: `The browser blocked the clipboard. The link is ${seminar.url}` }
      return
    }
    if (rowError?.id === seminar.id) rowError = null
    copiedId = seminar.id
    window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => (copiedId = null), 1600)
  }

  /* -------------------------------------------------------------- rename */

  function startRename(seminar: AdminSeminar): void {
    renamingId = seminar.id
    renameValue = seminar.name
    rowError = null
  }

  async function commitRename(seminar: AdminSeminar): Promise<void> {
    const name = renameValue.trim()
    renamingId = null
    if (!name || name === seminar.name) return

    // Safe to paint: a name is one string, and putting the old one back costs
    // the teacher nothing but the correction they were going to make anyway.
    const before = seminar.name
    patch(seminar.id, { name })
    try {
      replace(await adminApi.updateSeminar(seminar.id, { name }))
    } catch (cause: unknown) {
      patch(seminar.id, { name: before })
      rowError = { id: seminar.id, message: `Could not rename it — ${explain(cause)}` }
    }
  }

  async function archive(seminar: AdminSeminar, archived: boolean): Promise<void> {
    const before = seminar.archivedAt
    patch(seminar.id, { archivedAt: archived ? Date.now() : null })
    try {
      replace(await adminApi.updateSeminar(seminar.id, { archived }))
    } catch (cause: unknown) {
      patch(seminar.id, { archivedAt: before })
      rowError = { id: seminar.id, message: `Could not archive it — ${explain(cause)}` }
    }
  }

  /* -------------------------------------------------------------- delete */

  function confirmDelete(seminar: AdminSeminar): void {
    doomed = seminar
    deleteError = null
  }

  $effect(() => {
    // Focus lands on the way out, never on the button that destroys the room.
    if (doomed) cancelButton?.focus()
  })

  async function destroy(): Promise<void> {
    const target = doomed
    if (!target || deleteBusy) return

    deleteBusy = true
    deleteError = null
    try {
      await adminApi.deleteSeminar(target.id)
      seminars = seminars.filter((s) => s.id !== target.id)
      doomed = null
    } catch (cause: unknown) {
      // Already gone: the list is the thing that is wrong, so correct the list
      // rather than asking the owner to delete something that does not exist.
      if (cause instanceof AdminApiError && cause.status === 404) {
        seminars = seminars.filter((s) => s.id !== target.id)
        doomed = null
      } else {
        deleteError = explain(cause)
      }
    } finally {
      deleteBusy = false
    }
  }
</script>

<AdminPage title="Seminars">
  {#snippet actions()}
    <div
      class="flex h-[34px] w-[220px] items-center gap-2 border border-line bg-canvas px-3
             focus-within:border-accent"
    >
      <Icon name="search" size={13} class="shrink-0 text-faint" />
      <input
        type="search"
        bind:value={query}
        placeholder="Search seminars…"
        aria-label="Search seminars by name"
        class="min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-faint"
      />
    </div>
    <button
      type="button"
      onclick={startCreate}
      class="btn-primary h-[34px] gap-2 px-3.5 text-2xs font-bold uppercase tracking-caps"
    >
      <Icon name="plus" size={14} />
      New seminar
    </button>
  {/snippet}

  <!-- Nothing live, no banner. An empty "running now" is a lie with a border. -->
  {#each live as seminar (seminar.id)}
    <section
      class="-mx-7 flex h-[74px] items-center gap-[22px] border-b border-b-line border-l-[3px] border-l-accent bg-raised pl-[25px] pr-7"
    >
      <div class="flex min-w-0 flex-col gap-[3px]">
        <p
          class="flex items-center gap-[7px] text-micro font-bold uppercase tracking-label text-accent-text"
        >
          <span class="h-[7px] w-[7px] shrink-0 rounded-full bg-accent"></span>
          Running now
        </p>
        <h2 class="truncate text-title font-bold tracking-tight text-ink">{seminar.name}</h2>
      </div>

      <!--
        The artboard stacks the faces of the room here. AdminSeminar carries a
        head-count and nothing else, so there is nobody to draw: blank discs
        read as avatars that failed to load, and the roster endpoint answers
        with everyone who ever joined, which is a different set from the one
        this line is counting. The sentence is the honest version of the stack
        until the contract carries the people — see AvatarStack.
      -->
      <p class="shrink-0 text-ui text-muted" title={new Date(seminar.createdAt).toLocaleString()}>
        {people(seminar.liveCount)} in the room · started {startedAgo(seminar.createdAt, now)}
      </p>

      <div class="ml-auto flex shrink-0 items-center gap-2.5">
        <button
          type="button"
          onclick={() => copy(seminar)}
          title="Copy {seminar.url}"
          class={cn(
            'flex h-8 items-center gap-2 border border-line bg-canvas px-3 font-mono text-code',
            'transition-colors duration-100 hover:border-faint hover:text-ink',
            copiedId === seminar.id ? 'text-positive' : 'text-muted',
          )}
        >
          {hostPathOf(seminar)}
          <Icon name={copiedId === seminar.id ? 'check' : 'copy'} size={13} />
        </button>
        <a
          href={seminar.url}
          target="_blank"
          rel="noreferrer"
          class="btn-primary h-8 px-3.5 text-2xs font-bold uppercase tracking-caps"
        >
          Open
        </a>
      </div>
    </section>
  {/each}

  {#if loadError}
    <div class="mt-6 border border-danger/40 bg-surface px-4 py-3">
      <p class="text-ui text-danger">Could not load your seminars — {loadError}</p>
      <button type="button" class="btn-outline mt-2.5" onclick={() => void load()}>Try again</button>
    </div>
  {/if}

  <!-- Flush against the header, as on the artboard: the rule under the topbar
       is the table's own top rule, and a gap there reads as a missing row. -->
  <table class="w-full table-fixed">
    <colgroup>
      <col />
      <col class="w-[104px]" />
      <col class="w-[74px]" />
      <col class="w-[116px]" />
      <col class="w-10" />
    </colgroup>
    <thead>
      <tr class="border-b border-line text-micro font-bold uppercase tracking-label text-faint">
        <th scope="col" class="py-3 text-left">Seminar</th>
        <th scope="col" class="py-3 text-left">Date</th>
        <th scope="col" class="py-3 text-right">People</th>
        <th scope="col" class="py-3 text-right">Status</th>
        <th scope="col" class="py-3"><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      {#if creating}
        <tr class="border-b border-line-soft bg-surface">
          <td colspan="5" class="py-3">
            <form class="flex items-center gap-2" onsubmit={create}>
              <input
                bind:this={nameInput}
                bind:value={newName}
                class="field max-w-[380px]"
                placeholder="Computer Vision Seminar — 25.08"
                maxlength={LIMITS.seminarName}
                autocomplete="off"
                aria-label="Name of the new seminar"
              />
              <button class="btn-primary" type="submit" disabled={!newName.trim() || createBusy}>
                {#if createBusy}
                  <Icon name="spinner" size={15} class="animate-spin" />
                  Creating…
                {:else}
                  Create
                {/if}
              </button>
              <button class="btn-ghost" type="button" onclick={cancelCreate}>Cancel</button>
            </form>
            {#if createError}
              <p class="mt-2 text-ui text-danger">{createError}</p>
            {/if}
          </td>
        </tr>
      {/if}

      {#each shown as seminar (seminar.id)}
        {@const fresh = seminar.id === justCreatedId}
        <tr class={cn('group border-b border-line-soft', fresh && 'bg-accent/10')}>
          <td class="py-2 pr-4 align-top">
            {#if renamingId === seminar.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                bind:value={renameValue}
                class="field max-w-[380px]"
                maxlength={LIMITS.seminarName}
                autocomplete="off"
                autofocus
                aria-label="Rename {seminar.name}"
                onblur={() => void commitRename(seminar)}
                onkeydown={(event) => {
                  if (event.key === 'Enter') void commitRename(seminar)
                  if (event.key === 'Escape') renamingId = null
                }}
              />
            {:else}
              <a
                href={seminar.url}
                target="_blank"
                rel="noreferrer"
                class="block truncate text-ui font-semibold text-ink hover:underline"
              >
                {seminar.name}
              </a>
            {/if}

            <div class="mt-0.5 flex items-center gap-2">
              <button
                type="button"
                data-copy={seminar.id}
                onclick={() => copy(seminar)}
                title="Copy {seminar.url}"
                class={cn(
                  'flex items-center gap-1.5 font-mono text-2xs transition-colors duration-100',
                  'hover:text-ink focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/30',
                  copiedId === seminar.id ? 'text-positive' : 'text-muted',
                )}
              >
                {pathOf(seminar)}
                <Icon
                  name={copiedId === seminar.id ? 'check' : 'copy'}
                  size={12}
                  class={cn(
                    'transition-opacity duration-100',
                    copiedId === seminar.id || fresh
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100',
                  )}
                />
              </button>
              {#if seminar.status === 'draft'}
                <span class="text-2xs text-faint">link not shared yet</span>
              {/if}
              {#if seminar.archivedAt}
                <span class="text-2xs text-faint">archived</span>
              {/if}
            </div>

            {#if rowError?.id === seminar.id}
              <p class="mt-1 text-2xs text-danger">{rowError.message}</p>
            {/if}
          </td>

          <td class="py-2 align-middle text-ui text-muted">
            <span title={new Date(seminar.createdAt).toLocaleString()}>
              {stamp(seminar.createdAt)}
            </span>
          </td>

          <td class="py-2 text-right align-middle font-mono text-code text-ink">
            <span title="{people(seminar.totalParticipants)} joined in total">
              {seminar.totalParticipants > 0 ? seminar.totalParticipants : '—'}
            </span>
          </td>

          <td class="py-2 align-middle">
            <div class="flex justify-end">
              {#if seminar.status === 'live'}
                <span
                  class="chip h-[22px] gap-1.5 bg-accent/15 px-2 text-micro font-bold uppercase tracking-caps text-accent-text"
                >
                  <span class="h-[5px] w-[5px] rounded-full bg-accent"></span>
                  Live
                </span>
              {:else if seminar.status === 'draft'}
                <span
                  class="chip h-[22px] border border-line px-2 text-micro font-bold uppercase tracking-caps text-muted"
                >
                  Draft
                </span>
              {:else}
                <!-- Bare, so the three states share one right-hand lane: an ended
                     seminar is a fact, not a badge. -->
                <span class="text-micro font-bold uppercase tracking-caps text-muted">Ended</span>
              {/if}
            </div>
          </td>

          <td class="py-2 align-middle">
            <div class="relative flex justify-end">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={openMenuId === seminar.id}
                aria-label="Actions for {seminar.name}"
                onclick={(event) => {
                  event.stopPropagation()
                  openMenuId = openMenuId === seminar.id ? null : seminar.id
                }}
                class="p-1 text-faint transition-colors duration-100 hover:bg-raised hover:text-ink"
              >
                <Icon name="more" size={15} />
              </button>

              {#if openMenuId === seminar.id}
                <div
                  role="menu"
                  tabindex="-1"
                  class="absolute right-0 top-full z-20 mt-1 w-48 border border-line bg-canvas p-1 shadow-pop"
                >
                  <button role="menuitem" type="button" class="{ITEM} text-ink hover:bg-raised" onclick={() => copy(seminar)}>
                    Copy link
                  </button>
                  <a
                    role="menuitem"
                    href={seminar.url}
                    target="_blank"
                    rel="noreferrer"
                    class="{ITEM} text-ink hover:bg-raised"
                  >
                    Open seminar
                  </a>
                  <button role="menuitem" type="button" class="{ITEM} text-ink hover:bg-raised" onclick={() => startRename(seminar)}>
                    Rename
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    class="{ITEM} text-ink hover:bg-raised"
                    onclick={() => void archive(seminar, !seminar.archivedAt)}
                  >
                    {seminar.archivedAt ? 'Move back to the list' : 'Archive'}
                  </button>
                  {#if canDelete}
                    <div class="my-1 border-t border-line-soft"></div>
                    <button
                      role="menuitem"
                      type="button"
                      class="{ITEM} text-danger hover:bg-danger/10"
                      onclick={() => confirmDelete(seminar)}
                    >
                      Delete…
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          </td>
        </tr>
      {/each}

      {#if loading && seminars.length === 0}
        <tr>
          <td colspan="5" class="py-6 text-ui text-faint">Loading seminars…</td>
        </tr>
      {:else if shown.length === 0 && !creating}
        <tr>
          <td colspan="5" class="py-12 text-center">
            {#if needle}
              <p class="text-ui text-muted">Nothing here is called “{query.trim()}”.</p>
              <button type="button" class="btn-ghost mt-2" onclick={() => (query = '')}>
                Show all {count(seminars.length, 'seminar')}
              </button>
            {:else if !loadError}
              <p class="text-ui text-muted">No seminars yet.</p>
              <p class="mt-1 text-ui text-faint">
                Make one and you get a link to paste into the group chat.
              </p>
              <button type="button" class="btn-primary mt-3" onclick={startCreate}>
                <Icon name="plus" size={15} />
                New seminar
              </button>
            {/if}
          </td>
        </tr>
      {/if}
    </tbody>
  </table>

  {#if seminars.length > 0}
    <p class="mt-4 text-2xs text-faint">
      {#if needle}
        Showing {shown.length} of {count(seminars.length, 'seminar')}
      {:else}
        All {count(seminars.length, 'seminar')} this term
      {/if}
    </p>
  {/if}
</AdminPage>

{#if doomed}
  <!-- Nothing is painted before the server agrees: this is the one action on
       the screen that cannot be put back if the request never lands. -->
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="delete-seminar-title"
    class="fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="delete-seminar-title" class="text-title font-semibold text-ink">
        Delete “{doomed.name}”?
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        Deleting it takes the notebook ({count(doomed.cellCount, 'cell')}) and {count(
          doomed.fileCount,
          'file',
        )} in its workspace with it. Colloq keeps no second copy of either.
      </p>
      {#if doomed.liveCount > 0}
        <p class="mt-2 text-ui font-medium text-warning">
          {doomed.liveCount === 1
            ? 'Someone is in the room right now'
            : `${doomed.liveCount} people are in the room right now`} — they lose the notebook
          mid-seminar.
        </p>
      {/if}
      <p class="mt-2 text-ui leading-relaxed text-muted">
        To take it off the list without losing anything, archive it instead.
      </p>

      {#if deleteError}
        <p class="mt-3 text-ui text-danger">Could not delete it — {deleteError}</p>
      {/if}

      <div class="mt-5 flex justify-end gap-2">
        <button
          bind:this={cancelButton}
          type="button"
          class="btn-outline"
          disabled={deleteBusy}
          onclick={() => (doomed = null)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 active:brightness-95"
          disabled={deleteBusy}
          onclick={() => void destroy()}
        >
          {#if deleteBusy}
            <Icon name="spinner" size={15} class="animate-spin" />
            Deleting…
          {:else}
            <Icon name="trash" size={15} />
            Delete seminar
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}
