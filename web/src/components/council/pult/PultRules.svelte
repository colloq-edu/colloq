<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * The council rules — all of a cell's rules on one sheet.
   *
   * They used to live wherever they happened to land: "who runs" as the
   * queue's footer, "names on the projector" as a switch in the status line.
   * Both controls change not how the console looks but what the CLASS may
   * do, and hunting for them across tabs means remembering each time where
   * they were put. Here they are side by side, and next to each its
   * consequence is visible: how many requests a mode change will clear, how
   * long runs actually take, what captions a solution on the wall.
   *
   * The sheet drops from under the header and covers the tabs: it is about
   * the whole cell, and leading away from the open piece of work for it
   * would be unfair — people were reading that work and will go back to it.
   * Buttons apply at once, there is no "Save": a rule is not a form but the
   * position of a switch, and an extra step between "set 1 min" and "it is
   * 1 min" would mean the screen says something other than what is in force.
   */
  import { COUNCIL_SHARED_KERNEL_NOTE, type CouncilSettings } from '@shared/notebook'
  import {
    PULT_RULES,
    limitOptions,
    pauseOptions,
    pultDuration,
    type PultRule,
    type RunStats,
  } from '@/lib/council-pult'
  import { elapsed } from '@/lib/utils'

  interface Props {
    settings: CouncilSettings
    /** The rule the sheet was opened for: its row is highlighted and has focus. */
    rule: PultRule
    /** How many run requests a mode change will clear (server · clearRunRequests). */
    pending: number
    /** How long this cell's runs take; null means none has finished yet. */
    stats: RunStats | null
    /**
     * The limit of an ORDINARY cell in this room, in seconds; `null` — no
     * limit.
     *
     * A room rule, not a cell rule, and it is not changed from here — it
     * lives in the class rules. But it has to be mentioned exactly here: the
     * notebook has one queue, and a run limit set in this sheet saves from
     * nothing while an ordinary cell without a limit can run in the same
     * notebook. That is exactly the hole that made "the limit does not work"
     * true.
     */
    cellLimit: number | null
    /** Offline, or the console is not leading the class: viewable, not changeable. */
    disabled: boolean
    /** The bottom of the header: the sheet starts here, with the dimming below it. */
    top: number
    onchange: (patch: Partial<CouncilSettings>) => void
    onclose: () => void
  }

  let { settings, rule, pending, stats, cellLimit, disabled, top, onchange, onclose }: Props = $props()

  let sheet = $state<HTMLElement | null>(null)

  interface Segment { label: string; on: boolean; off: boolean; pick: () => void }
  interface Row { rule: PultRule; title: string; why: string; note: string; segments: Segment[] }

  const runs = $derived<Segment[]>(
    ([
      [false, 'room.pult.v2.rules.whoTeacher'],
      [true, 'room.pult.v2.rules.whoEveryone'],
      ['request', 'room.pult.v2.rules.whoRequest'],
    ] as [CouncilSettings['studentRun'], string][]).map(([value, key]) => ({
      label: tr(key),
      on: settings.studentRun === value,
      off: disabled,
      pick: () => onchange({ studentRun: value }),
    })),
  )

  const whoWhy = $derived(
    tr(
      settings.studentRun === false
        ? 'room.pult.v2.rules.whyTeacher'
        : settings.studentRun === true
          ? 'room.pult.v2.rules.whyEveryone'
          : 'room.pult.v2.rules.whyRequest',
    ),
  )

  /*
   * The statistics as a live figure, not `spell()`.
   *
   * A council attempt is a few lines, and an ordinary run takes fractions of
   * a second: a finished duration rounds them to "0 s", and the line the
   * limit is chosen by would report "typically 0 s · longest 3 s". The tenth
   * here is the only thing telling 0.4 s from 4 s.
   */
  const statLine = $derived(
    stats === null
      ? ''
      : tr('room.pult.v2.rules.limitStats', { median: elapsed(0, stats.median), max: elapsed(0, stats.max) }),
  )

  const rows = $derived<Row[]>(
    PULT_RULES.map((each) => {
      switch (each) {
        case 'studentRun':
          return {
            rule: each,
            title: tr('room.pult.v2.rules.whoTitle'),
            why: whoWhy,
            // A consequence people only learn about after the press: the
            // server clears all requests as soon as the mode changes.
            note: pending > 0 ? tr('room.pult.v2.rules.whoPending', { count: pending }) : '',
            segments: runs,
          }
        case 'runLimit':
          return {
            rule: each,
            title: tr('room.pult.v2.rules.limitTitle'),
            why: tr('room.pult.v2.rules.limitWhy'),
            note: statLine,
            segments: limitOptions(settings.runLimitSec).map((value) => ({
              label: value === null ? tr('room.pult.v2.rules.limitNoneOption') : pultDuration(value),
              on: settings.runLimitSec === value,
              off: disabled,
              pick: () => onchange({ runLimitSec: value }),
            })),
          }
        case 'rerunPause':
          return {
            rule: each,
            title: tr('room.pult.v2.rules.pauseTitle'),
            /*
             * The row stays in place even with runs switched off: if it
             * disappeared, it would take with it the fact that the pause is
             * set — and runs can be given back to students with one press of
             * the neighbouring button.
             *
             * With "by anyone, in turn" the caption is different, and that is
             * not decoration. The pause defaults to zero, and a teacher
             * switches on "by anyone, in turn" a minute before it matters and
             * does not remember the pause — the shared kernel's queue
             * immediately fills with repeat presses after every edit. The
             * only place to say so in time is here, in the neighbouring row of
             * the same sheet.
             */
            why: settings.studentRun === false
              ? tr('room.pult.v2.rules.pauseOff')
              : settings.studentRun === true
                ? tr('room.pult.v2.rules.pauseWhyEveryone')
                : tr('room.pult.v2.rules.pauseWhy'),
            note: '',
            /*
             * The buttons are always live, not only when students are allowed
             * to run. They used to grey out on `studentRun === false`, that
             * is, the pause could be set only after running had already been
             * opened — while the order "first set the pause, then open
             * running" is exactly the one in which the queue has no time to
             * fill up.
             */
            segments: pauseOptions(settings.rerunPauseSec).map((value) => ({
              label: value === 0 ? tr('room.pult.v2.rules.pauseNowOption') : pultDuration(value),
              on: settings.rerunPauseSec === value,
              off: disabled,
              pick: () => onchange({ rerunPauseSec: value }),
            })),
          }
        default:
          return {
            rule: each,
            title: tr('room.pult.v2.rules.screenTitle'),
            why: tr('room.pult.v2.rules.screenWhy'),
            note: '',
            segments: [true, false].map((value) => ({
              label: tr(value ? 'room.pult.v2.rules.screenNamesOption' : 'room.pult.v2.rules.screenAnonOption'),
              on: settings.namesOnProjector === value,
              off: disabled,
              pick: () => onchange({ namesOnProjector: value }),
            })),
          }
      }
    }),
  )

  /**
   * Focus lands on the button the sheet was opened for.
   *
   * Not on the heading and not on "Done": people came to change a rule, and
   * the very first arrow or space press has to land in its row. If there is
   * no button (the row is off or the console is not leading), "Done"
   * remains, so that Esc is not the only way out from the keyboard.
   */
  $effect(() => {
    const where = sheet
    if (!where) return
    const target =
      where.querySelector<HTMLButtonElement>(`[data-pult-rules-row="${rule}"] button:not(:disabled)[aria-pressed="true"]`) ??
      where.querySelector<HTMLButtonElement>('[data-pult-rules-done]')
    target?.focus({ preventScroll: true })
  })

  /** Tab cycles within the sheet: what lies behind it is not being controlled now. */
  function keys(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !sheet) return
    const items = [...sheet.querySelectorAll<HTMLElement>('button:not(:disabled)')]
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey ? at - 1 : at + 1
    if (at >= 0 && next >= 0 && next < items.length) return
    event.preventDefault()
    items[event.shiftKey ? items.length - 1 : 0].focus()
  }
</script>

<div class="rules-layer" style:--rules-top={`${top}px`}>
  <!-- The dimming starts under the sheet: the header with the sentence stays
       live, and the sheet can be closed with the same press that opened it. -->
  <div class="rules-scrim" role="presentation" onclick={onclose}></div>
  <div
    class="rules-sheet"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="pult-rules-title"
    data-pult-rules
    bind:this={sheet}
    onkeydown={keys}
  >
    <header class="rules-head">
      <div class="rules-head-copy">
        <h2 id="pult-rules-title">{tr('room.pult.v2.rules.title')}</h2>
        <p>{tr('room.pult.v2.rules.subtitle')}</p>
      </div>
      <button type="button" class="pult-button" data-pult-rules-done onclick={onclose}>
        {tr('room.pult.v2.rules.done')} <span class="rules-esc" aria-hidden="true">Esc</span>
      </button>
    </header>

    {#each rows as row (row.rule)}
      <div class="rules-row" class:here={row.rule === rule} data-pult-rules-row={row.rule}>
        <span class="rules-label">{row.title}</span>
        <div class="rules-options">
          {#each row.segments as segment, at (at)}
            <button
              type="button"
              class="pult-button"
              class:pult-button--selected={segment.on}
              aria-pressed={segment.on}
              disabled={segment.off}
              onclick={segment.pick}
            >{segment.label}{segment.on ? ' ✓' : ''}</button>
          {/each}
        </div>
        <p class="rules-why">
          {row.why}
          {#if row.note}<span class="rules-note">{row.note}</span>{/if}
        </p>
      </div>
    {/each}

    <!--
      The limit of an ORDINARY cell — next to the caption about the shared
      kernel, and it is the same knowledge told to the end: the kernel is
      shared, so the queue is shared too, and the run limit in this sheet
      guards only the attempts. The line stands under the rules, not as a row
      among them: it cannot be changed from here, it lives in the class rules.
    -->
    <p class="rules-kernel" class:rules-warn={cellLimit === null} data-pult-cell-limit>
      {cellLimit === null
        ? tr('room.pult.v3.rules.cellLimitOff')
        : tr('room.pult.v3.rules.cellLimitOn', { duration: pultDuration(cellLimit) })}
    </p>
    <p class="rules-kernel">{tr(COUNCIL_SHARED_KERNEL_NOTE)}</p>
  </div>
</div>

<style>
  .rules-layer { position:absolute; inset:0; z-index:40; pointer-events:none; }
  .rules-scrim { position:absolute; left:0; right:0; top:var(--rules-top); bottom:0; background:rgba(16,26,51,.32); pointer-events:auto; }
  .rules-sheet {
    /* A pixel above the bottom of the header: the sheet's own line lies
       exactly on its border, otherwise the joint shows a double line. */
    position:absolute; left:0; right:0; top:calc(var(--rules-top) - 1px);
    /* The sheet does not grow below the window: at 700 px of height four
       rows and the kernel caption do not fit, and otherwise the last rule
       simply cannot be reached. */
    max-height:calc(100dvh - var(--rules-top));
    overflow-y:auto; overscroll-behavior:contain;
    background:rgb(var(--canvas)); border-top:1px solid rgb(var(--line)); border-bottom:1px solid rgb(var(--line));
    pointer-events:auto;
  }
  .rules-head { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; padding:22px var(--pult-pad) 18px; }
  .rules-head-copy { min-width:0; }
  h2 { margin:0; font-size:20px; line-height:26px; font-weight:700; }
  .rules-head-copy p { margin:4px 0 0; color:rgb(var(--muted)); font-size:14px; line-height:18px; }
  .rules-esc { color:rgb(var(--faint)); font-size:12px; font-weight:600; }
  /* The left stripe is four pixels the text does NOT shift by: the sheet's
     heading and the row captions must start on the same vertical. */
  .rules-row { display:flex; align-items:center; gap:24px; padding:16px var(--pult-pad); border-top:1px solid rgb(var(--line)); border-left:4px solid transparent; }
  .rules-row.here { border-left-color:rgb(var(--primary)); background:rgb(var(--surface)); }
  .rules-label { width:168px; flex-shrink:0; font-size:15px; line-height:20px; font-weight:700; }
  .rules-options { display:flex; flex-wrap:wrap; gap:8px; width:452px; flex-shrink:0; }
  .rules-options .pult-button { min-height:38px; padding:10px 12px; font-size:14px; line-height:18px; }
  .rules-options .pult-button[aria-pressed='true'] { color:rgb(var(--primary)); font-weight:700; }
  .rules-why { flex:1; min-width:0; margin:0; color:rgb(var(--muted)); font-size:13px; line-height:18px; }
  .rules-note { display:block; margin-top:4px; color:rgb(var(--accent-text)); font-weight:600; }
  .rules-warn { color:rgb(var(--warning)); font-weight:600; }
  .rules-kernel { margin:0; padding:14px var(--pult-pad) 18px; border-top:1px solid rgb(var(--line)); color:rgb(var(--faint)); font-size:13px; line-height:18px; }
  @media (max-width:1000px) {
    .rules-row { flex-wrap:wrap; gap:10px 16px; }
    .rules-label { width:auto; flex-basis:100%; }
    .rules-options { width:auto; flex-shrink:1; }
    .rules-why { flex-basis:100%; }
  }
</style>
