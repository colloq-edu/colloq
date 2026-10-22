<script lang="ts">
  /**
   * One machine that runs submissions (Paper 16 · M3): a route under
   * Resources, /admin/resources/machines/<id>, so the owner can send it to a
   * colleague and come back to it in the middle of a class.
   *
   * What it says about itself (the facts), what the owner sets on it (places,
   * runs per card, trust), how ready it is for each competition, what it runs
   * now with a stop for each run, and its last fifty events. The page is read
   * again every five seconds while it is on screen: its runs tick, and its
   * state is a heartbeat.
   *
   * A setting is saved the moment it is committed (a number on Enter or
   * blur, the switch on a press), as a room's memory is on its settings: the
   * machine applies it to its next lease, and there is no form to forget to
   * save. Trusting asks first, because it hands a machine the hidden test;
   * untrusting does not, because it takes the hidden test away.
   *
   * Owner-only: the server answers a teacher 403, and the shell shows the tab
   * to everyone, so a teacher who follows a link reads the refusal here.
   *
   * Classes on machines (Paper 18 · Z3): the header carries the machine's
   * roles and Move classes; the counters gain its classes, the memory
   * they hold, its link and its moves of the last day; the settings row the
   * switch Takes classes (asked first both ways, and greyed against
   * the hidden test, D3); a table lists each class on it with its kernels,
   * memory, CPU, link and files; the log words the class lines.
   */
  import { onMount } from 'svelte'
  import { tr } from '@shared/i18n'
  import type { RemoteMachineDetail, RemoteMachineRun } from '@shared/remote-admin'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Section from '@/admin/ui/Section.svelte'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import Skeleton from '@/components/ui/Skeleton.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { cardWord, clock } from '@/admin/running-kernels'
  import {
    PER_DEVICE_BOUNDS,
    PLACES_BOUNDS,
    cardsFacts,
    classRowCells,
    classesChip,
    classesCount,
    eventLine,
    eventTime,
    gbFromMb,
    machineGone,
    machineLede,
    machineMenu,
    machinePlaces,
    machineSliceMb,
    machinesListPath,
    readinessCells,
    runPhaseWord,
    runnersApi,
    stateChip,
    stoppableOnMachine,
    wholeOrAuto,
    type LineTone,
  } from '@/admin/runners'
  import { shareGb } from '@/admin/runner-cards'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { cn } from '@/lib/utils'

  interface Props {
    id: string
    navigate: (path: string) => void
  }

  let { id, navigate }: Props = $props()

  let machine = $state<RemoteMachineDetail | null>(null)
  /** The server answered 404: no such machine, or it was removed. */
  let missing = $state(false)
  /**
   * The server answered 404 or 403: no such machine, or not this person's
   * to see. Reading again every five seconds would only repeat it — and
   * fill the server's log with one teacher's open tab — so the timer stops;
   * "Try again" still asks, and an answer resumes it.
   */
  let stopped = false
  let loadErrorText = $state<(() => string) | null>(null)
  const loadError = $derived(loadErrorText?.() ?? null)
  let now = $state(Date.now())
  let busy = $state(false)
  let actionErrorText = $state<(() => string) | null>(null)
  const actionError = $derived(actionErrorText?.() ?? null)
  let dialog = $state<'trust' | 'revoke' | 'classesOn' | 'classesOff' | 'moveClasses' | null>(null)
  let showAll = $state(false)

  /** The two number fields, as typed; `null` — not being edited, the field shows the server's value. */
  let placesText = $state<string | null>(null)
  let perDeviceText = $state<string | null>(null)
  let placesInvalid = $state(false)
  let perDeviceInvalid = $state(false)
  let savedAt = $state(0)

  const TONE: Record<LineTone, string> = {
    positive: 'text-positive',
    warning: 'text-warning',
    danger: 'text-danger',
    accent: 'text-accent-text',
    muted: 'text-muted',
    ink: 'text-ink',
  }

  /** The first ten events; the rest of the fifty a press away. */
  const EVENTS_SHOWN = 10

  const gone = $derived(machine ? machineGone(machine.state) : false)
  const menu = $derived(machine ? machineMenu(machine) : null)
  const places = $derived(machine ? machinePlaces(machine.places) : null)
  /** Runs per card in force on the machine now: the cards say it, whatever was set since. */
  const perDeviceNow = $derived(machine?.cards[0]?.perDevice ?? machine?.perDevice ?? 1)
  const roles = $derived(machine ? classesChip(machine) : null)
  /** The classes it holds now, for the dialogs' "3 classes move…". */
  const heldClasses = $derived(machine?.classes?.held.classes ?? 0)
  const classRows = $derived(machine?.classRows ?? [])
  /** Its classes' moves within the last day, from the log ("1 move in a day"). */
  const movesToday = $derived(machine ? machine.events.filter((event) => event.kind === 'class_failover' && now - event.at < 86_400_000).length : 0)

  function messageFor(cause: unknown): string {
    if (cause instanceof Error && cause.message) return cause.message
    return tr('admin.the.server.did.not.answer')
  }

  function reauthenticate(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
  }

  let disposed = false

  async function load(): Promise<void> {
    const asked = id
    try {
      const fresh = await runnersApi.machine(asked)
      if (disposed || asked !== id) return
      machine = fresh
      missing = false
      stopped = false
      loadErrorText = null
      now = Date.now()
    } catch (cause: unknown) {
      if (disposed || asked !== id) return
      reauthenticate(cause)
      if (cause instanceof AdminApiError && cause.status === 404) {
        missing = true
        machine = null
        stopped = true
        return
      }
      if (cause instanceof AdminApiError && cause.status === 403) {
        // The owner's page only: the refusal in the server's words, once.
        machine = null
        stopped = true
        loadErrorText = () => messageFor(cause)
        return
      }
      if (!machine) loadErrorText = () => messageFor(cause)
    }
  }

  onMount(() => {
    void load()
    const refresh = setInterval(() => {
      if (!stopped && document.visibilityState === 'visible') void load()
    }, 5_000)
    const tick = setInterval(() => (now = Date.now()), 1_000)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) dialog = null
    }
    window.addEventListener('keydown', onKey)
    return () => {
      disposed = true
      clearInterval(refresh)
      clearInterval(tick)
      window.removeEventListener('keydown', onKey)
    }
  })

  /* ------------------------------------------------------------- actions */

  async function run(what: () => Promise<void>): Promise<boolean> {
    if (busy) return false
    busy = true
    actionErrorText = null
    try {
      await what()
      await load()
      return true
    } catch (cause: unknown) {
      reauthenticate(cause)
      actionErrorText = () => messageFor(cause)
      return false
    } finally {
      busy = false
    }
  }

  async function confirm(): Promise<void> {
    const asked = dialog
    if (!asked || !machine) return
    const machineId = machine.id
    const done =
      asked === 'trust'
        ? await run(() => runnersApi.update(machineId, { trusted: true }))
        : asked === 'classesOn' || asked === 'classesOff'
          ? await run(() => runnersApi.update(machineId, { classes: asked === 'classesOn' }))
          : asked === 'moveClasses'
            ? await run(() => runnersApi.classAction(machineId, 'move'))
            : await run(() => runnersApi.act(machineId, 'revoke'))
    if (done) {
      dialog = null
      savedAt = Date.now()
    }
  }

  function toggleTrust(): void {
    if (!machine || gone) return
    const machineId = machine.id
    if (machine.trusted) {
      void run(() => runnersApi.update(machineId, { trusted: false })).then((done) => {
        if (done) savedAt = Date.now()
      })
    } else {
      actionErrorText = null
      dialog = 'trust'
    }
  }

  /** Takes classes, asked both ways: on hands it its classes' work, off moves them now. */
  function toggleClasses(): void {
    if (!machine || gone) return
    actionErrorText = null
    dialog = machine.classes?.on ? 'classesOff' : 'classesOn'
  }

  /** A number field committed: sent only when it says something new and something allowed. */
  async function commitPlaces(): Promise<void> {
    if (!machine || placesText === null) return
    const parsed = wholeOrAuto(placesText, PLACES_BOUNDS.min, PLACES_BOUNDS.max)
    if ('error' in parsed) {
      placesInvalid = true
      return
    }
    placesInvalid = false
    const machineId = machine.id
    if (parsed.value === machine.places.approved) {
      placesText = null
      return
    }
    if (await run(() => runnersApi.update(machineId, { approvedSlots: parsed.value }))) {
      placesText = null
      savedAt = Date.now()
    }
  }

  async function commitPerDevice(): Promise<void> {
    if (!machine || perDeviceText === null) return
    const parsed = wholeOrAuto(perDeviceText, PER_DEVICE_BOUNDS.min, PER_DEVICE_BOUNDS.max)
    if ('error' in parsed) {
      perDeviceInvalid = true
      return
    }
    perDeviceInvalid = false
    const machineId = machine.id
    if (parsed.value === machine.perDevice) {
      perDeviceText = null
      return
    }
    if (await run(() => runnersApi.update(machineId, { perDevice: parsed.value }))) {
      perDeviceText = null
      savedAt = Date.now()
    }
  }

  async function stopRun(item: RemoteMachineRun): Promise<void> {
    // The console's own door: on a machine it is a durable cancel that
    // reaches the machine with its next call (§3.5). Only while the run's
    // notebook is still there (`onMachine`): the page is up to five seconds
    // old, and a run that finished meanwhile is refused, not thrown away.
    await run(() => adminApi.killCompetitionRun(item.submissionId, { onMachine: true }).then(() => undefined))
  }

  function back(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    navigate(path)
  }

  /** The share a run would get at the runs per card the field now says. */
  const sliceReadout = $derived.by(() => {
    if (!machine || machine.cards.length === 0) return null
    const typed = perDeviceText === null ? null : wholeOrAuto(perDeviceText, PER_DEVICE_BOUNDS.min, PER_DEVICE_BOUNDS.max)
    const per = typed && 'value' in typed && typed.value !== null ? typed.value : perDeviceNow
    const slice = machineSliceMb(machine.cards, per)
    if (per <= 1) return tr('admin.resourcesTab.gpuSliceWhole')
    return slice === null ? null : tr('admin.resourcesTab.gpuSliceShort', { value: shareGb(slice) })
  })
</script>

{#snippet counter(value: number, label: string, tone: string)}
  <div class="flex items-baseline gap-2">
    <span class={cn('font-mono text-gauge font-bold', tone)}>{value}</span>
    <span class="text-2xs text-muted">{label}</span>
  </div>
{/snippet}

{#snippet fact(label: string, value: string, extra = '')}
  <div class="min-w-0">
    <p class="admin-label">{label}</p>
    <p class={cn('mt-1 break-words text-ui text-ink', extra)}>{value}</p>
  </div>
{/snippet}

<AdminPage title={machine?.name ?? id}>
  {#snippet eyebrow()}
    <a class="shrink-0 transition-colors duration-100 hover:text-ink" href="/admin/resources" onclick={(event) => back(event, '/admin/resources')}>
      {tr('admin.resourcesTab.title')}
    </a>
    <span aria-hidden="true">/</span>
    <a class="truncate transition-colors duration-100 hover:text-ink" href={machinesListPath()} onclick={(event) => back(event, machinesListPath())}>
      {tr('admin.runners.title')}
    </a>
  {/snippet}

  {#snippet beside()}
    {#if !machine && !missing && !loadError}
      <!-- Its state and its role, the two chips every machine has, while it is read. -->
      {#each ['7.5rem', '5.5rem'] as width, i (i)}
        <span class="block h-6" style:width aria-hidden="true"><Skeleton width="100%" height="100%" radius="0" /></span>
      {/each}
    {:else if machine}
      {@const chip = stateChip(machine.state, machine.silentSince, now)}
      <Badge word={chip.word} tone={chip.tone} />
      {#if !gone}
        <!-- Its roles (Z3), as on its row in the list. -->
        <Badge word={tr('admin.runners.chip.submissions')} />
        {#if roles}
          <Badge word={roles.word} tone={roles.tone} form={roles.dashed ? 'outline' : 'filled'} class={cn(roles.dashed && 'border-dashed !text-faint')} />
        {/if}
      {/if}
      {#if machine.trusted}
        <Badge word={tr('admin.runners.trusted')} tone="accent" form="outline" />
      {/if}
    {/if}
  {/snippet}

  {#snippet lede()}
    {#if machine}
      <span class="min-w-0 break-words text-2xs text-muted">{machineLede(machine, now)}</span>
    {:else if !missing && !loadError}
      <!-- Its line while the machine is read — its address, release and
           times, three lines on a phone: the header does not grow under the hand. -->
      <span class="flex min-w-0 flex-1 flex-col text-2xs" aria-hidden="true">
        <span class="block"><Skeleton width="18rem" height="0.75rem" /></span>
        <span class="hidden max-[640px]:block"><Skeleton width="80%" height="0.75rem" /></span>
        <span class="hidden max-[640px]:block"><Skeleton width="55%" height="0.75rem" /></span>
      </span>
    {/if}
  {/snippet}

  {#snippet actions()}
    {#if !machine && !missing && !loadError && adminAuth.isOwner}
      <!-- The owner's actions on a machine, while it is read: two of them stand here on most. -->
      {#each ['92px', '108px'] as width, i (i)}
        <span class="block h-10 max-[640px]:h-11 max-[640px]:flex-1" style:width aria-hidden="true">
          <Skeleton width="100%" height="100%" radius="0" />
        </span>
      {/each}
    {:else if machine && menu && adminAuth.isOwner}
      {#if menu.moveClasses}
        <button type="button" class="btn-outline max-[640px]:flex-1" disabled={busy} onclick={() => (dialog = 'moveClasses')}>
          {tr('admin.runners.menu.moveClasses')}
        </button>
      {/if}
      {#if menu.resumeClasses}
        <button type="button" class="btn-outline max-[640px]:flex-1" disabled={busy} onclick={() => void run(() => runnersApi.classAction(machine!.id, 'resume'))}>
          {tr('admin.runners.menu.resumeClasses')}
        </button>
      {/if}
      {#if menu.drain}
        <button type="button" class="btn-outline max-[640px]:flex-1" disabled={busy} onclick={() => void run(() => runnersApi.act(machine!.id, 'drain'))}>
          {tr('admin.runners.menu.drain')}
        </button>
      {:else if menu.resume}
        <button type="button" class="btn-outline max-[640px]:flex-1" disabled={busy} onclick={() => void run(() => runnersApi.act(machine!.id, 'resume'))}>
          {tr('admin.runners.menu.resume')}
        </button>
      {/if}
      {#if menu.revoke}
        <button type="button" class="btn-danger max-[640px]:flex-1" disabled={busy} onclick={() => (dialog = 'revoke')}>
          {tr('admin.runners.menu.revoke')}
        </button>
      {/if}
    {/if}
  {/snippet}

  {#if missing}
    <div class="mt-6 max-w-[560px] border border-line bg-surface px-4 py-3.5">
      <p class="text-ui text-ink">{tr('admin.runners.page.notFound')}</p>
      <a class="btn-outline mt-3" href={machinesListPath()} onclick={(event) => back(event, machinesListPath())}>
        {tr('admin.runners.page.toList')}
      </a>
    </div>
  {:else if loadError && !machine}
    <div class="mt-6 max-w-[560px] border border-line bg-surface px-4 py-3.5">
      <p class="text-ui text-danger" role="alert">{loadError}</p>
      <button type="button" class="btn-outline mt-3" onclick={() => void load()}>{tr('admin.try.again')}</button>
    </div>
  {:else if !machine || !places}
    <!--
      The machine is being read: the counters it is judged by and its own
      section — the facts under their captions, the settings row — where
      they will stand. The sections after it are named by what they count,
      and those counts are the answer.
    -->
    <div role="status" aria-busy="true" aria-label={tr('admin.runners.page.loading')}>
      <span class="sr-only">{tr('admin.runners.page.loading')}</span>
      <div class="contents" aria-hidden="true">
        <div class="flex flex-wrap items-baseline gap-x-9 gap-y-3 pt-6">
          {#each ['5rem', '6.5rem', '4.5rem', '6rem'] as width, i (i)}
            <div class="flex h-8 items-center gap-2">
              <Skeleton width="1.75rem" height="1.6rem" />
              <Skeleton {width} height="0.65rem" />
            </div>
          {/each}
        </div>
        <Section title={tr('admin.runners.page.machine')} description={tr('admin.runners.page.machineNote')}>
          <div class="rm-facts">
            {#each [
              [tr('admin.runners.fact.cores'), '2rem'],
              [tr('admin.runners.fact.memory'), '4rem'],
              [tr('admin.runners.fact.disk'), '4.5rem'],
              [tr('admin.runners.fact.cards'), '7rem'],
              [tr('admin.runners.fact.driver'), '5rem'],
              [tr('admin.runners.fact.docker'), '8rem'],
              [tr('admin.runners.fact.host'), '9rem'],
            ] as [label, width] (label)}
              <div class="min-w-0">
                <p class="admin-label">{label}</p>
                <span class="mt-1 flex h-6 items-center"><Skeleton {width} height="0.8rem" /></span>
              </div>
            {/each}
          </div>
          <!-- The settings row in its own boxes: the places' field with its
               note, the two switches with their words — what they are set
               to is the answer, grey; what they mean is the page's own. -->
          <div class="mt-6 flex flex-wrap items-start gap-x-5 gap-y-5 border-t border-line-soft pt-5">
            <div class="w-[220px] max-w-full">
              <p class="admin-label mb-1.5 block">{tr('admin.runners.connect.places')}</p>
              <span class="block h-10 max-[640px]:h-11"><Skeleton width="100%" height="100%" radius="0" /></span>
              <p class="mt-1.5 text-micro">
                {#each ['95%', '90%', '45%'] as width, i (i)}
                  <span class="block"><Skeleton {width} height="0.6rem" /></span>
                {/each}
              </p>
            </div>
            {#each [
              { caption: tr('admin.runners.page.classesLabel'), note: tr('admin.runners.page.classesNote'), long: false },
              { caption: tr('admin.runners.connect.sealed'), note: tr('admin.runners.page.trustNote'), long: true },
            ] as { caption, note, long } (caption)}
              <div class="min-w-[240px] flex-1 basis-[260px]">
                <p class="admin-label mb-1.5 block">{caption}</p>
                <div class="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 max-[640px]:min-h-11">
                  <Skeleton width="40px" height="22px" radius="999px" />
                  {#if long}
                    <!-- The untrusted machine's words (admin.runners.page.trustedOff) take a line of their own. -->
                    <span class="basis-full text-ui">
                      <span class="block"><Skeleton width="80%" height="0.8rem" /></span>
                      <span class="hidden max-[640px]:block"><Skeleton width="35%" height="0.8rem" /></span>
                    </span>
                  {:else}
                    <span class="text-ui"><Skeleton width="10rem" height="0.8rem" /></span>
                  {/if}
                </div>
                <p class="mt-1.5 text-micro text-muted">{note}</p>
              </div>
            {/each}
          </div>
        </Section>
      </div>
    </div>
  {:else}
    {#if actionError}
      <p role="alert" class="mt-5 border border-danger/40 bg-danger/5 px-4 py-3 text-ui text-danger">{actionError}</p>
    {/if}

    <!-- The numbers the machine is judged by; its classes' first (Z3) when it has any. -->
    <div class="flex flex-wrap items-baseline gap-x-9 gap-y-3 pt-6">
      {#if machine.classes && !gone}
        {@const held = machine.classes.held}
        {@const link = machine.classes.link}
        {@render counter(held.classes, tr('admin.runners.page.classesCount', { count: held.classes }), 'text-ink')}
        {@render counter(
          Math.round(held.memoryMb / 1024),
          machine.facts.memoryMb === null
            ? tr('admin.runners.page.classesMemoryHeld')
            : tr('admin.runners.page.classesMemory', { total: Math.round(machine.facts.memoryMb / 1024) }),
          'text-ink',
        )}
        {#if link && link.rttMs !== null}
          {@render counter(
            Math.round(link.rttMs),
            link.p95Ms === null ? tr('admin.runners.page.linkCounterOnly') : tr('admin.runners.page.linkCounter', { p95: Math.round(link.p95Ms) }),
            'text-ink',
          )}
        {/if}
      {/if}
      {@render counter(machine.counts.scored, tr('admin.runners.page.scored', { count: machine.counts.scored }), 'text-ink')}
      {@render counter(places.busy, tr('admin.runners.page.busyOf', { count: places.total }), 'text-ink')}
      {@render counter(machine.counts.lost, tr('admin.runners.page.lost', { count: machine.counts.lost }), machine.counts.lost > 0 ? 'text-danger' : 'text-ink')}
      {@render counter(
        machine.counts.declined,
        tr('admin.runners.page.declined', { count: machine.counts.declined }),
        machine.counts.declined > 0 ? 'text-warning' : 'text-ink',
      )}
      {#if machine.classes && movesToday > 0}
        {@render counter(movesToday, tr('admin.runners.page.moves', { count: movesToday }), 'text-warning')}
      {/if}
    </div>
    {#if machine.lastTrouble}
      <p class="mt-2 max-w-[760px] break-words text-2xs text-muted">{tr('admin.runners.page.lastTrouble', { text: machine.lastTrouble })}</p>
    {/if}

    <Section title={tr('admin.runners.page.machine')} description={tr('admin.runners.page.machineNote')}>
      <div class="rm-facts">
        {@render fact(tr('admin.runners.fact.cores'), machine.facts.cpus === null ? '—' : String(machine.facts.cpus))}
        {@render fact(tr('admin.runners.fact.memory'), machine.facts.memoryMb === null ? '—' : gbFromMb(machine.facts.memoryMb))}
        {@render fact(tr('admin.runners.fact.disk'), machine.facts.diskMb === null ? '—' : gbFromMb(machine.facts.diskMb))}
        {@render fact(tr('admin.runners.fact.cards'), cardsFacts(machine.cards), machine.cards.length > 0 ? 'font-semibold text-accent-text' : 'text-muted')}
        {@render fact(tr('admin.runners.fact.driver'), machine.facts.driver ?? '—', 'font-mono text-2xs')}
        {@render fact(tr('admin.runners.fact.docker'), [machine.facts.docker, machine.facts.storage].filter(Boolean).join(' · ') || '—', 'font-mono text-2xs')}
        {@render fact(tr('admin.runners.fact.host'), [machine.facts.hostname, machine.facts.platform].filter(Boolean).join(' · ') || '—', 'font-mono text-2xs')}
      </div>

      {#if !gone}
        <div class="mt-6 flex flex-wrap items-start gap-x-5 gap-y-5 border-t border-line-soft pt-5">
          <div class="w-[220px] max-w-full">
            <label for="machine-places" class="admin-label mb-1.5 block">{tr('admin.runners.connect.places')}</label>
            <div class={cn('admin-affix gap-2', placesInvalid && '!border-danger', placesText !== null && !placesInvalid && '!border-accent')}>
              <input
                id="machine-places"
                value={placesText ?? (machine.places.approved === null ? '' : String(machine.places.approved))}
                oninput={(event) => {
                  placesText = event.currentTarget.value
                  placesInvalid = false
                }}
                onblur={() => void commitPlaces()}
                onkeydown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                }}
                disabled={busy}
                class="placeholder:font-sans placeholder:text-ink"
                inputmode="numeric"
                autocomplete="off"
                aria-invalid={placesInvalid}
                placeholder={tr('admin.runners.places.autoNow', { count: machine.places.offered })}
              />
            </div>
            <p class={cn('mt-1.5 text-micro', placesInvalid ? 'text-danger' : 'text-muted')}>
              {placesInvalid
                ? tr('admin.runners.places.invalid', { min: PLACES_BOUNDS.min, max: PLACES_BOUNDS.max })
                : tr('admin.runners.page.placesNote', { count: machine.places.offered })}
            </p>
          </div>

          {#if machine.cards.length > 0}
            <div class="w-[220px] max-w-full">
              <label for="machine-per-device" class="admin-label mb-1.5 block">{tr('admin.runners.perDevice.field')}</label>
              <div class={cn('admin-affix gap-2', perDeviceInvalid && '!border-danger', perDeviceText !== null && !perDeviceInvalid && '!border-accent')}>
                <input
                  id="machine-per-device"
                  value={perDeviceText ?? (machine.perDevice === null ? '' : String(machine.perDevice))}
                  oninput={(event) => {
                    perDeviceText = event.currentTarget.value
                    perDeviceInvalid = false
                  }}
                  onblur={() => void commitPerDevice()}
                  onkeydown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                  disabled={busy}
                  class="placeholder:font-sans placeholder:text-ink"
                  inputmode="numeric"
                  autocomplete="off"
                  aria-invalid={perDeviceInvalid}
                  placeholder={tr('admin.runners.page.perDeviceInherit', { count: perDeviceNow })}
                />
                {#if sliceReadout}
                  <span class="shrink-0 text-2xs font-semibold text-accent-text">{sliceReadout}</span>
                {/if}
              </div>
              <p class={cn('mt-1.5 text-micro', perDeviceInvalid ? 'text-danger' : 'text-muted')}>
                {perDeviceInvalid
                  ? tr('admin.runners.places.invalid', { min: PER_DEVICE_BOUNDS.min, max: PER_DEVICE_BOUNDS.max })
                  : tr('admin.runners.page.perDeviceNote')}
              </p>
            </div>
          {/if}

          <!-- Takes classes (Z3): the switch in the settings row; the
               hidden test's gives way to it while classes are on (D3). -->
          <div class="min-w-[240px] flex-1 basis-[260px]">
            <span class="admin-label mb-1.5 block">{tr('admin.runners.page.classesLabel')}</span>
            <label class={cn('flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 max-[640px]:min-h-11', !busy && !machine.trusted && 'cursor-pointer')}>
              <button
                type="button"
                role="switch"
                aria-checked={machine.classes?.on === true}
                aria-label={tr('admin.runners.menu.classes')}
                disabled={busy || machine.trusted}
                class={cn(
                  'flex h-[22px] w-10 shrink-0 items-center rounded-full px-[3px] transition-colors duration-quick',
                  'focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/15 disabled:opacity-40',
                  machine.classes?.on ? 'justify-end bg-primary' : 'justify-start bg-faint/60',
                )}
                onclick={toggleClasses}
              >
                <span class="size-4 rounded-full bg-canvas shadow-sm" aria-hidden="true"></span>
              </button>
              <span class="text-ui text-ink">
                {machine.classes?.on ? tr('admin.runners.page.classesOn') : tr('admin.runners.page.classesOff')}
              </span>
            </label>
            <p class={cn('mt-1.5 text-micro', machine.trusted ? 'text-faint' : 'text-muted')}>
              {machine.trusted ? tr('admin.runners.menu.classesNotWithTrust') : tr('admin.runners.page.classesNote')}
            </p>
          </div>

          {#if !machine.classes?.on}
          <div class="min-w-[240px] flex-1 basis-[260px]">
            <span class="admin-label mb-1.5 block">{tr('admin.runners.connect.sealed')}</span>
            <!-- The whole row is the switch's label, as on the editor's late
                 intake: the track itself is 22 x 40 px, and on a phone a
                 finger needs the 44 px row (M7). -->
            <label class={cn('flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 max-[640px]:min-h-11', !busy && 'cursor-pointer')}>
              <button
                type="button"
                role="switch"
                aria-checked={machine.trusted}
                aria-label={tr('admin.runners.menu.trust')}
                disabled={busy}
                class={cn(
                  'flex h-[22px] w-10 shrink-0 items-center rounded-full px-[3px] transition-colors duration-quick',
                  'focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/15 disabled:opacity-40',
                  machine.trusted ? 'justify-end bg-primary' : 'justify-start bg-faint/60',
                )}
                onclick={toggleTrust}
              >
                <span class="size-4 rounded-full bg-canvas shadow-sm" aria-hidden="true"></span>
              </button>
              <span class="text-ui text-ink">
                {machine.trusted ? tr('admin.runners.page.trustedOn') : tr('admin.runners.page.trustedOff')}
              </span>
            </label>
            <p class="mt-1.5 text-micro text-muted">{tr('admin.runners.page.trustNote')}</p>
          </div>
          {/if}
        </div>
        {#if savedAt > 0 && now - savedAt < 2_500}
          <p class="mt-3 flex items-center gap-1 text-2xs font-semibold text-positive" role="status">
            <Icon name="check" size={13} />
            {tr('admin.runners.page.applies')}
          </p>
        {/if}
      {/if}
    </Section>

    {#if machine.classes && !gone}
      <!-- Classes on the machine (Z3): a row per class — its kernels there,
           the memory they hold, CPU, the machine's link, and how far its
           files are behind. -->
      <Section title={tr('admin.runners.page.classesSection', { count: classRows.length })} description={tr('admin.runners.page.classesSectionNote')}>
        {#if classRows.length === 0}
          <p class="text-ui text-muted">{tr('admin.runners.page.noClasses')}</p>
        {:else}
          <div class="rm-table">
            <div class="rm-class-head" aria-hidden="true">
              <span class="admin-label">{tr('admin.runners.page.col.class')}</span>
              <span class="admin-label">{tr('admin.runners.page.col.kernels')}</span>
              <span class="admin-label text-right">{tr('admin.runners.page.col.memory')}</span>
              <span class="admin-label text-right">{tr('admin.runners.page.col.cpu')}</span>
              <span class="admin-label text-right">{tr('admin.runners.page.col.link')}</span>
              <span class="admin-label">{tr('admin.runners.page.col.files')}</span>
            </div>
            {#each classRows as row (row.sessionId)}
              {@const cells = classRowCells(row)}
              {@const link = machine.classes.link}
              <div class="rm-class-row">
                <div class="rm-c-name min-w-0">
                  <p class="break-words text-ui font-semibold text-ink">{row.name ?? row.sessionId}</p>
                  <p class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    {#if row.course}
                      <span class="inline-flex min-w-0 items-center gap-1.5 bg-surface px-1.5 py-0.5">
                        <span class="size-[7px] shrink-0 bg-primary" aria-hidden="true"></span>
                        <span class="truncate text-micro font-semibold text-ink">{row.course.name}</span>
                      </span>
                    {/if}
                    {#if row.environment}<span class="font-mono text-micro text-muted">{row.environment}</span>{/if}
                  </p>
                </div>
                <div class="rm-c-kernels min-w-0">
                  <p class="rm-label admin-label">{tr('admin.runners.page.col.kernels')}</p>
                  <p class="text-2xs text-ink">{cells.kernels}</p>
                  {#if cells.kernelsDetail}<p class="mt-0.5 text-micro text-muted">{cells.kernelsDetail}</p>{/if}
                </div>
                <div class="rm-c-memory min-w-0">
                  <p class="rm-label admin-label">{tr('admin.runners.page.col.memory')}</p>
                  <p class="whitespace-nowrap font-mono text-2xs font-bold text-ink">{cells.memory}</p>
                  {#if cells.share !== null}
                    <div class="mt-1 h-[3px] bg-raised" aria-hidden="true">
                      <div class={cn('h-full', cells.share > 0.85 ? 'bg-warning' : 'bg-brand')} style:width="{(cells.share * 100).toFixed(1)}%"></div>
                    </div>
                  {/if}
                </div>
                <p class="rm-c-cpu whitespace-nowrap font-mono text-2xs text-ink">
                  <span class="rm-label admin-label block">{tr('admin.runners.page.col.cpu')}</span>
                  {cells.cpu ?? '—'}
                </p>
                <div class="rm-c-link min-w-0">
                  <p class="rm-label admin-label">{tr('admin.runners.page.col.link')}</p>
                  <p class="whitespace-nowrap font-mono text-2xs text-ink">
                    {link?.rttMs != null ? tr('admin.runners.page.ms', { ms: Math.round(link.rttMs) }) : '—'}
                  </p>
                  {#if link?.p95Ms != null}<p class="whitespace-nowrap text-micro text-muted">{tr('admin.runners.page.p95', { ms: Math.round(link.p95Ms) })}</p>{/if}
                </div>
                <div class="rm-c-files min-w-0">
                  <p class="rm-label admin-label">{tr('admin.runners.page.col.files')}</p>
                  {#if cells.files}
                    <p class={cn('break-words text-2xs', TONE[cells.files.tone])}>{cells.files.text}</p>
                  {:else}
                    <p class="text-2xs text-faint">—</p>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </Section>
    {/if}

    <Section title={tr('admin.runners.page.readiness')} description={tr('admin.runners.page.readinessNote')}>
      {#if machine.readiness.length === 0}
        <p class="text-ui text-muted">{tr('admin.runners.page.noReadiness')}</p>
      {:else}
        <div class="rm-table">
          <div class="rm-ready-head" aria-hidden="true">
            <span class="admin-label">{tr('admin.runners.page.col.competition')}</span>
            <span class="admin-label">{tr('admin.runners.page.col.image')}</span>
            <span class="admin-label">{tr('admin.runners.page.col.data')}</span>
            <span class="admin-label">{tr('admin.runners.page.col.result')}</span>
          </div>
          {#each machine.readiness as item (item.competitionId)}
            {@const cells = readinessCells(item, machine.facts)}
            <div class="rm-ready-row">
              <div class="rm-comp min-w-0">
                <p class="text-ui font-semibold text-ink">{item.title}</p>
                <p class="mt-0.5 text-micro text-muted">{cells.about}</p>
              </div>
              <div class="rm-image min-w-0">
                <p class="rm-label admin-label">{tr('admin.runners.page.col.image')}</p>
                <p class={cn('break-words text-2xs', TONE[cells.image.tone])}>{cells.image.lead}</p>
                {#if cells.image.percent !== null}
                  <div class="my-1.5 h-1 max-w-[220px] bg-raised" aria-hidden="true">
                    <div class="h-full bg-accent" style:width="{Math.max(0, Math.min(100, cells.image.percent)).toFixed(1)}%"></div>
                  </div>
                {/if}
                {#if cells.image.detail}<p class="text-micro text-muted">{cells.image.detail}</p>{/if}
              </div>
              <div class="rm-data min-w-0">
                <p class="rm-label admin-label">{tr('admin.runners.page.col.data')}</p>
                <p class={cn('text-2xs', TONE[cells.data.tone])}>{cells.data.lead}</p>
                {#if cells.data.detail}<p class="mt-0.5 text-micro text-muted">{cells.data.detail}</p>{/if}
              </div>
              <div class="rm-result min-w-0">
                <p class="rm-label admin-label">{tr('admin.runners.page.col.result')}</p>
                <p class={cn('text-2xs font-semibold', TONE[cells.result.tone])}>{cells.result.lead}</p>
                {#if cells.result.detail}<p class="mt-0.5 text-micro text-muted">{cells.result.detail}</p>{/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </Section>

    <Section title={tr('admin.runners.page.runs', { count: machine.runs.length })} description={tr('admin.runners.page.runsNote')}>
      {#if machine.runs.length === 0}
        <p class="text-ui text-muted">{tr('admin.runners.page.noRuns')}</p>
      {:else}
        <div class="rm-table border-t border-line">
          {#each machine.runs as item (item.attemptId)}
            {@const elapsed = item.startedAt === null ? null : Math.max(0, now - item.startedAt)}
            {@const share = elapsed === null ? 0 : Math.min(1, elapsed / Math.max(1, item.limitMs))}
            {@const late = share > 0.85}
            <div class="rm-run-row">
              <p class="rm-who min-w-0 truncate text-ui font-semibold text-ink">{item.entrantName} · #{item.number}</p>
              <p class="rm-where min-w-0 truncate text-2xs text-muted">{item.competition}</p>
              <span class="rm-card">
                {#if item.card}
                  <Badge word={cardWord(item.card.device)} tone="accent" case="lower" class="font-mono" />
                {/if}
              </span>
              <div class="rm-bar h-[3px] bg-raised" aria-hidden="true">
                <div class={cn('h-full', late ? 'bg-warning' : 'bg-accent')} style:width="{(share * 100).toFixed(1)}%"></div>
              </div>
              <span class={cn('rm-clock whitespace-nowrap text-right font-mono text-micro', late ? 'text-warning' : 'text-ink')}>
                {elapsed === null ? (runPhaseWord(item.phase) ?? '—') : `${clock(elapsed)} / ${clock(item.limitMs)}`}
              </span>
              <div class="rm-stop flex justify-end">
                <!-- Exporting or uploading, the notebook has run and its
                     answer is on its way to be scored: nothing to stop
                     (admin/runners.ts · stoppableOnMachine). -->
                {#if stoppableOnMachine(item.phase)}
                  <button
                    type="button"
                    class="admin-icon-btn hover:text-danger"
                    title={tr('admin.runners.page.stop')}
                    aria-label={tr('admin.runners.page.stopLabel', { who: `${item.entrantName} · #${item.number}` })}
                    disabled={busy}
                    onclick={() => void stopRun(item)}
                  >
                    <Icon name="x" size={13} />
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </Section>

    <Section title={tr('admin.runners.page.events')} description={tr('admin.runners.page.eventsNote')}>
      {#if machine.events.length === 0}
        <p class="text-ui text-muted">{tr('admin.runners.page.noEvents')}</p>
      {:else}
        <div class="border-t border-line">
          {#each showAll ? machine.events : machine.events.slice(0, EVENTS_SHOWN) as event, index (`${event.at}-${index}`)}
            {@const line = eventLine(event)}
            <div class="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 border-b border-line-soft py-2.5">
              <span class="w-[76px] shrink-0 font-mono text-micro text-muted">{eventTime(event.at, now)}</span>
              <div class="min-w-0 flex-1 basis-[240px]">
                <p class={cn('break-words text-2xs', TONE[line.tone])}>{line.text}</p>
                {#if line.detail}<p class="mt-0.5 break-words text-micro text-muted">{line.detail}</p>{/if}
              </div>
            </div>
          {/each}
        </div>
        {#if !showAll && machine.events.length > EVENTS_SHOWN}
          <button type="button" class="admin-link mt-3 max-[640px]:min-h-11" onclick={() => (showAll = true)}>
            {tr('admin.runners.page.showAll', { count: machine.events.length })}
          </button>
        {/if}
      {/if}
    </Section>
  {/if}
</AdminPage>

{#if dialog && machine}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="machine-dialog-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6 max-[640px]:p-4"
  >
    <div class="dialog-card w-full max-w-[460px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="machine-dialog-title" class="break-words text-title font-semibold text-ink">
        {dialog === 'trust'
          ? tr('admin.runners.trust.title', { name: machine.name })
          : dialog === 'classesOn'
            ? tr('admin.runners.classesOn.title', { name: machine.name })
            : dialog === 'classesOff'
              ? tr('admin.runners.classesOff.title', { name: machine.name })
              : dialog === 'moveClasses'
                ? tr('admin.runners.moveClasses.title', { name: machine.name })
                : tr('admin.runners.revoke.title', { name: machine.name })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {dialog === 'trust'
          ? tr('admin.runners.trust.body')
          : dialog === 'classesOn'
            ? tr('admin.runners.classesOn.body')
            : dialog === 'classesOff'
              ? heldClasses > 0
                ? tr('admin.runners.classesOff.body', { classes: classesCount(heldClasses) })
                : tr('admin.runners.classesOff.bodyEmpty')
              : dialog === 'moveClasses'
                ? tr('admin.runners.moveClasses.body', { classes: classesCount(heldClasses) })
                : tr('admin.runners.revoke.body')}
      </p>
      {#if actionError}
        <p class="mt-3 text-ui text-danger" role="alert">{actionError}</p>
      {/if}
      <div class="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (dialog = null)}>{tr('admin.cancel')}</button>
        {#if dialog === 'trust'}
          <button type="button" class="btn-primary" disabled={busy} onclick={() => void confirm()}>
            {busy ? tr('admin.runners.working') : tr('admin.runners.trust.confirm')}
          </button>
        {:else if dialog === 'classesOn'}
          <button type="button" class="btn-primary" disabled={busy} onclick={() => void confirm()}>
            {busy ? tr('admin.runners.working') : tr('admin.runners.classesOn.confirm')}
          </button>
        {:else if dialog === 'classesOff' || dialog === 'moveClasses'}
          <button type="button" class="btn-danger-solid" disabled={busy} onclick={() => void confirm()}>
            {busy
              ? tr('admin.runners.working')
              : dialog === 'classesOff'
                ? tr('admin.runners.classesOff.confirm')
                : tr('admin.runners.moveClasses.confirm')}
          </button>
        {:else}
          <button type="button" class="btn-danger-solid" disabled={busy} onclick={() => void confirm()}>
            {busy ? tr('admin.runners.working') : tr('admin.runners.revoke.confirm')}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /*
   * The facts: three to a line on a desktop, two on a phone, by the width the
   * section actually has (the panel's rail is 236 px or 56).
   */
  .rm-facts {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 16px 20px;
  }

  /*
   * The readiness table and the runs: a table from 760 px of their own
   * width, cards below it (M7), with the column captions moved into the card.
   */
  .rm-table {
    container-type: inline-size;
  }

  .rm-ready-head {
    display: none;
  }

  .rm-ready-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
    padding: 14px 0;
    border-bottom: 1px solid rgb(var(--line));
  }

  .rm-label {
    margin-bottom: 2px;
  }

  /* The classes table (Z3): a card per class below 760 px, the table above. */
  .rm-class-head {
    display: none;
  }

  .rm-class-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-areas:
      'name name'
      'kernels kernels'
      'memory cpu'
      'link files';
    gap: 10px 14px;
    padding: 14px 0;
    border-bottom: 1px solid rgb(var(--line));
  }

  .rm-c-name {
    grid-area: name;
  }

  .rm-c-kernels {
    grid-area: kernels;
  }

  .rm-c-memory {
    grid-area: memory;
  }

  .rm-c-cpu {
    grid-area: cpu;
  }

  .rm-c-link {
    grid-area: link;
  }

  .rm-c-files {
    grid-area: files;
  }

  .rm-run-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'who stop'
      'where where'
      'card clock'
      'bar bar';
    gap: 8px 12px;
    align-items: center;
    padding: 12px 0;
    border-bottom: 1px solid rgb(var(--line));
  }

  .rm-who {
    grid-area: who;
  }

  .rm-where {
    grid-area: where;
  }

  .rm-card {
    grid-area: card;
  }

  .rm-bar {
    grid-area: bar;
  }

  .rm-clock {
    grid-area: clock;
  }

  .rm-stop {
    grid-area: stop;
  }

  @container (min-width: 760px) {
    .rm-ready-head,
    .rm-ready-row {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 1.2fr);
      column-gap: 14px;
    }

    .rm-ready-head {
      align-items: center;
      height: 38px;
      border-bottom: 2px solid rgb(var(--ink));
    }

    .rm-ready-row {
      row-gap: 0;
      align-items: start;
    }

    .rm-label {
      display: none;
    }

    .rm-run-row {
      grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 72px minmax(0, 1.2fr) 104px 40px;
      grid-template-areas: 'who where card bar clock stop';
      padding: 8px 0;
    }

    .rm-class-head,
    .rm-class-row {
      display: grid;
      grid-template-columns: minmax(0, 224px) minmax(0, 1fr) 104px 44px 60px minmax(0, 1fr);
      grid-template-areas: 'name kernels memory cpu link files';
      column-gap: 14px;
    }

    .rm-class-head {
      align-items: center;
      height: 38px;
      border-bottom: 2px solid rgb(var(--ink));
    }

    .rm-class-row {
      row-gap: 0;
      align-items: start;
    }

    .rm-c-memory,
    .rm-c-cpu,
    .rm-c-link {
      text-align: right;
    }
  }
</style>
