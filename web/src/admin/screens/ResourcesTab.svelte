<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  /**
   * The instance's Resources tab: how the machine is divided right now, and
   * the defaults behind every room, personal-notebook container, competition
   * submission and upload.
   *
   * Two routes stand behind one form — /api/admin/resources (rooms, notebooks,
   * files) and /api/admin/competitions/settings (the queue) — and the page
   * treats them as one save: the header counts unsaved fields across both,
   * and Save sends only the half that changed.
   *
   * Every field says where its number came from. A number saved here beats
   * the environment variable, and "back to .env" forgets it. That is exactly
   * what the old .env-only setup could not tell anyone: which of two numbers
   * is in force.
   */
  import { onMount } from 'svelte'
  import type {
    ResourceSettingName,
    ResourceSettingsResponse,
    ResourceSource,
    UpdateResourceSettingsRequest,
  } from '@shared/admin'
  import type { CompetitionSettings, CompetitionSettingsInput } from '@shared/competitions-settings'
  import type { DiskSpace } from '@shared/disk'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Choice from '@/admin/ui/Choice.svelte'
  import Section from '@/admin/ui/Section.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { cn } from '@/lib/utils'

  /* ------------------------------------------------------------- fields */

  /** The competition half is prefixed so one record can hold the whole form. */
  type CompetitionKey = 'c.slots' | 'c.wallSeconds' | 'c.memoryMb' | 'c.cpus' | 'c.perDay' | 'c.uploadsPerMinute'
  type FieldKey = ResourceSettingName | CompetitionKey

  /** The fields this page edits; the process ceilings stay env-and-API only. */
  const RESOURCE_KEYS = [
    'roomMemoryMb',
    'gpuRoomMemoryMb',
    'roomCpus',
    'ownMemoryMb',
    'ownCpus',
    'ownMax',
    'ownIdleMin',
    'uploadMb',
    'sessionMb',
  ] as const satisfies readonly ResourceSettingName[]
  type EditedResource = (typeof RESOURCE_KEYS)[number]

  const COMPETITION_KEYS = [
    'c.wallSeconds',
    'c.memoryMb',
    'c.cpus',
    'c.perDay',
    'c.uploadsPerMinute',
  ] as const satisfies readonly CompetitionKey[]

  /** Memory is typed in gigabytes and stored in megabytes; the rest are plain counts. */
  const IN_GB = new Set<FieldKey>(['roomMemoryMb', 'gpuRoomMemoryMb', 'ownMemoryMb', 'c.memoryMb'])
  /** Empty means "the same as the room", not "unchanged". */
  const NULLABLE = new Set<FieldKey>(['ownMemoryMb', 'ownCpus'])

  /* --------------------------------------------------------------- state */

  let loaded = $state<ResourceSettingsResponse | null>(null)
  let competitions = $state<CompetitionSettings | null>(null)
  let loadErrorText = $state<(() => string | null) | null>(null)
  const loadError = $derived(loadErrorText?.() ?? null)
  let competitionErrorText = $state<(() => string | null) | null>(null)
  const competitionError = $derived(competitionErrorText?.() ?? null)

  let texts = $state<Record<FieldKey, string>>(blankTexts())
  /** Fields asked to forget their saved value and fall back to .env or the default. */
  let forgotten = $state<FieldKey[]>([])
  let slotsMode = $state<'auto' | 'fixed'>('auto')

  let saving = $state(false)
  let saveErrorText = $state<(() => string | null) | null>(null)
  const saveError = $derived(saveErrorText?.() ?? null)
  let justSaved = $state(false)
  let noteTimer: ReturnType<typeof setTimeout> | undefined

  /*
   * The class size behind the "per notebook" estimate. A viewer's convenience,
   * not a setting: nothing on the server depends on it, so it lives in this
   * browser and a blocked storage just means the default.
   */
  const CLASS_SIZE_KEY = 'colloq.admin.resources.classSize'
  let classSizeText = $state(readClassSize())

  const isOwner = $derived(adminAuth.isOwner)
  const ready = $derived(loaded !== null)

  /* ------------------------------------------------------------ plumbing */

  onMount(() => {
    void load()
    // The split of the machine moves as rooms start and stop; the form does
    // not. Only the budget is refreshed, so typing is never overwritten.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshBudget()
    }, 15_000)
    return () => {
      clearInterval(timer)
      clearTimeout(noteTimer)
    }
  })

  function blankTexts(): Record<FieldKey, string> {
    const record = {} as Record<FieldKey, string>
    for (const key of [...RESOURCE_KEYS, ...COMPETITION_KEYS, 'c.slots' as const]) record[key] = ''
    return record
  }

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
      // A private window: the estimate still works, it just is not remembered.
    }
  }

  function messageFor(cause: unknown): string {
    if (cause instanceof AdminApiError) return cause.message
    if (cause instanceof Error) return cause.message
    return tr('admin.the.server.did.not.answer')
  }

  function reauthenticate(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
  }

  async function load(): Promise<void> {
    const [resources, queue] = await Promise.allSettled([adminApi.resourceSettings(), adminApi.competitionSettings()])
    if (resources.status === 'fulfilled') {
      applyResources(resources.value)
      loadErrorText = null
    } else {
      loadErrorText = () => messageFor(resources.reason)
      reauthenticate(resources.reason)
    }
    // The queue half failing must not take the rooms half with it: the owner
    // who came to raise notebook memory can still do that.
    if (queue.status === 'fulfilled') {
      applyCompetitions(queue.value)
      competitionErrorText = null
    } else {
      competitionErrorText = () => messageFor(queue.reason)
    }
  }

  async function refreshBudget(): Promise<void> {
    const current = loaded
    if (!current || saving) return
    try {
      const fresh = await adminApi.resourceSettings()
      // Only what the machine is doing; the settings stay what the form shows.
      loaded = { ...current, budget: fresh.budget, machine: fresh.machine, disk: fresh.disk }
    } catch {
      // A missed refresh is not worth a banner: the next one will try again.
    }
  }

  /* ------------------------------------------------------------- values */

  const number = $derived(new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }))

  function gb(mb: number): string {
    return number.format(mb / 1024)
  }

  /** What the server holds for a field right now: the number the form is measured against. */
  function savedOf(key: FieldKey): number | null {
    if (!key.startsWith('c.')) return loaded?.settings[key as ResourceSettingName].value ?? null
    const queue = competitions
    if (!queue) return null
    switch (key) {
      case 'c.slots':
        return queue.slots.mode === 'fixed' ? queue.slots.value : null
      case 'c.uploadsPerMinute':
        return queue.uploadsPerMinute.value
      case 'c.wallSeconds':
        return queue.defaults.wallSeconds
      case 'c.memoryMb':
        return queue.defaults.memoryMb
      case 'c.cpus':
        return queue.defaults.cpus
      case 'c.perDay':
        return queue.defaults.perDay
    }
    return null
  }

  function boundsOf(key: FieldKey): { min: number; max: number } | null {
    if (!key.startsWith('c.')) return loaded?.bounds[key as ResourceSettingName] ?? null
    const bounds = competitions?.bounds
    if (!bounds) return null
    const name = key.slice(2) as keyof CompetitionSettings['bounds']
    return bounds[name] ?? null
  }

  function display(key: FieldKey, value: number | null): string {
    if (value === null) return ''
    return IN_GB.has(key) ? gb(value) : String(value)
  }

  /** What the field says, parsed and clamped; an unreadable text keeps the saved number. */
  function valueOf(key: FieldKey): number | null {
    const text = texts[key].trim()
    if (text === '') return NULLABLE.has(key) ? null : savedOf(key)
    const parsed = Number(text.replace(',', '.').replace(/[\s_]/g, ''))
    if (!Number.isFinite(parsed)) return savedOf(key)
    const raw = IN_GB.has(key) ? Math.round(parsed * 1024) : Math.round(parsed)
    const bounds = boundsOf(key)
    return bounds ? Math.min(Math.max(raw, bounds.min), bounds.max) : raw
  }

  function sourceOf(key: FieldKey): ResourceSource | null {
    if (!key.startsWith('c.')) return loaded?.settings[key as ResourceSettingName].source ?? null
    const queue = competitions
    if (!queue) return null
    if (key === 'c.slots') return queue.slots.source
    if (key === 'c.uploadsPerMinute') return queue.uploadsPerMinute.source
    return queue.defaultSources[key.slice(2) as keyof CompetitionSettings['defaultSources']] ?? null
  }

  function isDirty(key: FieldKey): boolean {
    if (forgotten.includes(key)) return true
    if (key === 'c.slots') {
      const queue = competitions
      if (!queue) return false
      if (slotsMode !== queue.slots.mode) return true
      return slotsMode === 'fixed' && valueOf('c.slots') !== queue.slots.value
    }
    return valueOf(key) !== savedOf(key)
  }

  const resourceDirty = $derived(RESOURCE_KEYS.filter((key) => isDirty(key)))
  const competitionDirty = $derived(
    competitions ? [...COMPETITION_KEYS, 'c.slots' as const].filter((key) => isDirty(key)) : [],
  )
  const dirtyCount = $derived(resourceDirty.length + competitionDirty.length)
  const dirty = $derived(dirtyCount > 0)

  /* --------------------------------------------------------- apply/save */

  function applyResources(response: ResourceSettingsResponse): void {
    loaded = response
    for (const key of RESOURCE_KEYS) texts[key] = display(key, response.settings[key].value)
    forgotten = forgotten.filter((key) => key.startsWith('c.'))
  }

  function applyCompetitions(settings: CompetitionSettings): void {
    competitions = settings
    slotsMode = settings.slots.mode
    texts['c.slots'] = String(settings.slots.mode === 'fixed' ? settings.slots.value : settings.slots.auto)
    for (const key of COMPETITION_KEYS) texts[key] = display(key, savedOf(key))
    forgotten = forgotten.filter((key) => !key.startsWith('c.'))
  }

  /** Blur tidies the text into what will be saved, so "4,25" becomes "4,3" before anyone saves it. */
  function tidy(key: FieldKey): void {
    if (forgotten.includes(key)) return
    texts[key] = display(key, valueOf(key))
  }

  /** "Back to .env": the saved row goes away on Save and the field shows what will answer instead. */
  function forget(key: FieldKey): void {
    if (!forgotten.includes(key)) forgotten = [...forgotten, key]
    if (key.startsWith('c.')) {
      texts[key] = ''
      return
    }
    const setting = loaded?.settings[key as ResourceSettingName]
    if (setting) texts[key] = display(key, setting.env ?? setting.default)
  }

  function typed(key: FieldKey): void {
    // Typing over a forgotten field is a new decision, not the old "forget".
    if (forgotten.includes(key)) forgotten = forgotten.filter((k) => k !== key)
  }

  function discard(): void {
    forgotten = []
    if (loaded) applyResources(loaded)
    if (competitions) applyCompetitions(competitions)
    saveErrorText = null
  }

  function flashSaved(): void {
    justSaved = true
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => (justSaved = false), 2500)
  }

  async function save(): Promise<void> {
    if (!dirty || saving) return
    const resourcePatch: UpdateResourceSettingsRequest = {}
    for (const key of resourceDirty) {
      resourcePatch[key as EditedResource] = forgotten.includes(key) ? null : valueOf(key)
    }
    const competitionPatch: CompetitionSettingsInput = {}
    for (const key of competitionDirty) {
      if (key === 'c.slots') {
        competitionPatch.slots = forgotten.includes(key) ? null : slotsMode === 'auto' ? 'auto' : valueOf(key)
        continue
      }
      const name = key.slice(2) as Exclude<keyof CompetitionSettingsInput, 'slots'>
      competitionPatch[name] = forgotten.includes(key) ? null : valueOf(key)
    }

    saving = true
    saveErrorText = null
    try {
      // One after the other and each applied as it lands: if the second half
      // is refused, the first is already saved and the form says so honestly.
      if (Object.keys(resourcePatch).length > 0) applyResources(await adminApi.updateResourceSettings(resourcePatch))
      if (Object.keys(competitionPatch).length > 0) {
        applyCompetitions(await adminApi.saveCompetitionSettings(competitionPatch))
        // The budget's competition segment is computed from these settings.
        void refreshBudget()
      }
      flashSaved()
    } catch (cause: unknown) {
      saveErrorText = () => messageFor(cause)
      reauthenticate(cause)
    } finally {
      saving = false
    }
  }

  /* -------------------------------------------------------------- budget */

  /** What the queue would take at full load with the numbers now on screen. */
  const competitionShare = $derived.by(() => {
    const queue = competitions
    const budget = loaded?.budget
    if (!queue || !budget) return null
    const slots = slotsMode === 'auto' ? queue.slots.auto : (valueOf('c.slots') ?? queue.slots.value)
    const memoryMb = valueOf('c.memoryMb') ?? queue.defaults.memoryMb
    const cpus = valueOf('c.cpus') ?? queue.defaults.cpus
    // What one automatic slot is sized for, as the server counts it: the saved
    // defaults plus the container's cushion. While the defaults are being
    // edited, the same cushion over the typed numbers.
    const cushion = queue.slots.perSlot ? queue.slots.perSlot.memoryMb - queue.defaults.memoryMb : 256
    return {
      slots,
      memoryMb: slots * memoryMb,
      cpus: slots * cpus,
      perSlotMb: memoryMb,
      perSlotCpus: cpus,
      autoSlotMb: memoryMb + cushion,
    }
  })

  const memory = $derived.by(() => {
    const budget = loaded?.budget
    if (!budget) return null
    const rooms = budget.rooms.memoryMb
    const own = budget.own.memoryMb
    const queue = competitionShare?.memoryMb ?? budget.competitions.memoryMb ?? 0
    const promised = rooms + own + queue
    const usable = budget.totalMb - budget.reserveMb
    const scale = Math.max(budget.totalMb, promised + budget.reserveMb)
    return {
      rooms,
      own,
      queue,
      promised,
      free: usable - promised,
      scale,
      total: budget.totalMb,
      reserve: budget.reserveMb,
    }
  })

  const cores = $derived.by(() => {
    const budget = loaded?.budget
    if (!budget) return null
    const rooms = budget.rooms.cpus
    const own = budget.own.cpus
    const queue = competitionShare?.cpus ?? budget.competitions.cpus ?? 0
    const promised = rooms + own + queue
    return { rooms, own, queue, promised, total: budget.totalCpus, scale: Math.max(budget.totalCpus, promised) }
  })

  function share(part: number, scale: number): string {
    return `${Math.max(0, (part / Math.max(scale, 1)) * 100)}%`
  }

  /*
   * Disk: one bar when data and workspace share a filesystem (the usual
   * case), two when the workspace has its own. The low flag comes from the
   * server, which applies the thresholds (@shared/disk).
   */
  interface DiskRow {
    key: string
    label: string
    note: string | null
    space: DiskSpace
  }

  const diskRows = $derived.by((): DiskRow[] => {
    const disk = loaded?.disk
    if (!disk) return []
    if (!disk.workspace) return [{ key: 'data', label: tr('admin.resourcesTab.disk'), note: null, space: disk.data }]
    return [
      { key: 'data', label: tr('admin.resourcesTab.diskData'), note: tr('admin.resourcesTab.diskDataNote'), space: disk.data },
      { key: 'workspace', label: tr('admin.resourcesTab.diskWorkspace'), note: tr('admin.resourcesTab.diskWorkspaceNote'), space: disk.workspace },
    ]
  })

  function gbOfBytes(bytes: number): string {
    return number.format(bytes / 1024 ** 3)
  }

  /* ------------------------------------------------------------- helpers */

  const classSize = $derived(Math.min(Math.max(Math.round(Number(classSizeText) || 0), 1), 500))

  /** The personal-notebook container's memory as the form would leave it. */
  const ownMemoryMb = $derived(valueOf('ownMemoryMb') ?? valueOf('roomMemoryMb') ?? 0)
  const ownCpus = $derived(valueOf('ownCpus') ?? valueOf('roomCpus') ?? 0)

  const perNotebook = $derived({
    memory: number.format(ownMemoryMb / 1024 / classSize),
    cpus: number.format(ownCpus / classSize),
    // Below a gigabyte a pandas notebook runs out of memory on the first real
    // dataset: the class container gets killed, and every notebook in it.
    tight: ownMemoryMb / classSize < 1024,
  })

  const dockerOnlyIgnored = $derived(loaded !== null && loaded.backend === 'broker')

  const slotOptions = $derived([
    {
      value: 'auto',
      label: competitions ? tr('admin.resourcesTab.slotsAuto', { count: competitions.slots.auto }) : tr('admin.resourcesTab.slotsAutoBare'),
      hint: competitionShare && competitions
        ? tr('admin.resourcesTab.slotsAutoHint', {
            cpus: competitionShare.perSlotCpus,
            memory: gb(competitionShare.autoSlotMb),
            machineCpus: competitions.machine.cpus,
            machineMemory: gb(competitions.machine.memoryMb),
          })
        : undefined,
    },
    {
      value: 'fixed',
      label: tr('admin.resourcesTab.slotsFixed'),
      hint: tr('admin.resourcesTab.slotsFixedHint', {
        min: competitions?.bounds.slots.min ?? 1,
        max: competitions?.bounds.slots.max ?? 64,
      }),
    },
  ])
</script>

{#snippet fieldLabel(key: FieldKey, text: string, id: string)}
  <label for={id} class="mb-1.5 flex items-baseline gap-2">
    <span class="text-2xs font-semibold uppercase tracking-label text-muted">{text}</span>
    {#if isDirty(key) && !forgotten.includes(key)}
      {@const before = savedOf(key)}
      <span class="text-2xs text-warning">
        {before === null ? tr('admin.resourcesTab.wasSameAsRoom') : tr('admin.resourcesTab.was', { value: display(key, before) })}
      </span>
    {/if}
  </label>
{/snippet}

<!--
  One field: the number, its unit, and one line saying where the number comes
  from. The line is the point of the page — "4 GB" alone does not say whether
  it is the panel's, the .env's or nobody's.
-->
{#snippet field(key: FieldKey, label: string, unit: string, width: string, placeholder = '')}
  {@const id = `resources-${key.replace('.', '-')}`}
  {@const source = sourceOf(key)}
  <div class={cn('min-w-0', width)}>
    {@render fieldLabel(key, label, id)}
    <div
      class={cn(
        'field flex items-center gap-2 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/25',
        isDirty(key) && 'border-accent',
      )}
    >
      <input
        {id}
        bind:value={texts[key]}
        oninput={() => typed(key)}
        onblur={() => tidy(key)}
        class="min-w-0 flex-1 bg-transparent font-mono text-code text-ink outline-none placeholder:font-sans placeholder:text-faint"
        inputmode="decimal"
        autocomplete="off"
        {placeholder}
      />
      <span class="shrink-0 text-2xs text-muted">{unit}</span>
    </div>
    <p class="mt-1.5 min-h-4 text-2xs text-faint">
      {#if forgotten.includes(key)}
        <span class="text-warning">{tr('admin.resourcesTab.willForget')}</span>
      {:else if source === 'saved'}
        {tr('admin.resourcesTab.sourceSaved')}
        {#if isOwner}
          ·
          <button type="button" class="text-accent-text hover:underline" onclick={() => forget(key)}>
            {key.startsWith('c.') || !loaded?.settings[key as ResourceSettingName].envName
              ? tr('admin.resourcesTab.backToDefault')
              : tr('admin.resourcesTab.backToEnv')}
          </button>
        {/if}
      {:else if source === 'env'}
        {@const setting = key.startsWith('c.') ? null : loaded?.settings[key as ResourceSettingName]}
        {tr('admin.resourcesTab.sourceEnv')} <span class="font-mono">{setting?.envName ?? 'COMPETITION_SLOTS'}</span>
      {:else if source === 'default'}
        {tr('admin.resourcesTab.sourceDefault')}
      {/if}
    </p>
  </div>
{/snippet}

{#snippet legend(tone: string, title: string, detail: string)}
  <div class="min-w-[150px]">
    <div class="flex items-center gap-2">
      <span class={cn('size-2.5 shrink-0', tone)}></span>
      <span class="text-ui font-semibold text-ink">{title}</span>
    </div>
    <p class="mt-0.5 pl-[18px] font-mono text-code text-muted">{detail}</p>
  </div>
{/snippet}

{#snippet actions()}
  {#if isOwner}
    {#if justSaved && !dirty}
      <span class="flex items-center gap-1 text-2xs font-semibold uppercase tracking-label text-positive">
        <Icon name="check" size={13} />
        {tr('admin.saved')}
      </span>
    {:else if dirty}
      <span class="text-ui text-warning">{tr('admin.resourcesTab.unsaved', { count: dirtyCount })}</span>
      <button type="button" class="btn-ghost" onclick={discard} disabled={saving}>{tr('admin.discard')}</button>
    {/if}
    <button type="button" class="btn-primary min-w-[112px]" onclick={save} disabled={!dirty || saving}>
      {#if saving}
        <Icon name="spinner" size={15} class="animate-spin" />
        {tr('admin.saving')}
      {:else}
        {tr('admin.save.changes')}
      {/if}
    </button>
  {/if}
{/snippet}

<AdminPage title={tr('admin.resourcesTab.title')} subtitle={tr('admin.resourcesTab.subtitle')} {actions}>
  {#if loadError}
    <div class="mt-6 max-w-[560px] border border-line bg-surface px-4 py-3.5">
      <p class="text-ui text-danger">{loadError}</p>
      <button type="button" class="btn-outline mt-3" onclick={() => void load()}>{tr('admin.try.again')}</button>
    </div>
  {:else if !ready}
    <p class="mt-6 text-ui text-muted">{tr('admin.resourcesTab.loading')}</p>
  {:else if loaded}
    {#if !isOwner}
      <p class="mt-5 max-w-[720px] border border-line bg-surface px-4 py-3 text-ui text-muted">
        <span class="font-semibold text-ink">{tr('admin.read.only')}</span>
        {tr('admin.resourcesTab.readOnly')}
      </p>
    {/if}
    {#if saveError}
      <p role="alert" class="mt-5 border border-danger/40 bg-danger/5 px-4 py-3 text-ui text-danger">{saveError}</p>
    {/if}

    <Section title={tr('admin.resourcesTab.machineTitle')} description={tr('admin.resourcesTab.machineNote')}>
      {#if memory && cores}
        <div class="flex flex-col gap-6">
          <div>
            <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div class="flex items-baseline gap-2.5">
                <span class="text-2xs font-black uppercase tracking-caps text-ink">{tr('admin.resourcesTab.memory')}</span>
                <span class="text-gauge font-black tracking-tight text-ink">{gb(memory.promised)}</span>
                <span class="text-ui-lg text-muted">{tr('admin.resourcesTab.ofPromisedGb', { total: gb(memory.total) })}</span>
              </div>
              {#if memory.free < 0}
                <span class="text-ui font-semibold text-danger">{tr('admin.resourcesTab.shortGb', { value: gb(-memory.free) })}</span>
              {:else}
                <span class="text-ui font-semibold text-positive">{tr('admin.resourcesTab.freeGb', { value: gb(memory.free) })}</span>
              {/if}
            </div>
            <div class="relative mt-2.5 flex h-[26px] gap-0.5" aria-hidden="true">
              <span class="bg-primary" style:width={share(memory.rooms, memory.scale)}></span>
              <span class="bg-brand-2" style:width={share(memory.own, memory.scale)}></span>
              <span class="bg-accent" style:width={share(memory.queue, memory.scale)}></span>
              <span class="flex-1 border border-dashed border-line bg-surface"></span>
              {#if memory.free < 0}
                <!-- Where the machine ends: everything right of this line is a promise it cannot keep. -->
                <span class="absolute -inset-y-1 w-0.5 bg-danger" style:left={share(memory.total - memory.reserve, memory.scale)}></span>
              {/if}
            </div>
            <div class="mt-3 flex flex-wrap gap-x-7 gap-y-3">
              {@render legend('bg-primary', tr('admin.resourcesTab.rooms'), tr('admin.resourcesTab.roomsDetail', { count: loaded.budget.rooms.count, memory: gb(memory.rooms) }))}
              {@render legend('bg-brand-2', tr('admin.resourcesTab.notebooks'), tr('admin.resourcesTab.notebooksDetail', { count: loaded.budget.own.count, memory: gb(memory.own) }))}
              {#if competitionShare}
                {@render legend('bg-accent', tr('admin.resourcesTab.competitions'), tr('admin.resourcesTab.competitionsDetail', { count: competitionShare.slots, memory: gb(competitionShare.perSlotMb) }))}
              {/if}
              {@render legend('border border-dashed border-faint bg-surface', tr('admin.resourcesTab.free'), tr('admin.resourcesTab.freeDetail', { memory: gb(Math.max(memory.free, 0)), reserve: gb(memory.reserve) }))}
            </div>
            {#if memory.free < 0}
              <p class="mt-3 text-2xs text-danger">{tr('admin.resourcesTab.overcommitNote')}</p>
            {/if}
            {#if !loaded.budget.complete}
              <p class="mt-2 text-2xs text-warning">{tr('admin.resourcesTab.incompleteNote')}</p>
            {/if}
          </div>

          <div>
            <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div class="flex items-baseline gap-2.5">
                <span class="text-2xs font-black uppercase tracking-caps text-ink">{tr('admin.resourcesTab.cores')}</span>
                <span class="text-gauge font-black tracking-tight text-ink">{cores.promised}</span>
                <span class="text-ui-lg text-muted">{tr('admin.resourcesTab.ofPromised', { total: cores.total })}</span>
              </div>
              {#if cores.promised > cores.total}
                <span class="text-ui font-semibold text-warning">{tr('admin.resourcesTab.coresShared')}</span>
              {/if}
            </div>
            <div class="mt-2.5 flex h-3 gap-0.5" aria-hidden="true">
              <span class="bg-primary" style:width={share(cores.rooms, cores.scale)}></span>
              <span class="bg-brand-2" style:width={share(cores.own, cores.scale)}></span>
              <span class="bg-accent" style:width={share(cores.queue, cores.scale)}></span>
              <span class="flex-1 border border-dashed border-line bg-surface"></span>
            </div>
            <p class="mt-2 text-2xs text-muted">
              {tr('admin.resourcesTab.coresNote', { rooms: cores.rooms, own: cores.own, queue: cores.queue })}
            </p>
          </div>

          {#each diskRows as row (row.key)}
            {@const used = Math.max(0, row.space.totalBytes - row.space.freeBytes)}
            <div>
              <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div class="flex items-baseline gap-2.5">
                  <span class="text-2xs font-black uppercase tracking-caps text-ink">{row.label}</span>
                  <span class="text-gauge font-black tracking-tight text-ink">{gbOfBytes(used)}</span>
                  <span class="text-ui-lg text-muted">{tr('admin.resourcesTab.ofUsedGb', { total: gbOfBytes(row.space.totalBytes) })}</span>
                </div>
                <span class={cn('text-ui font-semibold', row.space.low ? 'text-danger' : 'text-positive')}>
                  {tr('admin.resourcesTab.freeGb', { value: gbOfBytes(row.space.freeBytes) })}
                </span>
              </div>
              <div class="mt-2.5 flex h-3 gap-0.5" aria-hidden="true">
                <span class={row.space.low ? 'bg-danger' : 'bg-primary'} style:width={share(used, row.space.totalBytes)}></span>
                <span class="flex-1 border border-dashed border-line bg-surface"></span>
              </div>
              {#if row.note}
                <p class="mt-2 text-2xs text-muted">{row.note}</p>
              {/if}
              {#if row.space.low}
                <p class="mt-2 text-2xs text-danger">{tr('admin.resourcesTab.diskLowNote')}</p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </Section>

    <!-- One disabled fieldset rather than thirty disabled= attributes: a field
         added later cannot forget to be read-only for a teacher. -->
    <fieldset class="contents" disabled={!isOwner}>
      <Section title={tr('admin.resourcesTab.roomTitle')} description={tr('admin.resourcesTab.roomNote')}>
        {#if dockerOnlyIgnored}
          <p class="mb-4 text-2xs text-warning">{tr('admin.resourcesTab.brokerNote')}</p>
        {/if}
        <div class="flex flex-wrap gap-4">
          {@render field('roomMemoryMb', tr('admin.resourcesTab.memory'), tr('admin.resourcesTab.unitGb'), 'w-[200px]')}
          {@render field('roomCpus', tr('admin.resourcesTab.cores'), tr('admin.resourcesTab.unitCores'), 'w-[160px]')}
          {@render field('gpuRoomMemoryMb', tr('admin.resourcesTab.gpuMemory'), tr('admin.resourcesTab.unitGb'), 'w-[240px]')}
        </div>
        {#if loaded.perEnvironmentMemory.length > 0}
          <p class="mt-1 text-2xs text-muted">
            {tr('admin.resourcesTab.perEnvironment')}
            {#each loaded.perEnvironmentMemory as entry, i (entry.environment)}
              <span class="font-mono text-code">{entry.environment} = {gb(entry.mb)} {tr('admin.resourcesTab.unitGb')}</span>{i < loaded.perEnvironmentMemory.length - 1 ? ', ' : ''}
            {/each}
          </p>
        {/if}
      </Section>

      <Section title={tr('admin.resourcesTab.notebooksTitle')} description={tr('admin.resourcesTab.notebooksNote')}>
        <div class="flex flex-wrap items-start gap-4">
          {@render field('ownMemoryMb', tr('admin.resourcesTab.memoryPerClass'), tr('admin.resourcesTab.unitGb'), 'w-[200px]', tr('admin.resourcesTab.sameAsRoom'))}
          {@render field('ownCpus', tr('admin.resourcesTab.cores'), tr('admin.resourcesTab.unitCores'), 'w-[160px]', tr('admin.resourcesTab.sameAsRoom'))}
          <!-- The estimate the owner would otherwise do on a napkin: one
               container for the class, divided by the people in it. -->
          <div class="mt-[22px] flex min-h-[38px] min-w-[260px] flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 bg-surface px-3.5 py-2 text-ui text-ink">
            <label for="resources-class-size">{tr('admin.resourcesTab.classOf')}</label>
            <input
              id="resources-class-size"
              bind:value={classSizeText}
              onblur={rememberClassSize}
              class="w-10 border-b-[1.5px] border-ink bg-transparent px-1 text-center font-mono text-code outline-none"
              inputmode="numeric"
              autocomplete="off"
            />
            <span class={cn(perNotebook.tight && 'text-warning')}>
              {tr('admin.resourcesTab.perNotebook', { count: classSize, memory: perNotebook.memory, cpus: perNotebook.cpus })}
            </span>
            {#if perNotebook.tight}
              <span class="basis-full text-2xs text-warning">{tr('admin.resourcesTab.perNotebookTight')}</span>
            {/if}
          </div>
        </div>
        <div class="mt-2 flex flex-wrap items-start gap-4">
          {@render field('ownMax', tr('admin.resourcesTab.ownMax'), tr('admin.resourcesTab.unitPerClass'), 'w-[200px]')}
          {@render field('ownIdleMin', tr('admin.resourcesTab.ownIdle'), tr('admin.resourcesTab.unitIdleMinutes'), 'w-[160px]')}
          <p class="mt-[22px] min-w-[220px] flex-1 text-2xs text-muted">{tr('admin.resourcesTab.ownMaxNote')}</p>
        </div>
      </Section>

      <Section title={tr('admin.resourcesTab.competitionsTitle')} description={tr('admin.resourcesTab.competitionsNote')}>
        {#if competitionError}
          <p class="text-ui text-danger">{competitionError}</p>
          <button type="button" class="btn-outline mt-3" onclick={() => void load()}>{tr('admin.try.again')}</button>
        {:else if competitions}
          <p class="mb-1.5 text-2xs font-semibold uppercase tracking-label text-muted">{tr('admin.resourcesTab.slots')}</p>
          <div class="resources-slots">
            <Choice
              options={slotOptions}
              value={slotsMode}
              size="lg"
              onchange={(value) => {
                slotsMode = value === 'fixed' ? 'fixed' : 'auto'
                if (forgotten.includes('c.slots')) forgotten = forgotten.filter((key) => key !== 'c.slots')
              }}
            />
          </div>
          {#if slotsMode === 'fixed'}
            <div class="mt-3 flex flex-wrap items-start gap-4">
              {@render field('c.slots', tr('admin.resourcesTab.slotsNumber'), tr('admin.resourcesTab.unitSlots'), 'w-[200px]')}
            </div>
          {/if}

          <div class="mt-5 flex flex-wrap items-start gap-4">
            {@render field('c.wallSeconds', tr('admin.resourcesTab.wall'), tr('admin.resourcesTab.unitSeconds'), 'w-[200px]')}
            {@render field('c.memoryMb', tr('admin.resourcesTab.memory'), tr('admin.resourcesTab.unitGb'), 'w-[160px]')}
            {@render field('c.cpus', tr('admin.resourcesTab.cores'), '', 'w-[116px]')}
            {@render field('c.perDay', tr('admin.resourcesTab.perDay'), '', 'w-[176px]')}
          </div>
          <p class="-mt-1 text-2xs text-muted">{tr('admin.resourcesTab.defaultsNote')}</p>

          <div class="mt-4 flex flex-wrap items-start gap-4">
            {@render field('c.uploadsPerMinute', tr('admin.resourcesTab.uploads'), tr('admin.resourcesTab.unitPerMinute'), 'w-[376px] max-w-full')}
            <p class="mt-[22px] min-w-[220px] flex-1 text-2xs text-muted">{tr('admin.resourcesTab.uploadsNote')}</p>
          </div>
        {/if}
      </Section>

      <Section title={tr('admin.resourcesTab.filesTitle')} description={tr('admin.resourcesTab.filesNote')}>
        <div class="flex flex-wrap gap-4">
          {@render field('uploadMb', tr('admin.resourcesTab.uploadMb'), tr('admin.resourcesTab.unitMb'), 'w-[200px]')}
          {@render field('sessionMb', tr('admin.resourcesTab.sessionMb'), tr('admin.resourcesTab.unitMb'), 'w-[200px]')}
        </div>
      </Section>
    </fieldset>

    <div class="mt-2 flex items-start gap-2.5 bg-surface px-4 py-3.5">
      <Icon name="info" size={16} class="mt-px shrink-0 text-muted" />
      <p class="text-2xs text-muted">{tr('admin.resourcesTab.appliesNote')}</p>
    </div>
  {/if}
</AdminPage>

<style>
  /* Two wordy choices stack when their own column is narrow (see Oracle). */
  .resources-slots {
    container-type: inline-size;
  }

  @container (max-width: 479px) {
    .resources-slots > :global(div) {
      flex-direction: column;
    }
  }
</style>
