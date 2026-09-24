<script lang="ts">
  import Skeleton from '@/components/ui/Skeleton.svelte'
  import { tr, getLocale } from '@shared/i18n'
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
  import Resources from '@/admin/ui/Resources.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { oracleCeiling, oracleOverCeiling, splitBySize, uploadMb } from '@/admin/panel'
  import { adminApi } from '@/lib/adminApi'
  import { builtAgo, cn, imageSize } from '@/lib/utils'
  import {
    LIMITS,
    type AdminEnvironment,
    type EnvironmentsState,
    type ImportPreview,
    type InstanceResources,
    type OracleSettings,
  } from '@shared/admin'
  import { LECTURE_ROOM, OPEN_ROOM, type RoomRules, COUNCIL_ROOM } from '@shared/rules'
  import RoomRulesRows from '@/components/RoomRulesRows.svelte'

  interface Props {
    /** Back to the list, with the new seminar's id when one was made. */
    ondone: (createdId?: string) => void
  }

  let { ondone }: Props = $props()

  let name = $state('')
  /*
   * Three doors, not a flag.
   *
   * It used to be `fromGithub: boolean` — exactly two states, and a third
   * does not fit into it. An enum, because there are three doors now and one
   * day there may be four.
   */
  let source = $state<'blank' | 'file' | 'github'>('blank')
  const fromGithub = $derived(source === 'github')
  let githubUrl = $state('')

  /** The chosen notebook: name for the title, cells for the server — no outputs. */
  let notebook = $state<{
    filename: string
    cells: { cell_type: unknown; source: unknown }[]
  } | null>(null)
  let notebookErrorText = $state<(() => string | null) | null>(null)
  const notebookError = $derived(notebookErrorText?.() ?? null)
  let picker = $state<HTMLInputElement | null>(null)
  let dragging = $state(false)
  /**
   * The upload limit — the server's, not a copy of its default.
   *
   * There used to be our own 50 here: an operator who raised `MAX_UPLOAD_MB`
   * to 200 or lowered it to 20 read someone else's number on the screen and
   * learned the truth from a file that did not arrive — AFTER the room had
   * been created. `null` means "don't know": an older server build does not
   * send the field, and then the screen says nothing about the limit rather
   * than inventing one.
   */
  const maxUploadBytes = $derived(adminAuth.state?.maxUploadBytes ?? null)

  /*
   * The three doors grow up to 182px — exactly as in the mockup — but can
   * shrink to 168px and wrap to the available column width. That way the
   * third door does not slide under the clipped edge while the Section
   * caption still stands on the left.
   */
  /*
   * The 182px cap is the measure of a row of three doors, and on a phone
   * there is no row.
   *
   * At 390px the doors already stacked into a column, but each at its own
   * 182 of the 250 available: a dead margin stayed on the right, and the
   * captions broke in two (the Russian "BLANK / NOTEBOOK"). Below 640 the cap
   * is lifted and a door asks for the full width — the column becomes a
   * column on purpose, not by what is left over.
   */
  const DOOR =
    'flex min-w-[168px] max-w-[182px] flex-1 basis-[168px] flex-col gap-2.5 border p-3.5 text-left ' +
    'transition-colors duration-[var(--speed-quick)] ease-out ' +
    'max-[640px]:max-w-none max-[640px]:basis-full'
  const DOOR_ON = 'border-accent border-l-[3px] bg-surface'
  const DOOR_OFF = 'border-line bg-canvas hover:border-faint'
  const CAP = 'text-2xs font-bold uppercase tracking-label'

  /**
   * Read the notebook and count what is in it.
   *
   * Parsing here is only for two numbers on the card — how many cells and
   * what to call the seminar. The real parsing is done by the server with
   * the same code it uses for a GitHub import: two parsers that disagree
   * about what a cell is are a way to lose half of someone's notebook one
   * day.
   */
  async function takeNotebook(file: File | null): Promise<void> {
    if (!file) return
    notebookErrorText = null
    if (!/\.ipynb$/i.test(file.name)) {
      notebookErrorText = () => (tr("admin.choose.a.ipynb.notebook.has.a.different.extension", { p0: file.name }))
      return
    }
    try {
      const doc = JSON.parse(await file.text()) as { cells?: unknown[] }
      const cells = Array.isArray(doc.cells) ? doc.cells : []
      if (cells.length === 0) {
        notebookErrorText = () => (tr("admin.this.notebook.has.no.cells.choose.a.notebook.with.at.least.one.ce"))
        return
      }
      /*
       * Type and text — and nothing else.
       *
       * The server throws outputs away anyway, but the request body is capped
       * at 1 MB, and a notebook that has been run with a couple of plots is
       * megabytes of base64: it did not arrive at all, and the door answered
       * "internal error" for a file about which the card right there promised
       * "outputs are dropped". The real parsing is still on the server, with
       * the same code as the GitHub import.
       */
      notebook = {
        filename: file.name,
        cells: cells.map((cell) => {
          const one = (cell ?? {}) as { cell_type?: unknown; source?: unknown }
          return { cell_type: one.cell_type, source: one.source }
        }),
      }
      source = 'file'
      if (!name.trim()) name = tidyName(file.name)
    } catch {
      notebookErrorText = () => (tr("admin.could.not.read.this.notebook.check.that.it.is.a.valid.ipynb.file"))
    }
  }

  /* ------------------------------------------------------------ materials */

  /**
   * Everything the room will open with from the first minute.
   *
   * It sits here until Create is pressed and goes out after: an upload needs
   * an existing seminar. The notebook chosen as the source is not in this
   * list — it will become the room's document itself, not a file next to it.
   */
  let materials = $state<File[]>([])

  const materialBytes = $derived(materials.reduce((sum, f) => sum + f.size, 0))

  /** What did not fit the server's limit — in words, before Create is pressed. */
  let oversizedText = $state<(() => string | null) | null>(null)
  const oversized = $derived(oversizedText?.() ?? null)

  function addMaterials(list: FileList | File[] | null): void {
    const picked = Array.from(list ?? [])
    if (picked.length === 0) return
    // By name, not by reference: the same file chosen twice is one file, and
    // a second row in the list would be a lie.
    const have = new Set(materials.map((f) => f.name))
    const fresh = picked.filter((f) => !have.has(f.name))
    /*
     * A file that is too big is cut off here, not by the upload after
     * creation.
     *
     * The upload runs when the room already exists, and a refusal there
     * sounds like "the seminar was created but the dataset did not arrive": a
     * room without its material, and the teacher goes to add it by hand from
     * inside the room. Here it can still be replaced.
     */
    const { taken, refused } = splitBySize(fresh, maxUploadBytes ?? 0)
    oversizedText = () => (refused.length === 0 || maxUploadBytes === null
        ? null
        : `${refused.map((f) => f.name).join(', ')} ` +
          (tr("admin.exceed.the.mb.upload.limit.and.were.not.added", { p0: uploadMb(maxUploadBytes) }) + " ") +
          tr("admin.choose.smaller.files.or.ask.the.server.administrator.to.increase"))
    materials = [...materials, ...taken]
  }

  /** Returns the names of the files that did not arrive. */
  async function uploadMaterials(sessionId: string): Promise<string[]> {
    const failed: string[] = []
    for (const file of materials) {
      try {
        await adminApi.uploadMaterial(sessionId, file)
      } catch {
        failed.push(file.name)
      }
    }
    return failed
  }

  /**
   * Whether this is a notebook.
   *
   * A function, not an inline regex: in Svelte markup an expression starting
   * with `{/` reads as a block's closing tag, and `{/\.ipynb$/…}` breaks
   * template parsing entirely — with a message about an unpaired block that
   * points nowhere.
   */
  function isNotebook(filename: string): boolean {
    return /\.ipynb$/i.test(filename)
  }

  /** `01_HSE_Intro_to_Python.ipynb` → "HSE Intro to Python". */
  function tidyName(filename: string): string {
    const bare = filename.replace(/\.ipynb$/i, '').replace(/^[0-9]+[-_. ]*/, '')
    return bare.replace(/[-_]+/g, ' ').trim()
  }
  let environment = $state('')
  let environments = $state<AdminEnvironment[] | null>(null)
  /**
   * The room will not get its own container: the server cannot see docker or
   * isolation was switched off, and all seminars sit in one compose kernel.
   * Then the choice below is not a choice, and that has to be said here, not
   * in the kernel log in the middle of a class.
   */
  let gpuCapacityKnown = $state(true)
  /**
   * GPU slices: how many there are in total and how many are free right now.
   *
   * Needed here, not only on the environments screen: a room on a GPU
   * environment takes a slice for the whole life of its container, and when
   * none are free that has to be said BEFORE creation — otherwise the
   * teacher learns it from the first cell run in the middle of a class.
   */
  let gpus = $state<{ total: number; free: number }>({ total: 0, free: 0 })

  /** Does the chosen environment ask for a GPU slice — by its file, not by name. */
  const chosenGpu = $derived(
    environments?.find((e: AdminEnvironment) => e.name === environment)?.gpu ?? false,
  )

  /* The room's rules, starting as the open room the product has always been. */
  let rules = $state<RoomRules>({ ...OPEN_ROOM })

  /*
   * What kind of class this is — and why TWO values live next to the rules.
   *
   * `mode` is what the person chose; `rules` is what they tweaked
   * afterwards. Choosing a mode overwrites the rules with its preset, so the
   * table below shows the truth right away, not a promise; after that any
   * row can be changed by hand, and the mode stays selected. Both travel in
   * the request body, and the server lays the rules ON TOP of the preset —
   * so the result is exactly what is drawn on the screen, whichever way it
   * got there.
   *
   * A single `isLectureRoom(rules)` cannot express this: a lecture with one
   * row relaxed would stop matching the preset, and the card would go dark
   * even though the room is a lecture.
   */
  let mode = $state<'lab' | 'lecture' | 'council'>('lab')

  function pickMode(next: 'lab' | 'lecture' | 'council'): void {
    mode = next
    rules = { ...(next === 'council' ? COUNCIL_ROOM : next === 'lecture' ? LECTURE_ROOM : OPEN_ROOM) }
  }

  /*
   * Two doors into the room. The words come from the mockup: a card has to
   * say what the person will get, not what it is called internally.
   */
  const MODES: {
    value: 'lab' | 'lecture' | 'council'
    label: string
    what: string
    lines: [string, string]
  }[] = $derived([
    {
      value: 'lab',
      label: tr("admin.standard"),
      what:
        (tr("admin.participants.edit.the.notebook.together.run.cells.and.add.files") + " ") +
        tr("admin.oracle.access.depends.on.its.settings"),
      lines: [tr("admin.everyone.can.edit.and.run"), tr("admin.everyone.can.add.files")],
    },
    {
      value: 'lecture',
      label: tr("admin.lecture"),
      what:
        (tr("admin.the.teacher.edits.the.notebook.and.runs.code.students.read.the.no") + " ") +
        tr("admin.the.teacher.can.open.individual.cells.for.them.to.work.on"),
      lines: [tr("admin.only.the.teacher.can.edit.and.run"), tr("admin.individual.cells.can.be.opened.to.students")],
    },
    {
      value: 'council',
      label: tr("admin.council"),
      what:
        (tr("admin.each.student.writes.a.separate.solution.in.the.open.cell.the.teac") + " ") +
        tr("admin.reviews.attempts.shares.selected.ones.with.the.class.and.discusse"),
      lines: [tr("admin.the.teacher.controls.the.session"), tr("admin.a.separate.attempt.for.every.student")],
    },
  ])

  /**
   * What the machine has — and how much of it the room asks for.
   *
   * Read here and not on the environments screen precisely because the
   * decision is made here: on 13 Sep 2026 a seminar's kernel was killed for
   * memory sixteen times in a row, and the numbers that could have predicted
   * it were known only to whoever had ssh. `null` means "don't know yet": an
   * invented hint is worse than a missing one.
   */
  let resources = $state<InstanceResources | null>(null)
  /** How much memory was set for THIS room; null — same as the environment. */
  let memoryMb = $state<number | null>(null)
  /** How many cores were set for THIS room; null — same as the instance. */
  let cpus = $state<number | null>(null)

  let preview = $state<ImportPreview | null>(null)
  let previewing = $state(false)
  let previewErrorText = $state<(() => string | null) | null>(null)
  const previewError = $derived(previewErrorText?.() ?? null)
  let busy = $state(false)
  let errorText = $state<(() => string | null) | null>(null)
  const error = $derived(errorText?.() ?? null)

  /**
   * The instance's oracle settings — the ceiling a room cannot rise above.
   *
   * The cards below were always drawn, while the server clamps
   * (`oracleModeIn`): on an instance in hints mode, "Full answers" chosen
   * here silently turned into hints, and in class the teacher discovered
   * that the oracle does not write code. That is exactly what the honesty
   * rule in the file header forbids: a control that looks like a setting has
   * to be one.
   *
   * `null` means "don't know yet" (the read did not arrive): then the screen
   * greys out nothing. An invented ceiling is worse than a missing one.
   */
  let instanceOracle = $state<OracleSettings | null>(null)
  const ceiling = $derived(instanceOracle ? oracleCeiling(instanceOracle) : null)

  /*
   * The ceiling arrived after the press — lower the choice to it.
   *
   * The settings are read in onMount, but the cards can be pressed right
   * away: a click on "Full answers" can happen in between, and it would stay
   * selected on a greyed-out card, while `oracle: 'full'` went out in the
   * request body — the very silent mismatch the ceiling is read to prevent.
   */
  $effect(() => {
    const cap = ceiling
    if (cap && oracleOverCeiling(rules.oracle, cap.mode)) rules.oracle = cap.mode
  })

  /*
   * Three reads, and each has its own "still on the way" flag.
   *
   * One `null` for both "don't know" and "could not find out" is not enough:
   * before the answer the section must show a placeholder and keep the
   * button out of reach, after a refusal it must say so and still let you
   * through. The flag goes off on success and on refusal alike: there is no
   * point waiting for a second answer from someone who has already said
   * "no".
   */
  let environmentsLoading = $state(true)
  let oracleLoading = $state(true)
  let resourcesLoading = $state(true)

  /** Something decisive is still in flight — the form cannot know what it sends. */
  const settling = $derived(environmentsLoading || oracleLoading || resourcesLoading)

  onMount(() => {
    void adminApi
      .listEnvironments()
      .then((r: EnvironmentsState) => {
        environments = r.environments
        gpuCapacityKnown = r.gpuCapacityKnown !== false
        gpus = r.gpus
        if (!environment) environment = r.environments.find((e: AdminEnvironment) => e.active)?.name ?? ''
      })
      .catch(() => (environments = []))
      .finally(() => (environmentsLoading = false))
    // Readable by any teacher (GET /api/admin/oracle · requireStaff); the key
    // arrives masked.
    void adminApi
      .oracle()
      .then((settings: OracleSettings) => (instanceOracle = settings))
      .catch(() => (instanceOracle = null))
      .finally(() => (oracleLoading = false))
    // The machine. By the same rule as the oracle ceiling: if it did not
    // arrive, the section says nothing about numbers rather than showing
    // invented ones.
    void adminApi
      .resources()
      .then((r: InstanceResources) => (resources = r))
      .catch(() => (resources = null))
      .finally(() => (resourcesLoading = false))
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
      previewErrorText = null
      return
    }
    previewTimer = setTimeout(() => {
      previewing = true
      previewErrorText = null
      void adminApi
        .previewImport(url)
        .then((p: ImportPreview) => {
          preview = p
          if (!name.trim()) name = p.name
        })
        .catch((cause: unknown) => {
          preview = null
          previewErrorText = () => (cause instanceof Error ? cause.message : tr("admin.could.not.read.that.link"))
        })
        .finally(() => (previewing = false))
    }, 500)
    return () => {
      if (previewTimer) clearTimeout(previewTimer)
    }
  })

  /**
   * A room that already exists.
   *
   * Materials go out after it has been created, and when one file did not
   * arrive, the screen stayed as it was: the same fields, an active "Create
   * seminar" button — and the natural second press created a second,
   * identical seminar, with the same name and the same notebook. The link
   * sent to the chat was the duplicate's.
   */
  let created = $state<string | null>(null)

  /*
   * While the environment, the oracle ceiling and the resources are being
   * read, the button cannot be pressed.
   *
   * Not out of politeness to the placeholders: EVERYTHING drawn on the screen
   * goes out in the request body — the environment, the oracle mode, memory
   * and cores. A press on the first frame created a room on an empty
   * environment and with an oracle mode that a moment later would drop under
   * the instance ceiling ($effect below), that is, with settings nobody
   * chose. The answers come back in one trip to the server, so the wait is
   * exactly one round.
   */
  const canCreate = $derived(
    !busy &&
      !settling &&
      created === null &&
      (source === 'github'
        ? Boolean(preview)
        : source === 'file'
          ? Boolean(notebook)
          : name.trim().length > 0),
  )

  async function create(): Promise<void> {
    if (!canCreate) return
    busy = true
    errorText = null
    try {
      const seminar =
        source === 'github'
          ? await adminApi.importSeminar({
              url: githubUrl.trim(),
              name: name.trim() || undefined,
              environment: environment || null,
              mode,
              rules,
            })
          : source === 'file' && notebook
            ? await adminApi.importNotebook({
                cells: notebook.cells,
                filename: notebook.filename,
                name: name.trim() || undefined,
                environment: environment || null,
                mode,
                rules,
              })
            : await adminApi.createSeminar({
                name: name.trim(),
                environment: environment || null,
                mode,
                rules,
                memoryMb,
                cpus,
              })

      /*
       * Materials go out after the room has appeared.
       *
       * An upload needs an existing seminar — the files are put into its
       * directory — and creating a draft room for that costs more than it is
       * worth. The price is known and small: if a file did not arrive, the
       * room already exists, and that is said out loud instead of pretending
       * that nothing was created.
       */
      created = seminar.id
      /*
       * Memory comes as a follow-up, and only for the import doors.
       *
       * A blank room carries the number in the creation body. Import from
       * GitHub and from disk are other doors (routes/admin-import.ts), and
       * adding a field to them for one number would mean changing notebook
       * parsing where nobody asked for it. The seminar has already been
       * created, and the limit is applied to the live room with the same
       * PATCH as in the settings — at the cost of one extra request per
       * creation.
       */
      if ((memoryMb !== null || cpus !== null) && source !== 'blank') {
        try {
          await adminApi.updateSeminar(seminar.id, { memoryMb, cpus })
        } catch {
          /* The room exists and runs on the environment's default; staying
             silent about that is as wrong as cancelling the creation because
             of it — hence a line below, not a refusal. */
          errorText = () => tr('admin.resources.notApplied')
        }
      }
      if (materials.length > 0) {
        const failed = await uploadMaterials(seminar.id)
        if (failed.length > 0) {
          errorText = () => ((tr("admin.the.seminar.was.created.but", { p0: failed.length === 1 ? tr("admin.one.file") : tr("admin.files", { p0: failed.length }) }) + " ") +
            tr("admin.did.not.upload.add.them.from.the.room", { p0: failed.join(', ') }))
          busy = false
          return
        }
      }
      ondone(seminar.id)
    } catch (cause) {
      errorText = () => (cause instanceof Error ? cause.message : tr("admin.could.not.create.the.seminar"))
      busy = false
    }
  }

  /** One row of the rules table: a question, a sentence, and two answers. */
  const ORACLE: { value: RoomRules['oracle']; label: string; note: string }[] = $derived([
    { value: 'inherit', label: tr("admin.as.set.for.the.instance"), note: tr("admin.use.the.server.default") },
    { value: 'off', label: tr("admin.off"), note: tr("admin.disable.the.oracle.for.this.seminar") },
    { value: 'hints', label: tr("admin.hints.only"), note: tr("admin.instructed.to.give.hints") },
    { value: 'full', label: tr("admin.full.answers"), note: tr("admin.explains.and.writes.code") },
  ])

  /*
   * And the couplings — verified facts about this code, not disclaimers. The
   * honesty rule applies to them exactly as it does to the switches. (Their
   * number is not stated here: the array grew and shrank, while the word
   * "three" stayed.)
   */
  const COUPLINGS: { what: string; why: string; when: (r: RoomRules) => boolean }[] = $derived([
    {
      what: tr("admin.students.can.edit.code.the.teacher.runs"),
      why:
        (tr("admin.code.is.read.when.execution.starts.a.student.with.editing.access") + " ") +
        tr("admin.cell.before.the.teacher.s.run.begins"),
      when: (r) => r.run !== 'room' && r.edit === 'room',
    },
    {
      what: tr("admin.running.code.also.gives.access.to.files"),
      why:
        (tr("admin.the.container.has.access.to.this.room.s.files") + " ") +
        (tr("admin.anyone.allowed.to.run.code.can.list.read.and.delete.those.files.r") + " ") +
        tr("admin.file.panel.permissions"),
      when: (r) => r.files !== 'room' && r.run !== 'host',
    },
  ])
</script>

{#snippet actions()}
  <button type="button" class="btn-ghost" onclick={() => ondone(created ?? undefined)}>
    {created ? tr("admin.close") : tr("admin.cancel")}
  </button>
  <!-- The room has already been created — offering "create" again means
       offering a duplicate. The button leads to where this room already is,
       with its link. -->
  {#if created}
    <button type="button" class="btn-primary" onclick={() => ondone(created ?? undefined)}>
      {tr("admin.back.to.seminars")}
    </button>
  {:else}
    <button type="button" class="btn-primary" disabled={!canCreate} onclick={create}>
      {#if busy}
        <Icon name="spinner" size={15} class="animate-spin" />
        {tr("admin.creating")}
      {:else}
        {tr("admin.create.seminar")}
      {/if}
    </button>
  {/if}
{/snippet}

<AdminPage
  title={tr("admin.new.seminar")}
  subtitle={tr("admin.choose.a.notebook.environment.and.access.rules.then.create.the.se")}
  {actions}
>
  {#if error}
    <p class="mb-4 border-l-2 border-danger bg-danger/[0.06] px-3 py-2 text-ui text-danger" role="alert">
      {error}
    </p>
  {/if}

  <Section
    title={tr("admin.basics")}
    description={tr("admin.students.see.this.name.when.they.join.the.seminar")}
  >
    <div class="flex flex-col gap-3">
      <input
        bind:value={name}
        class="field"
        placeholder={tr("admin.week.7.attention")}
        maxlength={LIMITS.seminarName}
        aria-label={tr("admin.seminar.name")}
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
      <div class="flex flex-wrap gap-2.5">
        <button
          type="button"
          class={cn(DOOR, source === 'blank' ? DOOR_ON : DOOR_OFF)}
          aria-pressed={source === 'blank'}
          onclick={() => ((source = 'blank'), (preview = null))}
        >
          <span class="flex items-center gap-1.5">
            <Icon name="file" size={13} class={source === 'blank' ? 'text-accent-text' : 'text-muted'} />
            <span class={cn(CAP, source === 'blank' ? 'text-ink' : 'text-muted')}>{tr("admin.blank")}</span>
          </span>
          <!-- The bytes ensureInitialNotebook() actually seeds, not a description
               of them: a door should show what is behind it. -->
          <span class="flex flex-col gap-0.5 border border-line bg-canvas px-2.5 py-2 font-mono text-micro">
            <span class="text-faint">{tr("admin.welcome")}</span>
            <span class="text-muted">print("hello")</span>
          </span>
          <span class="text-2xs leading-tight text-muted">{tr("admin.start.with.a.text.cell.and.a.code.cell")}</span>
        </button>

        <button
          type="button"
          class={cn(DOOR, source === 'file' ? DOOR_ON : DOOR_OFF)}
          aria-pressed={source === 'file'}
          onclick={() => ((source = 'file'), (preview = null), picker?.click())}
        >
          <span class="flex items-center gap-1.5">
            <Icon name="upload" size={13} class={source === 'file' ? 'text-accent-text' : 'text-muted'} />
            <span class={cn(CAP, source === 'file' ? 'text-ink' : 'text-muted')}>{tr("admin.from.a.file")}</span>
          </span>
          <span
            class={cn(
              'flex h-[33px] items-center gap-2 border px-2.5 font-mono text-micro',
              notebook ? 'border-faint bg-canvas text-ink' : 'border-line bg-canvas text-faint',
            )}
          >
            {#if notebook}
              <Icon name="file" size={12} class="shrink-0 text-accent-text" />
              <span class="truncate">{notebook.filename}</span>
            {:else}
              week07.ipynb
            {/if}
          </span>
          <span class="text-2xs leading-tight text-muted">
            {#if notebook}
              {notebook.cells.length} {tr("admin.cells.outputs.are.dropped")}
            {:else}
              {tr("admin.choose.a.ipynb.file.outputs.are.not.imported")}
            {/if}
          </span>
        </button>

        <button
          type="button"
          class={cn(DOOR, source === 'github' ? DOOR_ON : DOOR_OFF)}
          aria-pressed={source === 'github'}
          onclick={() => (source = 'github')}
        >
          <span class="flex items-center gap-1.5">
            <Icon name="link" size={13} class={source === 'github' ? 'text-accent-text' : 'text-muted'} />
            <span class={cn(CAP, source === 'github' ? 'text-ink' : 'text-muted')}>{tr("admin.from.github")}</span>
          </span>
          <span class="flex h-[33px] items-center border border-line bg-canvas px-2.5 font-mono text-micro text-faint">
            github.com/…/week02
          </span>
          <!--
            "Public" is said here, not in the error message.

            GitHub answers an anonymous request for a private repository with
            404, not 403 — otherwise people would enumerate other people's
            repository names by response code. The error names both reasons,
            but learning this before you paste the link is better than after.
          -->
          <span class="text-2xs leading-tight text-muted">{tr("admin.public.repositories.only")}</span>
        </button>
      </div>

      <!--
        The real input is hidden: the native "choose file" has a look that
        cannot be matched to the rest of the screen, and a door should look
        like a door. Pressing the card opens it.
      -->
      <input
        bind:this={picker}
        type="file"
        accept=".ipynb,application/json"
        class="hidden"
        onchange={(event) => void takeNotebook(event.currentTarget.files?.[0] ?? null)}
      />
      {#if notebookError}
        <p class="text-2xs text-danger">{notebookError}</p>
      {/if}

      {#if fromGithub}
        <input
          bind:value={githubUrl}
          class="field font-mono text-code-lg"
          placeholder="https://github.com/sleep3r/ml_hse/tree/main/week02"
          autocomplete="off"
          spellcheck="false"
          aria-label={tr("admin.github.link.to.a.notebook.or.a.folder")}
        />
        {#if previewing}
          <div role="status" aria-label={tr('admin.reading.the.repository')} aria-busy="true" class="flex flex-wrap items-center gap-2 py-1">
            <Skeleton width="13rem" height="0.8rem" />
            <Skeleton width="11rem" height="0.8rem" />
            <Skeleton width="4rem" height="0.8rem" />
          </div>
        {:else if previewError}
          <p class="text-2xs text-danger">{previewError}</p>
        {:else if preview}
          <div class="flex flex-wrap items-center gap-2 text-2xs text-muted">
            {#each preview.notebooks ?? [{ name: preview.notebook, cells: preview.cells }] as book (book.name)}
              <span class="font-mono text-ink">{book.name}</span>
            {/each}
            <span>·</span>
            <span>{preview.cells} {tr("admin.cells")}</span>
            {#each preview.files as f (f.name)}
              <span>·</span>
              <span class="font-mono">{f.name}</span>
            {/each}
          </div>
          <!-- And what will not arrive: the total of the files is capped by
               the room's ceiling (server/src/routes/admin-import.ts ·
               withinRoomBudget), and the rest is cut off before the room is
               even created. On its own line, not as one more name in the row
               of what is brought, where it would read as "also coming". -->
          {#if preview.skipped.length > 0}
            <div class="mt-1.5 flex flex-wrap items-center gap-2 text-2xs text-warning">
              <span>
                {tr("admin.count.skippedFiles", { count: preview.skipped.length })}
              </span>
              {#each preview.skipped as name (name)}
                <span class="font-mono text-muted line-through">{name}</span>
              {/each}
            </div>
          {/if}
        {/if}
      {/if}
    </div>
  </Section>

  <Section
    title={tr("admin.environment.464")}
    description={tr("admin.the.python.environment.for.this.seminar.it.is.selected.when.the.s")}
  >
    <!--
      Not a line with a dropdown, but a card with contents.

      There used to be a `<select>` here, and the choice was a choice of name:
      `cv-torch-2.1` against `nlp-hf` — two words with nothing behind them for
      someone who did not build these images. The server already sends
      everything needed: the package list, the image size, when it was built.
      Showing it is cheaper than explaining in words, and more honest than not
      showing it.

      The Python version comes from the same place, the server's response: it
      reads it from the environment file's header and from the built image
      itself (PYTHON_VERSION in its config). It was missing here precisely
      because this screen has no right to invent it; now it is known — and it
      is the first thing people ask about when they bring a notebook from
      someone else's laptop. An empty string means "don't know" (that is how
      the published catalog answers), and then it is simply not shown.
    -->
    {#if environmentsLoading}
      <!--
        The list is still on its way.

        The placeholder repeats the chosen environment's card — the frame, the
        dot, the name line — and the "or choose" row under it, because in a
        moment exactly that will stand here. An empty "whatever this instance
        runs" line in its place answered a question nobody asked: it means
        "there are no environments", when they simply have not been brought
        yet.

        The placeholder has no package row on purpose: not every environment
        has one, and promising it to each would make the card jump by thirty
        pixels where no packages are listed.
      -->
      <div
        role="status"
        aria-label={tr("admin.python.environment")}
        aria-busy="true"
        class="flex flex-col gap-2.5"
      >
        <div class="flex flex-col border border-line">
          <!-- 45px is the same py-3 around a 21px name line (font-mono
               text-code-lg). The bars inside are thinner than the letters, so
               the row holds the height, not them: otherwise the card comes
               out seven pixels shorter. -->
          <div class="flex h-[45px] items-center gap-3 px-3.5">
            <Skeleton width="0.5rem" height="0.5rem" radius="0" />
            <Skeleton width="9rem" height="0.85rem" />
            <Skeleton width="7rem" height="0.7rem" class="ml-auto" />
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-micro font-bold uppercase tracking-label text-faint">{tr("admin.or.choose")}</span>
          {#each ['4.5rem', '6rem'] as width (width)}
            <Skeleton {width} height="24px" radius="0" />
          {/each}
        </div>
      </div>
    {:else if environments && environments.length > 0}
      {@const chosen = environments.find((e) => e.name === environment) ?? null}
      <div class="flex flex-col gap-2.5">
        {#if chosen}
          <div class="flex flex-col border border-line">
            <label class="flex cursor-pointer items-center gap-3 px-3.5 py-3">
              <span class="h-2 w-2 shrink-0 bg-accent"></span>
              <span class="font-mono text-code-lg font-medium text-ink">{chosen.name}</span>
              {#if chosen.state === 'ready'}
                <span class="inline-flex h-6 items-center bg-positive/10 px-1.5 text-2xs font-bold uppercase tracking-label text-positive">
                  {tr("admin.built")}
                </span>
              {/if}
              {#if chosen.gpu}
                <span class="inline-flex h-[18px] items-center bg-accent/15 px-1.5 text-micro font-bold uppercase tracking-label text-accent-text">
                  GPU
                </span>
              {/if}
              <span class="ml-auto text-2xs text-muted">
                {[
                  chosen.pythonBuilt || chosen.python
                    ? `Python ${chosen.pythonBuilt ?? chosen.python}`
                    : null,
                  chosen.imageBytes ? imageSize(chosen.imageBytes) : null,
                  chosen.builtAt ? builtAgo(chosen.builtAt) : null,
                  chosen.revision ? chosen.revision.slice(0, 19) + '…' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <select
                bind:value={environment}
                class="absolute h-0 w-0 opacity-0"
                aria-label={tr("admin.python.environment")}
              >
                {#each environments as env (env.name)}
                  <option value={env.name} disabled={env.state !== 'ready'}>{env.name}</option>
                {/each}
              </select>
            </label>
            {#if chosen.packages.length > 0}
              <div class="flex flex-wrap items-center gap-1.5 px-3.5 pb-3 pl-[34px]">
                {#each chosen.packages.slice(0, 5) as pkg (pkg)}
                  <span class="bg-surface px-2 py-0.5 font-mono text-micro text-muted">{pkg}</span>
                {/each}
                {#if chosen.packages.length > 5}
                  <span class="text-2xs text-faint">+ {chosen.packages.length - 5} {tr("admin.more")}</span>
                {/if}
              </div>
            {/if}
          </div>
        {/if}

        <!-- The other environments in one row: an unbuilt one is marked, -->
        <!-- and it cannot be chosen — a room will not start on it. -->
        {#if environments.length > 1}
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-micro font-bold uppercase tracking-label text-faint">{tr("admin.or.choose")}</span>
            {#each environments.filter((e) => e.name !== environment) as env (env.name)}
              <button
                type="button"
                disabled={env.state !== 'ready'}
                title={env.state === 'ready'
                  ? tr("admin.use", { p0: env.name })
                  : tr("admin.has.not.been.built.a.room.cannot.open.on.it", { p0: env.name })}
                onclick={() => (environment = env.name)}
                class={cn(
                  'inline-flex h-6 items-center gap-1.5 px-2 font-mono text-2xs',
                  env.state === 'ready'
                    ? 'border border-line text-muted hover:border-faint hover:text-ink'
                    : 'border border-dashed border-line text-faint',
                )}
              >
                {#if env.state !== 'ready'}
                  <span class="h-1 w-1 shrink-0 bg-warning"></span>
                {/if}
                {env.name}
                {#if env.state !== 'ready'}
                  <span class="font-sans text-2xs text-warning">{tr("admin.not.built.483")}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      <p class="text-2xs text-muted">{tr("admin.whatever.this.instance.runs")}</p>
    {/if}

    <!--
      A coupling of the same kind as in "The room", and with the same honesty
      rule: warn, but do not forbid. A slice may free up by the time of the
      class — someone else's room gets closed, its container removed — but
      staying silent is not an option: without a free slice this room's
      kernel will refuse to start, and hearing that from the first Run in the
      middle of a class is the worst way. Under a shared kernel the choice of
      environment affects nothing anyway, so there is nothing about GPUs to
      warn of there.
    -->
    {#if chosenGpu && gpuCapacityKnown && gpus.free === 0}
      <div class="mt-2.5 flex items-start gap-2.5 border-l-2 border-warning bg-warning/[0.07] px-3.5 py-2.5">
        <Icon name="alert" size={13} class="mt-0.5 shrink-0 text-warning" />
        <p class="min-w-0 text-2xs leading-snug text-muted">
          {#if gpus.total === 0}
            <span class="font-semibold text-ink">{tr("admin.gpu.is.not.configured")}</span>
            {tr("admin.this.environment.needs.a.gpu.but.kernel.gpus.is.not.set.choose.an")}
          {:else}
            <span class="font-semibold text-ink">{tr("admin.no.free.slices")}</span>
            {tr("admin.all.slices.are.held.by.containers.from.other.seminars.including.i")}
          {/if}
        </p>
      </div>
    {/if}
  </Section>

  <!--
    Resources come right under the environment, and that is not a matter of
    taste.

    The memory default depends on the chosen environment (a GPU environment
    asks for sixteen gigabytes against four), so reading the hint "the default
    for environment X is K GB" only makes sense once X has been chosen. The
    same component sits in an existing class's settings: one setting, named
    and computed the same way in both places.
  -->
  <Section title={tr('admin.resources.title')} description={tr('admin.resources.description')}>
    <Resources
      {resources}
      loading={resourcesLoading}
      {environment}
      {memoryMb}
      onmemory={(mb) => (memoryMb = mb)}
      {cpus}
      oncpus={(cores) => (cpus = cores)}
    />
  </Section>

  <!--
    Materials attached before the room opened.

    This is also where the answer to "what if a seminar is several notebooks"
    lives. The unit is the MATERIAL, not the notebook: a seminar carries a
    list of files, and exactly one of them is the live document that is
    edited together. The student opens and downloads the other notebooks as
    files.

    Today this costs nothing: the live notebook is that single Yjs document
    that already exists, and the rest sits in /workspace as ordinary files.
    Tomorrow, when someone wants to switch the live notebook on the fly, one
    pointer will have to change, not the data model.

    What is deliberately not here: a "make live" switch between several
    .ipynb files. The server cannot do that yet, and drawing a setting that
    does not exist is exactly what the honesty rule in this file's header
    forbids.
  -->
  <Section
    title={tr("admin.materials")}
    description={tr("admin.add.files.to.the.seminar.workspace.participants.can.download.them")}
  >
    <div class="flex flex-col">
      {#if materials.length > 0}
        <div class="flex items-center gap-3 border-b border-line pb-2">
          <span class="w-[13px] shrink-0"></span>
          <span class="flex-1 text-2xs font-bold uppercase tracking-label text-muted">{tr("admin.file")}</span>
          <span class="w-24 shrink-0 text-2xs font-bold uppercase tracking-label text-muted">{tr("admin.role")}</span>
          <span class="w-14 shrink-0 text-right text-2xs font-bold uppercase tracking-label text-muted">{tr("admin.size")}</span>
          <span class="w-8 shrink-0"></span>
        </div>
      {/if}

      <!--
        The source notebook stands as the first row and cannot be removed: it
        will become the room's document itself, not a file next to it. That is
        exactly what the LIVE chip says — "this is the one edited together".
      -->
      {#if notebook}
        <div class="flex items-center gap-3 border-b border-line border-l-[3px] border-l-accent bg-surface py-2.5 pl-2 pr-2">
          <Icon name="file" size={13} class="shrink-0 text-accent-text" />
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="truncate font-mono text-2xs font-medium text-ink">{notebook.filename}</span>
            <span class="text-micro text-muted">{notebook.cells.length} {tr("admin.cells.outputs.dropped")}</span>
          </span>
          <span class="w-24 shrink-0">
            <span class="inline-flex h-6 items-center gap-1.5 bg-accent px-2 text-2xs font-bold uppercase tracking-label text-white">
              <span class="h-1 w-1 bg-white"></span>
              {tr("admin.live")}
            </span>
          </span>
          <span class="w-14 shrink-0 text-right font-mono text-micro text-muted">—</span>
          <span class="w-8 shrink-0"></span>
        </div>
      {/if}

      {#each materials as file (file.name)}
        <div class="flex items-center gap-3 border-b border-line py-2.5 pl-[11px] pr-2">
          <Icon
            name={isNotebook(file.name) ? 'file' : 'box'}
            size={13}
            class="shrink-0 text-faint"
          />
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="truncate font-mono text-2xs text-ink">{file.name}</span>
            <span class="text-micro text-muted">
              {#if isNotebook(file.name)}
                {tr("admin.attached.notebook.file")}
              {:else}
                {tr("admin.read.from.code.with.open")}{file.name}")
              {/if}
            </span>
          </span>
          <span class="w-24 shrink-0 text-2xs text-muted">
            {isNotebook(file.name) ? tr("admin.notebook") : tr("admin.data")}
          </span>
          <span class="w-14 shrink-0 text-right font-mono text-micro text-muted">
            {imageSize(file.size)}
          </span>
          <button
            type="button"
            class="-my-2 flex h-8 w-8 shrink-0 items-center justify-center text-faint transition-colors duration-[var(--speed-quick)] hover:text-ink"
            aria-label={tr("admin.remove.from.the.upload.list", { p0: file.name })}
            onclick={() => (materials = materials.filter((f) => f.name !== file.name))}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      {/each}

      <label
        class={cn(
          'mt-3 flex cursor-pointer items-center gap-2.5 border border-dashed p-3.5',
          dragging ? 'border-accent bg-surface' : 'border-line hover:border-faint',
        )}
        ondragover={(event) => {
          event.preventDefault()
          dragging = true
        }}
        ondragleave={() => (dragging = false)}
        ondrop={(event) => {
          event.preventDefault()
          dragging = false
          addMaterials(event.dataTransfer?.files ?? null)
        }}
      >
        <Icon name="upload" size={15} class="shrink-0 text-faint" />
        <span class="text-2xs text-muted">
          {tr("admin.drop.notebooks.data.or.slides.or")} <span class="text-accent-text underline decoration-line underline-offset-2">{tr("admin.browse")}</span>.
          <!-- The number comes from the server. Until it is there, the
               sentence ends at the full stop: a limit named at random is
               worse than an unnamed one. -->
          {#if maxUploadBytes !== null}{tr("admin.up.to")} {uploadMb(maxUploadBytes)} {tr("admin.mb.each")}{/if}
        </span>
        <input
          type="file"
          multiple
          class="hidden"
          onchange={(event) => {
            addMaterials(event.currentTarget.files)
            event.currentTarget.value = ''
          }}
        />
      </label>

      {#if oversized}
        <p class="pt-2.5 text-2xs text-danger" role="alert">{oversized}</p>
      {/if}

      {#if materials.length > 0}
        <p class="pt-2.5 text-2xs text-faint">
          {tr("admin.count.material", { count: materials.length + (notebook ? 1 : 0) })} ·
          {imageSize(materialBytes)}
        </p>
      {/if}
    </div>
  </Section>

  <Section
    title={tr("admin.the.room")}
    description={tr("admin.choose.a.mode.and.adjust.access.rules.you.can.change.them.during")}
  >
    <div class="flex flex-col gap-4">
      <!--
        The mode stands BEFORE the rules table, not in it: it is a set of
        rules at once, and it has to be read before looking at the eight rows
        one by one. The choice rewrites the table beneath it — the card
        promises nothing, it sets.
      -->
      <div class="flex flex-col gap-2.5">
        <div class="flex flex-wrap gap-2.5">
          {#each MODES as option (option.value)}
            <button
              type="button"
              class="mode-card {mode === option.value ? 'mode-on' : ''}"
              aria-pressed={mode === option.value}
              onclick={() => pickMode(option.value)}
            >
              <span class="flex items-center gap-2.5">
                <span class="mode-dot"></span>
                <span class="mode-title text-title font-bold">{option.label}</span>
                {#if option.value === 'lecture'}
                  <Icon name="lock" size={14} class="ml-auto shrink-0 opacity-80" />
                {:else if option.value === 'council'}
                  <Icon name="users" size={14} class="ml-auto shrink-0 opacity-80" />
                {/if}
              </span>
              <span class="mode-what text-ui leading-relaxed">{option.what}</span>
              <span class="mode-facts flex flex-col gap-1.5 pt-0.5 font-mono text-2xs">
                {#each option.lines as line (line)}<span>{line}</span>{/each}
              </span>
            </button>
          {/each}
        </div>
        <p class="text-2xs text-muted">{tr("admin.you.can.change.the.mode.on.the.seminar.page")}</p>
      </div>

      <!-- "As for the class" names the number the form has just chosen above,
           and the list offers nothing the machine will not give. -->
      <RoomRulesRows
        {rules}
        instance={instanceOracle}
        own={{
          roomMemoryMb: memoryMb ?? resources?.kernel.defaultMemoryMb ?? null,
          roomCpus: cpus ?? resources?.kernel.defaultCpus ?? null,
          maxMemoryMb: resources?.limits.max ?? null,
          maxCpus: resources?.limits.cpus.max ?? null,
        }}
        onchange={(patch) => (rules = { ...rules, ...patch })}
      />

      <!--
        Couplings, printed here rather than hidden in the code. Each is about
        where a switch above means less than it seems; the honour rule is the
        same as for the switches themselves: do not promise what the product
        does not hold. They are shown only when relevant — a room nobody has
        restricted sees none of them.
      -->
      {#each COUPLINGS.filter((c) => c.when(rules)) as note (note.what)}
        <div class="flex items-start gap-2.5 border-l-2 border-warning bg-warning/[0.07] px-3.5 py-2.5">
          <Icon name="alert" size={13} class="mt-0.5 shrink-0 text-warning" />
          <p class="min-w-0 text-2xs leading-snug text-muted">
            <span class="font-semibold text-ink">{note.what}</span>
            {note.why}
          </p>
        </div>
      {/each}

      <div class="flex items-start gap-2.5 border-l-2 border-accent bg-accent/[0.06] px-3.5 py-3">
        <Icon name="lock" size={13} class="mt-0.5 shrink-0 text-accent-text" />
        <div class="min-w-0">
          <p class="text-ui font-semibold text-ink">{tr("admin.teacher.controls")}</p>
          <p class="mt-1 text-2xs text-muted">
            {tr("admin.interrupting.a.cell.somebody.else.started.renaming.the.seminar.re")}
          </p>
        </div>
      </div>
    </div>
  </Section>

  <Section
    title={tr("admin.oracle")}
    description={tr("admin.choose.oracle.access.for.this.seminar.within.the.server.s.allowed")}
  >
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap gap-1.5">
        {#each ORACLE as option (option.value)}
          <!-- Above the instance ceiling it is not a choice but a promise.
               Such a card greys out and says what it will actually become. -->
          {@const over = ceiling ? oracleOverCeiling(option.value, ceiling.mode) : false}
          <button
            type="button"
            class="oracle-card {rules.oracle === option.value ? 'oracle-on' : ''}"
            aria-pressed={rules.oracle === option.value}
            disabled={over}
            title={over ? tr("admin.the.server.allows.up.to.mode", { p0: tr(`admin.oracle.mode.${ceiling?.mode ?? 'off'}`) }) : undefined}
            onclick={() => (rules.oracle = option.value)}
          >
            <span class="text-ui font-semibold">{option.label}</span>
            <span class="text-2xs opacity-70">
              {over ? tr("admin.above.what.the.instance.allows", { p0: tr(`admin.oracle.mode.${ceiling?.mode ?? 'off'}`) }) : option.note}
            </span>
          </button>
        {/each}
      </div>
      <p class="text-2xs text-muted">
        {tr("admin.the.server.s.mode.limits.this.seminar.you.can.further.restrict.th")}
        {#if ceiling?.why}
          <span class="text-ink">
            {ceiling.mode === 'off'
              ? tr("admin.the.oracle.is.unavailable", { p0: ceiling.why })
              : tr("admin.server.limit", { p0: ceiling.why })}
          </span>
        {/if}
      </p>
    </div>
  </Section>
</AdminPage>

<style>
  /*
   * Two controls the admin does not have yet: a card that is a radio button for
   * the room's mode, and a smaller one for the oracle. They live here rather
   * than in index.css because nothing else uses them; promote them the day a
   * second screen needs one.
   *
   * `.tab-btn`/`.tab-on` stood here as a third and were not needed by a
   * single element: this screen's tab strip has long been drawn with inline
   * Tailwind classes. The compiler dropped them with a warning on every
   * build.
   */
  /*
   * The mode card is the same organ as `.oracle-card`: a radio button the
   * height of a paragraph. A separate class rather than a variant of the
   * oracle one, for one reason: it has three storeys of different weight
   * inside, and the oracle card's `min-width: 170px` would collapse them into
   * a column on the very first laptop.
   */
  .mode-card {
    display: flex;
    flex: 1 1 260px;
    flex-direction: column;
    gap: 14px;
    padding: 22px 24px 24px;
    text-align: left;
    color: rgb(var(--muted));
    background: rgb(var(--canvas));
    border: 1px solid rgb(var(--line));
    cursor: pointer;
    transition:
      background-color var(--speed-quick) var(--ease-out),
      border-color var(--speed-quick) var(--ease-out),
      transform var(--speed-press) var(--ease-out);
  }

  .mode-card:hover {
    border-color: rgb(var(--faint));
  }

  .mode-card:active {
    transform: scale(0.99);
  }

  .mode-title {
    color: rgb(var(--ink));
  }

  /* The radio dot: an empty ring, filled with white on the selected card. */
  .mode-dot {
    flex-shrink: 0;
    width: 9px;
    height: 9px;
    border: 2px solid rgb(var(--faint));
    border-radius: 9px;
  }

  .mode-on {
    color: #fff;
    background: rgb(var(--brand));
    border-color: rgb(var(--brand));
  }

  .mode-on .mode-title {
    color: #fff;
  }

  .mode-on .mode-dot {
    background: #fff;
    border-color: #fff;
  }

  /*
   * The card's three storeys are three voices, and on the filled card they
   * are not all white at once: solid white on the brand blue turns a
   * paragraph into a heading. The values are taken from the mockup and hold
   * contrast on this background (8:1 and 6.6:1); opacity cannot achieve this
   * — it also dims the light card, where muted and faint are already at
   * their limit.
   */
  .mode-facts {
    color: rgb(var(--faint));
  }

  .mode-on .mode-what {
    color: #c8d3ee;
  }

  .mode-on .mode-facts {
    color: #a8b8e4;
  }

  /* The lecture's last line is about the cells it does open after all. The
     lock is drawn for its sake, so it alone speaks at full voice. */
  .mode-on .mode-facts span:last-child {
    color: #fff;
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

  /*
   * Above the instance ceiling. The dashed border is the same language as the
   * "environment read" on the oracle screen: a frame that looks like a field
   * and does not respond is worse than a caption.
   */
  .oracle-card:disabled {
    color: rgb(var(--faint));
    border-style: dashed;
    cursor: default;
  }

  .oracle-card:disabled:hover {
    border-color: rgb(var(--line));
  }

  .oracle-on {
    background: rgb(var(--brand));
    border-color: rgb(var(--brand));
    color: #fff;
  }

  .mode-card:focus-visible,
  .oracle-card:focus-visible {
    outline: 2px solid rgb(var(--accent));
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .mode-card,
    .oracle-card {
      transition-property: background-color, border-color, color;
    }
  }
</style>
