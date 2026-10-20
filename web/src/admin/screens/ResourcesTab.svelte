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
  import {
    SETTINGS_LIMITS,
    type CompetitionGpuSettingsInput,
    type CompetitionRunnerSettingsInput,
    type CompetitionSettings,
    type CompetitionSettingsInput,
  } from '@shared/competitions-settings'
  import type { DiskSpace } from '@shared/disk'
  import { metricMemoryMb } from '@shared/competitions'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Check from '@/admin/ui/Check.svelte'
  import Choice from '@/admin/ui/Choice.svelte'
  import Runners from '@/admin/ui/Runners.svelte'
  import RunningKernels from '@/admin/ui/RunningKernels.svelte'
  import Section from '@/admin/ui/Section.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { notebooksOffQuestion } from '@/admin/runners'
  import { ceilingNote, defaultsNow, pastBoundNote } from '@/admin/competition-materials'
  import { cardWord } from '@/admin/running-kernels'
  import {
    cardFacts,
    cardHolder,
    cardsBar,
    cardsFallback,
    holderWord,
    perDeviceFallback,
    shareDetail,
    shareGauge,
    shareLines,
    shareReadout,
    sizesUnknown,
    withCardFacts,
    type CardHolder,
  } from '@/admin/runner-cards'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { cn } from '@/lib/utils'

  interface Props {
    /** The panel's router: the machines block opens a machine's page under this tab. */
    navigate: (path: string) => void
  }

  let { navigate }: Props = $props()

  /* ------------------------------------------------------------- fields */

  /**
   * The competition half is prefixed so one record can hold the whole form.
   * `c.gpuDevices` is the one field that is not a number: the runner cards,
   * kept as a list beside the texts (`gpuChosen`) and saved through its own
   * half of the door (CompetitionGpuSettingsInput). The machines' two
   * (`c.homeNotebooks`, a switch kept in `homeChoice`, and `c.scoreSlots`)
   * go through the same door as its third half (CompetitionRunnerSettingsInput).
   */
  type CompetitionKey =
    | 'c.slots'
    | 'c.wallSeconds'
    | 'c.memoryMb'
    | 'c.cpus'
    | 'c.perDay'
    | 'c.uploadsPerMinute'
    | 'c.gpuPerDevice'
    | 'c.gpuDevices'
    | 'c.homeNotebooks'
    | 'c.scoreSlots'
  type FieldKey = ResourceSettingName | CompetitionKey

  /** The fields this page edits; the process ceilings stay env-and-API only. */
  const RESOURCE_KEYS = [
    'roomMemoryMb',
    'gpuRoomMemoryMb',
    'roomCpus',
    'roomIdleMin',
    'ownMemoryMb',
    'ownCpus',
    'ownMax',
    'ownIdleMin',
    'uploadMb',
    'sessionMb',
  ] as const satisfies readonly ResourceSettingName[]
  type EditedResource = (typeof RESOURCE_KEYS)[number]

  /** The competition half's number fields; the slots and the card list have their own controls. */
  const COMPETITION_KEYS = [
    'c.wallSeconds',
    'c.memoryMb',
    'c.cpus',
    'c.perDay',
    'c.uploadsPerMinute',
    'c.gpuPerDevice',
  ] as const satisfies readonly CompetitionKey[]

  /**
   * The environment variable behind a field, for its "from .env" caption:
   * the room settings name their own; of the competition half only the slots
   * and the runner cards have one.
   */
  const COMPETITION_ENV: Partial<Record<CompetitionKey, string>> = {
    'c.slots': 'COMPETITION_SLOTS',
    'c.gpuDevices': 'COMPETITION_GPUS',
    'c.gpuPerDevice': 'COMPETITION_GPU_PER_DEVICE',
  }

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
  /** The cards ticked for competition submissions, in KERNEL_GPUS order (`c.gpuDevices`). */
  let gpuChosen = $state<string[]>([])
  /*
   * The machines' two settings come from the settings door with the rest of
   * the queue's half (CompetitionSettings.runners), each with where it came
   * from — so they have the source line and «вернуть умолчание» every other
   * field has, and a read of the machines list (every few seconds) can never
   * put an old value back into a field after Save.
   */
  /** «Тетради на этом сервере» as the form now stands (`c.homeNotebooks`); `null` until the server said. */
  let homeChoice = $state<boolean | null>(null)
  /** Bumped after a save that sent the machines' settings: the block reads its list again. */
  let runnersReload = $state(0)
  /**
   * Machines online, as the machines block last read them; `null` — it has
   * not read yet, or could not. Turning this server's notebooks off with
   * none online leaves nobody to run them (save · confirm).
   */
  let machinesOnline = $state<number | null>(null)

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
  /**
   * The most one submission may be given, and by whom: the bounds the
   * defaults' cores and memory are kept to, this server's or the biggest
   * machine's that runs submissions (competitions/settings.ts ·
   * submissionCeiling). Read with the rest of the queue's half.
   */
  const competitionCeiling = $derived(competitions ? ceilingNote(competitions) : null)
  /**
   * A default stored past its bound, said rather than drawn as a change: the
   * two fields show what a new competition gets (savedOf · defaultsNow).
   */
  const competitionPastBound = $derived(competitions ? pastBoundNote(competitions) : null)

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
      disposed = true
      clearTimeout(sizesTimer)
    }
  })

  function blankTexts(): Record<FieldKey, string> {
    const record = {} as Record<FieldKey, string>
    for (const key of [
      ...RESOURCE_KEYS,
      ...COMPETITION_KEYS,
      'c.slots' as const,
      'c.gpuDevices' as const,
      'c.homeNotebooks' as const,
      'c.scoreSlots' as const,
    ]) record[key] = ''
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

  /*
   * Each half is applied the moment it lands, not when both have. The queue
   * half names every card with its size, and after a restart the sizes are
   * still being asked (a throwaway container per machine, seconds): waiting
   * for both kept the whole tab — «Работают сейчас» and its stop buttons
   * included — behind «Загружаем ресурсы…» for up to eight seconds. The rooms
   * half draws the page; the competitions section waits under its own line.
   */
  async function load(): Promise<void> {
    await Promise.allSettled([
      adminApi.resourceSettings().then(
        (response) => {
          applyResources(response)
          loadErrorText = null
        },
        (cause: unknown) => {
          loadErrorText = () => messageFor(cause)
          reauthenticate(cause)
        },
      ),
      // The queue half failing must not take the rooms half with it: the owner
      // who came to raise notebook memory can still do that.
      adminApi.competitionSettings().then(
        (settings) => {
          applyCompetitions(settings)
          competitionErrorText = null
          askSizesLater()
        },
        (cause: unknown) => {
          competitionErrorText = () => messageFor(cause)
        },
      ),
    ])
  }

  /*
   * A card the server has not measured yet («объём неизвестен») is asked
   * about again a few times, a little later each time: the sizes come from a
   * probe in the background, and the answer that drew the form may have come
   * before it. Only the cards' own facts are taken from the new answer
   * (withCardFacts), never the saved choice the owner may be editing; a card
   * that never says its size (a MIG instance) stops the asking after the last
   * try, and a reload asks again.
   */
  const SIZE_ASKS = 4
  const SIZE_ASK_MS = 3_000
  let sizesTimer: ReturnType<typeof setTimeout> | undefined
  /** The tab is gone: an answer still on its way schedules nothing more. */
  let disposed = false

  function askSizesLater(attempt = 0): void {
    clearTimeout(sizesTimer)
    if (disposed || attempt >= SIZE_ASKS || !sizesUnknown(competitions?.gpu ?? null)) return
    sizesTimer = setTimeout(() => {
      void adminApi
        .competitionSettings()
        .then((fresh) => {
          if (competitions) competitions = { ...competitions, gpu: withCardFacts(competitions.gpu, fresh.gpu) }
        })
        .catch(() => undefined)
        .finally(() => askSizesLater(attempt + 1))
    }, SIZE_ASK_MS * (attempt + 1))
  }

  async function refreshBudget(): Promise<void> {
    const current = loaded
    if (!current || saving) return
    try {
      const fresh = await adminApi.resourceSettings()
      /*
       * A save (or a reload) landed while this was on its way: its answer is
       * newer, settings included, and spreading the copy taken above over it
       * would put the pre-save numbers back as "saved". The next tick
       * refreshes the machine.
       */
      if (saving || loaded !== current) return
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
    if (key === 'c.scoreSlots') return competitions?.runners?.scoreSlots.value ?? null
    const queue = competitions
    if (!queue) return null
    switch (key) {
      case 'c.slots':
        return queue.slots.mode === 'fixed' ? queue.slots.value : null
      case 'c.uploadsPerMinute':
        return queue.uploadsPerMinute.value
      case 'c.wallSeconds':
        return queue.defaults.wallSeconds
      // Held to their bounds as a new competition gets them (competition-materials.ts · defaultsNow).
      case 'c.memoryMb':
        return defaultsNow(queue).memoryMb
      case 'c.cpus':
        return defaultsNow(queue).cpus
      case 'c.perDay':
        return queue.defaults.perDay
      case 'c.gpuPerDevice':
        return queue.gpu.perDevice
    }
    return null
  }

  function boundsOf(key: FieldKey): { min: number; max: number } | null {
    if (!key.startsWith('c.')) return loaded?.bounds[key as ResourceSettingName] ?? null
    if (key === 'c.gpuPerDevice') return competitions?.gpu.bounds.perDevice ?? null
    if (key === 'c.scoreSlots') return SETTINGS_LIMITS.scoreSlots
    const bounds = competitions?.bounds
    if (!bounds) return null
    const name = key.slice(2) as keyof CompetitionSettings['bounds']
    return bounds[name] ?? null
  }

  function fieldId(key: FieldKey): string {
    return `resources-${key.replace('.', '-')}`
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
    if (key === 'c.scoreSlots') return queue.runners?.scoreSlots.source ?? null
    if (key === 'c.homeNotebooks') return queue.runners?.homeNotebooks.source ?? null
    if (key === 'c.slots') return queue.slots.source
    if (key === 'c.uploadsPerMinute') return queue.uploadsPerMinute.source
    if (key === 'c.gpuDevices') return queue.gpu.source.devices
    if (key === 'c.gpuPerDevice') return queue.gpu.source.perDevice
    return queue.defaultSources[key.slice(2) as keyof CompetitionSettings['defaultSources']] ?? null
  }

  /** The variable a field falls back to; `null` — none, and "back to" means the default. */
  function envNameOf(key: FieldKey): string | null {
    if (key.startsWith('c.')) return COMPETITION_ENV[key as CompetitionKey] ?? null
    return loaded?.settings[key as ResourceSettingName].envName ?? null
  }

  /** Two card lists hold the same cards: the order is KERNEL_GPUS's on both sides. */
  function sameCards(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((id) => b.includes(id))
  }

  function isDirty(key: FieldKey): boolean {
    if (forgotten.includes(key)) return true
    if (key === 'c.slots') {
      const queue = competitions
      if (!queue) return false
      if (slotsMode !== queue.slots.mode) return true
      return slotsMode === 'fixed' && valueOf('c.slots') !== queue.slots.value
    }
    if (key === 'c.gpuDevices') return competitions !== null && !sameCards(gpuChosen, competitions.gpu.devices)
    if (key === 'c.homeNotebooks') {
      const saved = competitions?.runners?.homeNotebooks.value
      return saved !== undefined && homeChoice !== null && homeChoice !== saved
    }
    return valueOf(key) !== savedOf(key)
  }

  const resourceDirty = $derived(RESOURCE_KEYS.filter((key) => isDirty(key)))
  const competitionDirty = $derived(
    competitions ? [...COMPETITION_KEYS, 'c.slots' as const, 'c.gpuDevices' as const].filter((key) => isDirty(key)) : [],
  )
  /** The machines' two: only when the server said them (a server from before machines has none to edit). */
  const runnerDirty = $derived(competitions?.runners ? (['c.homeNotebooks', 'c.scoreSlots'] as const).filter((key) => isDirty(key)) : [])
  const dirtyCount = $derived(resourceDirty.length + competitionDirty.length + runnerDirty.length)
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
    gpuChosen = [...settings.gpu.devices]
    // The machines' half of the same answer, read only here: on load, after
    // Save and on Discard — never on the machines list's timer.
    if (settings.runners) {
      texts['c.scoreSlots'] = String(settings.runners.scoreSlots.value)
      homeChoice = settings.runners.homeNotebooks.value
    }
    forgotten = forgotten.filter((key) => !key.startsWith('c.'))
  }

  /**
   * A card ticked or unticked. The list keeps KERNEL_GPUS's order, so "the
   * same cards" is a plain comparison, and a tick over a forgotten list is a
   * new decision, the way typing over a forgotten number is.
   */
  function pickCard(id: string, on: boolean): void {
    const cards = competitions?.gpu.cards ?? []
    const next = new Set(gpuChosen)
    if (on) next.add(id)
    else next.delete(id)
    gpuChosen = cards.map((card) => card.id).filter((card) => next.has(card))
    typed('c.gpuDevices')
  }

  /** Blur tidies the text into what will be saved, so "4,25" becomes "4,3" before anyone saves it. */
  function tidy(key: FieldKey): void {
    if (forgotten.includes(key)) return
    texts[key] = display(key, valueOf(key))
  }

  /** "Back to .env": the saved row goes away on Save and the field shows what will answer instead. */
  function forget(key: FieldKey): void {
    if (!forgotten.includes(key)) forgotten = [...forgotten, key]
    /*
     * The runner cards show what answers instead at once, like a room field:
     * the ticks, the holders and the share under them become what Save will
     * leave — the COMPETITION_GPUS cards or none, COMPETITION_GPU_PER_DEVICE
     * or one — instead of the saved ones they kept showing until Save. A
     * server that does not say (CompetitionGpuSettings.fallback) leaves the
     * old picture with the «после сохранения» line under it.
     */
    if (key === 'c.gpuDevices') {
      const fallback = cardsFallback(competitions?.gpu ?? null)
      if (fallback) gpuChosen = fallback.devices
      return
    }
    if (key === 'c.gpuPerDevice') {
      const fallback = perDeviceFallback(competitions?.gpu ?? null)
      texts[key] = fallback ? display(key, fallback.perDevice) : ''
      return
    }
    // The machines' two have no variable behind them: what answers once the
    // saved value is gone is the default, shown at once like a room field's.
    if (key === 'c.scoreSlots') {
      texts[key] = String(SETTINGS_LIMITS.scoreSlots.default)
      return
    }
    if (key === 'c.homeNotebooks') {
      homeChoice = SETTINGS_LIMITS.homeNotebooks.default
      return
    }
    if (key.startsWith('c.')) {
      texts[key] = ''
      return
    }
    const setting = loaded?.settings[key as ResourceSettingName]
    if (setting) texts[key] = display(key, setting.env ?? setting.default)
  }

  /**
   * The word on the button that forgets a saved value: back to .env where a
   * variable answers instead, back to the default where none does. Of the
   * competition half only the runner cards can tell (their fallback):
   * «вернуть умолчание» there gave the COMPETITION_GPUS cards back to
   * submissions.
   */
  function backWord(key: FieldKey): string {
    const fromEnv =
      key === 'c.gpuDevices'
        ? cardsFallback(competitions?.gpu ?? null)?.source === 'env'
        : key === 'c.gpuPerDevice'
          ? perDeviceFallback(competitions?.gpu ?? null)?.source === 'env'
          : !key.startsWith('c.') && !!loaded?.settings[key as ResourceSettingName].envName
    return tr(fromEnv ? 'admin.resourcesTab.backToEnv' : 'admin.resourcesTab.backToDefault')
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
    const competitionPatch: CompetitionSettingsInput & CompetitionGpuSettingsInput & CompetitionRunnerSettingsInput = {}
    // The machines' half of the same body: the switch as itself, the metric
    // lane's places as a number from its field, `null` for either forgotten.
    for (const key of runnerDirty) {
      if (key === 'c.homeNotebooks' && homeChoice !== null) competitionPatch.homeNotebooks = forgotten.includes(key) ? null : homeChoice
      if (key === 'c.scoreSlots') competitionPatch.scoreSlots = forgotten.includes(key) ? null : valueOf(key)
    }
    const runnerSent = runnerDirty.length > 0
    /*
     * «Только метрики» with no machine online leaves every submission
     * waiting: nothing here runs notebooks, and nothing else is there to.
     * Asked before it is saved, not found out from a queue that stopped
     * moving (admin/runners.ts · notebooksOffQuestion).
     */
    const question = notebooksOffQuestion(competitionPatch.homeNotebooks, machinesOnline)
    if (question !== null && !window.confirm(question)) return
    for (const key of competitionDirty) {
      if (key === 'c.slots') {
        competitionPatch.slots = forgotten.includes(key) ? null : slotsMode === 'auto' ? 'auto' : valueOf(key)
        continue
      }
      // The cards' half of the same body (shared/competitions-settings.ts · CompetitionGpuSettingsInput).
      if (key === 'c.gpuDevices') {
        competitionPatch.gpuDevices = forgotten.includes(key) ? null : [...gpuChosen]
        continue
      }
      if (key === 'c.gpuPerDevice') {
        competitionPatch.gpuPerDevice = forgotten.includes(key) ? null : valueOf(key)
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
        askSizesLater()
        // The budget's competition segment is computed from these settings.
        void refreshBudget()
        // The answer carried the machines' two with their sources (applied
        // above); the block reads its list again for what follows from them.
        if (runnerSent) runnersReload += 1
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
    /*
     * With «Тетради на этом сервере» off (as the form now stands) the queue
     * runs only its metric lane here, and the server's budget counts exactly
     * that (routes/admin-resources.ts · competitionShare): «Оценок
     * одновременно» metrics, each the run cushion and the metric's memory
     * (at most 2 GB, at least 512 MB). Promised as slots × a notebook's
     * memory, the bar showed seventy-six gigabytes taken by notebooks that
     * never run on this server — seen on a rehearsal home on 14 Oct 2026.
     */
    const homeOn = homeChoice ?? queue.runners?.homeNotebooks.value ?? true
    if (!homeOn) {
      const scores = valueOf('c.scoreSlots') ?? queue.runners?.scoreSlots.value ?? SETTINGS_LIMITS.scoreSlots.default
      const perScore = cushion + metricMemoryMb(memoryMb)
      return {
        slots: scores,
        memoryMb: scores * perScore,
        cpus: scores * cpus,
        perSlotMb: perScore,
        perSlotCpus: cpus,
        autoSlotMb: memoryMb + cushion,
        metricsOnly: true,
      }
    }
    return {
      slots,
      memoryMb: slots * memoryMb,
      cpus: slots * cpus,
      perSlotMb: memoryMb,
      perSlotCpus: cpus,
      autoSlotMb: memoryMb + cushion,
      metricsOnly: false,
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

  /*
   * The cards, as the server counted them: all of KERNEL_GPUS, the ones a
   * class holds, the ones given to submissions (ResourceBudget.gpus). Not the
   * form's ticks: like the rooms' memory this is a census of what is held,
   * and it catches up after Save (refreshBudget). No bar under Kubernetes,
   * where the cluster has the cards, nor on a machine without any.
   */
  const gpuBar = $derived(cardsBar(loaded?.budget.gpus, competitions?.gpu ?? null))

  /*
   * «Видеокарты для посылок» as the form now stands: the ticked cards, the
   * runs per card typed, and the share that makes — by the server's own rule
   * (admin/runner-cards.ts · shareReadout). The panel promises this number
   * only because the server enforces it.
   */
  const gpuForm = $derived.by(() => {
    const block = competitions?.gpu
    if (!block || block.managed || block.cards.length === 0) return null
    return shareReadout(block.cards, gpuChosen, valueOf('c.gpuPerDevice') ?? block.perDevice)
  })

  /**
   * How a card's holder word is painted: the submissions' in accent; in amber
   * one that changed hands while its holder is still on it — a class on a card
   * given to submissions, a submission on one given back to classes.
   */
  const HOLDER_TONE: Record<CardHolder, string> = {
    runners: 'font-semibold text-accent-text',
    leaving: 'font-semibold text-warning',
    rooms: 'text-muted',
    finishing: 'font-semibold text-warning',
    free: 'text-muted',
  }

  /** The first line under the readout, by its tone (admin/runner-cards.ts · shareLines). */
  const LINE_TONE = { ink: 'text-ink', warning: 'text-warning', muted: 'text-muted' } as const

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
    <span class="admin-label">{text}</span>
    {#if isDirty(key) && !forgotten.includes(key)}
      {@const before = savedOf(key)}
      <span class="text-micro text-warning">
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
  {@const id = fieldId(key)}
  <div class={cn('min-w-0', width)}>
    {@render fieldLabel(key, label, id)}
    {@render fieldControl(key, unit, id, placeholder)}
  </div>
{/snippet}

<!-- The box and its source line without the caption, for a field whose
     caption is wider than its box («Пустая комната отпускает ядро через»):
     the caption then spans the row and the hint stands beside the box. -->
{#snippet fieldControl(key: FieldKey, unit: string, id: string, placeholder = '')}
  {@const source = sourceOf(key)}
  <!-- The shared prefixed field: its frame, height and focus halo are the
       panel's. `!` because the scope paints every affix frame grey at two
       classes, and an unsaved number has to stand out from a saved one. -->
  <div class={cn('admin-affix gap-2', isDirty(key) && '!border-accent')}>
    <input
      {id}
      bind:value={texts[key]}
      oninput={() => typed(key)}
      onblur={() => tidy(key)}
      class="placeholder:font-sans"
      inputmode="decimal"
      autocomplete="off"
      {placeholder}
    />
    <span class="shrink-0 text-2xs text-muted">{unit}</span>
  </div>
  {@render sourceLine(key, source)}
{/snippet}

<!-- Where a value came from, under its control: a number box, or the list of
     runner cards. The variable named is the field's own (envNameOf): every
     competition field used to be captioned COMPETITION_SLOTS. -->
{#snippet sourceLine(key: FieldKey, source: ResourceSource | null)}
  <p class="admin-meta mt-1.5 min-h-5">
    {#if forgotten.includes(key)}
      <span class="text-warning">{tr('admin.resourcesTab.willForget')}</span>
    {:else if source === 'saved'}
      {tr('admin.resourcesTab.sourceSaved')}
      {#if isOwner}
        ·
        <button type="button" class="text-accent-text hover:underline" onclick={() => forget(key)}>
          {backWord(key)}
        </button>
      {/if}
    {:else if source === 'env'}
      {tr('admin.resourcesTab.sourceEnv')} <span class="font-mono">{envNameOf(key) ?? ''}</span>
    {:else if source === 'default'}
      {tr('admin.resourcesTab.sourceDefault')}
    {/if}
  </p>
{/snippet}

{#snippet legend(tone: string, title: string, detail: string)}
  <div class="min-w-[150px]">
    <div class="flex items-center gap-2">
      <span class={cn('size-2.5 shrink-0', tone)}></span>
      <span class="text-ui font-semibold text-ink">{title}</span>
    </div>
    <p class="mt-0.5 pl-[18px] font-mono text-micro text-muted">{detail}</p>
  </div>
{/snippet}

<!--
  «Видеокарты для посылок» (Paper 15 · G1): which of KERNEL_GPUS the owner
  gives to competition submissions, how many runs share one, and the share of
  video memory that makes. A card given here leaves the classes' pool whole —
  a class and submissions never meet on one card. Under Kubernetes the
  cluster gives the cards (Helm), and this form has nothing to give.
-->
{#snippet runnerCards(gpu: CompetitionSettings['gpu'])}
  <div class="mt-5 flex flex-col gap-3 border-t border-line pt-5">
    <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <p class="admin-label">{tr('admin.resourcesTab.gpuTitle')}</p>
      {#if !gpu.managed && gpu.cards.length > 0}
        <span class="admin-meta min-w-0">
          {tr('admin.resourcesTab.gpuCardsHere', { count: gpu.cards.length })} ·
          <span class="break-all font-mono">KERNEL_GPUS={gpu.cards.map((card) => card.id).join(',')}</span>
        </span>
      {/if}
    </div>
    {#if gpu.managed}
      <p class="text-2xs text-muted">{tr('admin.resourcesTab.gpuCluster')}</p>
    {:else if gpu.cards.length === 0}
      <p class="text-2xs text-muted">{tr('admin.resourcesTab.gpuNoCards')}</p>
    {:else}
      <!-- One lane for the names down the list: an index («GPU 0») is narrow,
           a UUID or MIG id («MIG-5c8e9a71…») takes a wider lane for every row. -->
      {@const lane = gpu.cards.every((card) => /^\d+$/.test(card.id)) ? 'w-[72px]' : 'w-[136px]'}
      <div>
        <div class="flex flex-col border border-line">
          {#each gpu.cards as card (card.id)}
            {@const picked = gpuChosen.includes(card.id)}
            {@const holder = cardHolder(card, picked)}
            <label
              class={cn(
                'flex min-h-11 flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-line px-4 py-2.5 first:border-t-0',
                picked && 'bg-accent/[0.07]',
                isOwner && 'cursor-pointer',
              )}
            >
              <Check
                checked={picked}
                label={tr('admin.resourcesTab.gpuPick', { card: cardWord(card.id) })}
                onchange={(on) => pickCard(card.id, on)}
              />
              <span class={cn('shrink-0 truncate font-mono text-2xs font-semibold text-ink', lane)} title={card.id}>{cardWord(card.id)}</span>
              <span class="min-w-0 flex-1 basis-[180px] text-2xs text-ink">{cardFacts(card)}</span>
              <span class={cn('ml-auto shrink-0 text-right text-micro', HOLDER_TONE[holder])}>{holderWord(holder)}</span>
            </label>
          {/each}
        </div>
        {@render sourceLine('c.gpuDevices', sourceOf('c.gpuDevices'))}
      </div>

      <div class="flex flex-wrap items-start gap-4">
        {@render field(
          'c.gpuPerDevice',
          tr('admin.resourcesTab.gpuPerDevice'),
          tr('admin.resourcesTab.gpuPerDeviceUnit', { min: gpu.bounds.perDevice.min, max: gpu.bounds.perDevice.max }),
          'w-[250px] max-w-full',
        )}
        {#if gpuForm && gpuForm.chosen > 0}
          <!-- 26px down: the caption line (20) and its gap (6), so the
               readout stands level with the box beside it. -->
          <div class="mt-[26px] flex min-h-10 min-w-[220px] flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span class="admin-label">{tr('admin.resourcesTab.gpuSlice')}</span>
            <span class="font-mono text-gauge font-bold text-ink">{shareGauge(gpuForm)}</span>
            <span class="text-2xs text-muted">{shareDetail(gpuForm)}</span>
          </div>
        {/if}
      </div>

      {#if gpuForm}
        {@const lines = shareLines(gpuForm)}
        <div class="flex max-w-[760px] flex-col gap-1">
          <p class={cn('text-2xs', LINE_TONE[lines.tone])}>{lines.lead}</p>
          {#if lines.note}
            <p class="text-micro text-muted">{lines.note}</p>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
{/snippet}

<!--
  The machines' two settings (Paper 16 · M1): whether this server runs
  notebooks too or only scores what the machines send back, and how many
  metrics it runs at once. Drawn by this form, inside the machines block,
  read from the settings door with where each came from, and saved by its
  Save with the queue's half of the body. Not drawn until that door answered:
  a switch with no saved value behind it would be measured against nothing.
-->
{#snippet runnerSettings()}
  {#if competitions?.runners}
    {@const saved = competitions.runners}
    {@const homeOn = homeChoice ?? saved.homeNotebooks.value}
    <div class="flex flex-wrap items-start gap-x-4 gap-y-4">
      <div class="min-w-0 flex-[1_1_320px]">
        <p class="mb-1.5 flex items-baseline gap-2">
          <span class="admin-label">{tr('admin.runners.homeNotebooks')}</span>
          {#if isDirty('c.homeNotebooks') && !forgotten.includes('c.homeNotebooks')}
            <span class="text-micro text-warning">
              {tr('admin.resourcesTab.was', {
                value: saved.homeNotebooks.value ? tr('admin.runners.homeNotebooks.on') : tr('admin.runners.homeNotebooks.off'),
              })}
            </span>
          {/if}
        </p>
        <div>
          <Choice
            size="lg"
            options={[
              { value: 'on', label: tr('admin.runners.homeNotebooks.on') },
              { value: 'off', label: tr('admin.runners.homeNotebooks.off') },
            ]}
            value={homeOn ? 'on' : 'off'}
            onchange={(value) => {
              homeChoice = value === 'on'
              typed('c.homeNotebooks')
            }}
          />
        </div>
        <p class="admin-meta mt-1.5">{homeOn ? tr('admin.runners.homeNotebooks.onNote') : tr('admin.runners.homeNotebooks.offNote')}</p>
        {@render sourceLine('c.homeNotebooks', sourceOf('c.homeNotebooks'))}
      </div>
      <div class="w-[220px] max-w-full">
        {@render fieldLabel('c.scoreSlots', tr('admin.runners.scoreSlots'), fieldId('c.scoreSlots'))}
        <div class={cn('admin-affix gap-2', isDirty('c.scoreSlots') && '!border-accent')}>
          <input
            id={fieldId('c.scoreSlots')}
            bind:value={texts['c.scoreSlots']}
            oninput={() => typed('c.scoreSlots')}
            onblur={() => tidy('c.scoreSlots')}
            inputmode="numeric"
            autocomplete="off"
          />
          <span class="shrink-0 text-2xs text-muted">{tr('admin.runners.scoreSlots.unit')}</span>
        </div>
        <p class="admin-meta mt-1.5">
          {tr('admin.runners.scoreSlots.note', { min: SETTINGS_LIMITS.scoreSlots.min, max: SETTINGS_LIMITS.scoreSlots.max })}
        </p>
        {@render sourceLine('c.scoreSlots', sourceOf('c.scoreSlots'))}
      </div>
    </div>
    {#if !homeOn && machinesOnline === 0}
      <!-- This server runs no notebooks — or will once this is saved — and
           no machine answers: every submission waits, and the console says
           so row by row. Said here, where the switch is, as soon as it is
           turned, not after Save. -->
      <p class="mt-3 flex items-start gap-2 text-2xs font-semibold text-warning" role="status">
        <Icon name="alert" size={14} class="mt-0.5 shrink-0" />
        <span>{tr('admin.runners.nobodyRuns')}</span>
      </p>
    {/if}
  {/if}
{/snippet}

{#snippet actions()}
  {#if isOwner}
    {#if justSaved && !dirty}
      <span class="admin-label flex items-center gap-1 text-positive">
        <Icon name="check" size={13} />
        {tr('admin.saved')}
      </span>
    {:else if dirty}
      <span class="admin-label text-warning">
        {tr('admin.resourcesTab.unsaved', { count: dirtyCount })}
      </span>
      <button type="button" class="btn-ghost" onclick={discard} disabled={saving}>{tr('admin.discard')}</button>
    {/if}
    <!-- flex-auto on a phone, not flex-1: from a zero basis the button stayed
         on the status word's line and min-w-[112px] let it clip its label;
         from its own width it drops to a line of its own and fills it. -->
    <button type="button" class="btn-primary min-w-[112px] whitespace-nowrap max-[640px]:flex-auto" onclick={save} disabled={!dirty || saving}>
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
      <p class="text-ui text-danger" role="alert">{loadError}</p>
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
                <span class="admin-section-title">{tr('admin.resourcesTab.memory')}</span>
                <span class="font-mono text-gauge font-bold text-ink">{gb(memory.promised)}</span>
                <span class="text-2xs text-muted">{tr('admin.resourcesTab.ofPromisedGb', { total: gb(memory.total) })}</span>
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
                {@render legend('bg-accent', tr('admin.resourcesTab.competitions'), tr(competitionShare.metricsOnly ? 'admin.resourcesTab.metricsDetail' : 'admin.resourcesTab.competitionsDetail', { count: competitionShare.slots, memory: gb(competitionShare.perSlotMb) }))}
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
                <span class="admin-section-title">{tr('admin.resourcesTab.cores')}</span>
                <span class="font-mono text-gauge font-bold text-ink">{cores.promised}</span>
                <span class="text-2xs text-muted">{tr('admin.resourcesTab.ofPromised', { total: cores.total })}</span>
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

          <!-- The cards (Paper 15 · G1): a card is a class's or the
               submissions', whole, never both — so the bar counts cards, and
               the share a submission gets on one is said beside it. -->
          {#if gpuBar}
            <div>
              <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div class="flex items-baseline gap-2.5">
                  <span class="admin-section-title">{tr('admin.resourcesTab.gpus')}</span>
                  <span class="font-mono text-gauge font-bold text-ink">{gpuBar.total}</span>
                  <span class="text-2xs text-muted">{tr('admin.resourcesTab.gpusOnMachine', { count: gpuBar.total })}</span>
                </div>
                <span class="text-ui font-semibold text-positive">{gpuBar.status}</span>
              </div>
              <div class="mt-2.5 flex h-3 gap-0.5" aria-hidden="true">
                <span class="bg-primary" style:width={share(gpuBar.rooms, gpuBar.total)}></span>
                <span class="bg-accent" style:width={share(gpuBar.runners, gpuBar.total)}></span>
                {#if gpuBar.free > 0}
                  <span class="flex-1 border border-dashed border-line bg-surface"></span>
                {/if}
              </div>
              <div class="mt-3 flex flex-wrap gap-x-7 gap-y-3">
                {@render legend('bg-primary', tr('admin.resourcesTab.gpuClasses'), gpuBar.roomsDetail)}
                {@render legend('bg-accent', tr('admin.resourcesTab.gpuSubmissions'), gpuBar.runnersDetail)}
                {@render legend('border border-dashed border-faint bg-surface', tr('admin.resourcesTab.free'), gpuBar.freeDetail)}
              </div>
              <p class="mt-2 text-2xs text-muted">{tr('admin.resourcesTab.gpusNote')}</p>
            </div>
          {/if}

          {#each diskRows as row (row.key)}
            {@const used = Math.max(0, row.space.totalBytes - row.space.freeBytes)}
            <div>
              <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div class="flex items-baseline gap-2.5">
                  <span class="admin-section-title">{row.label}</span>
                  <span class="font-mono text-gauge font-bold text-ink">{gbOfBytes(used)}</span>
                  <span class="text-2xs text-muted">{tr('admin.resourcesTab.ofUsedGb', { total: gbOfBytes(row.space.totalBytes) })}</span>
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

    <!-- What holds the machine right now, and the owner's stop. Outside the
         fieldset below: a teacher reads it too, and a disabled fieldset
         would grey out the notebook lists they may open. -->
    <Section
      title={tr('admin.resourcesTab.running.title')}
      description={isOwner ? tr('admin.resourcesTab.running.note') : tr('admin.resourcesTab.running.noteTeacher')}
    >
      <RunningKernels roomIdleMin={savedOf('roomIdleMin')} onchange={() => void refreshBudget()} />
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
              <span class="font-mono text-2xs">{entry.environment} = {gb(entry.mb)} {tr('admin.resourcesTab.unitGb')}</span>{i < loaded.perEnvironmentMemory.length - 1 ? ', ' : ''}
            {/each}
          </p>
        {/if}
        <!-- How long an empty room keeps its kernels (Paper K5). Before this
             it was a hard-coded two hours, and three idle rooms held 12 GB of
             a 15 GB machine for the whole of it. 0 is a real value here:
             never. -->
        <div class="mt-4">
          {@render fieldLabel('roomIdleMin', tr('admin.resourcesTab.roomIdle'), fieldId('roomIdleMin'))}
          <div class="flex flex-wrap items-start gap-4">
            <div class="w-[200px] min-w-0">
              {@render fieldControl('roomIdleMin', tr('admin.resourcesTab.unitRoomIdleMinutes'), fieldId('roomIdleMin'))}
            </div>
            <p class="min-w-[220px] max-w-[420px] flex-1 text-2xs text-muted">{tr('admin.resourcesTab.roomIdleNote')}</p>
          </div>
        </div>
      </Section>

      <Section title={tr('admin.resourcesTab.notebooksTitle')} description={tr('admin.resourcesTab.notebooksNote')}>
        <div class="flex flex-wrap items-start gap-4">
          {@render field('ownMemoryMb', tr('admin.resourcesTab.memoryPerClass'), tr('admin.resourcesTab.unitGb'), 'w-[200px]', tr('admin.resourcesTab.sameAsRoom'))}
          {@render field('ownCpus', tr('admin.resourcesTab.cores'), tr('admin.resourcesTab.unitCores'), 'w-[160px]', tr('admin.resourcesTab.sameAsRoom'))}
          <!-- The estimate the owner would otherwise do on a napkin: one
               container for the class, divided by the people in it.
               26px down: the caption line beside it (20) and its gap (6), so
               the box stands level with the fields. -->
          <div class="mt-[26px] flex min-h-10 min-w-[260px] flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 bg-surface px-3.5 py-2 text-ui text-ink">
            <label for="resources-class-size">{tr('admin.resourcesTab.classOf')}</label>
            <input
              id="resources-class-size"
              bind:value={classSizeText}
              onblur={rememberClassSize}
              class="w-10 border-b-[1.5px] border-ink bg-transparent px-1 text-center font-mono text-2xs outline-none"
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
          <p class="mt-[26px] min-w-[220px] flex-1 text-2xs text-muted">{tr('admin.resourcesTab.ownMaxNote')}</p>
        </div>
      </Section>

      <Section title={tr('admin.resourcesTab.competitionsTitle')} description={tr('admin.resourcesTab.competitionsNote')}>
        {#if competitionError}
          <p class="text-ui text-danger" role="alert">{competitionError}</p>
          <button type="button" class="btn-outline mt-3" onclick={() => void load()}>{tr('admin.try.again')}</button>
        {:else if competitions}
          {#if dockerOnlyIgnored && competitions.runners?.homeNotebooks.value === false}
            <!-- Kubernetes: the broker runs the submissions and no machine
                 can (§1), so the machines block with the switch is not drawn
                 here. Yet the setting can still be off — saved through the
                 door, or carried over in a database from a VM home whose
                 machines ran the notebooks — and with it off the pump takes
                 no notebook at all and every submission waits. The way back
                 is said here: the switch goes on in the form, and Save sends
                 it with the rest. -->
            <div class="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2.5 border-l-[3px] border-warning bg-warning/[0.07] px-3.5 py-3" role="status">
              <Icon name="alert" size={15} class="shrink-0 text-warning" />
              <p class="min-w-0 flex-1 basis-[240px] text-2xs text-ink">
                {homeChoice === true ? tr('admin.resourcesTab.brokerNotebooksPending') : tr('admin.resourcesTab.brokerNotebooksOff')}
              </p>
              {#if homeChoice !== true}
                <button
                  type="button"
                  class="btn-outline shrink-0 max-[640px]:w-full"
                  onclick={() => {
                    homeChoice = true
                    typed('c.homeNotebooks')
                  }}
                >
                  {tr('admin.resourcesTab.brokerNotebooksOn')}
                </button>
              {/if}
            </div>
          {/if}
          <p class="admin-label mb-1.5">{tr('admin.resourcesTab.slots')}</p>
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
          <p class="mt-2 text-2xs text-muted">{tr('admin.resourcesTab.defaultsNote')}</p>
          {#if competitionCeiling}
            <p class="mt-1 text-2xs text-muted">{competitionCeiling}</p>
          {/if}
          {#if competitionPastBound}
            <p class="mt-1 text-2xs text-muted">{competitionPastBound}</p>
          {/if}

          <div class="mt-4 flex flex-wrap items-start gap-4">
            {@render field('c.uploadsPerMinute', tr('admin.resourcesTab.uploads'), tr('admin.resourcesTab.unitPerMinute'), 'w-[376px] max-w-full')}
            <p class="mt-[26px] min-w-[220px] flex-1 text-2xs text-muted">{tr('admin.resourcesTab.uploadsNote')}</p>
          </div>

          {@render runnerCards(competitions.gpu)}
        {:else}
          <!-- The rooms half drew the page; this one is still asking the cards. -->
          <p class="text-ui text-muted">{tr('common.loading')}</p>
        {/if}
      </Section>

      <!-- The machines that run submissions (Paper 16 · M1): beside the
           queue's settings, since they are where its notebooks run. The
           owner's only: every door behind the block refuses a teacher. Not
           under Kubernetes: the broker runs submissions there (§1 keeps its
           path as it is), a machine needs this server's Docker to prepare
           and score, and «только метрики» there stopped every notebook with
           nothing left to run one. -->
      {#if isOwner && !dockerOnlyIgnored}
        <Section title={tr('admin.runners.title')} description={tr('admin.runners.note')}>
          <Runners {navigate} settings={runnerSettings} onfleet={(fleet) => (machinesOnline = fleet.online)} reload={runnersReload} />
        </Section>
      {/if}

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
