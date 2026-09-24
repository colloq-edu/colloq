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
   */
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import Skeleton from '@/components/ui/Skeleton.svelte'
  import { cn } from '@/lib/utils'
  import type { InstanceResources } from '@shared/admin'

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
  }: Props = $props()

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
  const tight = $derived(
    resources !== null &&
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
   * real section in a browser: the `.field` is 38 pixels, a hint line
   * (text-2xs · leading-snug) is 18. Computing them from the tokens on paper
   * did not work: at 11px the line height rounds differently from how it
   * multiplies, and the section drifted by a pixel. If the font size or the
   * padding changes, these numbers get re-measured.
   */
  const FIELD_H = '38px'
  const HINT_LINE = 18
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
      <div class="flex flex-wrap items-center gap-2.5">
        <Skeleton width="110px" height={FIELD_H} radius="0" />
        <span class="text-ui text-muted">{tr('admin.resources.gb')}</span>
      </div>
      <Skeleton width="320px" height="4px" radius="0" />
      {@render hintLines(['72%'])}

      <div class="flex flex-col gap-3 border-t border-line-soft pt-4">
        <div class="flex flex-wrap items-center gap-2.5">
          <Skeleton width="110px" height={FIELD_H} radius="0" />
          <span class="text-ui text-muted">{tr('admin.resources.cores')}</span>
        </div>
        <Skeleton width="320px" height="4px" radius="0" />
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
    <div class="flex flex-wrap items-center gap-2.5">
      <input
        type="number"
        min="0.5"
        step="0.5"
        inputmode="decimal"
        disabled={busy}
        class="field w-[110px]"
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
      <span class="text-ui text-muted">{tr('admin.resources.gb')}</span>
      {#if memoryMb !== null && defaultMb !== null}
        <!-- Back to the environment's value with one press: otherwise "as it
             was" has to be typed as a number, peeking at it in the hint
             below. -->
        <button
          type="button"
          class="text-2xs text-muted underline decoration-line underline-offset-2 hover:text-ink"
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
      <div class="flex h-1 w-full max-w-[320px] bg-line-soft" aria-hidden="true">
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
      <p class="text-2xs leading-snug text-muted">
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
      <p class="text-2xs leading-snug text-muted">{tr('admin.resources.ownHint')}</p>

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
        <p class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-2xs leading-snug text-muted">
          <span class="font-semibold text-ink">{tr('admin.resources.ownRow')}</span>
          <span>{tr('admin.resources.ownRoom', { p0: asGb(row?.memoryMb ?? 0), p1: String(row?.cpus ?? 0) })}</span>
          <span aria-hidden="true">·</span>
          <span>{tr('admin.resources.ownBooks', { p0: asGb(ownRoom.memoryMb), p1: String(ownRoom.cpus) })}</span>
        </p>
      {/if}

      {#if tight}
        <p class="flex items-start gap-2 text-2xs leading-snug text-warning">
          <Icon name="alert" size={13} class="mt-px shrink-0" />
          <span>{tr('admin.resources.overFree')}</span>
        </p>
      {/if}

      {#if refusal}
        <p class="text-2xs leading-snug text-danger" role="alert">{refusal}</p>
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
        <div class="flex flex-wrap items-center gap-2.5">
          {@render cpuField()}
        </div>

        <div class="flex h-1 w-full max-w-[320px] bg-line-soft" aria-hidden="true">
          <div
            class="h-full bg-accent transition-[width] duration-[var(--speed-quick)] ease-out"
            style="width: {(cpuShare * 100).toFixed(1)}%"
          ></div>
        </div>

        <!-- Cores follow the same rule as memory: docker's VM has its own
             share of them ("--cpu 10" out of twelve), and they are named
             after it. -->
        <p class="text-2xs leading-snug text-muted">
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
      </div>

      <!-- The GPU as a line, because that is what it is: there is nothing to
           set it with for this room, but you need to know what it will run
           on. -->
      <div class="flex flex-col gap-1.5 border-t border-line-soft pt-3">
        {#if resources.gpus.length > 0}
          {@const card = resources.gpus[0]}
          <p class="text-2xs leading-snug text-muted">
            <span class="font-semibold text-ink">GPU:</span>
            {card.name}, {asGb(card.memoryMb)} {tr('admin.resources.gb')}{resources.gpus.length > 1
              ? tr('admin.resources.moreCards', { p0: resources.gpus.length - 1 })
              : ''}
            ·
            {usesGpu ? tr('admin.resources.envUsesGpu') : tr('admin.resources.envNoGpu')}
          </p>
          <p class="text-2xs leading-snug text-faint">{tr('admin.resources.vramShared')}</p>
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
        <div class="flex flex-wrap items-center gap-2.5">
          {@render cpuField()}
        </div>
      </div>

      {#if refusal}
        <p class="text-2xs leading-snug text-danger" role="alert">{refusal}</p>
      {/if}

      <p class="text-2xs leading-snug text-muted">{tr('admin.resources.unreadable')}</p>
    {/if}
  {/if}
</div>

{#snippet cpuField()}
  <input
    type="number"
    min="1"
    step="1"
    inputmode="numeric"
    disabled={busy}
    class="field w-[110px]"
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
  <span class="text-ui text-muted">{tr('admin.resources.cores')}</span>
  {#if cpus !== null && defaultCores !== null}
    <button
      type="button"
      class="text-2xs text-muted underline decoration-line underline-offset-2 hover:text-ink"
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
