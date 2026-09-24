<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  /**
   * Instance-wide oracle settings.
   *
   * Three rules shape this screen.
   *
   * A preset SUGGESTS. It fills a base URL or a model only into a field that is
   * empty or still holding the last preset's suggestion; anything a teacher
   * typed is offered a replacement, never given one.
   *
   * The connection test runs against the SAVED configuration — the server reads
   * it back out of SQLite — so the page says so plainly whenever the form has
   * drifted ahead of what was saved, rather than reporting a green tick about
   * settings that are not installed anywhere.
   *
   * And the key is never guessed at. Sending '' clears the override and hands
   * the instance back to OPENAI_API_KEY; omitting the field leaves it alone.
   * Those are different sentences, so neither is ever said by accident: the
   * field goes into the patch only when the teacher typed a key or asked for
   * the stored one to go.
   */
  import { onMount } from 'svelte'
  import {
    LIMITS,
    PROVIDER_PRESETS,
    type AiProviderId,
    type OracleMode,
    type OracleSettings,
    type OracleTestResult,
    type ReasoningEffort,
    type OracleUsage,
    type UpdateOracleRequest,
  } from '@shared/admin'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Choice from '@/admin/ui/Choice.svelte'
  import Section from '@/admin/ui/Section.svelte'
  import Icon, { type IconName } from '@/components/ui/Icon.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { uploadMb } from '@/admin/panel'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { cn } from '@/lib/utils'

  interface Option {
    value: string
    label: string
    hint?: string
  }

  const PROVIDERS: Option[] = $derived((Object.keys(PROVIDER_PRESETS) as AiProviderId[]).map((id) => ({
    value: id,
    label: id === 'custom' ? tr("admin.custom.provider") : PROVIDER_PRESETS[id].label,
  })))

  const EFFORTS: Option[] = $derived([
    { value: 'instant', label: tr('common.reasoningInstant'), hint: tr('admin.effort.instant') },
    { value: 'normal', label: tr('common.reasoningNormal'), hint: tr('admin.effort.normal') },
    { value: 'deep', label: tr('common.reasoningDeep'), hint: tr('admin.effort.deep') },
  ])

  const MODES: Option[] = $derived([
    { value: 'off', label: tr("admin.off"), hint: tr("admin.oracle.disabled") },
    // "Asked to give hints", not "there will be no solution": the mode rests
    // on the wording of the request to the model, and we cannot promise on
    // its behalf.
    { value: 'hints', label: tr("admin.hints.only"), hint: tr("admin.instructed.to.give.hints.761") },
    { value: 'full', label: tr("admin.full.answers"), hint: tr("admin.explains.and.writes.code.764") },
  ])

  /**
   * The quick actions a cell offers, plus 'ask' for anything typed by hand.
   *
   * And 'work' — the room's "do it" mode. It used to be recorded as 'ask'
   * and was indistinguishable from a question in the breakdown, although one
   * such turn goes to the model up to twelve times: the most expensive row
   * stood without a label.
   */
  const ACTION_LABELS: Record<string, string> = $derived({
    ask: tr("admin.questions"),
    work: tr("admin.file.tasks"),
    explain: tr("admin.explain"),
    fix: tr("admin.fix.my.error"),
    debug: tr("admin.debug"),
    improve: tr("admin.improve"),
    hint: tr("admin.hint"),
  })

  const counted = $derived(new Intl.NumberFormat(getLocale()))

  /** Compact units follow the instance language; decimals follow its number format. */
  function compact(value: number): string {
    if (value >= 1_000_000) return tr("admin.m", { p0: new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value / 1_000_000) })
    if (value >= 10_000) return tr("admin.k", { p0: Math.round(value / 1000) })
    return counted.format(value)
  }

  /**
   * A narrow no-break space, which `whole()` strips again: the field can show
   * 20 000 and still be typed into as 20000.
   */
  function grouped(value: number): string {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  }

  /* --------------------------------------------------------------- state */

  /** The server's last word, and the only thing `dirty` is ever measured against. */
  let loaded = $state<OracleSettings | null>(null)
  let loadErrorText = $state<(() => string | null) | null>(null)
  const loadError = $derived(loadErrorText?.() ?? null)

  let provider = $state<AiProviderId>('custom')
  let baseUrl = $state('')
  let model = $state('')
  let defaultMode = $state<OracleMode>('full')
  let houseRules = $state('')
  let questionsText = $state('')
  let slowText = $state('')
  let contextText = $state('')
  let stepsText = $state('')
  let sendNames = $state(true)
  let reasoningEffort = $state<ReasoningEffort>('normal')

  let replacingKey = $state(false)
  let newKey = $state('')
  let clearKey = $state(false)
  /** A preset's suggestion that was NOT applied, because a typed value stood in the way. */
  let offeredBaseUrl = $state<string | null>(null)
  let offeredModel = $state<string | null>(null)

  let saving = $state(false)
  let saveErrorText = $state<(() => string | null) | null>(null)
  const saveError = $derived(saveErrorText?.() ?? null)
  let justSaved = $state(false)

  /*
   * Writing here is owner-only on the server, because baseUrl decides which
   * host receives the instance's API key. Offering a teacher the form and
   * failing them on Save would be a worse lie than not offering it.
   */
  const isOwner = $derived(adminAuth.isOwner)
  let noteTimer: ReturnType<typeof setTimeout> | undefined

  let testing = $state(false)
  let test = $state<OracleTestResult | null>(null)
  /** Which saved configuration the result above describes. */
  let testedFor = $state<string | null>(null)

  let usage = $state<OracleUsage | null>(null)
  let usageErrorText = $state<(() => string | null) | null>(null)
  const usageError = $derived(usageErrorText?.() ?? null)

  /** Bound so pressing Replace lands the caret in the field it just opened. */
  let keyInput = $state<HTMLInputElement | null>(null)

  /* ------------------------------------------------------------- derived */

  const ready = $derived(loaded !== null)
  const preset = $derived(PROVIDER_PRESETS[provider])
  const storedMask = $derived(loaded?.apiKeyMasked ?? null)
  const fromEnvironment = $derived(loaded?.keyFromEnvironment ?? false)
  /** Only an override can be removed: the environment's key is not ours to delete. */
  const canRemoveKey = $derived(storedMask !== null && !fromEnvironment)

  const questions = $derived(
    whole(questionsText, LIMITS.questionsPerHour, loaded?.questionsPerHour ?? LIMITS.questionsPerHour.default),
  )
  const slow = $derived(
    whole(slowText, LIMITS.slowModeSeconds, loaded?.slowModeSeconds ?? LIMITS.slowModeSeconds.default),
  )
  const context = $derived(
    whole(contextText, LIMITS.contextChars, loaded?.contextChars ?? LIMITS.contextChars.default),
  )

  const steps = $derived(whole(stepsText, LIMITS.agentSteps, loaded?.agentSteps ?? LIMITS.agentSteps.default))

  const dirty = $derived.by(() => {
    const saved = loaded
    if (!saved) return false
    return (
      provider !== saved.provider ||
      baseUrl.trim() !== saved.baseUrl ||
      model.trim() !== saved.model ||
      defaultMode !== saved.defaultMode ||
      houseRules.trim() !== saved.houseRules ||
      questions !== saved.questionsPerHour ||
      slow !== saved.slowModeSeconds ||
      context !== saved.contextChars ||
      steps !== (saved.agentSteps ?? LIMITS.agentSteps.default) ||
      sendNames !== (saved.sendNames ?? true) ||
      reasoningEffort !== (saved.reasoningEffort ?? 'normal') ||
      newKey.length > 0 ||
      clearKey
    )
  })

  const fresh = $derived(loaded !== null && test !== null && testedFor === signature(loaded))
  const testMessage = $derived(test?.message ?? '')
  const testOk = $derived(test?.ok ?? false)

  interface Chip {
    tone: string
    icon: IconName | null
    spin: boolean
    text: string
  }

  const chip = $derived.by<Chip | null>(() => {
    if (testing) {
      return { tone: 'bg-surface text-muted', icon: 'spinner', spin: true, text: tr("admin.testing") }
    }
    if (!ready) return null
    // A stale result is not a status: it describes settings that have since been
    // replaced, so the chip goes back to admitting it does not know.
    const result = fresh ? test : null
    if (result === null) {
      return { tone: 'bg-surface text-muted', icon: null, spin: false, text: tr("admin.not.tested") }
    }
    if (!result.ok) {
      return { tone: 'bg-danger/[0.05] text-danger', icon: 'x', spin: false, text: tr("admin.not.connected") }
    }
    return {
      tone: 'bg-positive/10 text-positive',
      icon: 'check',
      spin: false,
      text: result.ms === null ? tr("admin.connected") : tr("admin.connected.ms", { p0: result.ms }),
    }
  })

  const usageReady = $derived(usage !== null)
  const usageSince = $derived(usage?.since ?? 0)
  const usageQuestions = $derived(usage?.questions ?? 0)
  const usageTokens = $derived(usage?.tokens ?? null)
  const usageSeminars = $derived(usage?.seminarsWithQuestions ?? 0)

  /** Bars are drawn against the busiest action, so the smallest one is still visible. */
  const breakdown = $derived.by(() => {
    const rows = Object.entries(usage?.byAction ?? {}).map(([action, count]) => ({ action, count }))
    rows.sort((a, b) => b.count - a.count)
    const top = rows[0]?.count ?? 0
    return rows.map((row) => ({
      action: row.action,
      count: row.count,
      label: ACTION_LABELS[row.action] ?? row.action,
      share: top > 0 ? (row.count / top) * 100 : 0,
    }))
  })

  /* --------------------------------------------------------------- plumbing */

  onMount(() => {
    void loadSettings()
    void loadUsage()
    return () => clearTimeout(noteTimer)
  })

  // The field is created by the same click that asks for it, so the focus has
  // to wait for the element rather than ride along with the button handler.
  $effect(() => {
    if (replacingKey) keyInput?.focus()
  })

  function messageFor(cause: unknown): string {
    if (cause instanceof AdminApiError) return cause.message
    if (cause instanceof Error) return cause.message
    return tr("admin.the.server.did.not.answer")
  }

  /**
   * The upload limit — the one the server named.
   *
   * While it is missing from the response (an older build), the variable's
   * name stays in place of the value: naming "50 MB" at random on an
   * instance set to 200 is the same lie, only with a number.
   */
  const maxUploadBytes = $derived(adminAuth.state?.maxUploadBytes ?? null)

  /**
   * A dead cookie is the shell's business: re-reading `me` sends them to sign in.
   *
   * With a reason: the cookie reached the server and was rejected — a
   * rotated link or a removed account. Otherwise the sign-in screen
   * explained it with the browser's cookie settings, where there is nothing
   * to fix.
   */
  function reauthenticate(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') {
      void adminAuth.refresh('revoked')
    }
  }

  /** What the test result is about. Change any of it and the last test stops speaking for it. */
  function signature(settings: OracleSettings): string {
    return [
      settings.provider,
      settings.baseUrl,
      settings.model,
      settings.apiKeyMasked ?? '',
      String(settings.keyFromEnvironment),
    ].join('\n')
  }

  function whole(text: string, range: { min: number; max: number }, fallback: number): number {
    const parsed = Number(text.replace(/[\s_]/g, ''))
    if (text.trim() === '' || !Number.isFinite(parsed)) return fallback
    return Math.min(Math.max(Math.round(parsed), range.min), range.max)
  }

  async function loadSettings(): Promise<void> {
    try {
      apply(await adminApi.oracle())
      loadErrorText = null
    } catch (cause: unknown) {
      loadErrorText = () => (messageFor(cause))
      reauthenticate(cause)
    }
  }

  async function loadUsage(): Promise<void> {
    try {
      usage = await adminApi.oracleUsage()
      usageErrorText = null
    } catch (cause: unknown) {
      usageErrorText = () => (messageFor(cause))
    }
  }

  /** The server's answer is the form: it trims, clamps and masks, and we show that. */
  function apply(settings: OracleSettings): void {
    loaded = settings
    provider = settings.provider
    baseUrl = settings.baseUrl
    model = settings.model
    defaultMode = settings.defaultMode
    houseRules = settings.houseRules
    questionsText = String(settings.questionsPerHour)
    slowText = String(settings.slowModeSeconds)
    contextText = grouped(settings.contextChars)
    stepsText = String(settings.agentSteps ?? LIMITS.agentSteps.default)
    sendNames = settings.sendNames ?? true
    reasoningEffort = settings.reasoningEffort ?? 'normal'
    replacingKey = false
    newKey = ''
    clearKey = false
    offeredBaseUrl = null
    offeredModel = null
  }

  /**
   * A preset may fill a field that is empty or that still holds the previous
   * preset's suggestion — that value was ours, so taking it back costs nobody
   * anything. A value the teacher typed is left alone and the suggestion is
   * offered underneath instead.
   */
  function fill(current: string, previous: string, suggestion: string): { value: string; offer: string | null } {
    const typed = current.trim()
    if (suggestion === '' || typed === suggestion) return { value: current, offer: null }
    if (typed === '' || typed === previous) return { value: suggestion, offer: null }
    return { value: current, offer: suggestion }
  }

  function pickProvider(value: string): void {
    if (!(value in PROVIDER_PRESETS)) return
    const next = value as AiProviderId
    if (next === provider) return

    const before = PROVIDER_PRESETS[provider]
    const after = PROVIDER_PRESETS[next]
    provider = next

    const url = fill(baseUrl, before.baseUrl, after.baseUrl)
    baseUrl = url.value
    offeredBaseUrl = url.offer

    const name = fill(model, before.model, after.model)
    model = name.value
    offeredModel = name.offer
  }

  function useOfferedBaseUrl(): void {
    if (offeredBaseUrl === null) return
    baseUrl = offeredBaseUrl
    offeredBaseUrl = null
  }

  function useOfferedModel(): void {
    if (offeredModel === null) return
    model = offeredModel
    offeredModel = null
  }

  function startReplace(): void {
    clearKey = false
    replacingKey = true
    newKey = ''
  }

  function cancelReplace(): void {
    replacingKey = false
    newKey = ''
  }

  function markForRemoval(): void {
    replacingKey = false
    newKey = ''
    clearKey = true
  }

  function discard(): void {
    if (loaded) apply(loaded)
    saveErrorText = null
  }

  function flashSaved(): void {
    justSaved = true
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => (justSaved = false), 2500)
  }

  async function save(): Promise<void> {
    const saved = loaded
    if (!saved || !dirty || saving) return

    const patch: UpdateOracleRequest = {}
    if (provider !== saved.provider) patch.provider = provider
    if (baseUrl.trim() !== saved.baseUrl) patch.baseUrl = baseUrl.trim()
    if (model.trim() !== saved.model) patch.model = model.trim()
    if (defaultMode !== saved.defaultMode) patch.defaultMode = defaultMode
    if (houseRules.trim() !== saved.houseRules) patch.houseRules = houseRules.trim()
    if (questions !== saved.questionsPerHour) patch.questionsPerHour = questions
    if (slow !== saved.slowModeSeconds) patch.slowModeSeconds = slow
    if (context !== saved.contextChars) patch.contextChars = context
    if (steps !== (saved.agentSteps ?? LIMITS.agentSteps.default)) patch.agentSteps = steps
    if (sendNames !== (saved.sendNames ?? true)) patch.sendNames = sendNames
    if (reasoningEffort !== (saved.reasoningEffort ?? 'normal')) patch.reasoningEffort = reasoningEffort
    if (clearKey) patch.apiKey = ''
    else if (newKey.length > 0) patch.apiKey = newKey

    saving = true
    saveErrorText = null
    try {
      apply(await adminApi.updateOracle(patch))
      flashSaved()
    } catch (cause: unknown) {
      saveErrorText = () => (messageFor(cause))
      reauthenticate(cause)
    } finally {
      saving = false
    }
  }

  /**
   * Test what is on screen, saving it first if that is what it takes.
   *
   * The test calls the provider, and the provider only knows the SAVED
   * settings — so pressing Test with a freshly typed key used to report "no API
   * key is set" while the key sat right there in the field. A line of small
   * print explained it; the line was read and the trap sprung anyway, which
   * makes it the button's fault. Now the button says what it will do, and does
   * the thing the person meant.
   */
  async function saveAndTest(): Promise<void> {
    if (dirty) {
      await save()
      // A save that failed has already put its reason on screen. Testing after
      // it would produce a second, less useful message about the same thing.
      if (saveError) return
    }
    await runTest()
  }

  async function runTest(): Promise<void> {
    const saved = loaded
    if (!saved || testing) return
    // Captured before the round trip: a save landing meanwhile must not let the
    // result claim to describe a configuration it never saw.
    const about = signature(saved)
    testing = true
    try {
      test = await adminApi.testOracle()
    } catch (cause: unknown) {
      test = { ok: false, ms: null, message: messageFor(cause), model: null }
      reauthenticate(cause)
    } finally {
      testedFor = about
      testing = false
    }
  }
</script>

{#snippet fieldLabel(text: string, forId: string)}
  <label for={forId} class="mb-1.5 block text-2xs font-semibold uppercase tracking-label text-muted">
    {text}
  </label>
{/snippet}

{#snippet offer(suggestion: string, accept: () => void, dismiss: () => void)}
  <p class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted">
    <span>
      {provider === 'custom' ? tr('admin.custom.provider') : preset.label} {tr("admin.suggests")} <span class="font-mono text-code text-ink">{suggestion}</span>
    </span>
    <button type="button" class="font-semibold text-accent-text hover:underline" onclick={accept}>
      {tr("admin.use.it")}
    </button>
    <button type="button" class="text-muted hover:text-ink" onclick={dismiss}>{tr("admin.keep.mine")}</button>
  </p>
{/snippet}

{#snippet tile(value: string, caption: string)}
  <div class="px-4 py-3.5">
    <p class="text-head font-bold tracking-tight text-ink">{value}</p>
    <p class="mt-1 text-2xs text-muted">{caption}</p>
  </div>
{/snippet}

{#snippet actions()}
  {#if chip}
    <span
      class={cn(
        'flex items-center gap-1.5 px-2.5 py-1.5 text-2xs font-bold uppercase tracking-caps',
        chip.tone,
      )}
    >
      {#if chip.icon}
        <Icon name={chip.icon} size={13} class={cn('shrink-0', chip.spin && 'animate-spin')} />
      {/if}
      {chip.text}
    </span>
  {/if}

  {#if isOwner}
    {#if justSaved && !dirty}
      <span class="flex items-center gap-1 text-2xs font-semibold uppercase tracking-label text-positive">
        <Icon name="check" size={13} />
        {tr("admin.saved")}
      </span>
    {:else if dirty}
      <span class="text-2xs font-semibold uppercase tracking-label text-warning">{tr("admin.unsaved")}</span>
      <button type="button" class="btn-ghost" onclick={discard} disabled={saving}>{tr("admin.discard")}</button>
    {/if}

    <button type="button" class="btn-primary min-w-[112px]" onclick={save} disabled={!dirty || saving}>
      {#if saving}
        <Icon name="spinner" size={15} class="animate-spin" />
        {tr("admin.saving")}
      {:else}
        {tr("admin.save.changes")}
      {/if}
    </button>
  {/if}
{/snippet}

<AdminPage
  title={tr("admin.oracle")}
  subtitle={tr("admin.configure.the.provider.model.and.limits.for.all.seminars")}
  {actions}
>
  {#if loadError}
    <div class="mt-6 max-w-[560px] border border-line bg-surface px-4 py-3.5">
      <p class="text-ui text-danger">{loadError}</p>
      <p class="mt-1 text-2xs text-muted">
        {tr("admin.could.not.load.the.settings.try.again.to.view.the.server.configur")}
      </p>
      <button type="button" class="btn-outline mt-3" onclick={() => void loadSettings()}>
        {tr("admin.try.again")}
      </button>
    </div>
  {:else if ready}
    {#if !isOwner}
      <p class="mt-5 max-w-[720px] border border-line bg-surface px-4 py-3 text-ui text-muted">
        <span class="font-semibold text-ink">{tr("admin.read.only")}</span>
        {tr("admin.only.an.owner.can.change.these.settings.contact.an.owner.to.updat")}
      </p>
    {/if}

    <!-- One disabled fieldset rather than a disabled= on thirty controls: the
         browser propagates it to every descendant, so a control added later
         cannot forget to opt in. -->
    <fieldset class="contents" disabled={!isOwner}>
    {#if saveError}
      <p role="alert" class="mt-5 border border-danger/40 bg-danger/5 px-4 py-3 text-ui text-danger">
        {saveError}
      </p>
    {/if}

    <Section
      title={tr("admin.provider")}
      description={tr("admin.connect.an.openai.compatible.api.questions.and.notebook.context.a")}
    >
      <Choice options={PROVIDERS} value={provider} onchange={pickProvider} />

      <div class="mt-4 flex flex-wrap gap-4">
        <div class="min-w-[220px] flex-[1_1_320px]">
          {@render fieldLabel(tr("admin.base.url"), 'ai-base-url')}
          <input
            id="ai-base-url"
            bind:value={baseUrl}
            oninput={() => (offeredBaseUrl = null)}
            class="field font-mono text-code"
            placeholder="https://api.openai.com/v1"
            maxlength={LIMITS.baseUrl}
            autocomplete="off"
            spellcheck="false"
          />
          {#if offeredBaseUrl}
            {@render offer(offeredBaseUrl, useOfferedBaseUrl, () => (offeredBaseUrl = null))}
          {/if}
        </div>

        <div class="w-[230px] max-w-full shrink-0">
          {@render fieldLabel(tr("admin.model"), 'ai-model')}
          <input
            id="ai-model"
            bind:value={model}
            oninput={() => (offeredModel = null)}
            class="field font-mono text-code"
            placeholder="gpt-4o-mini"
            maxlength={LIMITS.model}
            autocomplete="off"
            spellcheck="false"
          />
          {#if offeredModel}
            {@render offer(offeredModel, useOfferedModel, () => (offeredModel = null))}
          {/if}
        </div>
      </div>

      <div class="mt-4">
        {@render fieldLabel(tr("admin.api.key"), 'ai-key')}
        <!--
          The key and the button that tests it wrap rather than overlap: at
          768px "Add a key" was printing 54px into "Test connection". A floor
          under the key lane is what decides when they separate, because the
          key row has three things of its own inside it.
        -->
        <div class="flex flex-wrap gap-2">
          <div class="min-w-[220px] flex-1">
            {#if clearKey}
              <div class="field flex items-center gap-3 border-warning">
                <span class="min-w-0 flex-1 truncate text-ui text-warning">
                  {tr("admin.the.stored.key.will.be.removed.when.you.save")}
                </span>
                <button
                  type="button"
                  class="-my-1 flex shrink-0 items-center py-1 text-ui font-medium text-accent-text
                         hover:underline"
                  onclick={() => (clearKey = false)}
                >
                  {tr("admin.keep.it")}
                </button>
              </div>
            {:else if replacingKey}
              <input
                id="ai-key"
                type="password"
                bind:this={keyInput}
                bind:value={newKey}
                class="field font-mono text-code"
                placeholder="sk-…"
                autocomplete="off"
                spellcheck="false"
              />
            {:else}
              <div class="field flex items-center gap-3">
                <span
                  class={cn(
                    'min-w-0 flex-1 truncate font-mono text-code',
                    storedMask ? 'text-muted' : 'text-faint',
                  )}
                >
                  {storedMask ?? tr("admin.no.key.set")}
                </span>
                <!-- -my-1 py-1: 19px of type is too small a thing to aim at, and the
                     row it sits in has the height to give without moving. -->
                <button
                  type="button"
                  class="-my-1 shrink-0 py-1 text-ui font-medium text-accent-text hover:underline"
                  onclick={startReplace}
                >
                  {storedMask ? tr("admin.replace") : tr("admin.add.a.key")}
                </button>
                {#if canRemoveKey}
                  <button
                    type="button"
                    class="shrink-0 text-ui font-medium text-muted hover:text-ink"
                    onclick={markForRemoval}
                  >
                    {tr("admin.remove")}
                  </button>
                {/if}
              </div>
            {/if}
          </div>

          <button
            type="button"
            class="btn-outline min-w-[152px] shrink-0"
            onclick={() => void saveAndTest()}
            disabled={testing || saving || !isOwner}
            title={dirty
              ? tr("admin.save.changes.and.send.a.test.request")
              : tr("admin.send.a.test.request.using.saved.settings")}
          >
            {#if testing || saving}
              <Icon name="spinner" size={15} class="animate-spin" />
              {saving ? tr("admin.saving") : tr("admin.testing")}
            {:else if dirty}
              {tr("admin.save.test")}
            {:else}
              {tr("admin.test.connection")}
            {/if}
          </button>
        </div>

        {#if replacingKey}
          <p class="mt-1.5 text-2xs text-muted">
            {tr("admin.the.new.key.is.stored.when.you.save.leaving.it.empty.changes.noth")}
            <button
              type="button"
              class="font-semibold text-accent-text hover:underline"
              onclick={cancelReplace}
            >
              {tr("admin.cancel.681")}
            </button>
            {tr("admin.to.keep.the.one.already.there")}
          </p>
        {/if}

        <!-- Where the key comes from outlives the replace form, so it is said
             there too; where it is kept is not, and repeating it under an open
             field is a third sentence nobody reads. -->
        {#if clearKey}
          <p class="mt-1.5 text-2xs text-muted">
            {tr("admin.the.server.will.use")} <span class="font-mono text-code">OPENAI_API_KEY</span> {tr("admin.if.it.is.set.providers.that.require.a.key.will.be.unavailable.wit")}
          </p>
        {:else if fromEnvironment}
          <p class="mt-1.5 text-2xs text-muted">
            {tr("admin.this.key.comes.from")} <span class="font-mono text-code">OPENAI_API_KEY</span> {tr("admin.in.the.server.environment.a.key.saved.here.overrides.it.for.this")}
          </p>
        {:else if !replacingKey}
          <p class="mt-1.5 text-2xs text-muted">
            {#if storedMask}
              {tr("admin.the.key.is.stored.on.the.server.and.masked.in.the.browser.the.ser")}
            {:else}
              {tr("admin.no.key.is.set.paste.one.here.or.point.the.base.url.at.a.local.run")}
            {/if}
          </p>
        {/if}

        {#if dirty}
          <!-- No longer a warning to obey: the button saves first and says so.
               This just tells you that pressing it will write, before it does. -->
          <p class="mt-1.5 text-2xs text-muted">
            <b class="font-semibold text-ink">{tr("admin.save.test")}</b> {tr("admin.saves.all.changes.on.this.page.before.sending.a.test.request")}
          </p>
        {/if}

        {#if testMessage}
          <p
            class={cn(
              'mt-2 flex items-start gap-2 text-ui',
              fresh ? (testOk ? 'text-positive' : 'text-danger') : 'text-muted',
            )}
          >
            <Icon name={testOk ? 'check' : 'x'} size={14} class="mt-0.5 shrink-0" />
            <span>
              {testMessage}
              {#if !fresh}
                <span class="text-2xs">{tr("admin.from.before.the.settings.changed")}</span>
              {/if}
            </span>
          </p>
        {/if}
      </div>
    </Section>

    <Section
      title={tr("admin.default.mode.and.limit")}
      description={tr("admin.applies.to.all.seminars.each.seminar.can.further.restrict.the.ora")}
    >
      <div class="oracle-mode-choice">
        <Choice
          options={MODES}
          value={defaultMode}
          size="lg"
          onchange={(value) => (defaultMode = value as OracleMode)}
        />
      </div>
    </Section>

    <!--
      What goes to the provider and how long it thinks — next to the model and
      the key, not among the ceilings: these are two settings about ONE
      request, and both change what leaves this Colloq.
    -->
    <Section
      title={tr('admin.request.shape')}
      description={tr('admin.request.shape.note')}
    >
      <label class="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          class="mt-0.5 size-4 shrink-0 accent-accent"
          bind:checked={sendNames}
        />
        <span class="min-w-0">
          <span class="block text-ui font-semibold text-ink">{tr('common.sendNames')}</span>
          <span class="mt-1 block text-2xs text-muted">
            {sendNames ? tr('common.sendNamesOn') : tr('common.sendNamesOff')}
          </span>
          <span class="mt-1 block text-2xs text-muted">{tr('common.sendNamesNote')}</span>
        </span>
      </label>

      <div class="mt-5">
        <p class="mb-1.5 block text-2xs font-semibold uppercase tracking-label text-muted">
          {tr('common.reasoning')}
        </p>
        <div class="oracle-mode-choice">
          <Choice
            options={EFFORTS}
            value={reasoningEffort}
            size="lg"
            onchange={(value) => (reasoningEffort = value as ReasoningEffort)}
          />
        </div>
        <p class="mt-2 text-2xs text-muted">{tr('common.reasoningNote')}</p>
      </div>
    </Section>

    <Section
      title={tr("admin.house.rules")}
      description={tr("admin.add.instructions.about.the.course.and.expected.answers.model.resp")}
    >
      <textarea
        id="ai-house-rules"
        bind:value={houseRules}
        class="field min-h-[104px] resize-y text-prose"
        maxlength={LIMITS.houseRules}
        placeholder={tr("admin.second.year.students.have.not.covered.autograd.explain.how.to.cal")}
      ></textarea>
      <p
        class={cn(
          'mt-2 text-2xs',
          houseRules.length >= LIMITS.houseRules ? 'text-warning' : 'text-muted',
        )}
      >
        {counted.format(houseRules.length)} / {counted.format(LIMITS.houseRules)} {tr("admin.characters")}
      </p>
    </Section>

    <Section
      title={tr("admin.usage.limits")}
      description={tr("admin.limit.student.questions.and.request.size.teachers.are.exempt.from")}
    >
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div class="min-w-0">
          {@render fieldLabel(tr("admin.questions.per.student"), 'ai-questions')}
          <div
            class="field flex items-center gap-2 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/25"
          >
            <input
              id="ai-questions"
              bind:value={questionsText}
              onblur={() => (questionsText = String(questions))}
              class="min-w-0 flex-1 bg-transparent font-mono text-code text-ink outline-none"
              inputmode="numeric"
              autocomplete="off"
            />
            <span class="shrink-0 text-2xs text-muted">{tr("admin.per.hour")}</span>
          </div>
          <p class={cn('mt-1.5 text-2xs', questions === 0 ? 'text-warning' : 'text-muted')}>
            {#if questions === 0}
              {tr("admin.zero.switches.the.oracle.off.in.every.seminar")}
            {:else}
              {LIMITS.questionsPerHour.min}–{LIMITS.questionsPerHour.max}{tr("admin.zero.switches.it.off")}
            {/if}
          </p>
        </div>

        <div class="min-w-0">
          {@render fieldLabel(tr("admin.between.questions"), 'ai-slow-mode')}
          <div
            class="field flex items-center gap-2 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/25"
          >
            <input
              id="ai-slow-mode"
              bind:value={slowText}
              onblur={() => (slowText = String(slow))}
              class="min-w-0 flex-1 bg-transparent font-mono text-code text-ink outline-none"
              inputmode="numeric"
              autocomplete="off"
            />
            <span class="shrink-0 text-2xs text-muted">{tr("admin.seconds")}</span>
          </div>
          <!--
            Why this is not the hourly ceiling: twenty questions can be shouted
            out in twenty seconds, and the ceiling would punish not the
            shouting but the next real question — an hour later. It is one
            line, but it is required here: otherwise two number fields side by
            side read as the same thing twice.
          -->
          <p class="mt-1.5 text-2xs text-muted">
            {#if slow === 0}
              {tr("admin.no.minimum.interval.between.questions")}
            {:else}
              {tr("admin.a.student.waits.this.long.between.questions.the.teacher.does.not")}
            {/if}
          </p>
        </div>

        <div class="min-w-0">
          {@render fieldLabel(tr('common.agentSteps'), 'ai-agent-steps')}
          <div class="field flex items-center gap-2 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/25">
            <input
              id="ai-agent-steps"
              bind:value={stepsText}
              onblur={() => (stepsText = String(steps))}
              class="min-w-0 flex-1 bg-transparent font-mono text-code text-ink outline-none"
              inputmode="numeric"
              autocomplete="off"
            />
            <span class="shrink-0 text-2xs text-muted">{tr('common.agentStepsUnit')}</span>
          </div>
          <p class="mt-1.5 text-2xs text-muted">{tr('common.agentStepsNote')}</p>
          {#if steps === 0}<p class="mt-1 text-2xs font-semibold text-muted">{tr('common.unlimitedActions')}</p>{/if}
        </div>

        <div class="min-w-0">
          {@render fieldLabel(tr("admin.notebook.context"), 'ai-context')}
          <div
            class="field flex items-center gap-2 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/25"
          >
            <input
              id="ai-context"
              bind:value={contextText}
              onblur={() => (contextText = grouped(context))}
              class="min-w-0 flex-1 bg-transparent font-mono text-code text-ink outline-none"
              inputmode="numeric"
              autocomplete="off"
            />
            <span class="shrink-0 text-2xs text-muted">{tr("admin.characters")}</span>
          </div>
          <p class="mt-1.5 text-2xs text-muted">
            {grouped(LIMITS.contextChars.min)}–{grouped(LIMITS.contextChars.max)}
            {tr("admin.characters.of.notebook.context.may.be.included.with.a.question")}
          </p>
        </div>

        <div class="min-w-0">
          <p class="mb-1.5 block text-2xs font-semibold uppercase tracking-label text-muted">
            {tr("admin.maximum.file.upload")}
          </p>
          <!-- Dashed, because it is a reading of the environment and not a control:
               a box that looks like a field and ignores you is worse than a label.
               And now it is actually read: a variable name in place of the
               value is not a reading but the promise of one. -->
          <div class="flex h-[38px] items-center border border-dashed border-line px-3">
            <span class="truncate font-mono text-code text-muted">
              {maxUploadBytes === null ? 'MAX_UPLOAD_MB' : tr("admin.mb", { p0: uploadMb(maxUploadBytes) })}
            </span>
          </div>
          <p class="mt-1.5 text-2xs text-muted">
            <span class="font-mono text-code">MAX_UPLOAD_MB</span> {tr("admin.in.the.server.environment.read.at.boot.change.it.in")} <span class="font-mono text-code">.env</span> {tr("admin.and.restart")}
          </p>
        </div>
      </div>
    </Section>

    <Section
      title={tr("admin.usage")}
      description={tr("admin.request.counts.recorded.by.this.server.token.counts.depend.on.wha")}
    >
      {#if usageError}
        <p class="text-ui text-danger">{usageError}</p>
        <button type="button" class="btn-outline mt-3" onclick={() => void loadUsage()}>
          {tr("admin.try.again")}
        </button>
      {:else if usageReady}
        <div class="grid grid-cols-1 divide-y divide-line-soft border border-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {@render tile(counted.format(usageQuestions), tr("admin.questions.asked"))}
          {#if usageTokens === null}
            <!-- null is "no endpoint told us", which is not the same sentence as
                 zero — and only one of them is safe to print as a number. -->
            {@render tile('—', usageQuestions === 0 ? tr("admin.tokens") : tr("admin.tokens.not.reported.by.this.endpoint"))}
          {:else}
            {@render tile(compact(usageTokens), 'tokens')}
          {/if}
          {@render tile(counted.format(usageSeminars), tr("admin.seminars.with.questions"))}
        </div>

        <!-- Cost is not here on purpose: it would take a price table per provider
             that goes stale in silence, and a wrong number about money is worse
             than no number. -->
        {#if breakdown.length > 0}
          <div class="mt-5 space-y-2">
            {#each breakdown as row (row.action)}
              <div class="flex items-center gap-3">
                <span class="w-[116px] shrink-0 truncate text-ui text-ink">{row.label}</span>
                <span class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface">
                  <span class="block h-full rounded-full bg-accent" style:width={`${row.share}%`}
                  ></span>
                </span>
                <span class="w-[56px] shrink-0 text-right font-mono text-code text-muted">
                  {counted.format(row.count)}
                </span>
              </div>
            {/each}
          </div>
        {:else}
          <p class="mt-4 text-ui text-muted">
            {tr("admin.no.questions.recorded.in.this.period.the.breakdown.appears.after")}
          </p>
        {/if}

        {#if usageSince > 0}
          <p class="mt-4 text-2xs text-muted">
            <!-- Numeric, not a month name: the browser's locale would drop a
                 Russian word into a sentence that is otherwise English. -->
            {tr("admin.counted.since")} {new Date(usageSince).toLocaleDateString(getLocale())}.
          </p>
        {/if}
      {/if}
    </Section>
    </fieldset>
  {/if}
</AdminPage>

<style>
  /*
   * Choice's viewport breakpoint cannot see that Section has already spent
   * 250px on its explanation. Stack the three wordy choices when their own
   * column is narrow, while keeping the existing three-column desktop row.
   */
  .oracle-mode-choice {
    container-type: inline-size;
  }

  @container (max-width: 539px) {
    .oracle-mode-choice > :global(div) {
      flex-direction: column;
    }

    .oracle-mode-choice > :global(div > button) {
      border-top-width: 1px;
      border-left-width: 0;
    }

    .oracle-mode-choice > :global(div > button:first-child) {
      border-top-width: 0;
    }
  }
</style>
