<script lang="ts">
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
    type OracleUsage,
    type UpdateOracleRequest,
  } from '@shared/admin'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Choice from '@/admin/ui/Choice.svelte'
  import Section from '@/admin/ui/Section.svelte'
  import Icon, { type IconName } from '@/components/ui/Icon.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { cn } from '@/lib/utils'

  interface Option {
    value: string
    label: string
    hint?: string
  }

  const PROVIDERS: Option[] = (Object.keys(PROVIDER_PRESETS) as AiProviderId[]).map((id) => ({
    value: id,
    label: PROVIDER_PRESETS[id].label,
  }))

  const MODES: Option[] = [
    { value: 'off', label: 'Off', hint: 'No oracle at all' },
    { value: 'hints', label: 'Hints only', hint: 'Nudges, never the solution' },
    { value: 'full', label: 'Full answers', hint: 'Explains and writes code' },
  ]

  /** The quick actions a cell offers, plus 'ask' for anything typed by hand. */
  const ACTION_LABELS: Record<string, string> = {
    ask: 'Asked in words',
    explain: 'Explain',
    fix: 'Fix my error',
    debug: 'Debug',
    improve: 'Improve',
    hint: 'Hint',
  }

  const counted = new Intl.NumberFormat(undefined)

  /**
   * Hand-rolled rather than Intl's compact notation, which localises the unit
   * itself — a Russian browser renders "6,1 млн" into an interface that is
   * otherwise entirely in English.
   */
  function compact(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 10_000) return `${Math.round(value / 1000)}k`
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
  let loadError = $state<string | null>(null)

  let provider = $state<AiProviderId>('custom')
  let baseUrl = $state('')
  let model = $state('')
  let defaultMode = $state<OracleMode>('full')
  let houseRules = $state('')
  let questionsText = $state('')
  let contextText = $state('')

  let replacingKey = $state(false)
  let newKey = $state('')
  let clearKey = $state(false)
  /** A preset's suggestion that was NOT applied, because a typed value stood in the way. */
  let offeredBaseUrl = $state<string | null>(null)
  let offeredModel = $state<string | null>(null)

  let saving = $state(false)
  let saveError = $state<string | null>(null)
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
  let usageError = $state<string | null>(null)

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
  const context = $derived(
    whole(contextText, LIMITS.contextChars, loaded?.contextChars ?? LIMITS.contextChars.default),
  )

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
      context !== saved.contextChars ||
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
      return { tone: 'bg-surface text-muted', icon: 'spinner', spin: true, text: 'Testing…' }
    }
    if (!ready) return null
    // A stale result is not a status: it describes settings that have since been
    // replaced, so the chip goes back to admitting it does not know.
    const result = fresh ? test : null
    if (result === null) {
      return { tone: 'bg-surface text-muted', icon: null, spin: false, text: 'Not tested' }
    }
    if (!result.ok) {
      return { tone: 'bg-danger/[0.05] text-danger', icon: 'x', spin: false, text: 'Not connected' }
    }
    return {
      tone: 'bg-positive/10 text-positive',
      icon: 'check',
      spin: false,
      text: result.ms === null ? 'Connected' : `Connected · ${result.ms} ms`,
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
    return 'The server did not answer.'
  }

  /** A dead cookie is the shell's business: re-reading `me` sends them to sign in. */
  function reauthenticate(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') {
      void adminAuth.refresh()
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
      loadError = null
    } catch (cause: unknown) {
      loadError = messageFor(cause)
      reauthenticate(cause)
    }
  }

  async function loadUsage(): Promise<void> {
    try {
      usage = await adminApi.oracleUsage()
      usageError = null
    } catch (cause: unknown) {
      usageError = messageFor(cause)
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
    contextText = grouped(settings.contextChars)
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
    saveError = null
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
    if (context !== saved.contextChars) patch.contextChars = context
    if (clearKey) patch.apiKey = ''
    else if (newKey.length > 0) patch.apiKey = newKey

    saving = true
    saveError = null
    try {
      apply(await adminApi.updateOracle(patch))
      flashSaved()
    } catch (cause: unknown) {
      saveError = messageFor(cause)
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
      {preset.label} suggests <span class="font-mono text-code text-ink">{suggestion}</span>
    </span>
    <button type="button" class="font-semibold text-accent-text hover:underline" onclick={accept}>
      Use it
    </button>
    <button type="button" class="text-muted hover:text-ink" onclick={dismiss}>Keep mine</button>
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
        Saved
      </span>
    {:else if dirty}
      <span class="text-2xs font-semibold uppercase tracking-label text-warning">Unsaved</span>
      <button type="button" class="btn-ghost" onclick={discard} disabled={saving}>Discard</button>
    {/if}

    <button type="button" class="btn-primary min-w-[112px]" onclick={save} disabled={!dirty || saving}>
      {#if saving}
        <Icon name="spinner" size={15} class="animate-spin" />
        Saving…
      {:else}
        Save changes
      {/if}
    </button>
  {/if}
{/snippet}

<AdminPage
  title="Oracle"
  subtitle="Instance-wide defaults. Any seminar can tighten them, none can loosen them."
  {actions}
>
  {#if loadError}
    <div class="mt-6 max-w-[560px] border border-line bg-surface px-4 py-3.5">
      <p class="text-ui text-danger">{loadError}</p>
      <p class="mt-1 text-2xs text-muted">
        The settings could not be read, so nothing below them is showing. Whatever is configured on
        the server is still in force — this page simply could not ask.
      </p>
      <button type="button" class="btn-outline mt-3" onclick={() => void loadSettings()}>
        Try again
      </button>
    </div>
  {:else if ready}
    {#if !isOwner}
      <p class="mt-5 max-w-[720px] border border-line bg-surface px-4 py-3 text-ui text-muted">
        <span class="font-semibold text-ink">Read-only.</span>
        These settings belong to the instance owner. The base URL decides which host the API key is
        sent to, so changing it is theirs alone — ask them if something here needs to move.
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
      title="Provider"
      description="Anything that speaks the OpenAI HTTP shape. A model on your own hardware never sends student code off campus."
    >
      <Choice options={PROVIDERS} value={provider} onchange={pickProvider} />

      <div class="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_230px]">
        <div class="min-w-0">
          {@render fieldLabel('Base URL', 'ai-base-url')}
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

        <div class="min-w-0">
          {@render fieldLabel('Model', 'ai-model')}
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
        {@render fieldLabel('API key', 'ai-key')}
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
                  The stored key will be removed when you save
                </span>
                <button
                  type="button"
                  class="-my-1 flex shrink-0 items-center py-1 text-ui font-medium text-accent-text
                         hover:underline"
                  onclick={() => (clearKey = false)}
                >
                  Keep it
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
                  {storedMask ?? 'No key set'}
                </span>
                <!-- -my-1 py-1: 19px of type is too small a thing to aim at, and the
                     row it sits in has the height to give without moving. -->
                <button
                  type="button"
                  class="-my-1 shrink-0 py-1 text-ui font-medium text-accent-text hover:underline"
                  onclick={startReplace}
                >
                  {storedMask ? 'Replace' : 'Add a key'}
                </button>
                {#if canRemoveKey}
                  <button
                    type="button"
                    class="shrink-0 text-ui font-medium text-muted hover:text-ink"
                    onclick={markForRemoval}
                  >
                    Remove
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
              ? 'Saves what you typed, then asks the provider'
              : 'Asks the provider with the settings on this screen'}
          >
            {#if testing || saving}
              <Icon name="spinner" size={15} class="animate-spin" />
              {saving ? 'Saving…' : 'Testing…'}
            {:else if dirty}
              Save &amp; test
            {:else}
              Test connection
            {/if}
          </button>
        </div>

        {#if replacingKey}
          <p class="mt-1.5 text-2xs text-muted">
            The new key is stored when you save. Leaving it empty changes nothing —
            <button
              type="button"
              class="font-semibold text-accent-text hover:underline"
              onclick={cancelReplace}
            >
              cancel
            </button>
            to keep the one already there.
          </p>
        {/if}

        <!-- Where the key comes from outlives the replace form, so it is said
             there too; where it is kept is not, and repeating it under an open
             field is a third sentence nobody reads. -->
        {#if clearKey}
          <p class="mt-1.5 text-2xs text-muted">
            Whatever <span class="font-mono text-code">OPENAI_API_KEY</span> supplies takes over
            again. If the environment supplies nothing, the oracle stops answering until a key is
            added.
          </p>
        {:else if fromEnvironment}
          <p class="mt-1.5 text-2xs text-muted">
            This key comes from <span class="font-mono text-code">OPENAI_API_KEY</span> in the
            server environment. A key saved here overrides it for this instance; remove that one and
            the environment takes over again.
          </p>
        {:else if !replacingKey}
          <p class="mt-1.5 text-2xs text-muted">
            {#if storedMask}
              Stored on this server and never handed back to a browser — students talk to your
              server, your server talks to the provider.
            {:else}
              No key is set. Paste one here, or point the base URL at a local runtime (Ollama, vLLM)
              that does not ask for one.
            {/if}
          </p>
        {/if}

        {#if dirty}
          <!-- No longer a warning to obey: the button saves first and says so.
               This just tells you that pressing it will write, before it does. -->
          <p class="mt-1.5 text-2xs text-muted">
            Testing calls the provider, and the provider only sees saved settings — so
            <b class="font-semibold text-ink">Save &amp; test</b> stores what you typed first.
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
                <span class="text-2xs">— from before the settings changed.</span>
              {/if}
            </span>
          </p>
        {/if}
      </div>
    </Section>

    <Section
      title="Default for new seminars"
      description="A seminar can move this down — to hints or off — but never up. The ceiling is set here."
    >
      <Choice
        options={MODES}
        value={defaultMode}
        size="lg"
        onchange={(value) => (defaultMode = value as OracleMode)}
      />
    </Section>

    <Section
      title="House rules"
      description="Appended to the system prompt. This is where you stop the oracle teaching a library the course has not reached yet."
    >
      <textarea
        id="ai-house-rules"
        bind:value={houseRules}
        class="field min-h-[104px] resize-y text-prose"
        maxlength={LIMITS.houseRules}
        placeholder="Students are second-year and have not covered autograd yet — explain gradients by hand rather than reaching for loss.backward()."
      ></textarea>
      <p
        class={cn(
          'mt-2 text-2xs',
          houseRules.length >= LIMITS.houseRules ? 'text-warning' : 'text-muted',
        )}
      >
        {counted.format(houseRules.length)} / {counted.format(LIMITS.houseRules)} characters
      </p>
    </Section>

    <Section
      title="Guardrails"
      description="Thirty students hammering a paid endpoint at once is a real bill. These caps are per person, per seminar."
    >
      <div class="grid gap-4 sm:grid-cols-3">
        <div class="min-w-0">
          {@render fieldLabel('Questions per student', 'ai-questions')}
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
            <span class="shrink-0 text-2xs text-muted">per hour</span>
          </div>
          <p class={cn('mt-1.5 text-2xs', questions === 0 ? 'text-warning' : 'text-muted')}>
            {#if questions === 0}
              Zero switches the oracle off in every seminar.
            {:else}
              {LIMITS.questionsPerHour.min}–{LIMITS.questionsPerHour.max}. Zero switches it off.
            {/if}
          </p>
        </div>

        <div class="min-w-0">
          {@render fieldLabel('Notebook context', 'ai-context')}
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
            <span class="shrink-0 text-2xs text-muted">characters</span>
          </div>
          <p class="mt-1.5 text-2xs text-muted">
            {grouped(LIMITS.contextChars.min)}–{grouped(LIMITS.contextChars.max)} of
            the notebook travels with a question.
          </p>
        </div>

        <div class="min-w-0">
          <p class="mb-1.5 block text-2xs font-semibold uppercase tracking-label text-muted">
            Never send files over
          </p>
          <!-- Dashed, because it is a reading of the environment and not a control:
               a box that looks like a field and ignores you is worse than a label. -->
          <div class="flex h-[38px] items-center border border-dashed border-line px-3">
            <span class="truncate font-mono text-code text-muted">MAX_UPLOAD_MB</span>
          </div>
          <p class="mt-1.5 text-2xs text-muted">
            Set in the server environment and read at boot. Change it in <span
              class="font-mono text-code">.env</span
            > and restart.
          </p>
        </div>
      </div>
    </Section>

    <Section
      title="Usage"
      description="Counted on your own server, so it reflects what the room did rather than what a provider's dashboard says."
    >
      {#if usageError}
        <p class="text-ui text-danger">{usageError}</p>
        <button type="button" class="btn-outline mt-3" onclick={() => void loadUsage()}>
          Try again
        </button>
      {:else if usageReady}
        <div class="grid grid-cols-1 divide-y divide-line-soft border border-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {@render tile(counted.format(usageQuestions), 'questions asked')}
          {#if usageTokens === null}
            <!-- null is "no endpoint told us", which is not the same sentence as
                 zero — and only one of them is safe to print as a number. -->
            {@render tile('—', usageQuestions === 0 ? 'tokens' : 'tokens — not reported by this endpoint')}
          {:else}
            {@render tile(compact(usageTokens), 'tokens')}
          {/if}
          {@render tile(counted.format(usageSeminars), 'seminars asked something')}
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
            Nothing asked yet in this window. The breakdown appears once the room starts.
          </p>
        {/if}

        {#if usageSince > 0}
          <p class="mt-4 text-2xs text-muted">
            <!-- Numeric, not a month name: the browser's locale would drop a
                 Russian word into a sentence that is otherwise English. -->
            Counted since {new Date(usageSince).toLocaleDateString()}.
          </p>
        {/if}
      {/if}
    </Section>
    </fieldset>
  {/if}
</AdminPage>
