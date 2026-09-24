<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Who is in the room — and, for the teacher, who is not let in.
   *
   * Two lists in one panel, because it is one and the same question asked from
   * two sides: a person is removed right here, with a right click on their row,
   * and brought back one row below. Putting them in different places would mean
   * hiding the lifting of a ban from whoever set it — and it is easy to hit the
   * wrong row in a list of names, there are no faces there.
   */
  import type { Ban } from '@shared/protocol'
  import { getSessionState } from '@/lib/session.svelte'
  import { peopleInRoom, whereabouts, type Person } from '@/lib/room'
  import { reveal, revealCell, type RevealTarget } from '@/lib/reveal'
  import { watchCell, watchCellNumbers, watchCellMeta, watchNotebookMeta } from '@/lib/yreactive.svelte'
  import {
    activeBans,
    askToBan,
    BANS_CHANGED_EVENT,
    mayBan,
    personNotes,
    untilWords,
    type PersonMark,
  } from '@/lib/bans'
  import { api } from '@/lib/api'
  import Avatar from '@/components/ui/Avatar.svelte'
  import { cn } from '@/lib/utils'

  /** Faces before the rest fold into "+N more"; the rail is a glance, not a roster. */
  const CAP = 6

  const session = getSessionState()
  const cellNumbers = watchCellNumbers(session.doc)
  const meta = watchNotebookMeta(session.doc)
  // The one cell the kernel is inside, if any — the difference between someone
  // sitting in a cell and someone waiting on it.
  const running = watchCell(session.doc, () => meta.current.runningCellId ?? '')
  const runningMeta = watchCellMeta(() => running.current)

  let expanded = $state(false)

  // One rule for "who is here", shared with the header's avatar row — they used
  // to count differently and the bar contradicted itself.
  const people = $derived(peopleInRoom(session.peers))

  const shown = $derived(expanded ? people : people.slice(0, CAP))
  const rest = $derived(people.length - shown.length)

  /* ------------------------------------------------------------------ bans */

  const isHost = $derived(session.me.role === 'host')

  let bans = $state.raw<Ban[]>([])
  /**
   * Notes about browsers — only those the server sent.
   *
   * Empty for everyone until the server knows about them: the people list then
   * looks exactly as it did — a note based on a guess is worse than a missing
   * one.
   */
  let marks = $state.raw<Record<string, PersonMark>>({})
  /**
   * The moment by which ban terms and the freshness of notes are computed.
   *
   * Reset together with re-reading the list: "first time, just now" stops being
   * true after five minutes, and a ban ends by itself — and a line "until
   * 18:40" still hanging there at seven in the evening offers to lift what has
   * already been lifted.
   */
  let now = $state(Date.now())
  let lifting = $state<string | null>(null)

  const live = $derived(activeBans(bans, now))

  async function refresh(): Promise<void> {
    try {
      const body = await api.bans(session.session.id, session.token)
      bans = body.bans
      marks = body.marks ?? {}
    } catch {
      /* network blip: the next round re-reads; the people list is unaffected */
    }
    now = Date.now()
  }

  /*
   * Once a minute, and only for the teacher. The request is cheap — a dozen
   * rows per room — and only one person in the room pays for it; for a student
   * this panel does not ask a single question it did not ask before.
   */
  $effect(() => {
    if (!isHost) return
    void refresh()
    const again = () => void refresh()
    const timer = window.setInterval(again, 60_000)
    window.addEventListener(BANS_CHANGED_EVENT, again)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(BANS_CHANGED_EVENT, again)
    }
  })

  /**
   * A right click on a row is the only way into the menu from here.
   *
   * Not an icon in the row: removal from class is pressed once a semester, and
   * a row of the people list ten times per class, to get to someone else's
   * cell. A button next to that route would end up under the finger of whoever
   * aimed at the name.
   */
  function offerBan(event: MouseEvent, person: Person): void {
    if (!mayBan(session.me.role, person.user.role)) return
    event.preventDefault()
    askToBan({
      id: person.user.id,
      name: person.user.name,
      color: person.user.color,
      avatar: person.user.avatar,
      x: event.clientX,
      y: event.clientY,
    })
  }

  async function lift(ban: Ban): Promise<void> {
    lifting = ban.id
    try {
      await api.liftBan(session.session.id, session.token, ban.id)
      // The row goes away at once: the server has answered, and waiting for the
      // next polling round would mean keeping someone who has already been
      // brought back under a pressed button.
      bans = bans.filter((other) => other.id !== ban.id)
    } catch (cause) {
      session.showError(cause instanceof Error ? tr(cause.message) : tr('room.ui.668'))
    } finally {
      lifting = null
    }
  }

  /** Cells, the run and who started it: what "who is where" is built from. */
  const view = $derived({
    numbers: cellNumbers.current,
    runningCellId: meta.current.runningCellId,
    runBy: (runningMeta.current.runBy as string | null) ?? null,
  })

  /**
   * The hover caption: where exactly a press will take you.
   *
   * In Russian, like everything around it: the list of the removed under this
   * same panel, the ban window, the rules console and the file tree are
   * Russian, and an English hint among them would read as a foreign insertion.
   * (The opposite argument stood here for a long time — it was right when the
   * app had four lines of Russian, and stopped being right when half of the
   * interface became Russian.)
   */
  function hintFor(person: Person, place: RevealTarget): string {
    const who = person.isSelf ? tr('room.ui.669') : person.user.name
    if (place.where === 'terminal') return tr('room.ui.670', { p0: who })
    if (place.where === 'oracle') return tr('room.ui.671', { p0: who })
    /*
     * Only a cell gets this far, and the check is there for that reason.
     *
     * `RevealTarget` gained a `file` variant — go-to-definition uses it to open
     * a .py file (lib/goto.svelte.ts) — but the people list does not show such
     * a place: it says who is WORKING where, and people work in a cell, in the
     * terminal and at the oracle. There used to be three variants, and after
     * two checks exactly one remained; now there are four, and the silent
     * "everything else is a cell" became untrue.
     */
    if (place.where !== 'cell') return tr('room.ui.672')
    const number = view.numbers.get(place.cellId)
    return number === undefined ? tr('room.ui.672') : tr('room.ui.673', { p0: String(number).padStart(2, '0') })
  }

  function go(place: RevealTarget): void {
    if (place.where === 'cell') revealCell(session, place.cellId)
    else reveal(place)
  }

  /** Who the person is, instead of what they are doing; and the teacher tag. */
  function badgeFor(person: Person): string | null {
    const host = person.user.role === 'host'
    if (person.isSelf) return host ? tr('room.ui.674') : tr('room.ui.544')
    return host ? tr('room.ui.675') : null
  }
</script>

<section class="flex shrink-0 flex-col gap-0.5 px-4 pb-5 pt-5" aria-label={tr('room.ui.657')}>
  <div class="flex items-center gap-2 pb-2">
    <h2 class="text-2xs font-bold uppercase tracking-section text-muted">{tr('room.ui.658')}</h2>
    <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
    <span class="font-mono text-micro tabular-nums text-muted">{people.length}</span>
  </div>

  {#if people.length === 0}
    <p class="px-2 text-2xs text-muted">{tr('room.ui.659')}</p>
  {/if}

  {#each shown as person (person.user.id)}
    {@const seen = whereabouts(person, view)}
    {@const activity = seen.line}
    {@const badge = badgeFor(person)}
    {@const place = seen.place}
    {@const notes = isHost
      ? personNotes(marks[person.user.id], { bansActive: live.length > 0, now })
      : []}
    <!--
      The row becomes a button exactly when it has somewhere to lead. When there
      is nothing to say about a person, there is nothing to show either: they
      are in the room, but not in any particular place in it — and a highlight
      under the cursor on such a row would promise a jump that will not happen.

      svelte:element, not two identical blocks of markup: the row has seven
      nested elements, and a second copy would drift from the first at the very
      first indentation edit.
    -->
    <svelte:element
      this={place ? 'button' : 'div'}
      role={place ? 'button' : undefined}
      type={place ? 'button' : undefined}
      title={place ? hintFor(person, place) : undefined}
      onclick={place ? () => go(place) : undefined}
      oncontextmenu={(event: MouseEvent) => offerBan(event, person)}
      class={cn(
        'flex min-h-[34px] w-full items-center gap-2.5 px-2 text-left',
        place &&
          'transition-colors duration-[var(--speed-quick)] hover:bg-line ' +
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
      )}
    >
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
          <span class="text-2xs font-semibold text-accent-text">
            {badge}
          </span>
        {:else if activity}
          <span class="truncate text-2xs tracking-caps text-muted">{activity}</span>
        {/if}
        <!--
          Notes — as a third line and in the same quiet colour as everything
          else here. They forbid nothing and can be wrong, so they do not
          compete for attention with the name or with what the person is doing:
          what exactly the room caught on to is written under the cursor.
        -->
        {#if notes.length > 0}
          <span class="flex flex-wrap items-center gap-x-1 text-micro leading-snug text-muted">
            {#each notes as note, index (note.text)}
              {#if index > 0}<span aria-hidden="true">·</span>{/if}
              <span title={note.why} class="cursor-help">{note.text}</span>
            {/each}
          </span>
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
    </svelte:element>
  {/each}

  {#if rest > 0 || expanded}
    <!-- The design stops the list at a glance; nobody in the room is actually
         unreachable, so the count opens the rest instead of hiding them. -->
    <button
      type="button"
      class="flex h-[30px] shrink-0 items-center gap-2.5 px-2 text-left text-2xs text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      onclick={() => (expanded = !expanded)}
    >
      <span class="w-6 shrink-0" aria-hidden="true"></span>
      <span>{expanded ? tr('room.ui.660') : tr('room.ui.661', { p0: rest })}</span>
    </button>
  {/if}
</section>

<!--
  Who is not let in — and one button that undoes it.

  There is no list at all until someone has been removed: an empty "Removed"
  section in every room would tell every teacher about punishment, including
  those who will never need it.
-->
{#if isHost && live.length > 0}
  <section class="flex shrink-0 flex-col gap-0.5 px-4 pb-5" aria-label={tr('room.ui.662')}>
    <div class="flex items-center gap-2 pb-2">
      <h2 class="text-2xs font-bold uppercase tracking-section text-muted">{tr('room.ui.663')}</h2>
      <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
      <span class="font-mono text-micro tabular-nums text-muted">{live.length}</span>
    </div>

    {#each live as ban (ban.id)}
      <div
        class="flex min-h-[34px] items-center gap-2.5 px-2"
        title={ban.byTeacher ? tr('room.extra.287', { p0: ban.byTeacher }) : undefined}
      >
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-ui text-ink">{ban.name}</span>
          <span class="truncate text-2xs tracking-caps text-muted"> {tr('room.ui.664')} {untilWords(ban.until, now)}{ban.mine ? tr('room.ui.665') : ''}
          </span>
        </div>
        <button
          type="button"
          class="btn-ghost h-6 shrink-0 px-2 text-2xs font-bold uppercase tracking-label"
          disabled={lifting === ban.id}
          onclick={() => void lift(ban)}
        >
          {lifting === ban.id ? tr('room.ui.666') : tr('room.ui.170')}
        </button>
      </div>
    {/each}

    <!--
      This used to say "restoring a version in the history brings them back" — a
      promise the product does not keep: the history stores the notebook's cells
      (`cellsOf` in collab/history.ts), and restoring a version does not touch
      the question feed at all. A teacher who read that pressed "Restore all" on
      a "before the ban" checkpoint and got an untouched notebook and the same
      empty feed. Until restoring can handle the feed, what is said is what
      there is.
    -->
    <p class="px-2 pt-1.5 text-micro leading-snug text-muted"> {tr('room.ui.667')} </p>
  </section>
{/if}
