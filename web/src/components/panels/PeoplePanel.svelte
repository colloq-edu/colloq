<script lang="ts">
  import type { AwarenessUser } from '@shared/protocol'
  import { getSessionState } from '@/lib/session.svelte'
  import { watchCell, watchCellIds, watchCellMeta, watchNotebookMeta } from '@/lib/yreactive.svelte'
  import Avatar from '@/components/ui/Avatar.svelte'

  interface Person {
    user: AwarenessUser
    isSelf: boolean
    /** Open tabs for this human; two tabs are still one person in the room. */
    tabs: number
  }

  /** Faces before the rest fold into "+N more"; the rail is a glance, not a roster. */
  const CAP = 6

  const session = getSessionState()
  const cellIds = watchCellIds(session.doc)
  const meta = watchNotebookMeta(session.doc)
  // The one cell the kernel is inside, if any — the difference between someone
  // sitting in a cell and someone waiting on it.
  const running = watchCell(session.doc, () => meta.current.runningCellId ?? '')
  const runningMeta = watchCellMeta(() => running.current)

  let expanded = $state(false)

  const people = $derived.by(() => {
    const byId = new Map<string, Person>()
    for (const peer of session.peers) {
      const existing = byId.get(peer.user.id)
      if (!existing) {
        byId.set(peer.user.id, { user: peer.user, isSelf: peer.isSelf, tabs: 1 })
        continue
      }
      existing.tabs += 1
      existing.isSelf ||= peer.isSelf
      // Whichever tab is actually doing something is the one worth reporting.
      if (!existing.user.activeCellId && peer.user.activeCellId) existing.user = peer.user
    }
    return [...byId.values()]
  })

  const shown = $derived(expanded ? people : people.slice(0, CAP))
  const rest = $derived(people.length - shown.length)

  /** Cell numbers read as they do in the gutter: 01, 02, 03. */
  function cellNumber(id: string | null | undefined): string | null {
    if (!id) return null
    const index = cellIds.current.indexOf(id)
    return index === -1 ? null : String(index + 1).padStart(2, '0')
  }

  /*
   * One sentence per person, from awareness and the run state and nothing else.
   * Ordered by what interrupts what: a run outranks where the cursor happens to
   * be, and "N tabs open" is only worth saying when there is nothing happening
   * in any of them. A person we can say nothing true about gets no line.
   */
  function activityFor(person: Person): string | null {
    const runningId = meta.current.runningCellId
    const runningNo = cellNumber(runningId)
    // Whoever pressed Run and whoever is standing in the cell while it runs are
    // both truthfully running it. runBy is a display name, so two students who
    // share one would both claim the run — the cursor test is what usually
    // decides it, and a wrong attribution here costs a word, not a state.
    const runs =
      runningNo !== null &&
      (runningMeta.current.runBy === person.user.name || person.user.activeCellId === runningId)
    if (runs) return `running cell ${runningNo}`

    if (person.user.inTerminal) return 'in the terminal'
    if (person.user.composing) return 'asking the assistant'

    const at = cellNumber(person.user.activeCellId)
    if (at) return `editing cell ${at}`

    if (person.tabs > 1) return `${person.tabs} tabs open`
    return null
  }

  /** The identity line replaces the activity line for you, and marks a host. */
  function badgeFor(person: Person): string | null {
    const host = person.user.role === 'host'
    if (person.isSelf) return host ? 'Host · You' : 'You'
    return host ? 'Host' : null
  }
</script>

<section class="flex shrink-0 flex-col gap-0.5 px-4 pb-5 pt-5" aria-label="People in the room">
  <div class="flex items-center gap-2 pb-2">
    <h2 class="text-2xs font-bold uppercase tracking-section text-faint">People</h2>
    <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
    <span class="font-mono text-micro tabular-nums text-faint">{people.length}</span>
  </div>

  {#if people.length === 0}
    <p class="px-2 text-2xs text-muted">Connecting to the room…</p>
  {/if}

  {#each shown as person (person.user.id)}
    {@const activity = activityFor(person)}
    {@const badge = badgeFor(person)}
    <div class="flex min-h-[34px] items-center gap-2.5 px-2">
      <Avatar
        name={person.user.name}
        color={person.user.color}
        avatar={person.user.avatar}
        size="sm"
      />

      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-ui text-ink {person.isSelf ? 'font-semibold' : ''}">
          {person.user.name}
        </span>
        <!-- Who you are outranks what you are doing: your own row and a host's
             carry the label, everyone else's carries the live line. -->
        {#if badge && (person.isSelf || !activity)}
          <span class="truncate text-micro font-bold uppercase tracking-label text-accent-text">
            {badge}
          </span>
        {:else if activity}
          <span class="truncate text-micro tracking-caps text-muted">{activity}</span>
        {/if}
      </div>

      <!-- The square is the same colour as this person's cursor in the editor;
           that tie is the whole reason it is a square and not a status dot. -->
      <span class="flex w-3.5 shrink-0 justify-end">
        <span
          class="h-2 w-2"
          style="background-color: {person.user.color}"
          aria-hidden="true"
        ></span>
      </span>
    </div>
  {/each}

  {#if rest > 0 || expanded}
    <!-- The design stops the list at a glance; nobody in the room is actually
         unreachable, so the count opens the rest instead of hiding them. -->
    <button
      type="button"
      class="flex h-[30px] shrink-0 items-center gap-2.5 px-2 text-left text-2xs text-faint transition-colors duration-100 hover:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      onclick={() => (expanded = !expanded)}
    >
      <span class="w-6 shrink-0" aria-hidden="true"></span>
      <span>{expanded ? 'Show fewer' : `+${rest} more`}</span>
    </button>
  {/if}
</section>
