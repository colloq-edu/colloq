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
  import { builtAgo, cn, imageSize } from '@/lib/utils'
  import {
    LIMITS,
    type AdminEnvironment,
    type EnvironmentsState,
    type ImportPreview,
  } from '@shared/admin'
  import { LECTURE_ROOM, OPEN_ROOM, type RoomRules } from '@shared/rules'
  import RoomRulesRows from '@/components/RoomRulesRows.svelte'

  interface Props {
    /** Back to the list, with the new seminar's id when one was made. */
    ondone: (createdId?: string) => void
  }

  let { ondone }: Props = $props()

  let name = $state('')
  /*
   * Три двери, а не флаг.
   *
   * Было `fromGithub: boolean` — ровно два состояния, и третье в него не
   * помещается. Перечисление, потому что дверей теперь три и когда-нибудь
   * может стать четыре.
   */
  let source = $state<'blank' | 'file' | 'github'>('blank')
  const fromGithub = $derived(source === 'github')
  let githubUrl = $state('')

  /** Выбранная тетрадь: имя для заголовка, ячейки для сервера — без выводов. */
  let notebook = $state<{
    filename: string
    cells: { cell_type: unknown; source: unknown }[]
  } | null>(null)
  let notebookError = $state<string | null>(null)
  let picker = $state<HTMLInputElement | null>(null)
  let dragging = $state(false)
  /** Тот же предел, что и на сервере; тянуть его сюда неоткуда, MAX_UPLOAD_MB в .env. */
  const LIMITS_UPLOAD_MB = 50

  /*
   * Три двери одной ширины: 568 на троих с зазором 10 — это 182 на карточку,
   * ровно как в макете. Обводка выбранной толще слева, как у всего
   * выбранного в этом продукте.
   */
  const DOOR =
    'flex w-[182px] shrink-0 flex-col gap-2.5 border p-3.5 text-left ' +
    'transition-colors duration-[var(--speed-quick)] ease-out'
  const DOOR_ON = 'border-accent border-l-[3px] bg-surface'
  const DOOR_OFF = 'border-line bg-canvas hover:border-faint'
  const CAP = 'text-2xs font-bold uppercase tracking-label'

  /**
   * Прочитать тетрадь и посчитать, что в ней.
   *
   * Разбор здесь только ради двух чисел на карточке — сколько ячеек и как
   * назвать семинар. Настоящий разбор делает сервер тем же кодом, которым
   * разбирает импорт с GitHub: два парсера, расходящиеся во мнениях о том,
   * что такое ячейка, — это способ однажды потерять половину чужой тетради.
   */
  async function takeNotebook(file: File | null): Promise<void> {
    if (!file) return
    notebookError = null
    if (!/\.ipynb$/i.test(file.name)) {
      notebookError = `${file.name} is not a notebook — Colloq opens .ipynb files.`
      return
    }
    try {
      const doc = JSON.parse(await file.text()) as { cells?: unknown[] }
      const cells = Array.isArray(doc.cells) ? doc.cells : []
      if (cells.length === 0) {
        notebookError = 'That notebook has no cells in it.'
        return
      }
      /*
       * Тип и текст — и ничего больше.
       *
       * Выводы сервер выбрасывает всё равно, но тело запроса ограничено 1 МБ, а
       * прогнанная тетрадь с парой графиков — это мегабайты base64: она не
       * доезжала вовсе, и дверь отвечала «internal error» на файл, про который
       * карточка тут же обещала «outputs are dropped». Настоящий разбор
       * по-прежнему на сервере, тем же кодом, что и импорт с GitHub.
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
      notebookError = 'That file would not parse — .ipynb is JSON, and this is not.'
    }
  }

  /* ------------------------------------------------------------ материалы */

  /**
   * Всё, что комната откроет с первой минуты.
   *
   * Лежит здесь до нажатия Create и уезжает после: загрузка требует
   * существующего семинара. Тетрадь, выбранная как источник, в этот список не
   * попадает — она станет самим документом комнаты, а не файлом рядом с ним.
   */
  let materials = $state<File[]>([])

  const materialBytes = $derived(materials.reduce((sum, f) => sum + f.size, 0))

  function addMaterials(list: FileList | File[] | null): void {
    const picked = Array.from(list ?? [])
    if (picked.length === 0) return
    // По имени, а не по ссылке: один и тот же файл, выбранный дважды, — это
    // один файл, и вторая строка в списке была бы враньём.
    const have = new Set(materials.map((f) => f.name))
    materials = [...materials, ...picked.filter((f) => !have.has(f.name))]
  }

  /** Возвращает имена тех, кто не доехал. */
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
   * Тетрадь ли это.
   *
   * Функцией, а не регуляркой по месту: в разметке Svelte выражение,
   * начинающееся с `{/`, читается как закрывающий тег блока, и `{/\.ipynb$/…}`
   * ломает разбор шаблона целиком — с сообщением про непарный блок, которое
   * никуда не указывает.
   */
  function isNotebook(filename: string): boolean {
    return /\.ipynb$/i.test(filename)
  }

  /** `01_HSE_Intro_to_Python.ipynb` → «HSE Intro to Python». */
  function tidyName(filename: string): string {
    const bare = filename.replace(/\.ipynb$/i, '').replace(/^[0-9]+[-_. ]*/, '')
    return bare.replace(/[-_]+/g, ' ').trim()
  }
  let environment = $state('')
  let environments = $state<AdminEnvironment[] | null>(null)
  /**
   * Своего контейнера у комнаты не будет: сервер не видит docker или изоляцию
   * выключили, и все семинары сидят в одном ядре compose. Тогда выбор ниже —
   * не выбор, и сказать об этом надо здесь, а не в журнале ядра посреди пары.
   */
  let sharedKernel = $state(false)
  /**
   * Срезы видеокарты: сколько их всего и сколько свободно прямо сейчас.
   *
   * Нужны здесь, а не только на экране окружений: комната на GPU-окружении
   * берёт срез на всё время жизни своего контейнера, и когда свободных нет,
   * сказать об этом надо ДО создания — иначе преподаватель узнает это первым
   * запуском ячейки посреди пары.
   */
  let gpus = $state<{ total: number; free: number }>({ total: 0, free: 0 })

  /** Просит ли выбранное окружение срез видеокарты — по его файлу, не по имени. */
  const chosenGpu = $derived(
    environments?.find((e: AdminEnvironment) => e.name === environment)?.gpu ?? false,
  )

  /* The room's rules, starting as the open room the product has always been. */
  let rules = $state<RoomRules>({ ...OPEN_ROOM })

  /*
   * Какое это занятие — и почему рядом с правилами живут ДВА значения.
   *
   * `mode` — то, что выбрал человек; `rules` — то, что он потом подкрутил.
   * Выбор режима переписывает правила его пресетом, так что таблица ниже сразу
   * показывает правду, а не обещание; дальше любую строку можно поменять
   * руками, и режим при этом остаётся выбранным. В теле запроса едет и то и
   * другое, и сервер кладёт правила ПОВЕРХ пресета — то есть получается ровно
   * то, что нарисовано на экране, каким бы путём туда ни пришли.
   *
   * Одним `isLectureRoom(rules)` это не выражается: лекция, у которой отпустили
   * одну строку, перестала бы совпадать с пресетом, и карточка гасла бы, хотя
   * комната лекционная.
   */
  let mode = $state<'lab' | 'lecture'>('lab')

  function pickMode(next: 'lab' | 'lecture'): void {
    mode = next
    rules = { ...(next === 'lecture' ? LECTURE_ROOM : OPEN_ROOM) }
  }

  /*
   * Две двери в комнату. Слова — с макета: карточка обязана сказать, что
   * человек получит, а не как это называется внутри.
   */
  const MODES: {
    value: 'lab' | 'lecture'
    label: string
    what: string
    lines: [string, string]
  }[] = [
    {
      value: 'lab',
      label: 'Обычный',
      what:
        'Лаборатория. Все печатают в тетради, запускают ячейки, кладут файлы и спрашивают ' +
        'оракула. Так Colloq работал всегда.',
      lines: ['правит — комната · запускает — комната', 'файлы — комната · оракул — по настройке'],
    },
    {
      value: 'lecture',
      label: 'Лекция',
      what:
        'Комната преподавателя. Студент читает, листает и смотрит: ни правки, ни запуска, ни ' +
        'терминала, ни файлов. Оракул — по настройке семинара.',
      lines: ['всё — преподаватель', 'кроме ячеек, которые он откроет сам'],
    },
  ]

  let preview = $state<ImportPreview | null>(null)
  let previewing = $state(false)
  let previewError = $state<string | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)

  onMount(() => {
    void adminApi
      .listEnvironments()
      .then((r: EnvironmentsState) => {
        environments = r.environments
        sharedKernel = r.shared
        gpus = r.gpus
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

  /**
   * Комната, которая уже есть.
   *
   * Материалы уезжают после её создания, и когда один файл не доехал, экран
   * оставался прежним: те же поля, активная кнопка «Create seminar» — и
   * естественное второе нажатие заводило второй такой же семинар, с тем же
   * именем и той же тетрадью. Ссылка в чат уходила от дубликата.
   */
  let created = $state<string | null>(null)

  const canCreate = $derived(
    !busy &&
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
    error = null
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
              })

      /*
       * Материалы уезжают после того, как комната появилась.
       *
       * Загрузка требует существующего семинара — файлы кладутся в его
       * каталог, — а черновик комнаты ради этого заводить дороже, чем оно
       * стоит. Плата известная и небольшая: если файл не доехал, комната уже
       * есть, и об этом говорят вслух вместо того, чтобы делать вид, что
       * ничего не создано.
       */
      created = seminar.id
      if (materials.length > 0) {
        const failed = await uploadMaterials(seminar.id)
        if (failed.length > 0) {
          error =
            `The seminar was created, but ${failed.length === 1 ? 'one file' : `${failed.length} files`} ` +
            `did not upload: ${failed.join(', ')}. Add them from the room.`
          busy = false
          return
        }
      }
      ondone(seminar.id)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not create the seminar'
      busy = false
    }
  }

  /** One row of the rules table: a question, a sentence, and two answers. */
  const ORACLE: { value: RoomRules['oracle']; label: string; note: string }[] = [
    { value: 'inherit', label: 'As set for the instance', note: 'whatever Oracle settings say' },
    { value: 'off', label: 'Off', note: 'no oracle in this room at all' },
    { value: 'hints', label: 'Hints only', note: 'nudges, never the solution' },
    { value: 'full', label: 'Full answers', note: 'explains and writes code' },
  ]

  /*
   * Чего в этом списке нет и почему. «Скоро будет» преподавателю не говорит
   * ничего, что можно спланировать, поэтому у каждой строки своя причина, и
   * список сокращается, но не пустеет.
   */
  const NOT_YET: { what: string; why: string }[] = [
    { what: 'Read the cells', why: 'every browser holds the whole notebook' },
    { what: 'Read the terminal transcript', why: 'it is in the shared document too' },
    { what: "Edit your own answer but not your neighbour's", why: 'a cell has no owner' },
    { what: 'Keep one student’s oracle question private', why: 'one thread, one document root' },
    { what: 'Remove somebody from the room', why: 'a token can expire, not be withdrawn' },
    { what: 'A model for this room only', why: 'not a permission, and read nowhere yet' },
  ]

  /*
   * И три сцепки — проверенные факты об этом коде, а не оговорки. Правило
   * честности к ним относится ровно так же, как к переключателям.
   */
  const COUPLINGS: { what: string; why: string; when: (r: RoomRules) => boolean }[] = [
    {
      what: 'Running is not a boundary while typing is open.',
      why:
        'The kernel reads a cell’s source at the instant it runs it, not when Run was pressed — so a ' +
        'student who may not run still writes the Python the teacher’s Run executes.',
      when: (r) => r.run !== 'room' && r.edit === 'room',
    },
    {
      what: 'Files are only as locked as the kernel is.',
      // Про соседние комнаты — только там, где ядро общее: под своим
      // контейнером в него смонтирована одна папка, и пугать нечем.
      get why(): string {
        return (
          (sharedKernel
            ? 'The shared container mounts this room’s folder — and every other room’s, '
            : 'The container mounts this room’s folder, ') +
          'so os.listdir() is the listing, open(...) is the download and os.remove(...) is the ' +
          'delete — for anyone who may run a cell.'
        )
      },
      when: (r) => r.files !== 'room' && r.run !== 'host',
    },
  ]
</script>

{#snippet actions()}
  <button type="button" class="btn-ghost" onclick={() => ondone(created ?? undefined)}>
    {created ? 'Close' : 'Cancel'}
  </button>
  <!-- Комната уже создана — предлагать «создать» ещё раз значит предлагать
       дубликат. Кнопка ведёт туда, где эта комната уже лежит, со ссылкой. -->
  {#if created}
    <button type="button" class="btn-primary" onclick={() => ondone(created ?? undefined)}>
      Go to the seminar
    </button>
  {:else}
    <button type="button" class="btn-primary" disabled={!canCreate} onclick={create}>
      {#if busy}
        <Icon name="spinner" size={15} class="animate-spin" />
        Creating…
      {:else}
        Create seminar
      {/if}
    </button>
  {/if}
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
      <div class="flex gap-2.5">
        <button
          type="button"
          class={cn(DOOR, source === 'blank' ? DOOR_ON : DOOR_OFF)}
          aria-pressed={source === 'blank'}
          onclick={() => ((source = 'blank'), (preview = null))}
        >
          <span class="flex items-center gap-1.5">
            <Icon name="file" size={13} class={source === 'blank' ? 'text-accent-text' : 'text-muted'} />
            <span class={cn(CAP, source === 'blank' ? 'text-ink' : 'text-muted')}>Blank</span>
          </span>
          <!-- The bytes ensureInitialNotebook() actually seeds, not a description
               of them: a door should show what is behind it. -->
          <span class="flex flex-col gap-0.5 border border-line bg-canvas px-2.5 py-2 font-mono text-micro">
            <span class="text-faint"># Welcome</span>
            <span class="text-muted">print("hello")</span>
          </span>
          <span class="text-2xs leading-tight text-muted">Two cells. Nothing else is seeded.</span>
        </button>

        <button
          type="button"
          class={cn(DOOR, source === 'file' ? DOOR_ON : DOOR_OFF)}
          aria-pressed={source === 'file'}
          onclick={() => ((source = 'file'), (preview = null), picker?.click())}
        >
          <span class="flex items-center gap-1.5">
            <Icon name="upload" size={13} class={source === 'file' ? 'text-accent-text' : 'text-muted'} />
            <span class={cn(CAP, source === 'file' ? 'text-ink' : 'text-muted')}>From a file</span>
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
              {notebook.cells.length} cells · outputs are dropped
            {:else}
              Drop a .ipynb here. Outputs are dropped.
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
            <span class={cn(CAP, source === 'github' ? 'text-ink' : 'text-muted')}>From GitHub</span>
          </span>
          <span class="flex h-[33px] items-center border border-line bg-canvas px-2.5 font-mono text-micro text-faint">
            github.com/…/week02
          </span>
          <!--
            Про «публичный» сказано здесь, а не в сообщении об ошибке.

            GitHub отвечает анонимному запросу к приватному репозиторию 404, а
            не 403 — иначе по коду ответа перебирали бы чужие названия. Ошибка
            называет обе причины, но узнать об этом до того, как вставишь
            ссылку, лучше, чем после.
          -->
          <span class="text-2xs leading-tight text-muted">Public repositories only.</span>
        </button>
      </div>

      <!--
        Настоящий input лежит скрытым: у нативного «выберите файл» вид,
        который нельзя привести к остальному экрану, а дверь должна выглядеть
        дверью. Нажатие на карточку открывает его.
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
    description={sharedKernel
      ? 'One container for every seminar on this server — what is picked here does not reach it.'
      : "The container every cell runs in. Chosen once, and then it is this room's Python for good."}
  >
    {#if sharedKernel}
      <!-- Не украшение к списку, а условие, при котором список ничего не
           решает: сказать это до создания комнаты дешевле, чем после. -->
      <p class="mb-2.5 flex items-start gap-2 border border-line bg-warning/[0.08] px-3 py-2.5 text-2xs leading-relaxed text-muted">
        <Icon name="alert" size={13} class="mt-0.5 shrink-0 text-warning" />
        <span>
          This server runs every seminar in one shared Python container, so this room will run the
          instance’s default environment rather than the one picked here. Cells in it also see the
          files of every other seminar on this machine, and share one memory limit.
        </span>
      </p>
    {/if}
    <!--
      Не строка со списком, а карточка с содержимым.

      Раньше здесь стоял `<select>`, и выбор был выбором имени: `cv-torch-2.1`
      против `nlp-hf` — два слова, за которыми для человека, не собиравшего эти
      образы, не стоит ничего. Всё нужное сервер отдаёт и так: список пакетов,
      размер образа, когда собран. Показать это дешевле, чем объяснять словами,
      и честнее, чем не показывать.

      Версии Python здесь нет намеренно: сервер её не знает, а придумать
      правдоподобную строчку — ровно тот жанр, который этот экран запрещает.
    -->
    {#if environments && environments.length > 0}
      {@const chosen = environments.find((e) => e.name === environment) ?? null}
      <div class="flex flex-col gap-2.5">
        {#if chosen}
          <div class="flex flex-col border border-line">
            <label class="flex cursor-pointer items-center gap-3 px-3.5 py-3">
              <span class="h-2 w-2 shrink-0 bg-accent"></span>
              <span class="font-mono text-code-lg font-medium text-ink">{chosen.name}</span>
              {#if chosen.state === 'ready'}
                <span class="inline-flex h-[18px] items-center bg-positive/10 px-1.5 text-micro font-bold uppercase tracking-label text-positive">
                  built
                </span>
              {/if}
              {#if chosen.gpu}
                <span class="inline-flex h-[18px] items-center bg-accent/15 px-1.5 text-micro font-bold uppercase tracking-label text-accent-text">
                  GPU
                </span>
              {/if}
              <span class="ml-auto text-2xs text-muted">
                {[
                  chosen.imageBytes ? imageSize(chosen.imageBytes) : null,
                  chosen.builtAt ? builtAgo(chosen.builtAt) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <select
                bind:value={environment}
                class="absolute h-0 w-0 opacity-0"
                aria-label="Python environment"
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
                  <span class="text-2xs text-faint">+ {chosen.packages.length - 5} more</span>
                {/if}
              </div>
            {/if}
          </div>
        {/if}

        <!-- Остальные окружения одной строкой: несобранное среди них помечено, -->
        <!-- и выбрать его нельзя — комната на нём не поднимется. -->
        {#if environments.length > 1}
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-micro font-bold uppercase tracking-label text-faint">or choose</span>
            {#each environments.filter((e) => e.name !== environment) as env (env.name)}
              <button
                type="button"
                disabled={env.state !== 'ready'}
                title={env.state === 'ready'
                  ? `Use ${env.name}`
                  : `${env.name} has not been built — a room cannot open on it`}
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
                  <span class="font-sans text-micro text-warning">not built</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      <p class="text-2xs text-muted">Whatever this instance runs.</p>
    {/if}

    <!--
      Сцепка того же рода, что и в «The room», и с тем же правилом честности:
      предупредить, но не запрещать. Срез может освободиться к паре — чужую
      комнату закроют, её контейнер уберут, — а вот молчать нельзя: без
      свободного среза ядро этой комнаты откажется подняться, и услышать это
      первым Run посреди занятия хуже всего. Под общим ядром выбор окружения
      и так ни на что не влияет, и пугать картами там нечем.
    -->
    {#if chosenGpu && !sharedKernel && gpus.free === 0}
      <div class="mt-2.5 flex items-start gap-2.5 border-l-2 border-warning bg-warning/[0.07] px-3.5 py-2.5">
        <Icon name="alert" size={13} class="mt-0.5 shrink-0 text-warning" />
        <p class="min-w-0 text-2xs leading-snug text-muted">
          {#if gpus.total === 0}
            <span class="font-semibold text-ink">Видеокарт здесь нет.</span>
            Это окружение просит срез, а KERNEL_GPUS не задана: ядро такой комнаты не поднимется,
            а на процессоре её пакеты не поедут.
          {:else}
            <span class="font-semibold text-ink">Свободных срезов нет.</span>
            Все срезы заняты другими комнатами, и остановленная держит свой тоже. Завести семинар
            можно — ядро поднимется, когда чей-то контейнер уберут.
          {/if}
        </p>
      </div>
    {/if}
  </Section>

  <!--
    Материалы, прикреплённые до того, как комната открылась.

    Здесь же лежит ответ на вопрос «а если семинар — это несколько тетрадей».
    Единицей сделан МАТЕРИАЛ, а не тетрадь: семинар несёт список файлов, и
    ровно один из них — живой документ, который правят вместе. Остальные
    тетради студент открывает и скачивает как файлы.

    Сегодня это стоит ноль: живая тетрадь — тот самый единственный Yjs-документ,
    который уже есть, а остальное лежит в /workspace обычными файлами. Завтра,
    когда живую тетрадь захочется переключать на ходу, менять придётся один
    указатель, а не модель данных.

    Чего здесь намеренно нет: переключателя «сделать живой» между несколькими
    .ipynb. Сервер этого пока не умеет, а рисовать настройку, которой нет, —
    ровно то, что запрещает правило честности в шапке этого файла.
  -->
  <Section
    title="Materials"
    description="Everything the class opens, in the room from the first minute. Data sits beside the notebook; students download it or read it from a cell."
  >
    <div class="flex flex-col">
      {#if materials.length > 0}
        <div class="flex items-center gap-3 border-b border-line pb-2">
          <span class="w-[13px] shrink-0"></span>
          <span class="flex-1 text-micro font-bold uppercase tracking-label text-faint">file</span>
          <span class="w-24 shrink-0 text-micro font-bold uppercase tracking-label text-faint">role</span>
          <span class="w-14 shrink-0 text-right text-micro font-bold uppercase tracking-label text-faint">size</span>
          <span class="w-[13px] shrink-0"></span>
        </div>
      {/if}

      <!--
        Тетрадь-источник стоит первой строкой и снять её нельзя: она станет
        самим документом комнаты, а не файлом рядом с ним. Именно это и говорит
        чип LIVE — «вот эту правят вместе».
      -->
      {#if notebook}
        <div class="flex items-center gap-3 border-b border-line border-l-[3px] border-l-accent bg-surface py-2.5 pl-2 pr-2">
          <Icon name="file" size={13} class="shrink-0 text-accent-text" />
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="truncate font-mono text-2xs font-medium text-ink">{notebook.filename}</span>
            <span class="text-micro text-muted">{notebook.cells.length} cells · outputs dropped</span>
          </span>
          <span class="w-24 shrink-0">
            <span class="inline-flex h-[18px] items-center gap-1.5 bg-accent px-2 text-micro font-bold uppercase tracking-label text-white">
              <span class="h-1 w-1 bg-white"></span>
              live
            </span>
          </span>
          <span class="w-14 shrink-0 text-right font-mono text-micro text-muted">—</span>
          <span class="w-[13px] shrink-0"></span>
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
                Students can open it; nobody edits it together
              {:else}
                Sits beside the notebook — open("{file.name}")
              {/if}
            </span>
          </span>
          <span class="w-24 shrink-0 text-2xs text-faint">
            {isNotebook(file.name) ? 'notebook' : 'data'}
          </span>
          <span class="w-14 shrink-0 text-right font-mono text-micro text-muted">
            {imageSize(file.size)}
          </span>
          <button
            type="button"
            class="shrink-0 text-faint transition-colors duration-[var(--speed-quick)] hover:text-ink"
            aria-label={`Take ${file.name} out of the seminar`}
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
          Drop notebooks, data or slides — or <span class="text-accent-text underline decoration-line underline-offset-2">browse</span>.
          Up to {Math.round(LIMITS_UPLOAD_MB)} MB each.
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

      {#if materials.length > 0}
        <p class="pt-2.5 text-2xs text-faint">
          {materials.length + (notebook ? 1 : 0)}
          {materials.length + (notebook ? 1 : 0) === 1 ? 'material' : 'materials'} ·
          {imageSize(materialBytes)}
        </p>
      {/if}
    </div>
  </Section>

  <Section
    title="The room"
    description="A lecture and a lab are not the same room. Set here before anyone joins — and changeable from inside the seminar at any point, without anybody rejoining."
  >
    <div class="flex flex-col gap-4">
      <!--
        Режим стоит ПЕРЕД таблицей правил, а не в ней: это набор правил разом, и
        читать его надо до того, как разглядывать восемь строк по одной. Выбор
        переписывает таблицу под собой — карточка ничего не обещает, она ставит.
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
                {/if}
              </span>
              <span class="mode-what text-ui leading-relaxed">{option.what}</span>
              <span class="mode-facts flex flex-col gap-1.5 pt-0.5 font-mono text-2xs">
                {#each option.lines as line (line)}<span>{line}</span>{/each}
              </span>
            </button>
          {/each}
        </div>
        <p class="text-2xs text-muted">Режим меняется и потом — со страницы семинара.</p>
      </div>

      <RoomRulesRows {rules} onchange={(patch) => (rules = { ...rules, ...patch })} />

      <!--
        Три сцепки, напечатанные здесь, а не спрятанные в коде. Каждая — про
        то, где переключатель выше значит меньше, чем кажется; правило чести то
        же, что и у самих переключателей: не обещать того, чего продукт не
        держит. Показываются только когда относятся к делу — комната, которую
        никто не ужимал, не видит ни одной.
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

      <div class="border border-line bg-surface">
        <div class="flex items-center gap-2.5 border-b border-line px-3.5 py-2">
          <span class="text-micro font-bold uppercase tracking-caps text-muted">Not yet settings</span>
          <span class="text-2xs text-faint">and the reason, which is not "coming soon"</span>
        </div>
        {#each NOT_YET as row (row.what)}
          <div
            class="flex items-center gap-3 border-b border-line-soft px-3.5 py-2 last:border-b-0"
          >
            <span class="min-w-0 flex-1 text-ui text-muted">{row.what}</span>
            <span class="shrink-0 text-right font-mono text-micro text-faint">{row.why}</span>
          </div>
        {/each}
      </div>

      <div class="flex items-start gap-2.5 border-l-2 border-accent bg-accent/[0.06] px-3.5 py-3">
        <Icon name="lock" size={13} class="mt-0.5 shrink-0 text-accent-text" />
        <div class="min-w-0">
          <p class="text-ui font-semibold text-ink">Yours alone, with no setting to lose</p>
          <p class="mt-1 text-2xs text-muted">
            Interrupting a cell somebody else started · renaming the seminar · restoring an old
            version and marking a checkpoint · deleting somebody's file.
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

  /*
   * Карточка режима — тот же орган, что и `.oracle-card`: радиокнопка ростом с
   * абзац. Отдельным классом, а не вариантом оракульской, по одной причине: у
   * неё внутри три этажа с разным весом, и `min-width: 170px` оракульской
   * схлопнул бы их в колонку на первом же ноутбуке.
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

  /* Кружок радиокнопки: пустой обод, залитый белым у выбранной. */
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
   * Три этажа карточки — три голоса, и на залитой они не белые все разом:
   * сплошной белый на брендовом синем превращает абзац в заголовок. Цифры
   * взяты с макета и держат контраст на этом фоне (8:1 и 6.6:1); прозрачностью
   * этого не добиться — она гасит и светлую карточку, где muted и faint уже
   * стоят на своём пределе.
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

  /* Последняя строка лекции — про ячейки, которые она всё-таки открывает. Ради
     неё замок и написан, поэтому она одна и звучит в полный голос. */
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

  .oracle-on {
    background: rgb(var(--brand));
    border-color: rgb(var(--brand));
    color: #fff;
  }

  .tab-btn:focus-visible,
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
