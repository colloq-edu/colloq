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
  let notebookErrorText = $state<(() => string | null) | null>(null)
  const notebookError = $derived(notebookErrorText?.() ?? null)
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
      notebookErrorText = () => (tr("admin.could.not.read.this.notebook.check.that.it.is.a.valid.ipynb.file"))
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
  let oversizedText = $state<(() => string | null) | null>(null)
  const oversized = $derived(oversizedText?.() ?? null)

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
    oversizedText = () => (refused.length === 0 || maxUploadBytes === null
        ? null
        : `${refused.map((f) => f.name).join(', ')} ` +
          (tr("admin.exceed.the.mb.upload.limit.and.were.not.added", { p0: uploadMb(maxUploadBytes) }) + " ") +
          tr("admin.choose.smaller.files.or.ask.the.server.administrator.to.increase"))
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
  let gpuCapacityKnown = $state(true)
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
   * Чем располагает машина — и сколько из этого просит комната.
   *
   * Читается здесь, а не на экране окружений, ровно потому, что решение
   * принимается здесь: 13.09 ядро семинара убили по памяти шестнадцать раз
   * подряд, и числа, по которым это можно было предвидеть, знал только тот, у
   * кого есть ssh. `null` — «ещё не знаем»: выдуманная подсказка хуже
   * отсутствующей.
   */
  let resources = $state<InstanceResources | null>(null)
  /** Сколько памяти задали ЭТОЙ комнате; null — как у окружения. */
  let memoryMb = $state<number | null>(null)
  /** Сколько ядер задали ЭТОЙ комнате; null — как у инстанса. */
  let cpus = $state<number | null>(null)

  let preview = $state<ImportPreview | null>(null)
  let previewing = $state(false)
  let previewErrorText = $state<(() => string | null) | null>(null)
  const previewError = $derived(previewErrorText?.() ?? null)
  let busy = $state(false)
  let errorText = $state<(() => string | null) | null>(null)
  const error = $derived(errorText?.() ?? null)

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

  /*
   * Три чтения, и у каждого свой флаг «ещё едет».
   *
   * Одного `null` на «не знаем» и «не узнали» не хватает: до ответа раздел
   * обязан показать заглушку и не пускать к кнопке, после отказа — сказать об
   * отказе и всё-таки пустить. Флаг гаснет и на успехе, и на отказе: ждать
   * второго ответа от того, кто уже ответил «нет», нечего.
   */
  let environmentsLoading = $state(true)
  let oracleLoading = $state(true)
  let resourcesLoading = $state(true)

  /** Хоть что-то из решающего ещё в пути — форма не знает, что отправит. */
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
    // Читается любым преподавателем (GET /api/admin/oracle · requireStaff);
    // ключ приезжает замаскированным.
    void adminApi
      .oracle()
      .then((settings: OracleSettings) => (instanceOracle = settings))
      .catch(() => (instanceOracle = null))
      .finally(() => (oracleLoading = false))
    // Машина. Тем же правилом, что и потолок оракула: не доехало — раздел
    // молчит о числах, а не показывает выдуманные.
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
   * Комната, которая уже есть.
   *
   * Материалы уезжают после её создания, и когда один файл не доехал, экран
   * оставался прежним: те же поля, активная кнопка «Create seminar» — и
   * естественное второе нажатие заводило второй такой же семинар, с тем же
   * именем и той же тетрадью. Ссылка в чат уходила от дубликата.
   */
  let created = $state<string | null>(null)

  /*
   * Пока читаются окружение, потолок оракула и ресурсы — кнопка не нажимается.
   *
   * Не из вежливости к заглушкам: в теле запроса уезжает ВСЁ, что нарисовано на
   * экране, — окружение, режим оракула, память и ядра. Нажатие на первом кадре
   * заводило комнату на пустом окружении и с режимом оракула, который через миг
   * опустится под потолок инстанса ($effect ниже), то есть с настройками,
   * которых никто не выбирал. Ответы приходят одним походом на сервер, так что
   * ждать приходится ровно один круг.
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
       * Материалы уезжают после того, как комната появилась.
       *
       * Загрузка требует существующего семинара — файлы кладутся в его
       * каталог, — а черновик комнаты ради этого заводить дороже, чем оно
       * стоит. Плата известная и небольшая: если файл не доехал, комната уже
       * есть, и об этом говорят вслух вместо того, чтобы делать вид, что
       * ничего не создано.
       */
      created = seminar.id
      /*
       * Память — вдогонку, и только у дверей импорта.
       *
       * Пустая комната уносит число в теле создания. Импорт с GitHub и с диска
       * — чужие двери (routes/admin-import.ts), и добавлять им поле ради одного
       * числа значило бы менять разбор тетради там, где его никто не просил.
       * Семинар уже создан, лимит на живую комнату применяется тем же PATCH,
       * что и в настройках, — цена одного лишнего запроса на создание.
       */
      if ((memoryMb !== null || cpus !== null) && source !== 'blank') {
        try {
          await adminApi.updateSeminar(seminar.id, { memoryMb, cpus })
        } catch {
          /* Комната есть и работает на умолчании окружения; молчать об этом
             нельзя ровно настолько же, насколько нельзя из-за этого отменять
             создание — поэтому строка ниже, а не отказ. */
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
   * И сцепки — проверенные факты об этом коде, а не оговорки. Правило честности
   * к ним относится ровно так же, как к переключателям. (Числом их здесь не
   * называют: массив рос и убывал, а слово «три» оставалось.)
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
  <!-- Комната уже создана — предлагать «создать» ещё раз значит предлагать
       дубликат. Кнопка ведёт туда, где эта комната уже лежит, со ссылкой. -->
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
      <div class="flex gap-2.5">
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
            Про «публичный» сказано здесь, а не в сообщении об ошибке.

            GitHub отвечает анонимному запросу к приватному репозиторию 404, а
            не 403 — иначе по коду ответа перебирали бы чужие названия. Ошибка
            называет обе причины, но узнать об этом до того, как вставишь
            ссылку, лучше, чем после.
          -->
          <span class="text-2xs leading-tight text-muted">{tr("admin.public.repositories.only")}</span>
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
          <!-- И то, что не приедет: сумма файлов ограничена потолком комнаты
               (server/src/routes/admin-import.ts · withinRoomBudget), и остаток
               отсекается ещё до её создания. Своей строкой, а не ещё одним
               именем в ряду привезённых, где оно читалось бы как «тоже едет». -->
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
      Не строка со списком, а карточка с содержимым.

      Раньше здесь стоял `<select>`, и выбор был выбором имени: `cv-torch-2.1`
      против `nlp-hf` — два слова, за которыми для человека, не собиравшего эти
      образы, не стоит ничего. Всё нужное сервер отдаёт и так: список пакетов,
      размер образа, когда собран. Показать это дешевле, чем объяснять словами,
      и честнее, чем не показывать.

      Версия Python — оттуда же, из ответа сервера: он читает её из шапки файла
      окружения и из самого собранного образа (PYTHON_VERSION в его
      конфигурации). Раньше её здесь не было именно потому, что придумывать её
      этот экран не вправе; теперь она известна — и это первое, о чём
      спрашивают, принося тетрадь с чужого ноутбука. Пустая строка значит «не
      знаем» (так отвечает опубликованный каталог), и тогда её просто нет.
    -->
    {#if environmentsLoading}
      <!--
        Список ещё едет.

        Заглушка повторяет карточку выбранного окружения — рамку, кружок,
        строку имени — и ряд «или выбрать» под ней, потому что через мгновение
        здесь встанет ровно это. Пустая строка «на чём работает инстанс» на её
        месте была ответом на вопрос, которого никто не задавал: она значит
        «окружений нет», а их просто ещё не принесли.

        Ряда пакетов в заглушке нет намеренно: он есть не у всякого окружения,
        и обещать его каждому значит уронить карточку на тридцать пикселей там,
        где пакеты не перечислены.
      -->
      <div
        role="status"
        aria-label={tr("admin.python.environment")}
        aria-busy="true"
        class="flex flex-col gap-2.5"
      >
        <div class="flex flex-col border border-line">
          <!-- 45px — это те же py-3 вокруг строки имени в 21px (font-mono
               text-code-lg). Полоски внутри тоньше букв, поэтому высоту держит
               ряд, а не они: иначе карточка приезжает на семь пикселей ниже. -->
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
                <span class="inline-flex h-[18px] items-center bg-positive/10 px-1.5 text-micro font-bold uppercase tracking-label text-positive">
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

        <!-- Остальные окружения одной строкой: несобранное среди них помечено, -->
        <!-- и выбрать его нельзя — комната на нём не поднимется. -->
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
                  <span class="font-sans text-micro text-warning">{tr("admin.not.built.483")}</span>
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
      Сцепка того же рода, что и в «The room», и с тем же правилом честности:
      предупредить, но не запрещать. Срез может освободиться к паре — чужую
      комнату закроют, её контейнер уберут, — а вот молчать нельзя: без
      свободного среза ядро этой комнаты откажется подняться, и услышать это
      первым Run посреди занятия хуже всего. Под общим ядром выбор окружения
      и так ни на что не влияет, и пугать картами там нечем.
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
    Ресурсы — сразу под окружением, и это не вкусовщина.

    Умолчание памяти зависит от выбранного окружения (окружение с GPU просит
    шестнадцать гигабайт против четырёх), так что читать подсказку «по
    умолчанию для окружения X — K ГБ» имеет смысл только после того, как X
    выбран. Тот же компонент стоит в настройках существующего занятия: одна
    настройка, названная и посчитанная одинаково в обоих местах.
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
    title={tr("admin.materials")}
    description={tr("admin.add.files.to.the.seminar.workspace.participants.can.download.them")}
  >
    <div class="flex flex-col">
      {#if materials.length > 0}
        <div class="flex items-center gap-3 border-b border-line pb-2">
          <span class="w-[13px] shrink-0"></span>
          <span class="flex-1 text-micro font-bold uppercase tracking-label text-faint">{tr("admin.file")}</span>
          <span class="w-24 shrink-0 text-micro font-bold uppercase tracking-label text-faint">{tr("admin.role")}</span>
          <span class="w-14 shrink-0 text-right text-micro font-bold uppercase tracking-label text-faint">{tr("admin.size")}</span>
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
            <span class="text-micro text-muted">{notebook.cells.length} {tr("admin.cells.outputs.dropped")}</span>
          </span>
          <span class="w-24 shrink-0">
            <span class="inline-flex h-[18px] items-center gap-1.5 bg-accent px-2 text-micro font-bold uppercase tracking-label text-white">
              <span class="h-1 w-1 bg-white"></span>
              {tr("admin.live")}
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
                {tr("admin.attached.notebook.file")}
              {:else}
                {tr("admin.read.from.code.with.open")}{file.name}")
              {/if}
            </span>
          </span>
          <span class="w-24 shrink-0 text-2xs text-faint">
            {isNotebook(file.name) ? tr("admin.notebook") : tr("admin.data")}
          </span>
          <span class="w-14 shrink-0 text-right font-mono text-micro text-muted">
            {imageSize(file.size)}
          </span>
          <button
            type="button"
            class="shrink-0 text-faint transition-colors duration-[var(--speed-quick)] hover:text-ink"
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
          <!-- Число — с сервера. Пока его нет, предложение обрывается на точке:
               предел, названный наугад, хуже неназванного. -->
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
        <p class="text-2xs text-muted">{tr("admin.you.can.change.the.mode.on.the.seminar.page")}</p>
      </div>

      <RoomRulesRows {rules} instance={instanceOracle} onchange={(patch) => (rules = { ...rules, ...patch })} />

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
          <!-- Выше потолка инстанса — не выбор, а обещание. Такая карточка
               гаснет и говорит, чем она станет на самом деле. -->
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
