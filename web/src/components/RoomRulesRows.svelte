<!--
  Room rules — a row per rule, as many as there are in `RULE_ROWS`.

  One markup for the panel and for the console in the room itself: a setting
  named differently in two places is two settings, and the teacher would be
  searching the room for a switch they set from the panel.

  Rows of two kinds, but one frame: the name and caption on the left, a single
  control on the right. For rules it is a switch, for the oracle ceilings a
  number field, because "how many questions an hour" cannot be picked from
  three words. The number of rows is left out on purpose: the list lives in
  `lib/rule-rows.ts` and grows, and a comment calling them eleven was already
  lying at the twelfth.

  The LANGUAGE of these rows is the ROOM's language, and it changes only
  together with the room.

  The teacher panel is bilingual (Seminars/Teachers/Oracle/Environments in
  English, Courses/Publish and the "Rules…" dialog in Russian), and it is
  tempting to translate the rule labels along with the panel. It cannot be
  done: the same component draws the rules console in the room itself, and
  the room is Russian throughout — from "Submit" to "Class ended".
  Translating only for the panel would give a rule two names — exactly what
  the paragraph above is about: a setting named differently in two places is
  two settings; translating together with the room would mean English rules
  in the middle of a Russian class.

  Hence the decision: the rule labels stay in the room's language, which
  means the panel's "Rules…" dialog stays ENTIRELY Russian — the heading, the
  warnings and "Done" around these rows (admin/screens/Seminars.svelte). The
  bilingualism of the seminar row menu (finding admin-17) is fixed there, not
  here. If the panel's language is one day chosen to be English, these rows
  will move to it only together with the room and in one piece: the labels
  themselves live in `lib/rule-rows.ts`, and here there is only the frame.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { RULE_ROWS, type LimitRow } from '@/lib/rule-rows'
  import type { OracleLimits, RoomRules } from '@shared/rules'

  interface Props {
    rules: RoomRules
    /** What changed — one key at a time, so the caller decides how to save it. */
    onchange: (patch: Partial<RoomRules>) => void
    /** A save is in flight: the switches must not lie about what has applied. */
    busy?: boolean
    /**
     * The instance's current ceilings — so that "as on the server" names a
     * number.
     *
     * Optional: a screen that has not asked for them yet (or has not waited
     * for them) draws the same two rows without the hint rather than hiding
     * the rule entirely.
     */
    instance?: OracleLimits | null
    /**
     * Whether the instance can give a personal notebook its own kernel.
     *
     * `true` by default, and that is not caution but the truth about an
     * ordinary install: a personal notebook has its own kernel everywhere
     * except the broker (k3s), where one Pod is created per class. There the
     * rule row says so BEFORE the teacher switches on, for their students,
     * notebooks that do not compute.
     */
    ownKernels?: boolean
    /**
     * What the class itself got — so that "as for the class" names a number.
     *
     * Optional: the room does not know its own resources (the teacher panel
     * computes them from the machine), and without them the row honestly
     * says "as for the class" without a figure. The ceiling comes from here
     * too: the browser does not know about docker's memory and should not —
     * a number out of bounds is refused by the server in words.
     */
    own?: { roomMemoryMb: number | null; roomCpus: number | null; maxMemoryMb: number | null; maxCpus: number | null } | null
  }

  let { rules, onchange, busy = false, instance = null, ownKernels = true, own = null }: Props = $props()

  /* -------------------------------------- personal notebook resources */

  const MB_IN_GB = 1024
  /**
   * A ladder, not an input field.
   *
   * The question here is not "exactly how many megabytes" but "how much to
   * hand out to students", and in real life it has five answers. An input
   * field would answer this question with an invitation to type 3.5 GB and a
   * server refusal in reply; a list — with two clicks and not one wrong
   * value.
   */
  const MEMORY_LADDER = [1, 2, 4, 8, 16, 32]
  const CPU_LADDER = [1, 2, 4, 8, 16]

  const gbOf = (mb: number): string => {
    const value = mb / MB_IN_GB
    return Number.isInteger(value) ? String(value) : value.toFixed(1)
  }
  const memoryChoices = $derived(
    MEMORY_LADDER.filter((gb) => own?.maxMemoryMb == null || gb * MB_IN_GB <= own.maxMemoryMb),
  )
  const cpuChoices = $derived(CPU_LADDER.filter((n) => own?.maxCpus == null || n <= own.maxCpus))
  /** The "as for the class" label: with the number when known, without when not. */
  const asClassMemory = $derived(
    own?.roomMemoryMb != null
      ? tr('room.rules.ownRes.asClassValue', {
          p0: tr('room.rules.ownRes.gb', { p0: gbOf(own.roomMemoryMb) }),
        })
      : tr('room.rules.ownRes.asClass'),
  )
  const asClassCpus = $derived(
    own?.roomCpus != null
      ? tr('room.rules.ownRes.asClassValue', {
          p0: tr('room.rules.ownRes.cores', { p0: String(own.roomCpus) }),
        })
      : tr('room.rules.ownRes.asClass'),
  )

  /** Ceiling fields, reset to the truth after a server refusal — see below. */
  let fields = $state<Record<string, HTMLInputElement | null>>({})

  /**
   * A save in flight — to tell its FALL from its rise, see the effect below.
   *
   * A plain `let`, not `$state`: this is the effect's memory of the previous
   * frame, there is nothing in the markup to read it, and a reactive one
   * would wake the effect itself.
   */
  let saving = false

  /**
   * The field shows what is written in the rules, not what failed to save.
   *
   * `commit` puts the number into the field before the PATCH — otherwise the
   * clamping ("500" → "200") is not visible. But if the PATCH failed, `rules`
   * do not change, Svelte does not rewrite the field (the `value` attribute
   * does nothing when the value is unchanged), and it keeps showing a
   * ceiling the room does not have. The fix is in place: `busy` is cleared on
   * success and on refusal alike, and checking against the rules row makes
   * the second case visible without touching the first.
   *
   * The key word is FALL. The caller raises `busy` synchronously, before the
   * request (`setRule` in SessionScreen and in admin/Seminars), so on the
   * rise `rules` are certainly the old ones: an effect firing on any change
   * of `busy` would wipe the number just typed for the whole round trip to
   * the server — a typed 500 under an "as on the server" ceiling would show
   * an empty field, that is, exactly the instance ceiling the field protects
   * against. So the check happens only once the save has ANSWERED.
   */
  $effect(() => {
    const answered = saving && !busy
    saving = busy
    if (!answered) return
    for (const row of RULE_ROWS) {
      if (row.kind !== 'limit') continue
      const field = fields[row.key]
      if (!field) continue
      const value = rules[row.key]
      const want = value === null || value === undefined ? '' : String(value)
      if (field.value !== want) field.value = want
    }
  })

  /**
   * The number is saved on leaving the field, not on every digit.
   *
   * One change is one PATCH for the whole room (see `setRule` in
   * SessionScreen), and "2" on the way to "20" is an extra rule that will
   * have time to reach the class and turn someone's question away.
   */
  /**
   * The number in force on the instance — and `undefined` when there is none.
   *
   * Not every number row asks the instance: the cell limit has no server
   * value, and an empty field there means "no limit", not "as on the
   * server". So the question is asked by a separate function, not by
   * indexing into `OracleLimits`: that type simply has no `cellLimitSec` key.
   */
  function atInstance(row: LimitRow): number | undefined {
    if (!instance) return undefined
    return (instance as unknown as Record<string, number | undefined>)[row.key]
  }

  function commit(row: LimitRow, field: HTMLInputElement): void {
    const current = rules[row.key]
    /*
     * Garbage in a number field is not "as on the server".
     *
     * For `<input type=number>` unparsable input ("5e", "--", "1.2.3") reads
     * as an EMPTY value: `field.value === ''`. The branch below took that for
     * a removed rule and reset the room's ceiling to the instance's — from a
     * single stray letter. `badInput` is the only thing that tells the two
     * cases apart.
     */
    if (field.validity.badInput) {
      field.value = current === null ? '' : String(current)
      return
    }
    const text = field.value.trim()
    if (!text) {
      if (current !== null) onchange({ [row.key]: null } as Partial<RoomRules>)
      return
    }
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) {
      // The field returns to the saved value: leaving garbage in it would
      // mean showing a rule that does not exist.
      field.value = current === null ? '' : String(current)
      return
    }
    const value = Math.min(Math.max(Math.round(parsed), row.min), row.max)
    field.value = String(value)
    if (value !== current) onchange({ [row.key]: value } as Partial<RoomRules>)
  }
</script>

<div class="flex flex-col">
  {#each RULE_ROWS as row (row.key)}
    <div
      class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line-soft py-3 last:border-b-0"
    >
      <div class="min-w-0 flex-1 basis-56">
        <p class="text-ui font-semibold text-ink">{row.title}</p>
        <p class="mt-0.5 text-2xs leading-snug text-muted">{row.note}</p>
        {#if row.kind === 'limit' && row.atInstance && atInstance(row) !== undefined}
          <p class="mt-0.5 text-2xs font-semibold leading-snug text-muted"> {tr('room.ui.5')} {row.atInstance(atInstance(row)!)}
          </p>
        {/if}
        <!--
          A caveat of the instance, not of the rule: on the broker a personal
          notebook has no kernel of its own, and running it is refused. Saying
          so here means telling the teacher before the class, not a student in
          the middle of it.
        -->
        {#if row.key === 'ownBooks' && !ownKernels}
          <p class="mt-0.5 text-2xs font-semibold leading-snug text-warning">{tr('room.rules.ownBooks.noKernel')}</p>
        {/if}
      </div>
      {#if row.kind === 'choice'}
        <!--
          Below 640 the switch stands as a full-width column.

          Three segments with `white-space: nowrap` are 311px (the Russian
          "Everyone · Add only · Teacher"), while on a 390px screen the row
          has 278 left: the group is `shrink-0`, and the right segment was cut
          off by the edge. There is nothing to shrink — the labels are the
          whole point of the button — so they stop sharing a line. The border
          between them is turned by the media rule below, in the same file
          and at the same threshold.
        -->
        <div
          class="flex shrink-0 border border-line max-[640px]:w-full max-[640px]:flex-col"
          role="group"
          aria-label={row.title}
        >
          {#each row.options as option (option.value)}
            <button
              type="button"
              class="rule-seg {rules[row.key] === option.value ? 'rule-seg-on' : ''}"
              aria-pressed={rules[row.key] === option.value}
              disabled={busy}
              onclick={() => onchange({ [row.key]: option.value } as Partial<RoomRules>)}
            >
              {option.label}
            </button>
          {/each}
        </div>
      {:else}
        <div class="flex shrink-0 items-center gap-2">
          <input
            bind:this={fields[row.key]}
            class="rule-num"
            type="number"
            inputmode="numeric"
            min={row.min}
            max={row.max}
            step="1"
            value={rules[row.key] ?? ''}
            placeholder={atInstance(row) !== undefined ? String(atInstance(row)) : '—'}
            aria-label={row.title}
            disabled={busy}
            onchange={(event) => commit(row, event.currentTarget)}
          />
          <span class="text-2xs font-semibold text-muted">{row.unit}</span>
          <!-- Empty is exactly "as on the server", but there is no need to
               clear the field by hand: the button appears only where there
               is something to remove. -->
          {#if rules[row.key] !== null}
            <button
              type="button"
              class="rule-clear"
              disabled={busy}
              onclick={() => onchange({ [row.key]: null } as Partial<RoomRules>)}
            > {tr('room.ui.6')} </button>
          {/if}
        </div>
      {/if}
    </div>
    <!--
      How much to hand out to students — right here, under the rule, and only
      when it is on.
      A person asks themselves "may they" and "how much" in a row, in one
      motion: they allow students their own notebooks and in the same second
      wonder whether those will take memory away from their own. A separate
      screen for the second question would mean that most people never answer
      it — and the "same amount" default costs the machine double.
    -->
    {#if row.key === 'ownBooks' && rules.ownBooks === 'on'}
      <div class="own-res">
        <p class="own-res-title">{tr('room.rules.ownRes.title')}</p>
        <div class="own-res-row">
          <label class="own-res-pick">
            <span class="own-res-label">{tr('room.rules.ownRes.memory')}</span>
            <select
              class="rule-pick"
              disabled={busy}
              value={rules.ownMemoryMb === null ? '' : String(rules.ownMemoryMb)}
              onchange={(event) =>
                onchange({
                  ownMemoryMb: event.currentTarget.value === '' ? null : Number(event.currentTarget.value),
                } as Partial<RoomRules>)}
            >
              <option value="">{asClassMemory}</option>
              {#each memoryChoices as gb (gb)}
                <option value={String(gb * MB_IN_GB)}>{tr('room.rules.ownRes.gb', { p0: String(gb) })}</option>
              {/each}
            </select>
          </label>
          <label class="own-res-pick">
            <span class="own-res-label">{tr('room.rules.ownRes.cpu')}</span>
            <select
              class="rule-pick"
              disabled={busy}
              value={rules.ownCpus === null ? '' : String(rules.ownCpus)}
              onchange={(event) =>
                onchange({
                  ownCpus: event.currentTarget.value === '' ? null : Number(event.currentTarget.value),
                } as Partial<RoomRules>)}
            >
              <option value="">{asClassCpus}</option>
              {#each cpuChoices as n (n)}
                <option value={String(n)}>{tr('room.rules.ownRes.cores', { p0: String(n) })}</option>
              {/each}
            </select>
          </label>
          <span class="own-res-gpu">{tr('room.rules.ownRes.noGpu')}</span>
        </div>
        <p class="own-res-note">{tr('room.rules.ownRes.note')}</p>
      </div>
    {/if}
  {/each}
</div>

<style>
  /*
   * The personal notebooks' resources block: nested, not one more rules row.
   *
   * The left indent and the thin line say whose it is: it is a detail of ONE
   * rule, and it appears only when the rule is on. As a row in the common
   * list it would read as the room's twelfth rule — and it is not a
   * permission but hardware.
   */
  .own-res {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-block: -4px 12px;
    padding: 12px 0 0 14px;
    border-left: 2px solid rgb(var(--line));
  }
  .own-res-title {
    font-size: 13px;
    font-weight: 700;
    color: rgb(var(--ink));
  }
  .own-res-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
  }
  .own-res-pick {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .own-res-label {
    font-size: 13px;
    font-weight: 600;
    color: rgb(var(--muted));
  }
  .own-res-gpu {
    font-size: 12px;
    font-weight: 600;
    color: rgb(var(--muted));
  }
  .own-res-note {
    font-size: 12px;
    line-height: 1.45;
    color: rgb(var(--muted));
  }
  /* The picker matches the number field beside it: same height, border and size. */
  .rule-pick {
    height: 32px;
    padding-inline: 8px;
    font-size: 14px;
    font-weight: 600;
    color: rgb(var(--ink));
    background: none;
    border: 1px solid rgb(var(--line));
  }
  .rule-pick:disabled {
    opacity: 0.5;
  }
  /* Phone: the same as for the segments — a finger, not a cursor. */
  @media (max-width: 640px) {
    .own-res-pick {
      width: 100%;
      justify-content: space-between;
    }
    .rule-pick {
      height: 44px;
      flex: 1 1 auto;
      min-width: 0;
    }
  }

  .rule-seg {
    height: 32px;
    padding-inline: 11px;
    /* A live rule must not be the smallest text on the screen — the same
       argument as for the "who runs" segment on the creation screen. */
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.03em;
    color: rgb(var(--muted));
    background: none;
    border: 0;
    border-right: 1px solid rgb(var(--line));
    white-space: nowrap;
    /* The ladder of speeds and curves (index.css) exists precisely so that no
       literal "100ms ease-out" stands here: colour answers the pointer and
       takes the built-in `ease`, shape answers the finger and takes
       --ease-out. */
    transition:
      background-color var(--speed-quick) ease,
      color var(--speed-quick) ease,
      transform var(--speed-press) var(--ease-out);
  }
  .rule-seg:last-child {
    border-right: 0;
  }
  .rule-seg:hover:not(:disabled) {
    color: rgb(var(--ink));
  }
  .rule-seg:active:not(:disabled) {
    transform: scale(0.97);
  }
  .rule-seg:disabled {
    opacity: 0.5;
  }
  .rule-seg-on {
    background: rgb(var(--primary));
    color: rgb(var(--primary-ink));
    font-weight: 700;
  }
  .rule-seg-on:hover {
    color: rgb(var(--primary-ink));
  }
  .rule-seg:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px rgb(var(--accent) / 0.5);
  }

  /*
   * Phone: the segments stand in a column, divided by a bottom border rather
   * than a right one.
   *
   * The threshold is the same as `max-[640px]:flex-col` on the group — and it
   * must be the same: a column with right borders draws a vertical line down
   * the right edge, and a row with bottom borders a strip under each button.
   * The height grows too: 32px is a cursor's measure, and this switch is
   * pressed with a finger, in the room too, from a tablet.
   */
  @media (max-width: 640px) {
    .rule-seg {
      height: 44px;
      text-align: left;
      border-right: 0;
      border-bottom: 1px solid rgb(var(--line));
    }
    .rule-seg:last-child {
      border-bottom: 0;
    }
  }

  /* The number field matches the switch next to it: one height, one border,
     one font size, so that two rows out of eleven do not look foreign. */
  .rule-num {
    width: 4.5rem;
    height: 32px;
    padding-inline: 8px;
    font-size: 14px;
    font-weight: 600;
    text-align: right;
    color: rgb(var(--ink));
    background: none;
    border: 1px solid rgb(var(--line));
    appearance: textfield;
  }
  /* An empty field shows the instance's number in grey: "as on the server" is
     a value, not the absence of one. */
  .rule-num::placeholder {
    color: rgb(var(--muted));
    font-weight: 600;
    opacity: 0.7;
  }
  /* The arrows eat half the width and change the number bypassing the save. */
  .rule-num::-webkit-outer-spin-button,
  .rule-num::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .rule-num:disabled {
    opacity: 0.5;
  }
  .rule-num:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px rgb(var(--accent) / 0.5);
  }
  /* A text action still needs a readable label and a full click target. */
  .rule-clear {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    font-size: 13px;
    font-weight: 600;
    color: rgb(var(--muted));
    background: none;
    border: 0;
    padding: 4px 0;
    text-decoration: underline;
    text-underline-offset: 3px;
    white-space: nowrap;
    transition:
      color var(--speed-quick) ease,
      transform var(--speed-press) var(--ease-out);
  }
  .rule-clear:active:not(:disabled) {
    transform: scale(0.97);
  }
  .rule-clear:hover:not(:disabled) {
    color: rgb(var(--ink));
  }
  .rule-clear:disabled {
    opacity: 0.5;
  }
  .rule-clear:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgb(var(--accent) / 0.5);
  }
</style>
