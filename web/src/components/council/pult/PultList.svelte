<script lang="ts">
  import { tr } from '@shared/i18n'
    /**
   * The console's left column: people from top to bottom, newest first.
   *
   * Two kinds of rows: a person (PultRow) and the heading of a half of the
   * feed ("Submitted · 12", "Writing · 5"). Only the first can be selected
   * with the cursor — Enter on a heading would mean "show the class" the work
   * of who knows whom.
   *
   * There used to be four kinds: the collapsed tail of a group and the header
   * of an expanded one went here too. There is no grouping in the console
   * any more (20 Sep 2026), and no people under someone else's tail either:
   * one submission is one row.
   *
   * The "↑ N more submitted — show" strip appears when the list is scrolled
   * or the cursor is not on the first row: a row that lands on top under the
   * reading eye pushes down everything it is reading. It is released by hand
   * — and only then does the list move.
   */
  import type { CouncilAttempt } from '@shared/protocol'
  import { pultPresence, rowMeaning, type PultRow as Row, type PultTab } from '@/lib/council-pult'
  import { cn } from '@/lib/utils'
  import PultRow from './PultRow.svelte'

  interface Props {
    rows: readonly Row[]
    people: ReadonlyMap<string, unknown>
    connected: boolean
    filtered?: boolean
    /** The open pile: an empty "Writing" and an empty "Submitted" are different news. */
    tab: PultTab
    /** The selected work — the same one open on the right. */
    cursor: string | null
    /** Came from the keyboard: only then is the ring drawn. */
    keyboard: boolean
    names: boolean
    /** Who is on the room's screen right now. */
    shown: string | null
    /** How many submissions are held behind the strip; 0 means no strip. */
    held: number
    /** The window clock: a live "Running 3 s" counter in the running person's row. */
    now: number
    /** Run requests cannot be decided (no connection, the wrong control). */
    decisionsOff: boolean
    onopen: (participantId: string) => void
    onlet: (attempt: CouncilAttempt) => void
    onrelease: () => void
    /** How far the list is scrolled: this decides whether to hold new submissions. */
    onscroll: (top: number) => void
  }

  let {
    rows,
    people,
    connected,
    filtered = false,
    tab,
    cursor,
    keyboard,
    names,
    shown,
    held,
    now,
    decisionsOff,
    onopen,
    onlet,
    onrelease,
    onscroll,
  }: Props = $props()

  const CAPS = 'text-[13px] font-semibold'
</script>

<!--
  308 is exactly what "Aleksandra Vereshchagina" fits into whole. Wider than
  1100 the list grows to 360: room has appeared, and it is worth giving it to
  the list — the work on the right reads no better for an extra 52 px, but the
  list does.
-->
<div
  class="flex min-h-0 flex-1 flex-col"
  data-pult-list
>
  {#if held > 0}
    <!--
      Pinned to the top of the list, not inserted as the first row: it is about
      what is not in the list yet, and it must not scroll away with it.
    -->
    <button
      type="button"
      class={cn(CAPS, 'flex min-h-10 shrink-0 items-center justify-center border-b border-line bg-accent text-accent-ink')}
      onclick={onrelease}
    >{tr('room.ui.1320', { count: held })}</button>
  {/if}
  <div
    class="pult-scroll min-h-0 flex-1 overflow-y-auto"
    data-pult-scroll
    onscroll={(event) => onscroll(event.currentTarget.scrollTop)}
  >
    {#each rows as row (row.id)}
      {#if row.kind === 'attempt'}
        <PultRow
          attempt={row.attempt}
          presence={pultPresence(connected, people, row.attempt.participantId)}
          unread={row.unread}
          variant={row.variant}
          {names}
          {now}
          selected={cursor === row.id}
          focused={keyboard && cursor === row.id}
          meaning={rowMeaning(row.attempt, cursor, shown)}
          onlet={row.attempt.runRequest?.status === 'pending' && !decisionsOff
            ? () => onlet(row.attempt)
            : null}
          onopen={() => onopen(row.id)}
        />
      {:else}
        <!--
          The feed's boundary: "Submitted · 12" and "Writing · 5".
          Sticky inside the scroll — if it scrolled away it would stop
          answering the only question it was made for: is the row under the
          eye right now one of those who submitted or of those writing? The
          cursor cannot land on it, j and k jump over it: it is a place in the
          feed, not a person.
        -->
        <div class="pult-section" data-pult-section={row.section}>
          {tr(
            row.section === 'submitted'
              ? 'room.pult.v3.sections.submitted'
              : 'room.pult.v3.sections.writing',
            { count: row.count },
          )}
        </div>
      {/if}
    {:else}
      <!--
        Emptiness is explained by its own reason. A filter that found nothing
        is one thing; "Writing" being empty because everyone has already
        submitted is quite another, and in class that is good news, not a lack
        of data.
      -->
      <div class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <p class="text-ui-lg font-bold text-muted">{tr(
          filtered ? 'room.pult.v2.noMatches' : tab === 'all' ? 'room.pult.v2.noAttempts' : 'room.pult.v3.tabs.empty',
        )}</p>
        <p class="text-[14px] leading-relaxed text-muted">{tr(
          filtered
            ? 'room.pult.v2.changeFilter'
            : tab === 'writing'
              ? 'room.pult.v3.tabs.emptyWriting'
              : tab === 'submitted'
                ? 'room.pult.v3.tabs.emptySubmitted'
                : 'room.pult.v2.noAttemptsHint',
        )}</p>
      </div>
    {/each}
  </div>
</div>

<style>
  /*
   * A finger, not a wheel.
   *
   * `overscroll-behavior: contain` keeps the jolt at the end of the list
   * inside the list: without it a list scrolled to the bottom on a phone
   * drags the whole page along, and the communication dock slides out from
   * under the thumb. Safari's momentum is enabled with its own prefix —
   * without it the list scrolls "like paper", in jerks of a screen's height.
   */
  .pult-scroll { overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
  .pult-section {
    position: sticky; top: 0; z-index: 2;
    display: flex; align-items: center; min-height: 28px;
    padding: 5px 12px;
    border-bottom: 1px solid rgb(var(--line));
    background: rgb(var(--surface));
    color: rgb(var(--faint));
    font-size: 12px; font-weight: 700; line-height: 16px; letter-spacing: .08em; text-transform: uppercase;
  }
  .pult-section[data-pult-section='submitted'] { color: rgb(var(--accent-text)); }
</style>
