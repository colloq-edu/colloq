<script lang="ts">
  /**
   * The packages a seminar's Python has.
   *
   * Drawn to artboard 1RG-0. One row per environment: what it contains, how big
   * the built image is, and whether the room is running it. Building shows the
   * log as it happens — a pip install of torch is four minutes of silence
   * otherwise, and silence is indistinguishable from a hang.
   *
   * The screen is honest about one thing the artboard leaves implicit: an
   * instance runs ONE kernel container, so switching switches for everybody.
   * That is said next to the button rather than discovered afterwards.
   */
  import { onMount } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { builtAgo, cn, imageSize } from '@/lib/utils'
  import { ENVIRONMENT_NAME, type AdminEnvironment, type EnvironmentsState } from '@shared/admin'

  // Not `state`: a variable by that name breaks the `$state` rune — Svelte
  // reads `$state` as a subscription to a store called `state`.
  let envs = $state<EnvironmentsState | null>(null)
  let loading = $state(true)
  let error = $state<string | null>(null)
  /** Per-row error, so a failed delete does not blank the page. */
  let rowError = $state<{ name: string; message: string } | null>(null)

  const isOwner = $derived(adminAuth.isOwner)
  const canBuild = $derived(envs?.canBuild ?? false)

  /* ------------------------------------------------------------- loading */

  async function refresh(): Promise<void> {
    try {
      envs = await adminApi.listEnvironments()
      error = null
    } catch (cause) {
      error = cause instanceof AdminApiError ? cause.message : 'Could not read the environments.'
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void refresh()
    /*
     * A build changes the row from the outside — it is a container image being
     * made, not a form being submitted. Polling only while something is
     * building keeps an idle panel quiet.
     */
    const tick = window.setInterval(() => {
      if (envs?.environments.some((e: AdminEnvironment) => e.state === 'building')) void refresh()
    }, 3000)
    const close = () => (openMenu = null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') openMenu = null
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearInterval(tick)
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  })

  /* ------------------------------------------------------------- the log */

  let logFor = $state<string | null>(null)
  let logLines = $state<string[]>([])
  let logBox = $state<HTMLElement | null>(null)
  let stream: EventSource | null = null

  /*
   * Which environment's build has just ended in front of the teacher, and only
   * for as long as that is still news. The one fact this screen exists to
   * deliver used to arrive with no announcement at all: a pill stopped blinking
   * and started saying a different word between two frames, four minutes into a
   * wait. `.enter` gives it the same 160ms the rest of the product gives to
   * something arriving, which says "this just changed" rather than "this is the
   * state" — a different sentence, and the one the teacher came here to read.
   *
   * Gated, because the pill is also inserted by `{#if}` on every first paint of
   * the screen: without the flag, every ready environment would replay the
   * entrance each time the tab is opened, which is decoration, not information.
   * The boundary is deliberate — only a completion watched live is marked. One
   * discovered by the 3s poll, in a tab reloaded or left behind, lands flat,
   * because the entrance is for the person who was staring at the log.
   */
  let justFinished = $state<string | null>(null)
  /** The finished row, once the refresh has actually brought its new state. */
  const finished = $derived.by(() => {
    if (justFinished === null) return null
    const env = envs?.environments.find((e: AdminEnvironment) => e.name === justFinished)
    return env && env.state !== 'building' ? env : null
  })

  function watch(name: string): void {
    stopWatching()
    logFor = name
    logLines = []
    stream = new EventSource(`/api/admin/environments/${encodeURIComponent(name)}/log`)
    stream.addEventListener('line', (event) => {
      logLines = [...logLines, JSON.parse((event as MessageEvent<string>).data) as string].slice(-300)
      // Follow the tail: a build log nobody has scrolled is read from the end.
      queueMicrotask(() => logBox?.scrollTo({ top: logBox.scrollHeight }))
    })
    stream.addEventListener('done', () => {
      stopWatching()
      /*
       * Only a build that was actually running has just ended. The endpoint
       * answers `done` immediately when there is no live build
       * (server/src/routes/admin-environments.ts:158-161), so simply opening
       * the Build log of something built last week arrives here too — and
       * marking that as "just finished" would replay the entrance below for a
       * fact that is days old, every time the log is opened.
       */
      if (envs?.environments.some((e: AdminEnvironment) => e.name === name && e.state === 'building')) {
        justFinished = name
        /*
         * The flag has to still be set when the pill mounts, and the pill only
         * mounts after refresh() has been to the server and back. A tidy-looking
         * short timer can therefore clear it first, and the entrance then
         * silently never plays. 1.5s is comfortably longer than that round trip
         * and comfortably shorter than the 3s poll above, which is the only
         * thing that could replay the entrance for a build that ended long ago.
         * The guard keeps a second build's flag from being cleared by the
         * first one's timer.
         */
        window.setTimeout(() => {
          if (justFinished === name) justFinished = null
        }, 1500)
      }
      void refresh()
    })
    stream.onerror = () => stopWatching()
  }

  function stopWatching(): void {
    stream?.close()
    stream = null
  }

  onMount(() => stopWatching)

  /* ------------------------------------------------------------ actions */

  let busy = $state<string | null>(null)

  async function act(name: string, what: () => Promise<unknown>, follow = false): Promise<void> {
    busy = name
    rowError = null
    try {
      await what()
      if (follow) watch(name)
      await refresh()
    } catch (cause) {
      rowError = {
        name,
        message: cause instanceof AdminApiError ? cause.message : 'That did not work.',
      }
    } finally {
      busy = null
    }
  }

  const build = (env: AdminEnvironment) =>
    act(env.name, () => adminApi.buildEnvironment(env.name), true)
  const cancel = (env: AdminEnvironment) => act(env.name, () => adminApi.cancelEnvironmentBuild(env.name))

  /* ------------------------------------------------------------ editing */

  let editing = $state<string | null>(null)
  let draftName = $state('')
  let draftSource = $state('')
  let creating = $state(false)

  async function openEditor(name: string): Promise<void> {
    rowError = null
    creating = false
    draftName = name
    editing = name
    draftSource = (await adminApi.readEnvironment(name)).source
  }

  function openCreate(): void {
    rowError = null
    creating = true
    editing = ''
    draftName = ''
    draftSource =
      '# Installed on top of the base (numpy, pandas, matplotlib, scikit-learn),\n' +
      '# so there is no need to list those. One package per line:\n#\n#   transformers>=4.44\n'
  }

  function duplicate(env: AdminEnvironment): void {
    void (async () => {
      const source = (await adminApi.readEnvironment(env.name)).source
      creating = true
      editing = ''
      draftName = `${env.name}-copy`.slice(0, 32)
      draftSource = source
    })()
  }

  const nameOk = $derived(ENVIRONMENT_NAME.test(draftName.trim()))

  async function save(): Promise<void> {
    const name = draftName.trim()
    if (!nameOk) return
    busy = name
    rowError = null
    try {
      await adminApi.saveEnvironment(name, draftSource)
      editing = null
      creating = false
      await refresh()
    } catch (cause) {
      rowError = {
        name,
        message: cause instanceof AdminApiError ? cause.message : 'Could not save that.',
      }
    } finally {
      busy = null
    }
  }

  /* ------------------------------------------------------------ deleting */

  let doomed = $state<string | null>(null)

  async function confirmDelete(): Promise<void> {
    const name = doomed
    if (!name) return
    await act(name, () => adminApi.deleteEnvironment(name))
    doomed = null
  }

  /* ------------------------------------------------------------ switching */

  let switching = $state<string | null>(null)

  async function confirmUse(): Promise<void> {
    const name = switching
    if (!name) return
    await act(name, () => adminApi.useEnvironment(name))
    switching = null
  }

  /* ---------------------------------------------------------- formatting */


  /** A stable colour per environment, so a row is recognisable at a glance. */
  function swatch(name: string): string {
    const hues = ['#8B6BD9', '#0FA0D7', '#2FA36B', '#E3A72F', '#E8734A', '#D4162F']
    let sum = 0
    for (const ch of name) sum = (sum + ch.charCodeAt(0)) % 997
    return hues[sum % hues.length]
  }

  const BTN =
    'inline-flex h-8 shrink-0 items-center gap-1.5 border border-line px-3 text-2xs font-bold ' +
    'uppercase tracking-label text-ink transition-colors duration-100 hover:bg-raised ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ' +
    'disabled:pointer-events-none disabled:opacity-40'
  const PILL = 'inline-flex h-[26px] shrink-0 items-center gap-1.5 px-2.5 text-micro font-bold uppercase tracking-label'
  const ITEM =
    'flex w-full items-center px-2.5 py-1.5 text-left text-ui text-ink transition-colors ' +
    'duration-100 hover:bg-raised disabled:pointer-events-none disabled:opacity-40'

  /** Which row's overflow menu is open. One at a time, like the seminars table. */
  let openMenu = $state<string | null>(null)
</script>

<AdminPage
  title="Environments"
  subtitle="A prebuilt container per course. Built once, reused by every seminar — nobody waits for pip during class."
>
  {#snippet actions()}
    <button
      type="button"
      class="inline-flex h-9 items-center gap-2 bg-primary px-4 text-2xs font-bold uppercase tracking-label text-primary-ink transition-opacity duration-100 hover:opacity-90 disabled:opacity-40"
      onclick={openCreate}
    >
      <Icon name="plus" size={14} />
      New environment
    </button>
  {/snippet}

  <!--
    The entrance on the pill only reaches a teacher who is looking at the row,
    and the premise of this screen is that they have been waiting four minutes
    and may well have looked away. This says the same thing to a reader who is
    not watching. It is one region outside the loop, written only while
    `justFinished` is set: the 3s poll reassigns every row wholesale, and a live
    region per row would narrate all of that instead of announcing the one event
    that matters.
  -->
  <p class="sr-only" aria-live="polite">
    {#if finished}
      {finished.name}: {finished.state === 'failed' ? 'build failed' : 'build finished'}
    {/if}
  </p>

  {#if loading}
    <div class="h-24"></div>
  {:else if error}
    <p class="border-l-2 border-danger px-3 py-2 text-ui text-danger">{error}</p>
  {:else if envs}
    <div class="pt-5">
    {#if !canBuild}
      <!-- Not a warning about something broken: an install that never mounted
           the Docker socket is a normal way to run this, and the panel is still
           the right place to read and edit the lists. -->
      <div class="mb-4 flex items-start gap-2.5 border border-line bg-surface px-3 py-2.5">
        <Icon name="info" size={14} class="mt-0.5 shrink-0 text-muted" />
        <p class="text-2xs leading-relaxed text-muted">{envs.cannotBuildReason}</p>
      </div>
    {/if}

    <div class="flex flex-col gap-2.5">
      {#each envs.environments as env (env.name)}
        <section class="border border-line">
          <div class="flex items-center gap-3 px-3.5 py-3">
            <span
              class="h-2.5 w-2.5 shrink-0"
              style="background: {swatch(env.name)}"
              aria-hidden="true"
            ></span>

            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <div class="flex items-center gap-2">
                <span class="truncate font-mono text-ui-lg font-semibold text-ink">{env.name}</span>
              </div>
              <!--
                Only the facts that exist. The row used to print size and build
                date unconditionally, so an environment that had never been
                built still read "— · never built" — two placeholders where
                there is simply nothing to say — and one that WAS built but
                edited since read "216 MB · built 5 days ago" beside a pill
                saying "Not built". Both halves were true of different things.
              -->
              <p class="truncate text-2xs text-muted">
                {[
                  'Python 3.11',
                  env.imageBytes === null ? null : imageSize(env.imageBytes),
                  env.builtAt === null ? null : builtAgo(env.builtAt),
                  `${env.packages.length} packages over the base`,
                ]
                  .filter((part) => part !== null)
                  .join(' · ')}
              </p>
            </div>

            {#if env.state === 'building'}
              <span class="{PILL} bg-accent/15 text-accent-text">
                <span class="h-1.5 w-1.5 animate-blink rounded-full bg-accent"></span>
                Building
              </span>
              <button class={BTN} onclick={() => cancel(env)} disabled={!isOwner || busy === env.name}>
                Cancel
              </button>
            {:else}
              <!--
                `.enter` and not a keyframe of this screen's own: index.css
                names this exact case in the comment over `colloq-enter` — "a
                status settling" — and the panel gains nothing from a second
                vocabulary for it. It is also opacity plus 3px, which is why
                there is no reduced-motion branch here: index.css already swaps
                that keyframe for its travel-free twin.
              -->
              {#if env.state === 'ready'}
                <span class={cn(PILL, 'text-positive', justFinished === env.name && 'enter')}>
                  <Icon name="check" size={12} />
                  Ready
                </span>
              {:else if env.state === 'failed'}
                <!-- The same mark on the failure. A wait ending badly is still
                     the wait ending, and a build that fails unannounced is the
                     worse of the two to miss. -->
                <span class={cn(PILL, 'bg-danger text-white', justFinished === env.name && 'enter')}>
                  Build failed
                </span>
              {:else if env.builtAt !== null}
                <!--
                  BUILT, BUT STALE — and that is not the same as "not built".
                  The image exists, rooms are running it right now; what changed
                  is the package list, saved after the build. Calling that "Not
                  built" beside "216 MB · built 5 days ago" is how the panel
                  contradicts itself in one line, and the reader is left unable
                  to tell whether anything is there at all.
                -->
                <span class={cn(PILL, 'text-warning')}>Needs rebuild</span>
              {:else}
                <span class={cn(PILL, 'text-muted')}>Not built</span>
              {/if}

              {#if env.active}
                <!--
                  «Default», а не «in use»: с окружением на семинар в работе
                  могут быть несколько сразу, по контейнеру на каждое. Это
                  окружение — то, что получит следующая созданная комната.
                -->
                <span class="{PILL} bg-accent/15 text-accent-text">Default</span>
              {/if}

              <!--
                One action, then a menu. Five buttons of equal weight in a row
                make the reader choose before they have read anything; the
                artboard draws two, and the seminars table already uses this
                exact pattern for the rest.
              -->
              {#if !env.active && env.state === 'ready'}
                <button
                  class="inline-flex h-8 shrink-0 items-center bg-primary px-3 text-2xs font-bold uppercase tracking-label text-primary-ink transition-opacity duration-100 hover:opacity-90 disabled:opacity-40"
                  onclick={() => (switching = env.name)}
                  disabled={!isOwner || !canBuild || busy === env.name}
                  title="New seminars will be created on this environment"
                >
                  Make default
                </button>
              {:else if env.state !== 'ready'}
                <button
                  class="inline-flex h-8 shrink-0 items-center bg-primary px-3 text-2xs font-bold uppercase tracking-label text-primary-ink transition-opacity duration-100 hover:opacity-90 disabled:opacity-40"
                  onclick={() => build(env)}
                  disabled={!isOwner || !canBuild || busy === env.name}
                >
                  Build
                </button>
              {/if}

              <div class="relative">
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === env.name}
                  aria-label="Actions for {env.name}"
                  class="flex h-8 w-8 items-center justify-center border border-line text-muted transition-colors duration-100 hover:bg-raised hover:text-ink"
                  onclick={(event) => {
                    event.stopPropagation()
                    openMenu = openMenu === env.name ? null : env.name
                  }}
                >
                  <Icon name="more" size={15} />
                </button>
                {#if openMenu === env.name}
                  <div
                    role="menu"
                    tabindex="-1"
                    class="row-menu absolute right-0 top-full z-30 mt-1 w-44 border border-line bg-canvas p-1 shadow-pop"
                  >
                    <button role="menuitem" class={ITEM} onclick={() => openEditor(env.name)}>
                      Edit packages
                    </button>
                    <button role="menuitem" class={ITEM} onclick={() => duplicate(env)}>
                      Duplicate
                    </button>
                    <button
                      role="menuitem"
                      class={ITEM}
                      onclick={() => build(env)}
                      disabled={!isOwner || !canBuild}
                    >
                      {env.state === 'ready' ? 'Rebuild' : 'Build'}
                    </button>
                    <button role="menuitem" class={ITEM} onclick={() => watch(env.name)}>
                      Build log
                    </button>
                    {#if env.name !== 'base' && !env.active}
                      <button
                        role="menuitem"
                        class={cn(ITEM, 'text-danger hover:bg-danger/10')}
                        onclick={() => (doomed = env.name)}
                        disabled={!isOwner}
                      >
                        Delete…
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>

          {#if env.packages.length > 0 && env.state !== 'building' && logFor !== env.name}
            <div class="flex flex-wrap gap-1.5 border-t border-line px-3.5 py-2.5">
              {#each env.packages.slice(0, 8) as pkg (pkg)}
                <span class="bg-surface px-2 py-1 font-mono text-micro text-muted">{pkg}</span>
              {/each}
              {#if env.packages.length > 8}
                <span class="px-2 py-1 font-mono text-micro text-faint">
                  +{env.packages.length - 8} more
                </span>
              {/if}
            </div>
          {/if}

          {#if logFor === env.name}
            <div
              bind:this={logBox}
              class="max-h-[76px] overflow-y-auto border-t border-line bg-[#060C1C] px-3.5 py-2"
            >
              <pre class="whitespace-pre-wrap font-mono text-code leading-relaxed text-[#9BA6BE]">{logLines.join(
                  '\n',
                ) || 'waiting for the build to say something…'}</pre>
            </div>
          {:else if env.state === 'failed' && env.error}
            <div class="flex items-start gap-2 border-t border-line bg-danger/[0.06] px-3.5 py-2.5">
              <Icon name="alert" size={13} class="mt-0.5 shrink-0 text-danger" />
              <p class="min-w-0 flex-1 break-words font-mono text-micro leading-relaxed text-danger">
                {env.error}
              </p>
              <button class={BTN} onclick={() => watch(env.name)}>Full log</button>
            </div>
          {/if}

          {#if rowError?.name === env.name}
            <p class="border-t border-line px-3.5 py-2 text-2xs text-danger">{rowError.message}</p>
          {/if}
        </section>
      {/each}
    </div>

    <p class="mt-4 flex items-start gap-2 text-2xs leading-relaxed text-muted">
      <Icon name="info" size={13} class="mt-0.5 shrink-0" />
      <span>
        An environment is a container image, and every environment somebody is using runs in its
        own container. A seminar picks one when it is created and keeps it, so making a different
        one the default changes what the <b class="font-semibold text-ink">next</b> seminar gets —
        not what an existing one is running.
      </span>
    </p>
    </div>
  {/if}
</AdminPage>

<!-- ------------------------------------------------------------- editor -->
{#if editing !== null}
  <div class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4">
    <div
      class="dialog-card flex max-h-[80vh] w-full max-w-2xl flex-col border border-line bg-canvas shadow-pop"
    >
      <div class="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <h2 class="flex-1 text-head font-black tracking-tight text-ink">
          {creating ? 'New environment' : `Environment ${draftName}`}
        </h2>
        <button class={BTN} onclick={() => ((editing = null), (creating = false))}>Close</button>
      </div>

      <div class="flex flex-col gap-4 overflow-y-auto px-5 py-4">
        {#if creating}
          <div class="flex flex-col gap-[7px]">
            <label for="env-name" class="text-2xs font-bold uppercase tracking-label text-muted">
              Name
            </label>
            <input
              id="env-name"
              bind:value={draftName}
              class="field h-[46px] bg-canvas px-4 font-mono text-code-lg"
              placeholder="cv-torch"
              autocomplete="off"
              spellcheck="false"
            />
            <p class="text-2xs text-muted">
              Lowercase letters, digits and dashes — the name becomes a filename and a Docker tag.
            </p>
          </div>
        {/if}

        <div class="flex flex-col gap-[7px]">
          <label for="env-source" class="text-2xs font-bold uppercase tracking-label text-muted">
            Packages
          </label>
          <textarea
            id="env-source"
            bind:value={draftSource}
            rows="14"
            class="field bg-canvas px-4 py-3 font-mono text-code-lg leading-relaxed"
            spellcheck="false"
          ></textarea>
          <p class="text-2xs text-muted">
            An ordinary requirements.txt. Installed on top of the base every kernel already has.
          </p>
        </div>
      </div>

      <div class="flex items-center gap-2 border-t border-line px-5 py-3.5">
        <p class="flex-1 text-2xs text-muted">
          Saving only writes the file. Building is what puts it in a kernel.
        </p>
        <button class={BTN} onclick={() => ((editing = null), (creating = false))}>Cancel</button>
        <button
          class="inline-flex h-8 items-center bg-primary px-4 text-2xs font-bold uppercase tracking-label text-primary-ink transition-opacity duration-100 hover:opacity-90 disabled:opacity-40"
          onclick={save}
          disabled={!nameOk || busy !== null}
        >
          Save
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ------------------------------------------------------ confirmations -->
{#if doomed}
  <div class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4">
    <div class="dialog-card w-full max-w-md border border-line bg-canvas p-5 shadow-pop">
      <h2 class="text-head font-black tracking-tight text-ink">Delete {doomed}?</h2>
      <p class="mt-2 text-ui text-muted">
        The package list goes. The built image stays in Docker — remove it separately if
        you no longer want it.
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button class={BTN} onclick={() => (doomed = null)}>Cancel</button>
        <button
          class="inline-flex h-8 items-center bg-danger px-4 text-2xs font-bold uppercase tracking-label text-white"
          onclick={confirmDelete}
        >
          Delete
        </button>
      </div>
    </div>
  </div>
{/if}

{#if switching}
  <div class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4">
    <div class="dialog-card w-full max-w-md border border-line bg-canvas p-5 shadow-pop">
      <h2 class="text-head font-black tracking-tight text-ink">Make {switching} the default?</h2>
      <p class="mt-2 text-ui text-muted">
        Seminars created from now on get {switching}. Seminars already pinned to another
        environment are untouched — they run in their own containers.
      </p>
      <p class="mt-2 text-ui text-muted">
        The shared kernel does restart, so any room currently running on the old default loses its
        variables and has to run those cells again. The cells and the files themselves stay.
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button class={BTN} onclick={() => (switching = null)}>Cancel</button>
        <button
          class="inline-flex h-8 items-center bg-primary px-4 text-2xs font-bold uppercase tracking-label text-primary-ink"
          onclick={confirmUse}
        >
          Make default
        </button>
      </div>
    </div>
  </div>
{/if}
