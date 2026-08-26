<script lang="ts">
  /**
   * Opening a room, and deciding what kind of room it is.
   *
   * Creating a seminar used to be one line inside the list: a name, maybe an
   * environment, and Enter. That is the right shape for the fifth seminar of the
   * week and the wrong shape for the first one of a course, where the decisions
   * that matter — which Python, what the class may do, whether the oracle
   * answers at all — are decisions you want to see before twenty people are in
   * the room rather than after.
   *
   * The honesty rule this screen runs on: a control that looks like a setting
   * has to be one. Rules the server cannot keep yet are not drawn as switches
   * that quietly do nothing — they are listed as what the room does today, with
   * the reason. A teacher deserves the real picture of what they can and cannot
   * hold, not the flattering half of it.
   */
  import { onMount } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Section from '@/admin/ui/Section.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { adminApi } from '@/lib/adminApi'
  import { cn } from '@/lib/utils'
  import { LIMITS, type AdminEnvironment, type ImportPreview } from '@shared/admin'
  import { OPEN_ROOM, type RoomRules, type Who } from '@shared/rules'

  interface Props {
    /** Back to the list, with the new seminar's id when one was made. */
    ondone: (createdId?: string) => void
  }

  let { ondone }: Props = $props()

  let name = $state('')
  let fromGithub = $state(false)
  let githubUrl = $state('')
  let environment = $state('')
  let environments = $state<AdminEnvironment[] | null>(null)

  /* The room's rules, starting as the open room the product has always been. */
  let rules = $state<RoomRules>({ ...OPEN_ROOM })

  let preview = $state<ImportPreview | null>(null)
  let previewing = $state(false)
  let previewError = $state<string | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)

  onMount(() => {
    void adminApi
      .listEnvironments()
      .then((r: { environments: AdminEnvironment[] }) => {
        environments = r.environments
        if (!environment) environment = r.environments.find((e: AdminEnvironment) => e.active)?.name ?? ''
      })
      .catch(() => (environments = []))
  })

  /*
   * The link is read before the room exists, so a teacher sees what will arrive
   * rather than finding out afterwards. Debounced because this reaches out to
   * GitHub, and a request per keystroke would spend somebody's rate limit on
   * half-typed URLs.
   */
  let previewTimer: ReturnType<typeof setTimeout> | null = null
  $effect(() => {
    const url = githubUrl.trim()
    if (previewTimer) clearTimeout(previewTimer)
    if (!fromGithub || !url) {
      preview = null
      previewError = null
      return
    }
    previewTimer = setTimeout(() => {
      previewing = true
      previewError = null
      void adminApi
        .previewImport(url)
        .then((p: ImportPreview) => {
          preview = p
          if (!name.trim()) name = p.name
        })
        .catch((cause: unknown) => {
          preview = null
          previewError = cause instanceof Error ? cause.message : 'Could not read that link'
        })
        .finally(() => (previewing = false))
    }, 500)
    return () => {
      if (previewTimer) clearTimeout(previewTimer)
    }
  })

  const canCreate = $derived(
    !busy && (fromGithub ? Boolean(preview) : name.trim().length > 0),
  )

  async function create(): Promise<void> {
    if (!canCreate) return
    busy = true
    error = null
    try {
      const seminar = fromGithub
        ? await adminApi.importSeminar({
            url: githubUrl.trim(),
            name: name.trim() || undefined,
            environment: environment || null,
            rules,
          })
        : await adminApi.createSeminar({
            name: name.trim(),
            environment: environment || null,
            rules,
          })
      ondone(seminar.id)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not create the seminar'
      busy = false
    }
  }

  /** One row of the rules table: a question, a sentence, and two answers. */
  const WHO: { value: Who; label: string }[] = [
    { value: 'room', label: 'Everyone' },
    { value: 'host', label: 'Teacher only' },
  ]

  const ORACLE: { value: RoomRules['oracle']; label: string; note: string }[] = [
    { value: 'inherit', label: 'As set for the instance', note: 'whatever Oracle settings say' },
    { value: 'off', label: 'Off', note: 'no oracle in this room at all' },
    { value: 'hints', label: 'Hints only', note: 'nudges, never the solution' },
    { value: 'full', label: 'Full answers', note: 'explains and writes code' },
  ]

  /*
   * What the room does today and cannot yet be told not to. Listed, not
   * switched: every one of these lives in the shared document or in a route
   * that checks only that you belong to the seminar, so a switch here would be
   * a promise the server does not keep. The right-hand note says why, because
   * "coming soon" tells a teacher nothing they can plan around.
   */
  const NOT_YET: { what: string; why: string }[] = [
    { what: 'Edit what is written in the cells', why: 'the notebook is shared by design' },
    { what: 'Add, delete and reorder cells', why: 'history can undo any of it' },
    { what: 'Open the terminal and run commands', why: 'same container as the kernel' },
    { what: 'Upload and delete files', why: 'reading them already needs the link' },
  ]
</script>

{#snippet actions()}
  <button type="button" class="btn-ghost" onclick={() => ondone()}>Cancel</button>
  <button type="button" class="btn-primary" disabled={!canCreate} onclick={create}>
    {#if busy}
      <Icon name="spinner" size={15} class="animate-spin" />
      Creating…
    {:else}
      Create and open
    {/if}
  </button>
{/snippet}

<AdminPage
  title="New seminar"
  subtitle="Nothing here is saved until you press Create — the room does not exist yet."
  {actions}
>
  {#if error}
    <p class="mb-4 border-l-2 border-danger bg-danger/[0.06] px-3 py-2 text-ui text-danger" role="alert">
      {error}
    </p>
  {/if}

  <Section
    title="Basics"
    description="The name is what students see on the join screen, so write it the way you say it out loud."
  >
    <div class="flex flex-col gap-3">
      <input
        bind:value={name}
        class="field"
        placeholder="Week 7 — Attention"
        maxlength={LIMITS.seminarName}
        aria-label="Seminar name"
      />

      <!--
        Two doors into one room, drawn as doors rather than as tabs.

        Where the notebook comes from is the first decision and the one that
        changes every other field on this screen, so it gets the weight of a
        choice instead of the weight of a filter. Each door shows what is
        actually behind it: the blank one prints the two cells the server really
        seeds, the other names the file it will take. A tab pair says "pick a
        mode"; these say "pick a starting point".
      -->
      <div class="flex flex-wrap gap-3">
        <button
          type="button"
          class={cn(
            'flex w-[280px] shrink-0 flex-col gap-2.5 border p-3.5 text-left',
            'transition-colors duration-[var(--speed-quick)] ease-out',
            !fromGithub ? 'border-accent bg-surface' : 'border-line bg-canvas hover:border-faint',
          )}
          aria-pressed={!fromGithub}
          onclick={() => ((fromGithub = false), (preview = null))}
        >
          <span class="text-2xs font-bold uppercase tracking-label text-ink">Blank notebook</span>
          <!-- The bytes ensureInitialNotebook() actually seeds, not a description
               of them: a door should show what is behind it. -->
          <span class="flex flex-col gap-0.5 border border-line bg-canvas px-2.5 py-2 font-mono text-2xs">
            <span class="text-muted"># Welcome</span>
            <span class="text-ink">print("hello, seminar")</span>
          </span>
          <span class="text-2xs text-muted">Exactly these two cells. Nothing else is seeded.</span>
        </button>

        <button
          type="button"
          class={cn(
            'flex w-[280px] shrink-0 flex-col gap-2.5 border p-3.5 text-left',
            'transition-colors duration-[var(--speed-quick)] ease-out',
            fromGithub ? 'border-accent bg-surface' : 'border-line bg-canvas hover:border-faint',
          )}
          aria-pressed={fromGithub}
          onclick={() => (fromGithub = true)}
        >
          <span class="text-2xs font-bold uppercase tracking-label text-ink">From GitHub</span>
          <span class="flex h-[34px] items-center border border-line bg-canvas px-2.5 font-mono text-2xs text-faint">
            github.com/…/week02
          </span>
          <span class="text-2xs text-muted">
            The first .ipynb by name, plus the data beside it. Outputs are dropped.
          </span>
        </button>
      </div>

      {#if fromGithub}
        <input
          bind:value={githubUrl}
          class="field font-mono text-code-lg"
          placeholder="https://github.com/sleep3r/ml_hse/tree/main/week02"
          autocomplete="off"
          spellcheck="false"
          aria-label="GitHub link to a notebook or a folder"
        />
        {#if previewing}
          <p class="text-2xs text-muted">Reading the repository…</p>
        {:else if previewError}
          <p class="text-2xs text-danger">{previewError}</p>
        {:else if preview}
          <div class="flex flex-wrap items-center gap-2 text-2xs text-muted">
            <span class="font-mono text-ink">{preview.notebook}</span>
            <span>·</span>
            <span>{preview.cells} cells</span>
            {#each preview.files as f (f.name)}
              <span>·</span>
              <span class="font-mono">{f.name}</span>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </Section>

  <Section
    title="Environment"
    description="The container every cell runs in. Chosen once, and then it is this room's Python for good."
  >
    {#if environments && environments.length > 0}
      <select bind:value={environment} class="field max-w-[280px] font-mono text-code-lg">
        {#each environments as env (env.name)}
          <option value={env.name} disabled={env.state !== 'ready'}>
            {env.name}{env.active ? ' — the instance default' : ''}{env.state === 'ready'
              ? ''
              : ' — not built'}
          </option>
        {/each}
      </select>
    {:else}
      <p class="text-2xs text-muted">Whatever this instance runs.</p>
    {/if}
  </Section>

  <Section
    title="The room"
    description="A lecture and a lab are not the same room. What the class may do is set here, once, before anyone joins."
  >
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div class="min-w-0 flex-1 basis-64">
          <p class="text-ui font-semibold text-ink">Who may run cells</p>
          <p class="mt-0.5 text-2xs text-muted">
            One kernel serves the room, so twenty people pressing Run is one queue.
          </p>
        </div>
        <div class="flex shrink-0 border border-line">
          {#each WHO as option (option.value)}
            <button
              type="button"
              class="seg {rules.run === option.value ? 'seg-on' : ''}"
              aria-pressed={rules.run === option.value}
              onclick={() => (rules.run = option.value)}
            >
              {option.label}
            </button>
          {/each}
        </div>
      </div>

      <div class="border border-line bg-surface">
        <div class="flex items-center gap-2.5 border-b border-line px-3.5 py-2">
          <span class="text-micro font-bold uppercase tracking-caps text-muted">Not yet settings</span>
          <span class="text-2xs text-faint">the room does all of this today, for everyone in it</span>
        </div>
        {#each NOT_YET as row (row.what)}
          <div
            class="flex items-center gap-3 border-b border-line-soft px-3.5 py-2 last:border-b-0"
          >
            <span class="min-w-0 flex-1 text-ui text-muted">{row.what}</span>
            <span class="shrink-0 font-mono text-micro text-faint">{row.why}</span>
          </div>
        {/each}
      </div>

      <div class="flex items-start gap-2.5 border-l-2 border-accent bg-accent/[0.06] px-3.5 py-3">
        <Icon name="lock" size={13} class="mt-0.5 shrink-0 text-accent-text" />
        <div class="min-w-0">
          <p class="text-ui font-semibold text-ink">Yours alone already, with no setting to lose</p>
          <p class="mt-1 text-2xs text-muted">
            Restarting the kernel · interrupting a cell somebody else started · clearing and closing
            the terminal · renaming the seminar · restoring an old version and marking a checkpoint.
          </p>
        </div>
      </div>
    </div>
  </Section>

  <Section
    title="Oracle"
    description="Overrides the instance for this seminar only. Useful when one class is an exercise and the next is a demonstration."
  >
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap gap-1.5">
        {#each ORACLE as option (option.value)}
          <button
            type="button"
            class="oracle-card {rules.oracle === option.value ? 'oracle-on' : ''}"
            aria-pressed={rules.oracle === option.value}
            onclick={() => (rules.oracle = option.value)}
          >
            <span class="text-ui font-semibold">{option.label}</span>
            <span class="text-2xs opacity-70">{option.note}</span>
          </button>
        {/each}
      </div>
      <p class="text-2xs text-muted">
        A room can be stricter than the instance, never looser: an instance in hints mode stays in
        hints mode here.
      </p>
    </div>
  </Section>
</AdminPage>

<style>
  /*
   * Three controls the admin does not have yet. They live here rather than in
   * index.css because nothing else uses them: a tab strip inside a form, a
   * two-way segmented answer, and a card that is a radio button. Promote them
   * the day a second screen needs one.
   */
  .tab-btn {
    height: 30px;
    padding-inline: 12px;
    font-size: 12px;
    font-weight: 600;
    color: rgb(var(--muted));
    background: none;
    border: 0;
    cursor: pointer;
    transition: background-color var(--speed-quick) var(--ease-out);
  }

  .tab-btn:hover {
    color: rgb(var(--ink));
    background: rgb(var(--raised));
  }

  /*
   * A ground and a rule under it, not a tint. The first version differed by
   * `bg-raised` alone, which on this near-white page is a shade nobody sees:
   * both doors looked equally unchosen, and the one thing this control has to
   * say is which door you are standing in.
   */
  .tab-on {
    color: rgb(var(--ink));
    background: rgb(var(--raised));
    box-shadow: inset 0 -2px 0 rgb(var(--brand));
    font-weight: 700;
  }

  .seg {
    height: 32px;
    padding-inline: 14px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: rgb(var(--muted));
    background: none;
    border: 0;
    cursor: pointer;
    /* Bound to the finger, not to the state, so it cannot arrive late. */
    transition:
      background-color var(--speed-quick) var(--ease-out),
      color var(--speed-quick) var(--ease-out),
      transform var(--speed-press) var(--ease-out);
  }

  .seg:active {
    transform: scale(0.97);
  }

  .seg-on {
    background: rgb(var(--brand));
    color: #fff;
    font-weight: 700;
  }

  .oracle-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
    min-width: 170px;
    padding: 10px 14px;
    text-align: left;
    color: rgb(var(--muted));
    background: none;
    border: 1px solid rgb(var(--line));
    cursor: pointer;
    transition:
      background-color var(--speed-quick) var(--ease-out),
      border-color var(--speed-quick) var(--ease-out),
      transform var(--speed-press) var(--ease-out);
  }

  .oracle-card:hover {
    border-color: rgb(var(--faint));
  }

  .oracle-card:active {
    transform: scale(0.99);
  }

  .oracle-on {
    background: rgb(var(--brand));
    border-color: rgb(var(--brand));
    color: #fff;
  }

  .tab-btn:focus-visible,
  .seg:focus-visible,
  .oracle-card:focus-visible {
    outline: 2px solid rgb(var(--accent));
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .seg,
    .oracle-card {
      transition-property: background-color, border-color, color;
    }
  }
</style>
