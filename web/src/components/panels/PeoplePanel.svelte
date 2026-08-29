<script lang="ts">
  import type { AwarenessUser } from '@shared/protocol'
  import { getSessionState } from '@/lib/session.svelte'
  import { peopleInRoom, whereabouts, type Person } from '@/lib/room'
  import { reveal, revealCell, type RevealTarget } from '@/lib/reveal'
  import { watchCell, watchCellNumbers, watchCellMeta, watchNotebookMeta } from '@/lib/yreactive.svelte'
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

  /** Ячейки, запуск и кто его нажал — всё, из чего считается «где кто». */
  const view = $derived({
    numbers: cellNumbers.current,
    runningCellId: meta.current.runningCellId,
    runBy: (runningMeta.current.runBy as string | null) ?? null,
  })

  /**
   * Подпись на наведение: куда именно уведёт нажатие.
   *
   * По-английски, как и весь остальной интерфейс: это единственные четыре
   * строки во всём приложении, которые были написаны по-русски, и в списке
   * рядом с «Files», «People» и «Run» они читались как чужая вставка.
   */
  function hintFor(person: Person, place: RevealTarget): string {
    const who = person.isSelf ? 'you' : person.user.name
    if (place.where === 'terminal') return `Go to ${who} in the terminal`
    if (place.where === 'oracle') return `Go to ${who}’s thread with the oracle`
    const number = view.numbers.get(place.cellId)
    return number === undefined ? 'Go to the cell' : `Go to cell ${String(number).padStart(2, '0')}`
  }

  function go(place: RevealTarget): void {
    if (place.where === 'cell') revealCell(session, place.cellId)
    else reveal(place)
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
    <h2 class="text-2xs font-bold uppercase tracking-section text-muted">People</h2>
    <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
    <span class="font-mono text-micro tabular-nums text-muted">{people.length}</span>
  </div>

  {#if people.length === 0}
    <p class="px-2 text-2xs text-muted">Connecting to the room…</p>
  {/if}

  {#each shown as person (person.user.id)}
    {@const seen = whereabouts(person, view)}
    {@const activity = seen.line}
    {@const badge = badgeFor(person)}
    {@const place = seen.place}
    <!--
      Строка становится кнопкой ровно тогда, когда ей есть куда вести. Про
      человека, о котором нечего сказать, и показать нечего: он в комнате, но
      не в каком-то её месте — и подсветка под курсором на такой строке
      обещала бы переход, которого не будет.

      svelte:element, а не два одинаковых блока разметки: у ряда семь
      вложенных элементов, и вторая копия разошлась бы с первой на первой же
      правке отступа.
    -->
    <svelte:element
      this={place ? 'button' : 'div'}
      role={place ? 'button' : undefined}
      type={place ? 'button' : undefined}
      title={place ? hintFor(person, place) : undefined}
      onclick={place ? () => go(place) : undefined}
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
          <span class="truncate text-2xs font-bold uppercase tracking-label text-accent-text">
            {badge}
          </span>
        {:else if activity}
          <span class="truncate text-2xs tracking-caps text-muted">{activity}</span>
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
      <span>{expanded ? 'Show fewer' : `+${rest} more`}</span>
    </button>
  {/if}
</section>
