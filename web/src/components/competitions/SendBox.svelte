<script lang="ts">
  /**
   * The notebook drop zone: drag-and-drop plus a button (P2), a single button
   * (P4).
   *
   * There is no upload "from the notebook in the class" here — the owner
   * removed it from the mockup, and that is not a simplification but a rule:
   * the check runs the notebook FROM SCRATCH, while the notebook in the room
   * lives with saved variables and other people's edits. The only way is a
   * file the person chose and saw themselves.
   *
   * The extension is checked here, before the network: twenty megabytes over
   * mobile internet just to hear "only an .ipynb notebook is accepted" is not
   * a check, it is a punishment.
   */
  import { onMount } from 'svelte'
  import type { DependencyOverview } from '@shared/dependencies'
  import { entrantApi } from '@/lib/entrantApi'
  import { tr } from '@shared/i18n'
  import type { EntrantCompetitionView, EntrantSubmissions } from '@shared/competitions-entrant'

  interface Props {
    view: EntrantCompetitionView
    mine: EntrantSubmissions
    phone: boolean
    busy: boolean
    /** A send refusal — in the server's words, or our own about the extension. */
    refusal: string | null
    onsend: (file: File, bundleId?: string | null) => Promise<boolean>
    onrefuse: (message: string) => void
  }

  const { view, mine, phone, busy, refusal, onsend, onrefuse }: Props = $props()

  let chosenFile = $state<File | null>(null)
  let dependencies = $state<DependencyOverview | null>(null)
  let bundleId = $state('')
  let packageError = $state('')
  let loadingPackages = $state(true)
  const readyBundles = $derived(dependencies?.bundles.filter((bundle) => bundle.state === 'ready' && bundle.revisionId === dependencies?.revision?.id) ?? [])
  const selectionReset = $derived(!!dependencies?.draft.selectedBundleId && !readyBundles.some((bundle) => bundle.id === dependencies?.draft.selectedBundleId))
  async function loadPackages(): Promise<void> {
    loadingPackages = true
    try {
      const next = await entrantApi.dependencies(view.competition.slug)
      dependencies = next
      bundleId = next.bundles.some((bundle) => bundle.id === next.draft.selectedBundleId && bundle.state === 'ready' && bundle.revisionId === next.revision?.id) ? next.draft.selectedBundleId ?? '' : ''
      packageError = ''
    } catch (cause) { packageError = cause instanceof Error ? cause.message : tr('common.networkError') }
    finally { loadingPackages = false }
  }
  onMount(() => { void loadPackages() })
  async function confirmSend(): Promise<void> {
    if (!chosenFile || blocked || loadingPackages || packageError) return
    if (await onsend(chosenFile, bundleId || null)) chosenFile = null
  }

  let dragging = $state(false)
  let input = $state<HTMLInputElement | null>(null)

  const minutes = $derived(Math.max(1, Math.round(view.competition.limits.wallSeconds / 60)))
  const quota = $derived.by(() => {
    /*
     * Closed submissions have no daily quota.
     *
     * "You can send 4 more submissions today, out of 5" above a button that
     * will not accept anything any more is a promise, and it can be read in
     * exactly one way: "so something is broken". Under the zone there is
     * already a sentence saying why submissions are closed, and it is the
     * only truth here.
     */
    if (mine.accepting !== 'open') return ''
    if (mine.leftToday === null) return tr('competitions.p.dropNoLimit')
    if (mine.leftToday <= 0) {
      return tr('competitions.refusal.dailyQuota', { count: mine.perDay })
    }
    return tr(phone ? 'competitions.p.phoneLeftToday' : 'competitions.p.dropLeftToday', {
      count: mine.leftToday,
      perDay: mine.perDay,
    })
  })
  const unavailable = $derived(view.capabilities?.execution.available === false)
  const blocked = $derived(
    unavailable || busy || mine.accepting !== 'open' || mine.inFlight > 0 || mine.leftToday === 0,
  )

  function take(list: FileList | null | undefined): void {
    if (blocked) return
    const file = list?.[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.ipynb')) {
      onrefuse(tr('competitions.refusal.notIpynb'))
      return
    }
    chosenFile = file
    onrefuse('')
  }
</script>

<div class="flex flex-col gap-2">
  {#if phone}
    <button
      class="flex h-12 w-full items-center justify-center bg-brand text-2xs font-black uppercase tracking-label text-white disabled:bg-faint"
      type="button"
      disabled={blocked}
      onclick={() => input?.click()}
    >
      {busy ? tr('competitions.p.sending') : tr('competitions.p.pickFilePhone')}
    </button>
    <p class="text-2xs leading-[18px] text-muted">
      {tr('competitions.p.phoneNeedsCsv')}{#if quota}<br />{quota}{/if}<br />{tr(
        'competitions.p.phoneLimits',
        { count: minutes },
      )}
    </p>
  {:else}
    <div
      class="flex flex-col gap-4 border-[1.5px] border-dashed bg-surface sm:flex-row sm:items-center {dragging
        ? 'border-accent bg-accent/5'
        : 'border-brand-2'}"
      role="region"
      aria-label={tr('competitions.p.dropTitle')}
      ondragover={(event) => {
        event.preventDefault()
        dragging = true
      }}
      ondragleave={() => (dragging = false)}
      ondrop={(event) => {
        event.preventDefault()
        dragging = false
        if (!blocked) take(event.dataTransfer?.files)
      }}
    >
      <div class="flex min-w-0 grow items-center gap-[18px] px-6 py-[22px]">
        <svg width="28" height="32" viewBox="0 0 28 32" class="shrink-0 text-primary" aria-hidden="true">
          <path d="M2 2h15l9 9v19H2V2Z" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M17 2v9h9" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M14 25V15m0 0-4 4m4-4 4 4" fill="none" stroke="rgb(var(--accent))" stroke-width="2" />
        </svg>
        <div class="flex min-w-0 flex-col gap-1">
          <p class="text-title font-bold leading-6 text-ink">
            {dragging ? tr('competitions.p.dropHere') : tr('competitions.p.dropTitle')}
          </p>
          <p class="text-ui leading-5 text-muted">
            {tr('competitions.p.dropNeedsCsv')}{#if quota}<br />{quota}{/if}
          </p>
        </div>
      </div>
      <div class="flex shrink-0 items-center justify-center px-6 pb-[22px] sm:w-[238px] sm:pb-0">
        <button
          class="h-11 w-[190px] max-w-full bg-brand px-[18px] text-micro font-black uppercase tracking-label text-white hover:bg-brand-2 disabled:bg-faint"
          type="button"
          disabled={blocked}
          onclick={() => input?.click()}
        >
          {busy ? tr('competitions.p.sending') : tr('competitions.p.pickFile')}
        </button>
      </div>
    </div>
  {/if}

  {#if chosenFile}
    <div class="space-y-3 border border-line bg-surface p-4 text-[15px]">
      <div class="flex flex-wrap items-center justify-between gap-2"><strong class="break-all text-ink">{chosenFile.name}</strong><button type="button" class="min-h-10 text-[14px] text-accent-text underline" disabled={busy} onclick={() => (chosenFile = null)}>{tr('dependencies.removeFile')}</button></div>
      <label class="block text-[14px] font-bold text-ink" for="submission-packages">{tr('dependencies.sendWith')}</label>
      <select id="submission-packages" class="min-h-11 w-full max-w-full border border-line bg-canvas px-3 text-[15px] text-ink" bind:value={bundleId} disabled={busy || loadingPackages}>
        <option value="">{tr('dependencies.base')}</option>
        {#each readyBundles as bundle (bundle.id)}<option value={bundle.id}>{tr('dependencies.set', { number: bundle.number })}</option>{/each}
      </select>
      {#if dependencies?.revision}<p class="break-words text-[14px] text-muted">{dependencies.revision.environmentName} · Python {dependencies.revision.pythonVersion}</p>{/if}
      {#if selectionReset && !bundleId}<p class="text-[14px] text-warning" role="status">{tr('dependencies.selectionReset')}</p>{/if}
      {#if loadingPackages}<p class="text-[14px] text-muted" role="status">{tr('dependencies.loading')}</p>{/if}
      {#if packageError}<p class="text-[14px] text-danger" role="alert">{packageError}</p><button type="button" class="min-h-10 text-accent-text underline" onclick={loadPackages}>{tr('dependencies.reload')}</button>{/if}
      <p class="text-[14px] text-muted">{tr('dependencies.sendHint')}</p>
      <div class="flex flex-wrap items-center gap-4"><button type="button" class="min-h-11 bg-brand px-5 font-bold text-white disabled:opacity-50" disabled={blocked || loadingPackages || !!packageError} onclick={confirmSend}>{tr(busy ? 'competitions.p.sending' : 'dependencies.send')}</button><a class="text-[14px] text-accent-text underline" href={`/k/${view.competition.slug}/dependencies`}>{tr('dependencies.manage')}</a></div>
    </div>
  {/if}

  {#if unavailable}
    <p class="text-2xs leading-[18px] text-warning" role="status">{view.capabilities?.execution.reason}</p>
  {/if}
  {#if refusal}
    <p class="text-2xs leading-[18px] text-danger" role="alert">{refusal}</p>
  {:else if mine.inFlight > 0}
    <p class="text-2xs leading-[18px] text-muted">{tr('competitions.refusal.inFlight')}</p>
  {:else if mine.accepting === 'closed'}
    <p class="text-2xs leading-[18px] text-muted">{tr('competitions.refusal.closed')}</p>
  {:else if mine.accepting === 'not_open'}
    <p class="text-2xs leading-[18px] text-muted">{tr('competitions.refusal.notOpen')}</p>
  {/if}

  <input
    class="hidden"
    type="file"
    disabled={blocked}
    accept=".ipynb,application/x-ipynb+json"
    bind:this={input}
    onchange={(event) => {
      const target = event.currentTarget
      take(target.files)
      // The field is reset, otherwise choosing THE SAME file again does not
      // fire the event at all: a person edits the notebook and sends it again
      // — the usual case.
      target.value = ''
    }}
  />
</div>
