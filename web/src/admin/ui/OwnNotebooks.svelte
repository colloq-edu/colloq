<script lang="ts">
  /**
   * Students' personal notebooks, as a RESOURCE: may they, and how much of
   * the machine the whole class gets for them.
   *
   * In the rules list this was one switch with two drop-downs tucked under it,
   * and the numbers were the class container's: every personal notebook of
   * the class lives in ONE container and shares its memory. A teacher reading
   * "as for the class — 4 GB" did not read "4 GB for thirty people", and on a
   * 90-minute competition day that is exactly what killed the notebooks. So
   * the creation form asks the question next to the room's own memory, in
   * gigabytes per class, and does the division out loud.
   *
   * The room console keeps its rules row (RoomRulesRows): it is the same
   * rule, the same three fields in the room's rules, only drawn here.
   */
  import { formatNumber, tr } from '@shared/i18n'
  import type { RoomRules } from '@shared/rules'
  import { cn } from '@/lib/utils'

  interface Props {
    rules: RoomRules
    onchange: (patch: Partial<RoomRules>) => void
    /** The class's own kernel, as the form above leaves it; null — not known yet. */
    roomMemoryMb: number | null
    roomCpus: number | null
    /** The instance defaults for a class that says nothing (Resources tab); null — "same as the room". */
    instanceMemoryMb: number | null
    instanceCpus: number | null
    /** What the machine allows; null — not known, the server refuses out of bounds in words. */
    maxMemoryMb: number | null
    maxCpus: number | null
    /** False where the instance cannot give a personal notebook a kernel of its own; every backend can since 0.10. */
    ownKernels?: boolean
    busy?: boolean
  }

  let {
    rules,
    onchange,
    roomMemoryMb,
    roomCpus,
    instanceMemoryMb,
    instanceCpus,
    maxMemoryMb,
    maxCpus,
    ownKernels = true,
    busy = false,
  }: Props = $props()

  const MB_IN_GB = 1024
  const on = $derived(rules.ownBooks === 'on')

  /** What the class container really gets when its field is empty. */
  const fallbackMb = $derived(instanceMemoryMb ?? roomMemoryMb)
  const fallbackCpus = $derived(instanceCpus ?? roomCpus)
  const effectiveMb = $derived(rules.ownMemoryMb ?? fallbackMb ?? 0)
  const effectiveCpus = $derived(rules.ownCpus ?? fallbackCpus ?? 0)

  function gb(mb: number): string {
    return formatNumber(mb / MB_IN_GB, { maximumFractionDigits: 1 })
  }

  const memoryPlaceholder = $derived(
    fallbackMb === null
      ? tr('admin.ownNotebooks.asRoom')
      : instanceMemoryMb !== null
        ? tr('admin.ownNotebooks.asDefaultValue', { value: gb(fallbackMb) })
        : tr('admin.ownNotebooks.asRoomValue', { value: gb(fallbackMb) }),
  )
  const cpuPlaceholder = $derived(
    fallbackCpus === null
      ? tr('admin.ownNotebooks.asRoom')
      : instanceCpus !== null
        ? tr('admin.ownNotebooks.asDefaultValue', { value: String(fallbackCpus) })
        : tr('admin.ownNotebooks.asRoomValue', { value: String(fallbackCpus) }),
  )

  /*
   * Each field keeps its own string while it is being typed into, for the
   * reason Resources.svelte gives: "1" on the way to "12" is not a number
   * anybody asked for, and it must not go up.
   */
  let memoryText = $state<string | null>(null)
  let cpuText = $state<string | null>(null)
  const memoryShown = $derived(memoryText ?? (rules.ownMemoryMb === null ? '' : gb(rules.ownMemoryMb)))
  const cpuShown = $derived(cpuText ?? (rules.ownCpus === null ? '' : String(rules.ownCpus)))

  function commitMemory(): void {
    const text = (memoryText ?? '').trim()
    memoryText = null
    if (text === '') {
      if (rules.ownMemoryMb !== null) onchange({ ownMemoryMb: null })
      return
    }
    const value = Number(text.replace(',', '.'))
    if (!Number.isFinite(value) || value <= 0) return
    // Half-gigabyte steps, like the room's own field, and never above the machine.
    let mb = Math.max(512, Math.round((value * MB_IN_GB) / 512) * 512)
    if (maxMemoryMb !== null) mb = Math.min(mb, maxMemoryMb)
    if (mb !== rules.ownMemoryMb) onchange({ ownMemoryMb: mb })
  }

  function commitCpus(): void {
    const text = (cpuText ?? '').trim()
    cpuText = null
    if (text === '') {
      if (rules.ownCpus !== null) onchange({ ownCpus: null })
      return
    }
    const value = Math.floor(Number(text.replace(',', '.')))
    if (!Number.isFinite(value) || value < 1) return
    const cores = maxCpus !== null ? Math.min(value, maxCpus) : value
    if (cores !== rules.ownCpus) onchange({ ownCpus: cores })
  }

  /* The same class size the Resources tab remembers: one guess per browser. */
  const CLASS_SIZE_KEY = 'colloq.admin.resources.classSize'
  let classSizeText = $state(readClassSize())
  const classSize = $derived(Math.min(Math.max(Math.round(Number(classSizeText) || 0), 1), 500))
  const perMemory = $derived(effectiveMb / MB_IN_GB / classSize)
  const perCpus = $derived(effectiveCpus / classSize)

  function readClassSize(): string {
    try {
      return localStorage.getItem(CLASS_SIZE_KEY) ?? '20'
    } catch {
      return '20'
    }
  }

  function rememberClassSize(): void {
    classSizeText = String(classSize)
    try {
      localStorage.setItem(CLASS_SIZE_KEY, classSizeText)
    } catch {
      // Not remembered in a private window; the estimate still works.
    }
  }

  function decimal(value: number): string {
    return formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  }
</script>

<div class="flex flex-col gap-2.5">
  <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
    <div class="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
      <span class="admin-section-title">{tr('admin.ownNotebooks.title')}</span>
      <span class="text-2xs text-muted">{tr('admin.ownNotebooks.lede')}</span>
    </div>
    <div class="flex shrink-0 border border-line" role="group" aria-label={tr('admin.ownNotebooks.title')}>
      {#each [{ value: 'off', label: tr('admin.ownNotebooks.off') }, { value: 'on', label: tr('admin.ownNotebooks.on') }] as option (option.value)}
        {@const pressed = rules.ownBooks === option.value}
        <button
          type="button"
          aria-pressed={pressed}
          disabled={busy}
          onclick={() => onchange({ ownBooks: option.value as RoomRules['ownBooks'] })}
          class={cn(
            // The panel's control height, and the room rules' segments below
            // (RoomRulesRows · .admin-ui) are drawn the same: one switch voice.
            'min-h-10 px-3 text-ui font-medium transition-colors duration-100 max-[640px]:min-h-11',
            'focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/15',
            pressed ? 'bg-primary font-semibold text-primary-ink' : 'bg-canvas text-ink hover:bg-surface',
          )}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </div>

  {#if on}
    {#if !ownKernels}
      <p class="text-2xs font-semibold text-warning">{tr('room.rules.ownBooks.noKernel')}</p>
    {/if}
    <div class="flex flex-wrap items-stretch gap-3">
      <label class="admin-affix w-[200px] shrink-0 gap-2">
        <input
          value={memoryShown}
          oninput={(event) => (memoryText = event.currentTarget.value)}
          onblur={commitMemory}
          onkeydown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          disabled={busy}
          class="placeholder:font-sans"
          inputmode="decimal"
          autocomplete="off"
          placeholder={memoryPlaceholder}
          aria-label={tr('admin.ownNotebooks.memory')}
        />
        <span class="shrink-0 text-2xs text-muted">{tr('admin.ownNotebooks.gbPerClass')}</span>
      </label>
      <label class="admin-affix w-[160px] shrink-0 gap-2">
        <input
          value={cpuShown}
          oninput={(event) => (cpuText = event.currentTarget.value)}
          onblur={commitCpus}
          onkeydown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          disabled={busy}
          class="placeholder:font-sans"
          inputmode="numeric"
          autocomplete="off"
          placeholder={cpuPlaceholder}
          aria-label={tr('admin.ownNotebooks.cpus')}
        />
        <span class="shrink-0 text-2xs text-muted">{tr('admin.ownNotebooks.cores')}</span>
      </label>
      <div class="flex min-w-[240px] flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 bg-surface px-3.5 py-2 text-ui text-ink">
        <label for="own-notebooks-class-size">{tr('admin.ownNotebooks.classOf')}</label>
        <input
          id="own-notebooks-class-size"
          bind:value={classSizeText}
          onblur={rememberClassSize}
          class="w-10 border-b-[1.5px] border-ink bg-transparent px-1 text-center font-mono text-2xs outline-none"
          inputmode="numeric"
          autocomplete="off"
        />
        <span class={cn(perMemory < 1 && 'text-warning')}>
          {tr('admin.ownNotebooks.perNotebook', { count: classSize, memory: decimal(perMemory), cpus: decimal(perCpus) })}
        </span>
      </div>
    </div>
    <p class="admin-meta">{tr('admin.ownNotebooks.note')}</p>
  {/if}
</div>
