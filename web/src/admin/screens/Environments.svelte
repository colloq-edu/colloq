<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  /**
   * The packages a seminar's Python has.
   *
   * Drawn to artboard 1RG-0. One row per environment: what it contains, how big
   * the built image is, and whether the room is running it. Building shows the
   * log as it happens — a pip install of torch is four minutes of silence
   * otherwise, and silence is indistinguishable from a hang.
   *
   * The screen is honest about one thing the artboard leaves implicit: a
   * seminar picks its environment when it is created and keeps it, so the
   * active one is only what the NEXT room gets — switching does not move a
   * class that is already running. That is said next to the button rather than
   * discovered afterwards. Production environments come from the release catalog.
   */
  import { onMount, untrack } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import EnvironmentLink from '@/components/ui/EnvironmentLink.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { builtAgo, cn, imageSize } from '@/lib/utils'
  import {
    DEFAULT_PYTHON,
    ENVIRONMENT_NAME,
    PYTHON_VERSIONS,
    declaresParent,
    declaresPython,
    unreadablePython,
    withPython,
    type AdminEnvironment,
    type EnvironmentsState,
  } from '@shared/admin'

  // Not `state`: a variable by that name breaks the `$state` rune — Svelte
  // reads `$state` as a subscription to a store called `state`.
  let envs = $state<EnvironmentsState | null>(null)
  let loading = $state(true)
  let errorText = $state<(() => string | null) | null>(null)
  const error = $derived(errorText?.() ?? null)
  /** Per-row error, so a failed delete does not blank the page. */
  let rowError = $state<{ name: string; message: () => string } | null>(null)

  const isOwner = $derived(adminAuth.isOwner)
  /*
   * Собрать и назначить умолчанием — разные «можно ли», и гаснет ровно та
   * кнопка, которой нельзя.
   *
   * Одна причина на всё выключала обе разом: под `make up` сервер сидит в
   * контейнере, и панель отказывала в сборке тоже — то есть завести окружение
   * на арендованной машине можно было только по ssh. Сборке хватает docker и
   * каталога kernel; умолчание — это .env хоста, и там оно и остаётся.
   */
  const canBuild = $derived(envs?.canBuild ?? false)
  const canSetDefault = $derived(envs?.canSetDefault ?? false)
  /** Причины отказа без повторов: когда docker не виден, она у обеих одна. */
  const blocked = $derived(
    [envs?.cannotBuildReason ?? null, envs?.cannotSetDefaultReason ?? null].filter(
      (reason, i, all): reason is string => reason !== null && all.indexOf(reason) === i,
    ),
  )
  const managed = $derived(envs?.managed ?? false)
  const gpuCapacityKnown = $derived(envs?.gpuCapacityKnown !== false)
  /*
   * Срезы видеокарты и те, кто их просит.
   *
   * Считает сервер: свободен тот срез, которого нет ни на одном контейнере
   * комнаты, и знать это может только он. Здесь — чтобы строка над списком и
   * пометка в строке говорили одно и то же число.
   */
  const gpus = $derived(envs?.gpus ?? { total: 0, free: 0 })
  const someoneWantsGpu = $derived(
    envs?.environments.some((e: AdminEnvironment) => e.gpu) ?? false,
  )

  /* ------------------------------------------------------------- loading */

  async function refresh(): Promise<void> {
    try {
      envs = await adminApi.listEnvironments()
      // Число в боковой навигации — отсюда: иначе шелл спрашивал docker второй
      // раз за тот же переход, ради той же цифры.
      navCounts.environments = envs.environments.length
      errorText = null
    } catch (cause) {
      errorText = () => (cause instanceof AdminApiError ? cause.message : tr("admin.could.not.read.the.environments"))
    } finally {
      loading = false
    }
  }

  // Capabilities are server-localized. Refresh only their read model; the
  // package editor's draft and open dialogs keep their own state.
  let environmentLocale = getLocale()
  $effect(() => {
    const locale = getLocale()
    if (locale !== environmentLocale) {
      environmentLocale = locale
      untrack(() => void refresh())
    }
  })

  onMount(() => {
    void refresh()
    /*
     * A build changes the row from the outside — it is a container image being
     * made, not a form being submitted. Polling only while something is
     * building keeps an idle panel quiet.
     *
     * И не чаще, чем нужно, и не там, где ответ придёт сам. Каждый тик — это
     * `docker version`, `docker image inspect` на КАЖДОЕ окружение, проверка
     * изоляции и опрос срезов видеокарты, и всё это в том же цикле событий,
     * который в эту секунду ведёт чужую пару; на двух открытых вкладках —
     * вдвое. Пока лог открыт, конец сборки приезжает кадром `done`, и
     * спрашивать про неё docker незачем: опрос остаётся только для сборки,
     * запущенной из другой вкладки или из CLI.
     */
    const tick = window.setInterval(() => {
      const building = (envs?.environments ?? []).filter(
        (e: AdminEnvironment) => e.state === 'building',
      )
      if (building.length === 0) return
      if (stream && building.every((e: AdminEnvironment) => e.name === logFor)) return
      void refresh()
    }, 12_000)
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
  let logLost = $state(false)
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
   * discovered by the background poll above, in a tab reloaded or left behind,
   * lands flat, because the entrance is for the person who was staring at the log.
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
    logLost = false
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
       * answers `done` immediately when there is no live build (the log route
       * in server/src/routes/admin-environments.ts, right after the SSE
       * headers: `if (!existing || existing.done) send('done', …)`), so simply
       * opening the Build log of something built last week arrives here too — and
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
         * and comfortably shorter than the poll above, which is the only thing
         * that could replay the entrance for a build that ended long ago.
         * The guard keeps a second build's flag from being cleared by the
         * first one's timer.
         */
        window.setTimeout(() => {
          if (justFinished === name) justFinished = null
        }, 1500)
      }
      void refresh()
    })
    /*
     * Поток оборвался — и это надо сказать.
     *
     * Перезапуск сервера, прокси, уснувший ноутбук: `done` уже не придёт,
     * `justFinished` не выставится, а панель лога остаётся на экране с
     * последними строками и без единого признака, что она мёртвая. Человек,
     * который «смотрит на лог четыре минуты», смотрит на замерший вывод.
     * Состояние строки всё равно догонит опросом — здесь нужно только слово.
     */
    stream.onerror = () => {
      logLost = true
      stopWatching()
      queueMicrotask(() => logBox?.scrollTo({ top: logBox.scrollHeight }))
    }
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
        message: () => (cause instanceof AdminApiError ? cause.message : tr("admin.could.not.update.the.environment.try.again")),
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
  /**
   * Черновик в диалоге — правда об этом окружении, а не остаток прошлого.
   *
   * Диалог открывается до ответа сервера, а `draftSource` до него хранит текст
   * предыдущего открытого окружения. Неудачное чтение — истёкшее печенье,
   * оборванная сеть — оставляло на экране «Environment cv» со списком пакетов
   * nlp и активной кнопкой Save, которая этот список туда и записывала. Пока
   * не прочитали, сохранять нечего.
   */
  let editorReady = $state(false)
  /** Отказ виден там, где нажали: строка таблицы лежит под затемнением. */
  let editorErrorText = $state<(() => string | null) | null>(null)
  const editorError = $derived(editorErrorText?.() ?? null)

  const explain = (cause: unknown, fallback: string): string =>
    cause instanceof AdminApiError ? cause.message : fallback

  async function openEditor(name: string): Promise<void> {
    rowError = null
    editorErrorText = null
    creating = false
    draftName = name
    draftSource = ''
    editorReady = false
    editing = name
    try {
      draftSource = (await adminApi.readEnvironment(name)).source
      editorReady = true
    } catch (cause) {
      editorErrorText = () => (explain(cause, tr("admin.could.not.read", { p0: name })))
    }
  }

  function openCreate(): void {
    rowError = null
    editorErrorText = null
    creating = true
    editing = ''
    draftName = ''
    editorReady = true
    draftSource =
      (tr("admin.installed.on.top.of.the.base.numpy.pandas.matplotlib.scikit.learn") + "\n") +
      (tr("admin.so.there.is.no.need.to.list.those.one.package.per.line.transforme") + "\n")
  }

  /**
   * Имя, которого ещё нет.
   *
   * Второй «Duplicate» того же окружения предлагал то же `-copy` и молча
   * переписывал первую копию — уже отредактированную.
   */
  function freeName(base: string): string {
    const taken = new Set((envs?.environments ?? []).map((e: AdminEnvironment) => e.name))
    const fit = (value: string): string => value.slice(0, 32).replace(/-+$/, '')
    if (!taken.has(fit(base))) return fit(base)
    for (let n = 2; n < 100; n += 1) {
      const candidate = fit(`${base}-${n}`)
      if (!taken.has(candidate)) return candidate
    }
    return fit(base)
  }

  function duplicate(env: AdminEnvironment): void {
    rowError = null
    editorErrorText = null
    creating = true
    editing = ''
    draftName = freeName(`${env.name}-copy`)
    draftSource = ''
    editorReady = false
    void adminApi
      .readEnvironment(env.name)
      .then((r) => {
        draftSource = r.source
        editorReady = true
      })
      // Раньше здесь не было ничего: при отказе диалог просто не открывался, и
      // «Duplicate» выглядел как кнопка, которая ничего не делает.
      .catch((cause) => (editorErrorText = () => (explain(cause, tr("admin.could.not.read", { p0: env.name })))))
  }

  /* ------------------------------------------------------ версия Python */

  /**
   * Версия, которую просит черновик, — и та, что задана за него родителем.
   *
   * Читается из того же текста, который уедет на сервер, тем же разбором, что и
   * сборка (shared/admin.ts): отдельное поле формы рядом с редактируемой шапкой
   * разъехалось бы с ней на первой же правке руками, а правят здесь именно
   * текст.
   */
  const draftParent = $derived(declaresParent(draftSource))
  const draftPython = $derived(declaresPython(draftSource) ?? DEFAULT_PYTHON)
  /** Версия родителя — из уже загруженного списка; '' значит «не знаем». */
  const parentPython = $derived(
    draftParent === null
      ? null
      : ((envs?.environments ?? []).find((e: AdminEnvironment) => e.name === draftParent)?.python ??
          ''),
  )

  function pickPython(version: string): void {
    draftSource = withPython(draftSource, version)
  }

  /**
   * Что не так с шапкой черновика — одной строкой, не мешая сохранить.
   *
   * Обе беды молчаливые: `# colloq: python 3.8` разбором не считается вовсе
   * (такого slim-образа нет), а своя версия у окружения поверх чужого образа —
   * это будущий отказ сборки. Сказать об этом здесь стоит строки; узнать это
   * из журнала сборки — минут.
   */
  const draftWarning = $derived.by<(() => string) | null>(() => {
    const line = unreadablePython(draftSource)
    if (line !== null) {
      return () =>
        tr('admin.env.pythonNotUnderstood', {
          line,
          list: PYTHON_VERSIONS.join(', '),
          version: draftPython,
        })
    }
    if (draftParent !== null && parentPython && declaresPython(draftSource) !== null) {
      const own = declaresPython(draftSource)
      if (own !== parentPython) {
        return () =>
          tr('admin.env.pythonConflict', { parent: draftParent, version: parentPython })
      }
    }
    return null
  })

  const nameOk = $derived(ENVIRONMENT_NAME.test(draftName.trim()))
  /** Имя, уже занятое на этом же экране. Правка своего же имени — не занятость. */
  const nameTaken = $derived(
    creating && (envs?.environments ?? []).some((e: AdminEnvironment) => e.name === draftName.trim()),
  )

  async function save(): Promise<void> {
    const name = draftName.trim()
    if (!nameOk || !editorReady || busy !== null) return
    /*
     * Создание — это создание, а не правка вслепую.
     *
     * PUT один и тот же для обоих, поэтому имя, уже занятое, молча перетирало
     * чужой список пакетов: сорок строк, набранных руками, которых больше нигде
     * нет. Тот же барьер стоит в CLI — `make env-new` отказывается, если файл
     * уже есть.
     */
    if (nameTaken) {
      editorErrorText = () => (tr("admin.environment.already.exists.open.it.with.edit.packages", { p0: name }))
      return
    }
    busy = name
    rowError = null
    editorErrorText = null
    try {
      // `creating` едет до сервера заголовком: список на экране успевает
      // устареть, и тогда занятость видит только он.
      await adminApi.saveEnvironment(name, draftSource, { creating })
      editing = null
      creating = false
      await refresh()
    } catch (cause) {
      editorErrorText = () => (explain(cause, tr("admin.could.not.save.the.package.list.try.again")))
      /*
       * Имя заняли, пока диалог был открыт: вторая вкладка, планшет рядом.
       * Перечитываем список, чтобы имя показалось занятым и здесь — а набранные
       * строки остаются в поле: их писали руками, и под другим именем они те же.
       */
      if (cause instanceof AdminApiError && cause.reason === 'exists') await refresh()
    } finally {
      busy = null
    }
  }

  /* ------------------------------------------------------------ deleting */

  let doomed = $state<string | null>(null)

  async function confirmDelete(): Promise<void> {
    const name = doomed
    if (!name || busy !== null) return
    await act(name, () => adminApi.deleteEnvironment(name))
    doomed = null
  }

  /* ------------------------------------------------------------ switching */

  let switching = $state<string | null>(null)

  async function confirmUse(): Promise<void> {
    const name = switching
    // Второе нажатие — второй `docker compose up` по тому же проекту: ядро
    // пересоздаётся дважды, а второй запрос падает на конфликте контейнера.
    if (!name || busy !== null) return
    await act(name, () => adminApi.useEnvironment(name))
    switching = null
  }

  /* ---------------------------------------------------------- formatting */


  /**
   * Файл просит одну версию, а образ собран на другой.
   *
   * Не косметика: директива для pip — комментарий, поэтому смена версии в шапке
   * не меняет ни одного пакета и «Needs rebuild» от списка не зажигает. Сервер
   * считает это тем же устареванием (environments.ts · pythonDrifted), а здесь
   * это решает, ЧТО показать в строке: обещание файла или правду образа.
   */
  function pythonStale(env: AdminEnvironment): boolean {
    if (env.pythonBuilt === null || env.python === '') return false
    return env.pythonBuilt !== env.python && !env.pythonBuilt.startsWith(`${env.python}.`)
  }

  /**
   * «Python 3.12.7» — то, что в образе, пока оно совпадает с просимым, и
   * «Python 3.13» — то, что просит файл, когда его поправили после сборки.
   *
   * null — когда версии нет вовсе: опубликованный каталог может её не назвать,
   * и написать на этом месте умолчание значило бы выдумать версию чужого
   * образа.
   */
  function pythonLabel(env: AdminEnvironment): string | null {
    const shown = env.pythonBuilt !== null && !pythonStale(env) ? env.pythonBuilt : env.python
    return shown === '' ? null : `Python ${shown}`
  }

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
  /*
   * `order-1` ниже 640 — это вторая строка карточки.
   *
   * Строка окружения — один нерасходящийся ряд: имя `flex-1`, всё остальное
   * `shrink-0`. На 390px имя ужималось в ноль (его не было видно вовсе, а
   * значок GPU при этом печатался поверх соседнего состояния), а неужимаемый
   * хвост всё равно уезжал за край: «По умолчанию» кончалась на 403px,
   * «Использовать по умолчанию» — на 539px при экране в 390. Измерено на
   * стенде.
   *
   * Ниже 640 ряд переносится, и порядок делит его надвое: всё с `order-1`
   * (состояния и действие) уходит под первую строку, где остаются только
   * квадрат, имя и меню. Номер стоит здесь, у общей константы, а не у каждой
   * плашки по месту: плашек шесть на пять ветвей, и разъехаться они могут
   * только все сразу.
   */
  const PILL =
    'inline-flex h-7 shrink-0 items-center gap-1.5 px-2.5 text-2xs font-bold uppercase ' +
    'tracking-label max-[640px]:order-1'
  /*
   * Действие строки — во всю ширину и в две строки текста, если надо.
   *
   * «Использовать по умолчанию» в одну строку — это 293px, которых на телефоне
   * нет ни у кого. Жёсткая высота 32px тут и держала текст в одну строку.
   */
  const ROW_ACTION =
    'inline-flex h-8 shrink-0 items-center bg-primary px-3 text-2xs font-bold uppercase ' +
    'tracking-label text-primary-ink transition-opacity duration-100 hover:opacity-90 ' +
    'disabled:opacity-40 max-[640px]:order-1 max-[640px]:h-auto max-[640px]:min-h-[44px] ' +
    'max-[640px]:w-full max-[640px]:justify-center max-[640px]:py-2 max-[640px]:text-center ' +
    'max-[640px]:leading-snug'
  const ITEM =
    'flex w-full items-center px-2.5 py-1.5 text-left text-ui text-ink transition-colors ' +
    'duration-100 hover:bg-raised disabled:pointer-events-none disabled:opacity-40'

  /** Which row's overflow menu is open. One at a time, like the seminars table. */
  let openMenu = $state<string | null>(null)
</script>

<AdminPage
  title={tr("admin.environments")}
  subtitle={tr("admin.build.container.images.with.the.python.packages.your.seminars.nee")}
>
  {#snippet actions()}
    <button disabled={managed}
      type="button"
      class="inline-flex h-9 items-center gap-2 bg-primary px-4 text-2xs font-bold uppercase tracking-label text-primary-ink transition-opacity duration-100 hover:opacity-90 disabled:opacity-40"
      onclick={openCreate}
    >
      <Icon name="plus" size={14} />
      {tr("admin.new.environment")}
    </button>
  {/snippet}

  <!--
    The entrance on the pill only reaches a teacher who is looking at the row,
    and the premise of this screen is that they have been waiting four minutes
    and may well have looked away. This says the same thing to a reader who is
    not watching. It is one region outside the loop, written only while
    `justFinished` is set: the background poll reassigns every row wholesale, and a live
    region per row would narrate all of that instead of announcing the one event
    that matters.
  -->
  <p class="sr-only" aria-live="polite">
    {#if finished}
      {finished.name}: {finished.state === 'failed' ? tr("admin.build.failed") : tr("admin.build.finished")}
    {/if}
  </p>

  {#if loading}
    <div class="h-24"></div>
  {:else if error}
    <p class="border-l-2 border-danger px-3 py-2 text-ui text-danger">{error}</p>
  {:else if envs}
    <div class="pt-5">
    {#each blocked as reason (reason)}
      <!-- Not a warning about something broken: an install that never mounted
           the Docker socket is a normal way to run this, and so is a server in
           a container whose .env lives on the host. The panel is still the
           right place to read and edit the lists — and, in that second case,
           to build them. -->
      <div class="mb-4 flex items-start gap-2.5 border border-line bg-surface px-3 py-2.5">
        <Icon name="info" size={14} class="mt-0.5 shrink-0 text-muted" />
        <p class="text-2xs leading-relaxed text-muted">{reason}</p>
      </div>
    {/each}

    {#if managed}
      <p class="mb-4 border border-line bg-surface px-4 py-3 text-ui text-muted">
        {tr("admin.environments.come.from.the.release.catalog.each.seminar.keeps.its")}
      </p>
    {/if}

    <!--
      Про карты — там, где карты есть или где их просят. Установка без
      видеокарт и без GPU-окружений не должна читать абзац про железо, которого
      никто не звал; а вот окружение с пометкой на машине без карт — это
      будущий отказ на подъёме ядра, и узнать о нём лучше здесь.
    -->
    {#if gpuCapacityKnown && gpus.total > 0}
      <div class="mb-4 flex items-start gap-2.5 border border-line bg-surface px-3 py-2.5">
        <Icon name="info" size={14} class="mt-0.5 shrink-0 text-muted" />
        <p class="text-2xs leading-relaxed text-muted">
          {tr("admin.gpu")} {tr("admin.count.gpu", { count: gpus.total })}, {gpus.free} {tr("admin.free.a.room.on.a.gpu.environment.holds.its.slice.for.as.long.as.i")}
        </p>
      </div>
    {:else if gpuCapacityKnown && someoneWantsGpu}
      <div class="mb-4 flex items-start gap-2.5 border border-line bg-surface px-3 py-2.5">
        <Icon name="info" size={14} class="mt-0.5 shrink-0 text-muted" />
        <p class="text-2xs leading-relaxed text-muted">
          {tr("admin.no.gpu.slices.are.configured.in.kernel.gpus.seminars.using.a.gpu")}
        </p>
      </div>
    {/if}

    <div class="flex flex-col gap-2.5">
      {#each envs.environments as env (env.name)}
        <section class="border border-line">
          <!--
            Первая строка карточки на телефоне отмерена ровно: квадрат 10 +
            зазор 8 + имя + зазор 8 + меню 44 — отсюда и `100% - 70px` у имени.
            Разъехавшись, эти числа переносят кнопку меню под имя.
          -->
          <div
            class="flex items-center gap-3 px-3.5 py-3 max-[640px]:flex-wrap max-[640px]:items-start
                   max-[640px]:gap-x-2 max-[640px]:gap-y-2.5"
          >
            <span
              class="h-2.5 w-2.5 shrink-0 max-[640px]:mt-1.5"
              style="background: {swatch(env.name)}"
              aria-hidden="true"
            ></span>

            <div class="flex min-w-0 flex-1 flex-col gap-0.5 max-[640px]:basis-[calc(100%_-_70px)]">
              <!-- `flex-wrap` и `min-w-0` — это и есть починка налезающего GPU:
                   значок стоит `shrink-0`, и в ужатой до нуля строке он
                   печатался поверх соседнего состояния. -->
              <div class="flex items-center gap-2 max-[640px]:flex-wrap">
                <!-- Две строки с обрезкой на телефоне, одна с многоточием на
                     столе: `truncate` держит `white-space: nowrap`, и зажим в
                     две строки под ним молча остаётся одной. -->
                <span
                  class="font-mono text-ui-lg font-semibold text-ink max-[640px]:min-w-0
                         max-[640px]:line-clamp-2 min-[641px]:truncate"
                >
                  <EnvironmentLink name={env.name} endpoint={`/api/admin/environments/${encodeURIComponent(env.name)}/inventory`} />
                </span>
                <!-- У имени, а не среди состояний справа: это про то, чем
                     окружение является, а не про то, что с ним сейчас
                     происходит, — и потому видно и во время сборки. -->
                {#if env.gpu}
                  <span
                    class="inline-flex h-[18px] shrink-0 items-center bg-accent/15 px-1.5 text-micro font-bold uppercase tracking-label text-accent-text"
                    title={tr("admin.a.room.on.this.environment.holds.a.gpu.slice.for.as.long.as.its.c")}
                  >
                    GPU
                  </span>
                {/if}
              </div>
              <!--
                Only the facts that exist. The row used to print size and build
                date unconditionally, so an environment that had never been
                built still read "— · never built" — two placeholders where
                there is simply nothing to say — and one that WAS built but
                edited since read "216 MB · built 5 days ago" beside a pill
                saying "Not built". Both halves were true of different things.

                Поверх чего собрано — здесь же, на месте слова «the base»: это
                и есть ответ на «сверх чего эти пакеты», а строка «4 packages
                over base-gpu» объясняет заодно, почему torch в списке нет, а в
                комнате он есть.

                Слово «Python» здесь стояло голым, без версии, — а версия и есть
                то, ради чего на эту строку смотрят: тетрадь с `match` на 3.9 не
                поедет, и узнать об этом до пары дешевле. Показывается версия
                СОБРАННОГО образа, пока она совпадает с просимой в файле; иначе
                — просимая, и рядом «Needs rebuild», который её объясняет.
              -->
              <!-- На телефоне строка фактов переносится: обрезанная по 178px,
                   она показывала «Python 3.11 · 2…» и ничего больше. -->
              <p class="truncate text-2xs text-muted max-[640px]:whitespace-normal">
                {[
                  pythonLabel(env),
                  env.imageBytes === null ? null : imageSize(env.imageBytes),
                  env.builtAt === null ? null : builtAgo(env.builtAt),
                  env.revision ? env.revision.slice(0, 19) + '…' : null,
                  tr("admin.count.packages", { count: env.packages.length, parent: env.parent ?? tr("admin.the.base") }),
                ]
                  .filter((part) => part !== null)
                  .join(' · ')}
              </p>
            </div>

            {#if env.state === 'building'}
              <span class="{PILL} bg-accent/15 text-accent-text">
                <span class="h-1.5 w-1.5 animate-blink rounded-full bg-accent"></span>
                {tr("admin.building")}
              </span>
              <button
                class={cn(BTN, 'max-[640px]:order-1')}
                onclick={() => cancel(env)}
                disabled={!isOwner || busy === env.name}
              >
                {tr("admin.cancel")}
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
                  {tr("admin.ready")}
                </span>
              {:else if env.state === 'failed'}
                <!-- The same mark on the failure. A wait ending badly is still
                     the wait ending, and a build that fails unannounced is the
                     worse of the two to miss. -->
                <span class={cn(PILL, 'bg-danger text-white', justFinished === env.name && 'enter')}>
                  {tr("admin.build.failed.297")}
                </span>
              {:else if env.builtAt !== null}
                <!--
                  BUILT, BUT STALE — and that is not the same as "not built".
                  The image exists, rooms are running it right now; what changed
                  is the package list, saved after the build. Calling that "Not
                  built" beside "216 MB · built 5 days ago" is how the panel
                  contradicts itself in one line, and the reader is left unable
                  to tell whether anything is there at all.

                  Устареть можно и не своей правкой: у окружения поверх чужого
                  образа родителя могли пересобрать позже. Значок тот же — дело
                  одно и то же, — а вот причину подсказка называет, иначе
                  «Needs rebuild» появляется на файле, которого никто не трогал.
                -->
                <span
                  class={cn(PILL, 'text-warning')}
                  title={pythonStale(env)
                    ? tr('admin.env.pythonNeedsRebuild', {
                        version: env.python,
                        built: env.pythonBuilt ?? '',
                      })
                    : env.parent
                      ? tr("admin.the.package.list.changed.or.the.parent.image.was.rebuilt", { p0: env.parent })
                      : tr("admin.the.package.list.changed.after.the.build")}
                >
                  {tr("admin.needs.rebuild")}
                </span>
              {:else}
                <span class={cn(PILL, 'text-muted')}>{tr("admin.not.built")}</span>
              {/if}

              {#if env.active}
                <!--
                  «Default», а не «in use»: с окружением на семинар в работе
                  могут быть несколько сразу, по контейнеру на каждое. Это
                  окружение — то, что получит следующая созданная комната.
                -->
                <span class="{PILL} bg-accent/15 text-accent-text">{tr("admin.default")}</span>
              {/if}

              <!--
                One action, then a menu. Five buttons of equal weight in a row
                make the reader choose before they have read anything; the
                artboard draws two, and the seminars table already uses this
                exact pattern for the rest.
              -->
              {#if !env.active && env.state === 'ready'}
                <button
                  class={ROW_ACTION}
                  onclick={() => (switching = env.name)}
                  disabled={!isOwner || !canSetDefault || busy === env.name}
                  title={envs.cannotSetDefaultReason ??
                    tr("admin.new.seminars.will.be.created.on.this.environment")}
                >
                  {tr("admin.make.default")}
                </button>
              {:else if env.state !== 'ready'}
                <button
                  class={ROW_ACTION}
                  onclick={() => build(env)}
                  disabled={!isOwner || !canBuild || busy === env.name}
                >
                  {tr("admin.build")}
                </button>
              {/if}

              <div class="relative max-[640px]:shrink-0">
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === env.name}
                  aria-label="{tr("admin.actions.for")} {env.name}"
                  class="flex h-8 w-8 items-center justify-center border border-line text-muted transition-colors duration-100 hover:bg-raised hover:text-ink max-[640px]:h-11 max-[640px]:w-11"
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
                    <button role="menuitem" class={ITEM} disabled={managed} onclick={() => openEditor(env.name)}>
                      {tr("admin.edit.packages")}
                    </button>
                    <button role="menuitem" class={ITEM} disabled={managed} onclick={() => duplicate(env)}>
                      {tr("admin.duplicate")}
                    </button>
                    <button
                      role="menuitem"
                      class={ITEM}
                      onclick={() => build(env)}
                      disabled={!isOwner || !canBuild}
                    >
                      {env.state === 'ready' ? tr("admin.rebuild") : tr("admin.build")}
                    </button>
                    <button role="menuitem" class={ITEM} onclick={() => watch(env.name)}>
                      {tr("admin.build.log")}
                    </button>
                    {#if !managed && env.name !== 'base' && !env.active}
                      <button
                        role="menuitem"
                        class={cn(ITEM, 'text-danger hover:bg-danger/10')}
                        onclick={() => (doomed = env.name)}
                        disabled={!isOwner}
                      >
                        {tr("admin.delete")}
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
                  +{env.packages.length - 8} {tr("admin.more")}
                </span>
              {/if}
            </div>
          {/if}

          {#if logFor === env.name}
            <div
              bind:this={logBox}
              class="max-h-[76px] overflow-y-auto border-t border-line bg-[#060C1C] px-3.5 py-2"
            >
              <pre class="whitespace-pre-wrap font-mono text-code leading-relaxed text-[#9BA6BE]">{[...logLines, ...(logLost ? [tr("admin.log.connection.lost.reopen.build.log.to.check.the.build.status")] : [])].join('\n') || tr("admin.waiting.for.build.log")}</pre>
            </div>
          {:else if env.state === 'failed' && env.error}
            <div class="flex items-start gap-2 border-t border-line bg-danger/[0.06] px-3.5 py-2.5">
              <Icon name="alert" size={13} class="mt-0.5 shrink-0 text-danger" />
              <p class="min-w-0 flex-1 break-words font-mono text-micro leading-relaxed text-danger">
                {env.error}
              </p>
              <button class={BTN} onclick={() => watch(env.name)}>{tr("admin.full.log")}</button>
            </div>
          {/if}

          {#if rowError?.name === env.name}
            <p class="border-t border-line px-3.5 py-2 text-2xs text-danger">{rowError.message()}</p>
          {/if}
        </section>
      {:else}
        <!-- Пустой каталог — это установка, где никто ещё не заводил окружений,
             а не поломка. Раньше на этом месте была молчаливая пустота. -->
        <div class="border border-line px-3.5 py-6 text-center">
          <p class="text-ui text-muted">{tr("admin.no.environments.yet")}</p>
          <p class="mt-1 text-2xs text-muted">
            {tr("admin.rooms.run.on.the.base.image.numpy.pandas.matplotlib.scikit.learn")}
          </p>
          <button disabled={managed} type="button" class="{BTN} mt-3" onclick={openCreate}>
            <Icon name="plus" size={14} />
            {tr("admin.new.environment")}
          </button>
        </div>
      {/each}
    </div>

    <p class="mt-4 flex items-start gap-2 text-2xs leading-relaxed text-muted">
      <Icon name="info" size={13} class="mt-0.5 shrink-0" />
      <span>
        {tr("admin.an.environment.is.a.container.image.each.seminar.runs.in.its.own")} <b class="font-semibold text-ink">{tr("admin.new")}</b> {tr("admin.seminars.330")}
        {#if managed}{tr("admin.existing.seminars.keep.their.pinned.image.revision")}{/if}
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
          {creating ? tr("admin.new.environment") : tr("admin.environment", { p0: draftName })}
        </h2>
        <button class={BTN} onclick={() => ((editing = null), (creating = false))}>{tr("admin.close")}</button>
      </div>

      <div class="flex flex-col gap-4 overflow-y-auto px-5 py-4">
        {#if creating}
          <div class="flex flex-col gap-[7px]">
            <label for="env-name" class="text-2xs font-bold uppercase tracking-label text-muted">
              {tr("admin.name")}
            </label>
            <input
              id="env-name"
              bind:value={draftName}
              class="field h-[46px] bg-canvas px-4 font-mono text-code-lg"
              placeholder="cv-torch"
              autocomplete="off"
              spellcheck="false"
            />
            <p class={cn('text-2xs', nameTaken ? 'text-danger' : 'text-muted')}>
              {#if nameTaken}
                {draftName.trim()} {tr("admin.already.exists.choose.another.name.or.use.edit.packages.on.the.ex")}
              {:else}
                {tr("admin.use.1.32.lowercase.letters.digits.or.dashes.start.and.end.with.a")}
              {/if}
            </p>
          </div>
          <!--
            Версия Python — выбором, а не строчкой, которую надо помнить
            наизусть.

            Пишется она всё равно в текст ниже (`# colloq: python 3.12`), и это
            намеренно: файл остаётся единственной правдой об окружении, а кнопки
            — способом её набрать. Поэтому и читается отсюда же: вписанная
            руками директива подсвечивает свою кнопку.

            Умолчание директивой не записывается: файл без строки и файл со
            строкой про умолчание значат одно и то же, а второй ещё и врёт, если
            умолчание однажды поднимут.
          -->
          <div class="flex flex-col gap-[7px]">
            <span class="text-2xs font-bold uppercase tracking-label text-muted">
              {tr('admin.env.pythonVersion')}
            </span>
            <div class="flex flex-wrap gap-1.5">
              {#each PYTHON_VERSIONS as version (version)}
                <button
                  type="button"
                  class={cn(
                    BTN,
                    'font-mono normal-case tracking-normal',
                    (draftParent === null ? draftPython === version : parentPython === version) &&
                      'border-accent bg-accent/10 text-accent-text',
                  )}
                  aria-pressed={draftParent === null && draftPython === version}
                  disabled={draftParent !== null || !editorReady}
                  onclick={() => pickPython(version)}
                >
                  {version}
                </button>
              {/each}
            </div>
            <p class="text-2xs text-muted">
              {#if draftParent !== null}
                <!-- Слой поверх готового образа интерпретатор не меняет: pip
                     в нём ставит колёса под тот Python, что пришёл из базы.
                     Поэтому кнопки заперты, а не просто ничего не делают. -->
                {parentPython
                  ? tr('admin.env.pythonFromParent', {
                      parent: draftParent,
                      version: parentPython,
                    })
                  : tr('admin.env.pythonFromParentUnknown', { parent: draftParent })}
              {:else}
                {tr('admin.env.pythonHint', { version: draftPython })}
              {/if}
            </p>
          </div>
        {/if}

        <div class="flex flex-col gap-[7px]">
          <label for="env-source" class="text-2xs font-bold uppercase tracking-label text-muted">
            {tr("admin.packages")}
          </label>
          <!-- Пока файл не приехал, поле не принимает текст: иначе набранное за
               эти полсекунды затирается ответом сервера. -->
          <textarea
            id="env-source"
            bind:value={draftSource}
            rows="14"
            disabled={!editorReady}
            class="field bg-canvas px-4 py-3 font-mono text-code-lg leading-relaxed disabled:opacity-60"
            spellcheck="false"
          ></textarea>
          <p class="text-2xs text-muted">
            {tr("admin.use.requirements.txt.syntax.one.package.per.line.packages.are.add")}
          </p>
        </div>
      </div>

      <div class="flex items-center gap-2 border-t border-line px-5 py-3.5">
        <!-- Отказ важнее предупреждения, предупреждение важнее подсказки: одна
             строка на троих, и занимает её самое срочное из сказанного. -->
        <p
          class={cn(
            'min-w-0 flex-1 text-2xs',
            editorError ? 'text-danger' : draftWarning ? 'text-warning' : 'text-muted',
          )}
        >
          {editorError ??
            draftWarning?.() ??
            tr("admin.save.the.package.list.then.build.the.environment.to.install.its.p")}
        </p>
        <button class={BTN} onclick={() => ((editing = null), (creating = false))}>{tr("admin.cancel")}</button>
        <button
          class="inline-flex h-8 items-center bg-primary px-4 text-2xs font-bold uppercase tracking-label text-primary-ink transition-opacity duration-100 hover:opacity-90 disabled:opacity-40"
          onclick={save}
          disabled={!nameOk || nameTaken || !editorReady || busy !== null}
        >
          {tr("admin.save")}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ------------------------------------------------------ confirmations -->
{#if doomed}
  <div class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4">
    <div class="dialog-card w-full max-w-md border border-line bg-canvas p-5 shadow-pop">
      <h2 class="text-head font-black tracking-tight text-ink">{tr("admin.delete.350")} {doomed}?</h2>
      <p class="mt-2 text-ui text-muted">
        {tr("admin.this.deletes.the.package.list.the.built.image.remains.in.docker.a")}
      </p>
      <!-- Кнопки гаснут на время запроса. Диалог висит до ответа, а второе
           нажатие уходило вторым запросом: он приходил к уже удалённому
           окружению и отвечал «no such environment» — ложной ошибкой поверх
           успеха. -->
      <div class="mt-5 flex justify-end gap-2">
        <button class={BTN} onclick={() => (doomed = null)} disabled={busy !== null}>{tr("admin.cancel")}</button>
        <button
          class="inline-flex h-8 items-center bg-danger px-4 text-2xs font-bold uppercase tracking-label text-white disabled:opacity-40"
          onclick={confirmDelete}
          disabled={busy !== null}
        >
          {busy === doomed ? tr("admin.deleting") : tr("admin.delete.354")}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if switching}
  <div class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4">
    <div class="dialog-card w-full max-w-md border border-line bg-canvas p-5 shadow-pop">
      <h2 class="text-head font-black tracking-tight text-ink">{tr("admin.make")} {switching} {tr("admin.the.default")}</h2>
      <p class="mt-2 text-ui text-muted">
        {tr("admin.seminars.created.from.now.on.get")} {switching}{tr("admin.existing.seminars.keep.their.selected.environment")}
      </p>
      <!-- Те же гаснущие кнопки: два нажатия — два `docker compose up`, и
           второй падает на конфликте контейнера, отвечая «ядро не вернулось»
           там, где переключение уже состоялось. -->
      <div class="mt-5 flex justify-end gap-2">
        <button class={BTN} onclick={() => (switching = null)} disabled={busy !== null}>
          {tr("admin.cancel")}
        </button>
        <button
          class="inline-flex h-8 items-center bg-primary px-4 text-2xs font-bold uppercase tracking-label text-primary-ink disabled:opacity-40"
          onclick={confirmUse}
          disabled={busy !== null}
        >
          {busy === switching ? tr("admin.switching") : tr("admin.make.default")}
        </button>
      </div>
    </div>
  </div>
{/if}
