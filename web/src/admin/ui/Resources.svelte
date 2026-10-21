<script lang="ts">
  /**
   * How much of the machine this room gets.
   *
   * On 13 Sep 2026 a seminar's kernel was killed for memory sixteen times in
   * a row. There was one limit for all rooms, it lived in an environment
   * variable and was shown nowhere in the product: the teacher saw "the
   * kernel restarted" on the same cell and had neither a number nor a knob.
   * Here there are both the number and the knob.
   *
   * This screen's honesty rule (see the header of NewSeminar.svelte) holds
   * here too, so memory and cores are fields, and the GPU is a line. cgroup
   * does not limit video memory at all: rooms share the whole card, and
   * drawing a field next to it would promise a limit that does not exist.
   *
   * Cores have their own caveat, and it is said out loud under the field:
   * `docker update` changes a live container's CPU share right away, but the
   * number of numpy and torch threads is computed ONCE, when the interpreter
   * starts — so an already running kernel keeps computing with the old
   * number until a restart.
   *
   * One component for both doors — the new class form and an existing
   * class's settings. A setting that is named differently and computed
   * differently in two places is two settings.
   *
   * Where it runs (classes on machines, Paper 18 · Z4) is drawn here too,
   * under the numbers, for the same reason: the presets, the three parts
   * (class notebooks, personal notebooks, the council), what happens without
   * a machine and when one disappears, the council's two numbers, the live
   * line of machines that fit, and the refusals that keep a class here. A
   * teacher whom the owner's switch keeps out reads it greyed, with why.
   */
  import { formatDate, tr } from '@shared/i18n'
  import Check from '@/admin/ui/Check.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import Skeleton from '@/components/ui/Skeleton.svelte'
  import { cn } from '@/lib/utils'
  import { CLASS_PLACEMENT_BOUNDS, CLASS_PLACEMENT_PRESETS, COUNCIL_POOL, type ClassNumberBounds, type ClassPlacement, type InstanceResources } from '@shared/admin'
  import type { ClassPlacementOutlook } from '@shared/remote-admin'
  import { outlookLine, placementRefusal, presetOf, presetWords, presetsFor, refusalLocks } from '@/admin/runners'

  interface Props {
    /** What the machine reported; null — not arrived yet or not asked. */
    resources: InstanceResources | null
    /**
     * The machine's answer is still on its way.
     *
     * Tells "don't know yet" from "asked and did not find out", and the
     * difference is not academic: `null` here used to serve both cases, so on
     * the first frames the section showed an EMPTY memory field — enabled,
     * ready to type into — and half a second later the number arrived and
     * wiped what had been typed. While the answer is on its way, placeholders
     * of exactly the fields' size stand in their place.
     */
    loading?: boolean
    /** The chosen environment: the default and the need for a GPU depend on it. */
    environment: string
    /** What is set for the room, in megabytes; null — "same as the environment". */
    memoryMb: number | null
    /** The number went out. `null` returns the room to the environment's default. */
    onmemory: (mb: number | null) => void
    /** How many cores are set for the room; null — "same as the instance". */
    cpus: number | null
    /** The cores went out. `null` returns the room to the instance's default. */
    oncpus: (cores: number | null) => void
    /** Request in flight — the field is not touched, so as not to outrun the answer. */
    busy?: boolean
    /** The server's refusal, if any: printed under the field, not off to the side. */
    refusal?: string | null
    /** Whose form this is; absent — a new class that has no kernel yet. */
    roomId?: string | null
    /**
     * The bounds the server holds this class's memory and cores to now, by
     * where its slots compute (the seminar's `bounds`, remote-classes.md
     * §6.2): the machines' line under the numbers, and whether this server's
     * free memory is the class's concern at all, come from them, never from a
     * copy of the rule here. Absent — a new class, or a server that does not
     * say: no machines' line, and the free-memory warning as before machines.
     */
    bounds?: ClassNumberBounds | null
    /**
     * The personal notebooks are set right below this component (the creation
     * form's OwnNotebooks), so the hint that sends the teacher to the rules
     * list for them would point at a row that is no longer there.
     */
    ownBelow?: boolean
    /**
     * Where it runs (Z4): the class's setting, every field filled. Absent —
     * the block is not drawn (a server from before classes).
     */
    placement?: ClassPlacement | null
    /**
     * Whether the viewer may change it: the owner, a teacher while the owner's
     * switch is on (D4). Only the right: false prints the owner's-switch line
     * and hides the presets (Z4), so a save in flight is `placementBusy`.
     */
    placementEditable?: boolean
    /** A change of where it runs is on its way (or the form can no longer send one): the block's controls wait. */
    placementBusy?: boolean
    /** A part of the setting changed: the existing class saves it at once, the new form keeps it for the creation. */
    onplacement?: (patch: Partial<ClassPlacement>) => void
    /** The live line's answer; null — not asked (a new class has no slot to ask about) or not read yet. */
    outlook?: ClassPlacementOutlook | null
    /** The viewer is the owner: the way to Resources under the no-machines refusal is theirs. */
    owner?: boolean
    /** The new form's way to its environment (Change environment); null — the class's environment is fixed. */
    onenvironment?: (() => void) | null
    /** The setting's own refusal, printed under the block. */
    placementRefusal?: string | null
    /**
     * What to draw: the numbers and the block under them (`all`, the class
     * dialog), or one of the two where the page gives each a section of its
     * own (the new class form: Resources, then Where it runs).
     */
    part?: 'all' | 'numbers' | 'placement'
  }

  let {
    resources,
    loading = false,
    environment,
    memoryMb,
    onmemory,
    cpus,
    oncpus,
    busy = false,
    refusal = null,
    roomId = null,
    bounds = null,
    ownBelow = false,
    placement = null,
    placementEditable = false,
    placementBusy = false,
    onplacement,
    outlook = null,
    owner = false,
    onenvironment = null,
    placementRefusal: placementError = null,
    part = 'all',
  }: Props = $props()

  /* ----------------------------------------------------- where it runs */

  /** The class's room needs a card: the environment says so in its own file. */
  const gpuClass = $derived(resources?.kernel.perEnvironment[environment]?.gpu ?? false)
  /** Why the class can run only here, which greys On machines (admin/runners.ts · placementRefusal). */
  const placeRefusal = $derived(
    placement ? placementRefusal(outlook, { gpu: gpuClass, homeCards: resources?.gpus.length ?? 0, room: placement.room }) : null,
  )
  const locked = $derived(refusalLocks(placeRefusal))
  /** May the viewer press anything in the block: their right, and nothing in flight. */
  const placeable = $derived(placementEditable && !busy && !placementBusy && onplacement !== undefined)
  const tile = $derived(placement ? presetOf(placement, gpuClass) : null)
  const live = $derived(outlook ? outlookLine(outlook) : null)
  /** The seconds and the attempt memory as typed, while typed. */
  let secondsText = $state<string | null>(null)
  let attemptText = $state<string | null>(null)
  let workersText = $state<string | null>(null)

  function place(patch: Partial<ClassPlacement>): void {
    if (!placeable || !onplacement) return
    onplacement(patch)
  }

  /** A whole number typed into one of the block's fields, within its bounds; null — not one. */
  function wholeIn(text: string, bounds: { min: number; max: number }): number | null {
    const value = Math.round(Number(text.replace(',', '.').trim()))
    return Number.isFinite(value) && text.trim() !== '' ? Math.min(Math.max(value, bounds.min), bounds.max) : null
  }

  function commitSeconds(): void {
    const value = secondsText === null ? null : wholeIn(secondsText, CLASS_PLACEMENT_BOUNDS.failoverSec)
    secondsText = null
    if (value !== null && placement && value !== placement.failoverSec) place({ failoverSec: value, failover: 'auto' })
  }

  function commitAttempt(): void {
    const gb = attemptText === null ? null : Number(attemptText.replace(',', '.').trim())
    attemptText = null
    if (gb === null || !Number.isFinite(gb) || gb <= 0 || !placement) return
    const mb = Math.min(Math.max(Math.round(gb * 1024), CLASS_PLACEMENT_BOUNDS.attemptMb.min), CLASS_PLACEMENT_BOUNDS.attemptMb.max)
    if (mb !== placement.attemptMb) place({ attemptMb: mb })
  }

  function commitWorkers(): void {
    const value = workersText === null ? null : wholeIn(workersText, CLASS_PLACEMENT_BOUNDS.workers)
    workersText = null
    if (value !== null && placement && value !== placement.workers) place({ workers: value })
  }

  const MB_IN_GB = 1024

  /** THIS environment's default; the general one if the environment is unknown. */
  const defaultMb = $derived(
    resources?.kernel.perEnvironment[environment]?.memoryMb ??
      (resources ? resources.kernel.defaultMemoryMb : null),
  )

  /** Does the chosen environment ask for a GPU — by its own file, not by name. */
  const usesGpu = $derived(resources?.kernel.perEnvironment[environment]?.gpu ?? false)

  /** What the room will really get: its own number or the environment's default. */
  const effectiveMb = $derived(memoryMb ?? defaultMb ?? 0)

  /** The instance's default for cores; it does not depend on the environment. */
  const defaultCores = $derived(resources?.kernel.defaultCpus ?? null)
  /** How many cores the room will really get. */
  const effectiveCores = $derived(cpus ?? defaultCores ?? 0)

  /*
   * The field holds ITS OWN string, not one derived from the number.
   *
   * While a person erases "6" to type "12", the value passes through an
   * empty string and through "1". Computing megabytes from those and sending
   * them up would mean sending, on every keystroke, a request with a number
   * nobody wanted — and on "1" also getting a "less than 512 MB" refusal. So
   * the field lives its own life, and only what makes sense goes up.
   */
  let typed = $state('')
  let editing = $state(false)

  const shown = $derived(editing ? typed : gb(effectiveMb))

  function gb(mb: number): string {
    if (!mb) return ''
    const value = mb / MB_IN_GB
    // "6", not "6.0": halves are this field's step, tenths are not.
    return Number.isInteger(value) ? String(value) : value.toFixed(1)
  }

  /** Screen gigabytes to the seminar row's megabytes, in multiples of half a GB. */
  function toMb(text: string): number | null {
    const value = Number(text.replace(',', '.').trim())
    if (!Number.isFinite(value) || value <= 0) return null
    return Math.round((value * MB_IN_GB) / 512) * 512
  }

  function commit(): void {
    editing = false
    const mb = toMb(typed)
    // Empty means "same as the environment": that is how a room is returned
    // to the default, without inventing a second switch next to the field.
    if (typed.trim() === '') {
      if (memoryMb !== null) onmemory(null)
      return
    }
    if (mb === null || mb === memoryMb) return
    onmemory(mb)
  }

  /* Cores work the same way as memory: the field has its own string, and only
     what makes sense goes up. An integer, rounded down: docker understands a
     fractional `--cpus`, but numpy threads do not, and the number in the
     field must be the same one that goes to both. */
  let typedCores = $state('')
  let editingCores = $state(false)
  const shownCores = $derived(editingCores ? typedCores : effectiveCores ? String(effectiveCores) : '')

  function commitCores(): void {
    editingCores = false
    if (typedCores.trim() === '') {
      if (cpus !== null) oncpus(null)
      return
    }
    const value = Math.floor(Number(typedCores.replace(',', '.').trim()))
    if (!Number.isFinite(value) || value <= 0 || value === cpus) return
    oncpus(value)
  }

  /* ----------------------------------------------------------------- bar */

  const totalMb = $derived(resources?.memory.totalMb ?? 0)
  /** The machine share the room asks for. No hundredths: it is a bar, not a number. */
  const share = $derived(totalMb > 0 ? Math.min(1, effectiveMb / totalMb) : 0)
  /*
   * Red — when the room asks for more than is FREE on the machine.
   *
   * Not a ban: free memory changes between opening the form and the class,
   * someone else's room gets closed, its container removed. But taking eight
   * gigabytes where two are free is a kernel that will not start, and it is
   * better to learn that now than from the first Run in class.
   *
   * `null` means "free is unknown" (macOS without docker: there is no
   * MemAvailable there), and then there is no warning at all. There used to
   * be `os.freemem()` in its place, which on a Mac is always near zero, and
   * the section went red at any limit — scaring people exactly where there
   * was nothing to fear.
   */
  /*
   * A live room already holds its memory — it asks only for the increase.
   *
   * On k3s and under colima "free" means NOT yet promised, and what was
   * promised to this very room has already been subtracted from it. Without
   * the correction a running class's settings went red on their own: an
   * 8 GB Pod on a 16 GB node "asked for more than is free" (16 − 1 − 8 = 7)
   * — exactly when the teacher came to raise the memory in the middle of a
   * class.
   */
  /** This class's row in the census of rooms — both containers are taken from it. */
  const row = $derived(
    (roomId && resources?.rooms.find((one) => one.id === roomId)) || null,
  )
  /**
   * The class's second container — the one where students' personal
   * notebooks run.
   *
   * `null` — there is none right now: no personal notebooks were opened,
   * they are not allowed, or this is not the docker backend. Then the
   * section looks exactly as before.
   */
  const ownRoom = $derived(row?.own ?? null)
  /*
   * The machine holds BOTH containers, not one.
   *
   * Otherwise "free" would lie precisely in a class with personal notebooks:
   * their container with the same memory already stands on the machine, and
   * the room's increase would be counted from a number that leaves it out.
   */
  const heldMb = $derived(
    !row?.alive ? 0 : row.memoryMb + (ownRoom?.memoryMb ?? 0),
  )
  /*
   * Not for a class none of whose slots this number reaches can compute here,
   * as the server says (`bounds.memory.here`): what this server has free says
   * nothing of a kernel over there, and the bound that holds it is the
   * machines' line below.
   */
  const tight = $derived(
    resources !== null &&
      bounds?.memory.here !== false &&
      resources.memory.availableMb !== null &&
      effectiveMb - heldMb > resources.memory.availableMb &&
      effectiveMb > 0,
  )

  /** The share of the machine's CPU the room asks for. */
  const cpuShare = $derived(
    resources && resources.cpus > 0 ? Math.min(1, effectiveCores / resources.cpus) : 0,
  )

  const asGb = (mb: number): string => {
    const value = mb / MB_IN_GB
    return Number.isInteger(value) ? String(value) : value.toFixed(1)
  }

  /*
   * The machines' bound (remote-classes.md §6.2), as the server holds the
   * class's numbers: a slot set to machines is held to the biggest machine
   * that can take it, not to this server, and the server refuses past it by
   * name. Said under the numbers for each number whose bound is a machine's;
   * nothing when both are this server's (the tighter of the two for a class
   * notebook here), or when the server did not say.
   */
  const machineBound = $derived.by((): string | null => {
    if (!bounds) return null
    const { memory, cpus: cores } = bounds
    const gb = asGb(memory.max)
    if (memory.machine !== null && cores.machine !== null) {
      return memory.machine === cores.machine
        ? tr('admin.resources.machinesBound', { p0: gb, p1: String(cores.max), p2: memory.machine })
        : tr('admin.resources.machinesBoundTwo', { p0: gb, p1: memory.machine, p2: String(cores.max), p3: cores.machine })
    }
    if (memory.machine !== null) return tr('admin.resources.machinesBoundMemory', { p0: gb, p1: memory.machine })
    if (cores.machine !== null) return tr('admin.resources.machinesBoundCores', { p0: String(cores.max), p1: cores.machine })
    return null
  })

  /**
   * Asked — and did not find out.
   *
   * Then there will never be hints, a bar or the environment's default, and
   * there is nothing to wait for: the fields show what is set for the ROOM,
   * and a line below says why the machine's numbers are missing next to
   * them. An empty field here means "take the default", and the placeholder
   * inside the field says so: a silent empty frame in its place read as
   * "zero gigabytes".
   */
  const unreadable = $derived(!resources && !loading)

  /*
   * The placeholder sizes are not eyeballed.
   *
   * A placeholder goes exactly where the real element will stand half a
   * second later, and its point is that the section does not jump when the
   * numbers arrive. So the heights here are not invented but taken from the
   * real section in a browser: the field is the panel's 40 pixels (index.css ·
   * .admin-affix), a hint line (.admin-meta, 14/20 in the panel) is 20.
   * Computing them from the tokens on paper did not work: at 11px the line
   * height rounds differently from how it multiplies, and the section
   * drifted by a pixel. If the font size or the padding changes, these
   * numbers get re-measured.
   */
  const FIELD_H = '40px'
  const HINT_LINE = 20
</script>

{#snippet hintLines(widths: string[])}
  <!-- A paragraph of N lines takes N line heights, and the bars themselves are
       thinner: letters do not fill a line entirely. The container holds the
       height, and the bars inside are simply spread to the edges. -->
  <div
    class="flex flex-col justify-between"
    style:height="{(widths.length * HINT_LINE).toFixed(2)}px"
    aria-hidden="true"
  >
    {#each widths as width, i (i)}
      <Skeleton {width} height="0.5rem" />
    {/each}
  </div>
{/snippet}

<div class="flex flex-col gap-3">
  {#if part !== 'placement'}
  {#if loading}
    <!--
      The numbers are still on their way.

      The section is drawn whole — field, bar, hint, second field — because in
      a moment exactly that will stand here. Showing an empty field instead
      would invite typing into it a moment before the server's answer wipes
      what was typed.
    -->
    <div role="status" aria-label={tr('admin.resources.reading')} aria-busy="true" class="contents">
      <span class="sr-only">{tr('admin.resources.reading')}</span>
      <Skeleton width="200px" height={FIELD_H} radius="0" />
      <Skeleton width="200px" height="4px" radius="0" />
      {@render hintLines(['72%'])}

      <div class="flex flex-col gap-3 border-t border-line-soft pt-4">
        <Skeleton width="200px" height={FIELD_H} radius="0" />
        <Skeleton width="200px" height="4px" radius="0" />
        {@render hintLines(['96%', '52%'])}
      </div>

      <!--
        The GPU is two lines, as it really has: the model with its video
        memory, and the caveat that everyone shares the video memory.

        The only spot in the section where the placeholder GUESSES: how many
        GPUs the machine has — zero or four — nobody knows before the answer.
        The bet is on a machine with a GPU, because that is what this product
        is run for; on a machine without one both lines will not appear, and
        this is the only piece of the section that will collapse there.
      -->
      <div class="flex flex-col gap-1.5 border-t border-line-soft pt-3">
        {@render hintLines(['78%'])}
        {@render hintLines(['88%'])}
      </div>
    </div>
  {:else}
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <!-- The shared prefixed field with the unit inside, as on the Resources
           tab: the number and what it counts are one control. -->
      <div class="admin-affix w-[200px] gap-2">
        <input
          type="number"
          min="0.5"
          step="0.5"
          inputmode="decimal"
          disabled={busy}
          class="placeholder:font-sans"
          aria-label={tr('admin.resources.memoryLabel')}
          placeholder={unreadable ? tr('admin.resources.asDefault') : ''}
          value={shown}
          oninput={(event) => {
            editing = true
            typed = event.currentTarget.value
          }}
          onblur={commit}
          onkeydown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        <span class="shrink-0 text-2xs text-muted">{tr('admin.resources.gb')}</span>
      </div>
      {#if memoryMb !== null && defaultMb !== null}
        <!-- Back to the environment's value with one press: otherwise "as it
             was" has to be typed as a number, peeking at it in the hint
             below. -->
        <button
          type="button"
          class="admin-link"
          disabled={busy}
          onclick={() => {
            editing = false
            onmemory(null)
          }}
        >
          {tr('admin.resources.useDefault')}
        </button>
      {/if}
    </div>

    {#if resources}
      <!-- The bar: what share of the machine this room asks for. A number
           next to it would be redundant — it is in the field above. -->
      <div class="flex h-1 w-full max-w-[200px] bg-line-soft" aria-hidden="true">
        <div
          class={cn('h-full transition-[width] duration-[var(--speed-quick)] ease-out', tight ? 'bg-warning' : 'bg-accent')}
          style="width: {(share * 100).toFixed(1)}%"
        ></div>
      </div>

      <!--
        Three captions under the field — because there can be two machines
        under a room.

        Under colima and Docker Desktop the containers live in a VM with its
        own memory, and "the machine has 36 GB" on a Mac was plainly untrue:
        only twelve of it can be handed out. When the numbers came from the
        daemon, that is what it says. When free memory is unknown (macOS
        without docker), we say nothing about it — rather than print
        `freemem`, which is always near zero there.
      -->
      <p class="admin-meta">
        {#if resources.memory.availableMb === null}
          {tr('admin.resources.hintNoFree', {
            p0: asGb(resources.memory.totalMb),
            p1: environment || tr('admin.resources.thisEnvironment'),
            p2: asGb(defaultMb ?? resources.kernel.defaultMemoryMb),
          })}
        {:else if resources.memory.source === 'docker'}
          {tr('admin.resources.hintDocker', {
            p0: asGb(resources.memory.totalMb),
            p1: asGb(resources.memory.availableMb),
            p2: environment || tr('admin.resources.thisEnvironment'),
            p3: asGb(defaultMb ?? resources.kernel.defaultMemoryMb),
          })}
        {:else}
          {tr('admin.resources.hint', {
            p0: asGb(resources.memory.totalMb),
            p1: asGb(resources.memory.availableMb),
            p2: environment || tr('admin.resources.thisEnvironment'),
            p3: asGb(defaultMb ?? resources.kernel.defaultMemoryMb),
          })}
        {/if}
      </p>

      <!--
        About the second container — right under the field, not only in the
        line below.

        The line below shows the numbers of a LIVE class; it appears when the
        container is already standing. But knowing that the field above costs
        the machine twice as much is needed BEFORE it is raised: the number is
        chosen once, and it is chosen here.
      -->
      {#if !ownBelow}
        <p class="admin-meta">{tr('admin.resources.ownHint')}</p>
      {/if}

      <!--
        The class's second container — as a line, not as an addition to the
        number above.

        Students' personal notebooks run separately, with their own memory
        limit and their own CPU (server/src/kernel/pool.ts · KernelRole).
        Adding them to the room in one number would promise the teacher
        memory that none of their Pythons will get; staying silent would not
        say that the machine holds twice as much. So both numbers are named,
        and the line appears only when the second container really exists.
      -->
      {#if ownRoom}
        <p class="admin-meta flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span class="font-semibold text-ink">{tr('admin.resources.ownRow')}</span>
          <span>{tr('admin.resources.ownRoom', { p0: asGb(row?.memoryMb ?? 0), p1: String(row?.cpus ?? 0) })}</span>
          <span aria-hidden="true">·</span>
          <span>{tr('admin.resources.ownBooks', { p0: asGb(ownRoom.memoryMb), p1: String(ownRoom.cpus) })}</span>
        </p>
      {/if}

      {#if tight}
        <p class="flex items-start gap-2 text-micro text-warning">
          <Icon name="alert" size={13} class="mt-px shrink-0" />
          <span>{tr('admin.resources.overFree')}</span>
        </p>
      {/if}

      {#if refusal}
        <p class="text-ui text-danger" role="alert">{refusal}</p>
      {/if}

      <!--
        The CPU is the second field, and it works like the first.

        Whole cores, because the number from this field goes to two different
        things at once: docker's `--cpus` (which understands fractions too)
        and OMP/MKL/OPENBLAS/NUMEXPR inside the container (which take only
        integers). Showing "1.5" and silently rounding one of the two would
        once again split word from deed.
      -->
      <div class="flex flex-col gap-3 border-t border-line-soft pt-4">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {@render cpuField()}
        </div>

        <div class="flex h-1 w-full max-w-[200px] bg-line-soft" aria-hidden="true">
          <div
            class="h-full bg-accent transition-[width] duration-[var(--speed-quick)] ease-out"
            style="width: {(cpuShare * 100).toFixed(1)}%"
          ></div>
        </div>

        <!-- Cores follow the same rule as memory: docker's VM has its own
             share of them ("--cpu 10" out of twelve), and they are named
             after it. -->
        <p class="admin-meta">
          {#if resources.memory.source === 'docker'}
            {tr('admin.resources.cpuHintDocker', {
              p0: resources.cpus,
              p1: defaultCores ?? resources.kernel.defaultCpus,
            })}
          {:else}
            {tr('admin.resources.cpuHint', {
              p0: resources.cpus,
              p1: defaultCores ?? resources.kernel.defaultCpus,
            })}
          {/if}
        </p>
        {#if machineBound}
          <!-- The numbers above are this server's; a slot on machines is held to theirs. -->
          <p class="admin-meta">{machineBound}</p>
        {/if}
      </div>

      <!-- The GPU as a line, because that is what it is: there is nothing to
           set it with for this room, but you need to know what it will run
           on. -->
      <div class="flex flex-col gap-1.5 border-t border-line-soft pt-3">
        {#if resources.gpus.length > 0}
          {@const card = resources.gpus[0]}
          <p class="admin-meta">
            <span class="font-semibold text-ink">GPU:</span>
            {card.name}, {asGb(card.memoryMb)} {tr('admin.resources.gb')}{resources.gpus.length > 1
              ? tr('admin.resources.moreCards', { p0: resources.gpus.length - 1 })
              : ''}
            ·
            {usesGpu ? tr('admin.resources.envUsesGpu') : tr('admin.resources.envNoGpu')}
          </p>
          <p class="admin-meta">{tr('admin.resources.vramShared')}</p>
        {/if}
      </div>
    {:else}
      <!--
        The machine did not answer. The fields keep working — a room's memory
        is set blind too, and that is exactly what people come here for in the
        middle of a class — but there are no numbers next to them and there
        will be none, and that is said in one line rather than with emptiness.
      -->
      <div class="flex flex-col gap-3 border-t border-line-soft pt-4">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {@render cpuField()}
        </div>
      </div>

      {#if refusal}
        <p class="text-ui text-danger" role="alert">{refusal}</p>
      {/if}

      <p class="admin-meta">{tr('admin.resources.unreadable')}</p>
    {/if}
  {/if}

  {/if}

  {#if part !== 'numbers' && placement && !loading}
    {@render whereItRuns(placement)}
  {/if}
</div>

<!--
  Where it runs (Paper 18 · Z4): presets on top, the parts below, then what
  happens without a machine and when one disappears, the council's two
  numbers while it is on machines, and the live line — or the refusal that
  takes its place and greys On machines. Tiles in a row from 720 px of its
  own width, a radio list below (the 640 px class dialog and the phone, Z10).
  The council's part and its numbers come with its pool (COUNCIL_POOL, 0.26):
  "In the shared kernel" is the notebook's kernel, one attempt after
  another, "On machines" the class's pool of workers on a machine.
-->
{#snippet whereItRuns(current: ClassPlacement)}
  <section
    class={cn('pl flex flex-col gap-4', part === 'all' && 'mt-2 border-t border-line-soft pt-5')}
    aria-label={tr('admin.placement.title')}
  >
    {#if part === 'all'}
      <!-- In the class dialog the block is a part of Resources; the new form gives it a section of its own, with this heading. -->
      <div>
        <h4 class="text-ui font-semibold text-ink">{tr('admin.placement.title')}</h4>
        <p class="admin-meta mt-1">{tr('admin.placement.note')}</p>
      </div>
    {/if}

    {#if placementEditable}
      <!-- The presets are a way to change it: a teacher whom the owner's switch keeps out reads the parts, not them (Z4). -->
      <div class="pl-presets" role="radiogroup" aria-label={tr('admin.placement.presets')}>
        {#each presetsFor(gpuClass) as preset (preset)}
          {@const words = presetWords(preset)}
          {@const on = tile === preset}
          <button
            type="button"
            role="radio"
            aria-checked={on}
            disabled={!placeable || (locked && preset !== 'home')}
            class={cn('pl-preset', on && 'pl-preset-on')}
            onclick={() => place({ ...CLASS_PLACEMENT_PRESETS[preset] })}
          >
            <span class="pl-dot" aria-hidden="true"></span>
            <span class="min-w-0">
              <span class="block text-ui font-semibold">{words.name}</span>
              <span class="pl-preset-note mt-0.5 block text-2xs">{words.note}</span>
            </span>
          </button>
        {/each}
      </div>
    {/if}

    <div class="flex flex-col bg-surface">
      {#each [
        { key: 'room' as const, title: tr('admin.placement.room'), note: tr('admin.placement.roomNote'), here: tr('admin.placement.here') },
        { key: 'own' as const, title: tr('admin.placement.own'), note: tr('admin.placement.ownNote'), here: tr('admin.placement.here') },
        { key: 'council' as const, title: tr('admin.placement.council'), note: tr('admin.placement.councilNote'), here: tr('admin.placement.shared') },
      ].filter((one) => COUNCIL_POOL || one.key !== 'council') as part (part.key)}
        {@const onMachines = current[part.key] === 'machines'}
        <div class="pl-part border-b border-line-soft px-3.5 py-3 last:border-b-0">
          <div class="min-w-0">
            <p class="text-ui font-semibold text-ink">{part.title}</p>
            <p class="admin-meta mt-0.5">{part.note}</p>
          </div>
          <div class="pl-seg text-2xs" role="group" aria-label={part.title}>
            <button
              type="button"
              aria-pressed={!onMachines}
              disabled={!placeable}
              class={cn('pl-seg-btn', !onMachines && 'pl-seg-on')}
              onclick={() => place(part.key === 'council' ? { council: 'shared' } : { [part.key]: 'home' })}
            >{part.here}</button>
            <button
              type="button"
              aria-pressed={onMachines}
              disabled={!placeable || locked}
              class={cn('pl-seg-btn', onMachines && 'pl-seg-on')}
              onclick={() => place({ [part.key]: 'machines' })}
            >{tr('admin.placement.machines')}</button>
          </div>
        </div>
      {/each}
    </div>

    <div class="pl-fields">
      <div class="min-w-0">
        <label class={cn('flex min-h-10 items-center gap-2.5 max-[640px]:min-h-11', placeable && 'cursor-pointer')}>
          <Check checked={current.fallback} disabled={!placeable} onchange={(on) => place({ fallback: on })} />
          <span class="text-ui text-ink">{tr('admin.placement.fallback')}</span>
        </label>
        <p class="admin-meta mt-1">{tr('admin.placement.fallbackNote')}</p>
      </div>
      <div class="min-w-0">
        <p class="admin-label mb-1.5">{tr('admin.placement.failover')}</p>
        <div class="pl-seg pl-seg-wide text-2xs" role="group" aria-label={tr('admin.placement.failover')}>
          <span class={cn('pl-seg-btn gap-1.5', current.failover === 'auto' && 'pl-seg-on')}>
            <button type="button" class="contents" aria-pressed={current.failover === 'auto'} disabled={!placeable} onclick={() => place({ failover: 'auto' })}>
              {tr('admin.placement.failoverAuto')}
            </button>
            <input
              class="pl-seconds"
              inputmode="numeric"
              autocomplete="off"
              aria-label={tr('admin.placement.failoverAuto')}
              disabled={!placeable}
              value={secondsText ?? String(current.failoverSec)}
              oninput={(event) => (secondsText = event.currentTarget.value)}
              onblur={commitSeconds}
              onkeydown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
            <span>{tr('admin.placement.seconds')}</span>
          </span>
          <button
            type="button"
            aria-pressed={current.failover === 'wait'}
            disabled={!placeable}
            class={cn('pl-seg-btn', current.failover === 'wait' && 'pl-seg-on')}
            onclick={() => place({ failover: 'wait' })}
          >{tr('admin.placement.failoverWait')}</button>
        </div>
        <p class="admin-meta mt-1">{tr('admin.placement.failoverNote')}</p>
      </div>

      {#if COUNCIL_POOL && current.council === 'machines'}
        <!-- The council's two numbers (Z4): only while it is on machines, where its pool's workers take them. -->
        <div class="min-w-0">
          <p class="admin-label mb-1.5">{tr('admin.placement.workers')}</p>
          <div class="pl-seg pl-seg-wide text-2xs" role="group" aria-label={tr('admin.placement.workers')}>
            <button
              type="button"
              aria-pressed={current.workers === 'auto'}
              disabled={!placeable}
              class={cn('pl-seg-btn', current.workers === 'auto' && 'pl-seg-on')}
              onclick={() => place({ workers: 'auto' })}
            >{tr('admin.placement.workersAuto')}</button>
            {#if current.workers === 'auto'}
              <button
                type="button"
                aria-pressed="false"
                disabled={!placeable}
                class="pl-seg-btn"
                onclick={() => place({ workers: 8 })}
              >{tr('admin.placement.workersCustom')}</button>
            {:else}
              <span class="pl-seg-btn pl-seg-on gap-1.5">
                <input
                  class="pl-seconds"
                  inputmode="numeric"
                  autocomplete="off"
                  aria-label={tr('admin.placement.workersCustom')}
                  disabled={!placeable}
                  value={workersText ?? String(current.workers)}
                  oninput={(event) => (workersText = event.currentTarget.value)}
                  onblur={commitWorkers}
                  onkeydown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                />
              </span>
            {/if}
          </div>
          <p class="admin-meta mt-1">{tr('admin.placement.workersNote')}</p>
        </div>
        <div class="min-w-0">
          <label for="placement-attempt" class="admin-label mb-1.5 block">{tr('admin.placement.attemptMb')}</label>
          <div class="admin-affix w-[200px] max-w-full gap-2">
            <input
              id="placement-attempt"
              inputmode="decimal"
              autocomplete="off"
              disabled={!placeable}
              value={attemptText ?? String(Math.round((current.attemptMb / 1024) * 10) / 10)}
              oninput={(event) => (attemptText = event.currentTarget.value)}
              onblur={commitAttempt}
              onkeydown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
            <span class="shrink-0 text-2xs text-muted">{tr('admin.placement.gb')}</span>
          </div>
          <p class="admin-meta mt-1">{tr('admin.placement.attemptNote')}</p>
        </div>
      {/if}
    </div>

    {#if placeRefusal}
      <!-- The refusal takes the live line's place (Z4, M6's warning pattern). -->
      <div class={cn('border', placeRefusal === 'gpu' ? 'border-accent/50' : placeRefusal === 'no-machines' ? 'border-line' : 'border-warning/50')}>
        <div class={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5', placeRefusal === 'gpu' ? 'bg-accent/[0.07]' : placeRefusal === 'no-machines' ? '' : 'bg-warning/[0.07]')}>
          <span class={cn('admin-label', placeRefusal === 'gpu' ? 'text-accent-text' : placeRefusal === 'no-machines' ? '' : 'text-warning')}>{tr('admin.placement.title')}</span>
          <span class="border border-line bg-canvas px-1.5 py-0.5 text-micro text-muted">
            {placeRefusal === 'gpu' ? environment : tr('admin.placement.refusal.label')}
          </span>
          <span class={cn('min-w-0 text-2xs font-semibold', placeRefusal === 'gpu' ? 'text-accent-text' : placeRefusal === 'no-machines' ? 'text-ink' : 'text-warning')}>
            {placeRefusal === 'not-portable'
              ? tr('admin.placement.refusal.notPortable')
              : placeRefusal === 'gpu'
                ? tr('admin.placement.refusal.gpu')
                : placeRefusal === 'no-machines'
                  ? tr('admin.placement.refusal.noMachines')
                  : tr('admin.placement.refusal.blockedRanges')}
          </span>
        </div>
        {#if placeRefusal !== 'blocked-ranges'}
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2.5 bg-surface px-3.5 py-3">
            <p class="min-w-0 flex-1 basis-[240px] text-2xs text-ink">
              {placeRefusal === 'not-portable'
                ? tr('admin.placement.refusal.notPortableNote', { env: outlook?.environment ?? environment })
                : placeRefusal === 'gpu'
                  ? tr('admin.placement.refusal.gpuNote')
                  : tr('admin.placement.refusal.noMachinesNote')}
            </p>
            {#if placeRefusal === 'not-portable' && onenvironment}
              <button type="button" class="btn-outline shrink-0 max-[640px]:w-full" onclick={onenvironment}>{tr('admin.placement.refusal.changeEnvironment')}</button>
            {:else if placeRefusal === 'gpu' && placeable}
              <button type="button" class="btn-outline shrink-0 max-[640px]:w-full" onclick={() => place({ ...CLASS_PLACEMENT_PRESETS.gpu })}>
                {tr('admin.classes.preset.gpu')}
              </button>
            {:else if placeRefusal === 'no-machines' && owner}
              <a class="btn-outline shrink-0 max-[640px]:w-full" href="/admin/resources?machines=list">{tr('admin.placement.refusal.openResources')}</a>
            {/if}
          </div>
        {/if}
      </div>
    {:else if live}
      <!-- The live line (Z4): the machines that fit now, with a positive bar. -->
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-l-[3px] px-3 py-1.5 {live.tone === 'positive' ? 'border-positive' : 'border-warning'}">
        <p class="min-w-0 flex-1 basis-[240px] break-words text-2xs text-ink">
          {live.text}
          {#if live.far}<span class="font-semibold text-warning"> {live.far}</span>{/if}
        </p>
        {#if outlook}
          <span class="shrink-0 text-micro text-muted">{tr('admin.placement.updated', { time: formatDate(outlook.at, { hour: '2-digit', minute: '2-digit' }) })}</span>
        {/if}
      </div>
    {/if}

    {#if !placementEditable}
      <!-- The owner's switch keeps teachers out (D4): the block reads, greyed, with why. -->
      <p class="flex items-start gap-2 text-2xs text-muted">
        <Icon name="lock" size={13} class="mt-px shrink-0" />
        <span>
          {current.room === 'home' && current.own === 'home' && current.council === 'shared'
            ? tr('admin.placement.locked')
            : tr('admin.placement.lockedPlaced')}
        </span>
      </p>
    {/if}
    {#if placementError}
      <p class="text-ui text-danger" role="alert">{placementError}</p>
    {/if}
  </section>
{/snippet}

<style>
  /*
   * Where it runs, by its own width (container query): the class dialog is
   * 640 px and a phone 390, so a window width would measure the wrong box.
   * From 720 px the presets are tiles in a row and each part's choice a
   * 2×124 px segmented control beside it; below, a radio list with 48 px rows
   * and full-width 50/50 controls 44 px high (Z10).
   */
  .pl {
    container-type: inline-size;
  }

  .pl-presets {
    display: flex;
    flex-direction: column;
    border: 1px solid rgb(var(--line));
  }

  .pl-preset {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 8px 14px;
    text-align: left;
    color: rgb(var(--ink));
    background: rgb(var(--canvas));
    border-top: 1px solid rgb(var(--line));
    transition: background-color 100ms ease-out;
  }

  .pl-preset:first-child {
    border-top: 0;
  }

  .pl-preset:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .pl-preset-note {
    color: rgb(var(--muted));
  }

  .pl-preset-on {
    background: rgb(var(--primary) / 0.08);
  }

  .pl-dot {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    border: 1.5px solid rgb(var(--faint));
    border-radius: 9999px;
  }

  .pl-preset-on .pl-dot {
    border: 5px solid rgb(var(--ink));
  }

  .pl-part {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .pl-seg {
    display: flex;
    width: 100%;
    border: 1px solid rgb(var(--line));
    background: rgb(var(--canvas));
  }

  .pl-seg-btn {
    display: inline-flex;
    flex: 1 1 50%;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 10px;
    color: rgb(var(--muted));
    white-space: nowrap;
  }

  .pl-seg-btn:disabled,
  .pl-seg-btn:has(:disabled) {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .pl-seg-on {
    background: rgb(var(--primary));
    color: rgb(var(--primary-ink));
    font-weight: 700;
  }

  .pl-seconds {
    width: 3.2em;
    border: 0;
    border-bottom: 1px dashed currentColor;
    background: transparent;
    color: inherit;
    font-family: var(--font-mono);
    text-align: center;
  }

  .pl-fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }

  @container (min-width: 720px) {
    .pl-presets {
      flex-direction: row;
      gap: 10px;
      border: 0;
    }

    .pl-preset {
      flex: 1 1 0;
      align-items: flex-start;
      min-height: 64px;
      border: 1px solid rgb(var(--line));
    }

    .pl-preset:first-child {
      border-top: 1px solid rgb(var(--line));
    }

    .pl-preset-on {
      background: rgb(var(--primary));
      color: rgb(var(--primary-ink));
      border-color: rgb(var(--primary));
    }

    .pl-preset-on .pl-preset-note {
      color: rgb(var(--primary-ink) / 0.75);
    }

    .pl-dot {
      display: none;
    }

    .pl-part {
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    .pl-part .pl-seg {
      width: 248px;
      flex-shrink: 0;
    }

    .pl-seg-btn {
      min-height: 32px;
      flex: 0 0 124px;
    }

    .pl-seg-wide {
      width: auto;
      display: inline-flex;
    }

    .pl-seg-wide .pl-seg-btn {
      flex: 0 0 auto;
      padding: 0 14px;
    }

    .pl-fields {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>

{#snippet cpuField()}
  <div class="admin-affix w-[200px] gap-2">
    <input
      type="number"
      min="1"
      step="1"
      inputmode="numeric"
      disabled={busy}
      class="placeholder:font-sans"
      aria-label={tr('admin.resources.cpuLabel')}
      placeholder={unreadable ? tr('admin.resources.asDefault') : ''}
      value={shownCores}
      oninput={(event) => {
        editingCores = true
        typedCores = event.currentTarget.value
      }}
      onblur={commitCores}
      onkeydown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
    <span class="shrink-0 text-2xs text-muted">{tr('admin.resources.cores')}</span>
  </div>
  {#if cpus !== null && defaultCores !== null}
    <button
      type="button"
      class="admin-link"
      disabled={busy}
      onclick={() => {
        editingCores = false
        oncpus(null)
      }}
    >
      {tr('admin.resources.useDefaultCpu')}
    </button>
  {/if}
{/snippet}
