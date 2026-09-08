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
  import { adminAuth } from '@/admin/auth.svelte'
  import { oracleCeiling, oracleOverCeiling, splitBySize, uploadMb } from '@/admin/panel'
  import { adminApi } from '@/lib/adminApi'
  import { builtAgo, cn, imageSize } from '@/lib/utils'
  import {
    LIMITS,
    type AdminEnvironment,
    type EnvironmentsState,
    type ImportPreview,
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
  /**
   * Предел загрузки — тот, что у сервера, а не копия его умолчания.
   *
   * Здесь стояло собственное 50: оператор, поднявший `MAX_UPLOAD_MB` до 200 или
   * опустивший до 20, читал на экране чужое число, а правду узнавал файлом,
   * который не доехал — уже ПОСЛЕ того, как комната создана. `null` значит «не
   * знаю»: сборка сервера постарше поля не присылает, и тогда экран о пределе
   * молчит, а не выдумывает его.
   */
  const maxUploadBytes = $derived(adminAuth.state?.maxUploadBytes ?? null)

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
      notebookError = `Choose a .ipynb notebook. ${file.name} has a different extension.`
      return
    }
    try {
      const doc = JSON.parse(await file.text()) as { cells?: unknown[] }
      const cells = Array.isArray(doc.cells) ? doc.cells : []
      if (cells.length === 0) {
        notebookError = 'This notebook has no cells. Choose a notebook with at least one cell.'
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
      notebookError = 'Could not read this notebook. Check that it is a valid .ipynb file.'
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

  /** Что не влезло в предел сервера — словами, до нажатия Create. */
  let oversized = $state<string | null>(null)

  function addMaterials(list: FileList | File[] | null): void {
    const picked = Array.from(list ?? [])
    if (picked.length === 0) return
    // По имени, а не по ссылке: один и тот же файл, выбранный дважды, — это
    // один файл, и вторая строка в списке была бы враньём.
    const have = new Set(materials.map((f) => f.name))
    const fresh = picked.filter((f) => !have.has(f.name))
    /*
     * Слишком большой файл отсекается здесь, а не загрузкой после создания.
     *
     * Загрузка идёт, когда комната уже есть, и отказ там звучит как «семинар
     * создан, но датасет не доехал»: комната без материала, и преподаватель
     * идёт докладывать его руками из комнаты. Здесь его ещё можно заменить.
     */
    const { taken, refused } = splitBySize(fresh, maxUploadBytes ?? 0)
    oversized =
      refused.length === 0 || maxUploadBytes === null
        ? null
        : `${refused.map((f) => f.name).join(', ')} ` +
          `exceed the ${uploadMb(maxUploadBytes)} MB upload limit and were not added. ` +
          'Choose smaller files or ask the server administrator to increase MAX_UPLOAD_MB.'
    materials = [...materials, ...taken]
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
  let mode = $state<'lab' | 'lecture' | 'council'>('lab')

  function pickMode(next: 'lab' | 'lecture' | 'council'): void {
    mode = next
    rules = { ...(next === 'council' ? COUNCIL_ROOM : next === 'lecture' ? LECTURE_ROOM : OPEN_ROOM) }
  }

  /*
   * Две двери в комнату. Слова — с макета: карточка обязана сказать, что
   * человек получит, а не как это называется внутри.
   */
  const MODES: {
    value: 'lab' | 'lecture' | 'council'
    label: string
    what: string
    lines: [string, string]
  }[] = [
    {
      value: 'lab',
      label: 'Обычный',
      what:
        'Участники вместе редактируют тетрадь, запускают ячейки и добавляют файлы. ' +
        'Доступ к оракулу зависит от его настроек.',
      lines: ['редактирование и запуск — всем', 'добавление файлов — всем'],
    },
    {
      value: 'lecture',
      label: 'Лекция',
      what:
        'Преподаватель редактирует тетрадь и запускает код. Студенты читают тетрадь; ' +
        'преподаватель может открыть отдельные ячейки для работы.',
      lines: ['редактирование и запуск — преподавателю', 'отдельные ячейки можно открыть студентам'],
    },
    {
      value: 'council',
      label: 'Консилиум',
      what:
        'В открытой ячейке каждый студент пишет отдельное решение. Преподаватель ' +
        'просматривает попытки, показывает выбранные классу и обсуждает их с оракулом.',
      lines: ['управление занятием — преподавателю', 'отдельная попытка для каждого студента'],
    },
  ]

  let preview = $state<ImportPreview | null>(null)
  let previewing = $state(false)
  let previewError = $state<string | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)

  /**
   * Настройки оракула на инстансе — потолок, выше которого комната не поднимется.
   *
   * Карточки ниже рисовались всегда, а сервер клампит (`oracleModeIn`): на
   * инстансе в режиме hints выбранное здесь «Full answers» молча превращалось в
   * hints, и на паре преподаватель обнаруживал, что оракул не пишет код. Это
   * ровно то, что запрещает правило честности в шапке файла: контрол, который
   * выглядит настройкой, обязан ею быть.
   *
   * `null` — «ещё не знаем» (чтение не доехало): тогда экран не гасит ничего.
   * Выдуманный потолок хуже отсутствующего.
   */
  let instanceOracle = $state<OracleSettings | null>(null)
  const ceiling = $derived(instanceOracle ? oracleCeiling(instanceOracle) : null)

  /*
   * Потолок приехал позже нажатия — опускаем выбор до него.
   *
   * Настройки читаются в onMount, а карточки нажимаются сразу: между тем и
   * другим успевает пройти щелчок по «Full answers», и он остался бы выбранным
   * на погашенной карточке, а в теле запроса уехал бы `oracle: 'full'` — то
   * самое молчаливое расхождение, ради которого потолок и читается.
   */
  $effect(() => {
    const cap = ceiling
    if (cap && oracleOverCeiling(rules.oracle, cap.mode)) rules.oracle = cap.mode
  })

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
    // Читается любым преподавателем (GET /api/admin/oracle · requireStaff);
    // ключ приезжает замаскированным.
    void adminApi
      .oracle()
      .then((settings: OracleSettings) => (instanceOracle = settings))
      .catch(() => (instanceOracle = null))
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
    { value: 'inherit', label: 'As set for the instance', note: 'use the server default' },
    { value: 'off', label: 'Off', note: 'disable the oracle for this seminar' },
    { value: 'hints', label: 'Hints only', note: 'instructed to give hints' },
    { value: 'full', label: 'Full answers', note: 'explains and writes code' },
  ]

  /*
   * Чего в этом списке нет и почему. «Скоро будет» преподавателю не говорит
   * ничего, что можно спланировать, поэтому у каждой строки своя причина, и
   * список сокращается, но не пустеет.
   */
  const NOT_YET: {
    what: string
    why: string
    /** Не во всех режимах: в консилиуме своя строка у каждого уже есть. */
    unless?: (mode: 'lab' | 'lecture' | 'council') => boolean
  }[] = [
    { what: 'Hide notebook cells', why: 'participants receive the whole notebook' },
    { what: 'Hide terminal history', why: 'participants receive the terminal history' },
    {
      what: "Edit your own answer but not your neighbour's",
      why: 'editing access applies to the shared cell',
      /*
       * Кроме консилиума — там это и есть его смысл. Строка стояла на одном
       * экране с карточкой «Консилиум: открытая ячейка — каждому свой лист» и
       * говорила ей прямо противоположное.
       */
      unless: (m) => m === 'council',
    },
    { what: 'Keep one student’s oracle question private', why: 'questions are visible to the room' },
    /*
     * «Remove somebody from the room — a token can expire, not be withdrawn»
     * отсюда убрано: бан с выкидыванием из комнаты есть и работает
     * (server/src/routes/bans.ts, panels/BanMenu.svelte, control.ts ·
     * evictBanned). Он не настройка комнаты, а действие внутри неё, поэтому
     * стоит в списке того, что принадлежит преподавателю, — ниже.
     */
    { what: 'A model for this room only', why: 'the model is configured for the server' },
  ]

  const notYet = $derived(NOT_YET.filter((row) => !row.unless?.(mode)))

  /*
   * И сцепки — проверенные факты об этом коде, а не оговорки. Правило честности
   * к ним относится ровно так же, как к переключателям. (Числом их здесь не
   * называют: массив рос и убывал, а слово «три» оставалось.)
   */
  const COUPLINGS: { what: string; why: string; when: (r: RoomRules) => boolean }[] = [
    {
      what: 'Students can edit code the teacher runs.',
      why:
        'Code is read when execution starts. A student with editing access can change a queued ' +
        'cell before the teacher’s run begins.',
      when: (r) => r.run !== 'room' && r.edit === 'room',
    },
    {
      what: 'Running code also gives access to files.',
      // Про соседние комнаты — только там, где ядро общее: под своим
      // контейнером в него смонтирована одна папка, и пугать нечем.
      get why(): string {
        return (
          (sharedKernel
            ? 'The shared container has access to files from every seminar. '
            : 'The container has access to this room’s files. ') +
          'Anyone allowed to run code can list, read and delete those files, regardless of the ' +
          'file panel permissions.'
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
      Back to seminars
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
  subtitle="Choose a notebook, environment and access rules, then create the seminar."
  {actions}
>
  {#if error}
    <p class="mb-4 border-l-2 border-danger bg-danger/[0.06] px-3 py-2 text-ui text-danger" role="alert">
      {error}
    </p>
  {/if}

  <Section
    title="Basics"
    description="Students see this name when they join the seminar."
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
          <span class="text-2xs leading-tight text-muted">Start with a text cell and a code cell.</span>
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
              Choose a .ipynb file. Outputs are not imported.
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
          <!-- И то, что не приедет: сумма файлов ограничена потолком комнаты
               (server/src/routes/admin-import.ts · withinRoomBudget), и остаток
               отсекается ещё до её создания. Своей строкой, а не ещё одним
               именем в ряду привезённых, где оно читалось бы как «тоже едет». -->
          {#if preview.skipped.length > 0}
            <div class="mt-1.5 flex flex-wrap items-center gap-2 text-2xs text-warning">
              <span>
                {preview.skipped.length === 1
                  ? '1 file exceeds the import limit and will be skipped:'
                  : `${preview.skipped.length} files exceed the import limit and will be skipped:`}
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
    title="Environment"
    description={sharedKernel
      ? 'All seminars use one shared container with the server’s default environment.'
      : "The Python environment for this seminar. It is selected when the seminar is created."}
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
            <span class="font-semibold text-ink">GPU не настроены.</span>
            Окружению нужен GPU, но KERNEL_GPUS не задана. Выберите другое окружение
            или попросите администратора настроить GPU.
          {:else}
            <span class="font-semibold text-ink">Свободных срезов нет.</span>
            Все срезы заняты контейнерами других семинаров, в том числе неактивных.
            Семинар можно создать, но для запуска ядра потребуется освободить срез.
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
    description="Add files to the seminar workspace. Participants can download them; reading them from code requires permission to run code."
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
                Attached notebook file
              {:else}
                Read from code with open("{file.name}")
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
            aria-label={`Remove ${file.name} from the upload list`}
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
          <!-- Число — с сервера. Пока его нет, предложение обрывается на точке:
               предел, названный наугад, хуже неназванного. -->
          {#if maxUploadBytes !== null}Up to {uploadMb(maxUploadBytes)} MB each.{/if}
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
          {materials.length + (notebook ? 1 : 0)}
          {materials.length + (notebook ? 1 : 0) === 1 ? 'material' : 'materials'} ·
          {imageSize(materialBytes)}
        </p>
      {/if}
    </div>
  </Section>

  <Section
    title="The room"
    description="Choose a mode and adjust access rules. You can change them during the seminar."
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
        <p class="text-2xs text-muted">Режим можно изменить на странице семинара.</p>
      </div>

      <RoomRulesRows {rules} onchange={(patch) => (rules = { ...rules, ...patch })} />

      <!--
        Сцепки, напечатанные здесь, а не спрятанные в коде. Каждая — про
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
          <span class="text-micro font-bold uppercase tracking-caps text-muted">Unavailable controls</span>
          <span class="text-2xs text-faint">Current limitations</span>
        </div>
        {#each notYet as row (row.what)}
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
          <p class="text-ui font-semibold text-ink">Teacher controls</p>
          <p class="mt-1 text-2xs text-muted">
            Interrupting a cell somebody else started · renaming the seminar · restoring an old
            version and marking a checkpoint · deleting files from the file panel · closing somebody's access
            from the People panel, which also takes them out of the room.
          </p>
        </div>
      </div>
    </div>
  </Section>

  <Section
    title="Oracle"
    description="Choose oracle access for this seminar within the server’s allowed mode."
  >
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap gap-1.5">
        {#each ORACLE as option (option.value)}
          <!-- Выше потолка инстанса — не выбор, а обещание. Такая карточка
               гаснет и говорит, чем она станет на самом деле. -->
          {@const over = ceiling ? oracleOverCeiling(option.value, ceiling.mode) : false}
          <button
            type="button"
            class="oracle-card {rules.oracle === option.value ? 'oracle-on' : ''}"
            aria-pressed={rules.oracle === option.value}
            disabled={over}
            title={over ? `The server allows up to ${ceiling?.mode} mode` : undefined}
            onclick={() => (rules.oracle = option.value)}
          >
            <span class="text-ui font-semibold">{option.label}</span>
            <span class="text-2xs opacity-70">
              {over ? `above what the instance allows (${ceiling?.mode})` : option.note}
            </span>
          </button>
        {/each}
      </div>
      <p class="text-2xs text-muted">
        The server’s mode limits this seminar. You can further restrict the oracle here.
        {#if ceiling?.why}
          <span class="text-ink">
            {ceiling.mode === 'off'
              ? `The oracle is unavailable: ${ceiling.why}.`
              : `Server limit: ${ceiling.why}.`}
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
   * `.tab-btn`/`.tab-on` стояли здесь третьими и не были нужны ни одному
   * элементу: полоса вкладок этого экрана давно нарисована классами Tailwind
   * по месту. Компилятор выкидывал их с предупреждением на каждой сборке.
   */
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

  /*
   * Выше потолка инстанса. Пунктир — тот же язык, что и у «чтения окружения» на
   * экране оракула: рамка, которая выглядит полем и не отвечает, хуже подписи.
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
