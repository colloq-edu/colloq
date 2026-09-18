<!--
  Курсы: список и один курс.

  Курс — это адрес, который дают классу в первую неделю и больше не дают
  ничего. Поэтому у него нет ни архива, ни скрытия, а удаление живёт внутри
  самого курса и называет ссылку, которую ломает.
-->
<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { AdminApiError, addressHolderOf, adminApi, type AdminPublication } from '@/lib/adminApi'
  import { copyText } from '@/lib/clipboard'
  import { plural } from '@/lib/plural'
  import {
    MAX_COURSE_BLURB,
    MAX_COURSE_NAME,
    MAX_PLANNED_WHEN,
    slugOk,
    suggestSlug,
    type AddressHolder,
    type Course,
    type CourseItem,
  } from '@shared/publish'
  import type { AdminSeminar } from '@shared/admin'
  import {
    courseTally,
    plannedRow,
    putPlanned,
    seatSeminar,
    type PlannedTarget,
  } from '@/admin/course-plan'
  import { tick } from 'svelte'

  interface Props {
    /** Открытый курс, если адрес его называет. */
    open: string | null
    navigate: (path: string) => void
  }

  let { open, navigate }: Props = $props()

  let courses = $state<Course[]>([])
  let course = $state<Course | null>(null)
  let seminars = $state<AdminSeminar[]>([])
  let errorText = $state<(() => string | null) | null>(null)
  const error = $derived(errorText?.() ?? null)
  let busy = $state(false)
  let creating = $state(false)
  let draftName = $state('')
  let copied = $state<string | null>(null)
  let adding = $state(false)
  /** Курс запрошен, ответа ещё нет: пустая область — не ответ. */
  let loadingOne = $state(false)

  const explain = (cause: unknown): string => {
    // Мёртвым печеньем этот экран распорядиться не может: оболочка меняет всю
    // панель на экран входа. С причиной — печенье доехало и его отвергли.
    if (cause instanceof AdminApiError) {

      return cause.message
    }
    return tr("admin.could.not.complete.the.request.try.again")
  }

  /** Адрес, который диктуют вслух: имя, если его дали, иначе идентификатор. */
  const addressOf = (item: { id: string; slug: string | null }): string => item.slug ?? item.id

  async function loadList(): Promise<void> {
    try {
      courses = await adminApi.listCourses()
      navCounts.courses = courses.length
      await loadOrphans()
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
    }
  }

  async function loadOne(id: string): Promise<void> {
    loadingOne = true
    try {
      course = await adminApi.course(id)
      errorText = null
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      // Курса по этому адресу нет — ветка внизу скажет это словами, а раньше на
      // его месте была пустая область.
      course = null
      errorText = () => (explain(cause))
      return
    } finally {
      loadingOne = false
    }
    try {
      // Список семинаров нужен только кнопке «Добавить семинар»: без него экран
      // курса остаётся целым, и объявлять курс ненайденным из-за него нельзя.
      seminars = await adminApi.listSeminars()
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
    }
  }

  /*
   * Одна загрузка на открытие, а не две.
   *
   * Рядом стоял `onMount` с теми же двумя вызовами: эффект выполняется сразу
   * после монтирования, так что каждый экран уходил за списком дважды — два
   * `listCourses` и два `listPublications`, а курс — два `course` и два
   * `listSeminars`, тот самый, что разбирает снимок тетради каждой не-живой
   * комнаты. Два ответа на один `course` вдобавок гонялись наперегонки.
   */
  $effect(() => {
    const id = open
    if (id) void loadOne(id)
    else {
      course = null
      void loadList()
    }
  })

  async function create(): Promise<void> {
    const name = draftName.trim()
    // busy проверяется, а не только выставляется: кнопка по нему гаснет, а Enter
    // с автоповтором — нет, и полсекунды удержания заводили пять одинаковых
    // курсов, каждый со своим адресом.
    if (!name || busy) return
    busy = true
    try {
      const made = await adminApi.createCourse({ name })
      draftName = ''
      creating = false
      navigate(`/admin/courses/${made.id}`)
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
    } finally {
      busy = false
    }
  }

  /**
   * Один порядок — один запрос, со сравнением версии.
   *
   * Несовпадение не ошибка, а гонка: другой преподаватель переставил этот курс,
   * пока экран держал его старым. Ответ несёт список таким, какой он сейчас.
   *
   * Итог записи — словом, а не пустотой: форме строки плана надо знать, стирать
   * ли набранное. Успех — стирать; гонка (409) — закрыть, потому что под
   * формой уже другой список; сбой сети — оставить, чтобы нажать ещё раз, а
   * не набирать тему заново.
   */
  async function writeItems(items: CourseItem[]): Promise<'ok' | 'conflict' | 'failed'> {
    // busy проверяется, а не только выставляется: «Убрать строку» и «Добавить
    // семинар» гаснут по нему, но два быстрых нажатия успевают уйти с одним и
    // тем же `rev`, и второе возвращалось как «этот курс успел изменить кто-то
    // ещё» — про собственный двойной клик.
    if (!course || busy) return 'failed'
    busy = true
    errorText = null
    try {
      course = await adminApi.setCourseItems(course.id, course.rev, items)
      return 'ok'
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      if (cause instanceof AdminApiError && cause.status === 409) {
        /*
         * Сначала перечитать, потом сказать. Было наоборот, а успешный
         * `loadOne` сам обнуляет ошибку — и фраза «повторите изменение» гасла,
         * не успев показаться: список молча становился другим, а правка
         * преподавателя пропадала без единого слова.
         */
        await loadOne(course.id)
        errorText = () => (tr("admin.another.user.changed.the.course.the.current.version.will.load.ple"))
        return 'conflict'
      }
      errorText = () => (explain(cause))
      return 'failed'
    } finally {
      busy = false
    }
  }

  function move(index: number, by: -1 | 1): void {
    if (!course) return
    const next = [...course.items]
    const to = index + by
    if (to < 0 || to >= next.length) return
    ;[next[index], next[to]] = [next[to], next[index]]
    closeRowForms()
    void writeItems(next)
  }

  function drop(index: number): void {
    if (!course) return
    closeRowForms()
    void writeItems(course.items.filter((_, i) => i !== index))
  }

  function add(sessionId: string): void {
    if (!course) return
    const session = seminars.find((s) => s.id === sessionId)
    if (!session) return
    adding = false
    void writeItems([
      ...course.items,
      { kind: 'seminar', sessionId, name: session.name, publication: null },
    ])
  }

  /**
   * Строки плана — прямо в списке курса.
   *
   * Одна форма на экран: новая тема (внизу, `target: null`) или правка
   * существующей (на месте строки). Две открытые сразу держали бы два номера
   * строк, и после первого сохранения второй указывал бы уже не туда.
   *
   * Правка знает, какой строка БЫЛА (course-plan.ts · PlannedTarget): номер
   * строки после чужой перестановки — это другая неделя, и переименовать её
   * вместо своей значило бы испортить план молча.
   */
  let plan = $state<{ target: PlannedTarget | null; name: string; when: string } | null>(null)
  /** Строка плана, на место которой выбирают занятие. */
  let seating = $state<PlannedTarget | null>(null)
  let planTopic = $state<HTMLInputElement | null>(null)

  const planReady = $derived(plan !== null && plannedRow(plan.name, plan.when) !== null)

  /**
   * Перестановка или удаление строки сдвигает номера, и открытые на строках
   * формы закрываются: правка по сдвинутому номеру правила бы соседа. Новая
   * тема внизу номера не держит и остаётся с набранным.
   */
  function closeRowForms(): void {
    if (plan?.target) plan = null
    seating = null
  }

  async function openPlan(at: number | null): Promise<void> {
    const row = at === null ? null : course?.items[at]
    seating = null
    adding = false
    plan =
      row?.kind === 'planned' && at !== null
        ? { target: { at, was: row }, name: row.name, when: row.when }
        : { target: null, name: '', when: '' }
    await tick()
    planTopic?.focus()
  }

  async function savePlan(): Promise<void> {
    const draft = plan
    if (!course || !draft || busy) return
    const row = plannedRow(draft.name, draft.when)
    if (!row) {
      planTopic?.focus()
      return
    }
    const next = putPlanned(course.items, row, draft.target)
    if (!next) {
      plan = null
      errorText = () => tr('admin.course.planRowMoved')
      return
    }
    // Правка закрывается и после гонки: под ней уже другой список.
    if (draft.target) {
      if ((await writeItems(next)) !== 'failed') plan = null
      return
    }
    /*
     * План семестра набирают подряд — пятнадцать тем за один присест. Форма
     * остаётся открытой, курсор снова в теме: иначе каждая неделя стоила бы
     * лишнего нажатия «+ Тема по плану».
     *
     * Пустеет форма СРАЗУ, а не по ответу. По ответу было так: Enter в поле
     * недели, курсор остаётся там же, следующая тема печатается в хвост недели
     * («1–7 сенДеревья»), а пришедший ответ стирает обе строки — на медленном
     * плече это секунды, и набранное пропадало молча. И «Отмена» посреди
     * записи открывала форму снова, когда ответ доезжал.
     *
     * Не записалось (сбой, 409) — набранное возвращается, если в пустую форму
     * ещё ничего не начали печатать и её не закрыли: набирать тему заново
     * из-за сети незачем, а начатое поверх затирать нельзя.
     */
    const typed = { name: draft.name, when: draft.when }
    const writing = writeItems(next)
    plan = { target: null, name: '', when: '' }
    const fresh = plan
    await tick()
    planTopic?.focus()
    if ((await writing) === 'ok') return
    if (plan === fresh && !fresh.name && !fresh.when) plan = { target: null, ...typed }
  }

  function openSeat(at: number): void {
    const row = course?.items[at]
    if (row?.kind !== 'planned') return
    plan = null
    adding = false
    seating = seating?.at === at ? null : { at, was: row }
  }

  async function seat(sessionId: string): Promise<void> {
    const target = seating
    const session = seminars.find((s) => s.id === sessionId)
    if (!course || !target || !session || busy) return
    const next = seatSeminar(course.items, target, session)
    if (!next) {
      seating = null
      errorText = () => tr('admin.course.planRowMoved')
      return
    }
    if ((await writeItems(next)) !== 'failed') seating = null
  }

  function planKeys(event: KeyboardEvent): void {
    // Enter, которым подтверждают набор в IME, — не «Добавить»: тема ушла бы
    // недонабранной.
    if (event.isComposing) return
    if (event.key === 'Enter') void savePlan()
    if (event.key === 'Escape') plan = null
  }

  /** Семинары, которых в этом курсе ещё нет. */
  const addable = $derived(
    seminars.filter(
      (s) => !course?.items.some((i) => i.kind === 'seminar' && i.sessionId === s.id),
    ),
  )

  /**
   * Скопировать — или показать ссылку словами.
   *
   * `copyText` бросает там, где буфер закрыт (панель по http на чужом хосте —
   * обычный способ держать инстанс кафедры). Раньше этот отказ уходил
   * необработанным промисом: «Скопировано» не появлялось, ссылки на экране не
   * было, и нажатие выглядело как ничего.
   */
  async function copy(text: string, key: string): Promise<void> {
    try {
      await copyText(text)
    } catch {
      errorText = () => (tr("admin.could.not.copy.the.link.copy.it.manually", { p0: text }))
      return
    }
    copied = key
    setTimeout(() => (copied = copied === key ? null : copied), 1600)
  }

  /**
   * Черновики полей курса.
   *
   * Предложение из названия — только когда имени ещё нет: подставлять его
   * поверх выбранного человеком значило бы переписывать чужое решение при
   * каждом открытии экрана.
   *
   * Ключ — идентификатор курса, а не сам объект: `course` переприсваивается
   * ответом сервера после каждой перестановки строк, и эффект, зависевший от
   * объекта, стирал набранный, но не сохранённый адрес — вместе с кнопкой
   * «Сохранить адрес», которой его собирались сохранить.
   */
  let slugDraft = $state('')
  let nameDraft = $state('')
  let blurbDraft = $state('')
  let drafted: string | null = null

  $effect(() => {
    const open = course
    if (!open) {
      drafted = null
      return
    }
    if (drafted === open.id) return
    drafted = open.id
    // Форма строки плана принадлежит курсу: номер строки из соседнего курса
    // здесь указывал бы на чужую неделю.
    plan = null
    seating = null
    slugDraft = open.slug ?? suggestSlug(open.name)
    nameDraft = open.name
    blurbDraft = open.blurb ?? ''
  })

  /**
   * Имя, которого не дали, и кто его держит.
   *
   * «Адрес «ml-2025» уже занят» — тупик, если держателя не назвать: курса с
   * таким адресом в списке нет, его переименовали в «ml-2025-fall», и прежнее
   * имя он держит ради ссылки, записанной в чате прошлогодней группы. Такое имя
   * владелец отпускает сам (server/src/publish/store.ts · releaseFormerSlug);
   * живой чужой адрес — не отпускает, и кнопки для него не будет. Пока сервер о
   * держателе молчит, экран ведёт себя как раньше: повторяет фразу отказа.
   */
  let held = $state<{ slug: string; holder: AddressHolder } | null>(null)
  /** Второй шаг: отпустить прежний адрес необратимо, и спрашивается это вслух. */
  let askingSlug = $state(false)

  async function saveSlug(): Promise<void> {
    if (!course || busy) return
    const next = slugDraft.trim().toLowerCase()
    if (next && !slugOk(next)) {
      errorText = () => (tr("admin.address.3.64.lowercase.latin.letters.digits.or.dashes.start.and.e"))
      return
    }
    busy = true
    errorText = null
    held = null
    try {
      await adminApi.setSlug('course', course.id, next || null)
      await loadOne(course.id)
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
      const holder = addressHolderOf(cause)
      if (holder?.former && next) held = { slug: next, holder }
    } finally {
      busy = false
    }
  }

  /**
   * Освободить прежний адрес и занять его — одним решением.
   *
   * Одним, потому что отпускают его ровно затем, чтобы дать это имя своему
   * курсу: два нажатия подряд оставили бы посередине состояние «имя ничьё», в
   * котором его занимает кто угодно другой.
   */
  async function releaseSlug(): Promise<void> {
    if (!held || busy) return
    const { holder, slug: freed } = held
    busy = true
    errorText = null
    try {
      await adminApi.releaseFormerSlug(holder.kind, holder.id, freed)
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
      return
    } finally {
      busy = false
    }
    held = null
    askingSlug = false
    slugDraft = freed
    await saveSlug()
  }

  /**
   * Своё прежнее имя — то, которое держит этот курс.
   *
   * Второй путь к тому же действию, и нужен он не тому, кому имя отказали, а
   * владельцу: курс «ML 2025», переименованный в «ml-2025-fall», держит
   * «ml-2025» за собой навсегда — ссылка с ним записана в чате прошлогодней
   * группы, — и курсу следующего года это имя не дать. Увидеть, что держит его
   * именно этот курс, было негде: строки с таким адресом в списке нет вовсе.
   * Список приезжает вместе с курсом (server/src/routes/courses.ts · former).
   */
  let dropping = $state<string | null>(null)
  /** Прежние имена этого курса — с сервера, вместе с самим курсом. */
  const former = $derived(course?.former ?? [])

  async function dropFormer(): Promise<void> {
    const open = course
    const name = dropping
    if (!open || !name || busy) return
    busy = true
    errorText = null
    try {
      await adminApi.releaseFormerSlug('course', open.id, name)
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
      return
    } finally {
      busy = false
    }
    dropping = null
    // Перечитываем курс, а не вычитаем имя из списка на месте: прежние имена
    // считает сервер, и вторая копия этого ответа разошлась бы с ним на первом
    // же отказе.
    await loadOne(open.id)
  }
  /**
   * Название и подпись курса.
   *
   * Их не было нигде: курс, заведённый с опечаткой в названии, оставался с ней
   * навсегда, и опечатку видел весь класс на публичной странице.
   */
  const detailsChanged = $derived(
    Boolean(course) &&
      (nameDraft.trim() !== course?.name || blurbDraft.trim() !== (course?.blurb ?? '')),
  )

  async function saveDetails(): Promise<void> {
    const open = course
    if (!open || busy) return
    const name = nameDraft.trim()
    if (!name) {
      errorText = () => (tr("admin.enter.a.course.name"))
      return
    }
    busy = true
    errorText = null
    try {
      const saved = await adminApi.updateCourse(open.id, { name, blurb: blurbDraft.trim() || null })
      course = saved
      /*
       * Черновики — с ответа сервера, а не с того, что набрали.
       *
       * Сервер режет подпись по `MAX_COURSE_BLURB`, и после сохранения
       * сохранённое короче набранного: `detailsChanged` оставался истинным,
       * кнопка «Сохранить изменения» не гасла, и её жали снова и снова. Эффект
       * выше их не трогает — он ключом по `open.id`, а курс тот же.
       */
      nameDraft = saved.name
      blurbDraft = saved.blurb ?? ''
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
    } finally {
      busy = false
    }
  }

  /**
   * Удаление курса — здесь же, и оно называет ссылку, которую ломает.
   *
   * Сами семинары и их страницы остаются: курс — это порядок и адрес, а не
   * хранилище. Ломается ровно то, что классу продиктовали в первую неделю.
   */
  let doomed = $state(false)

  async function destroy(): Promise<void> {
    const open = course
    if (!open || busy) return
    busy = true
    errorText = null
    try {
      await adminApi.deleteCourse(open.id)
      doomed = false
      navigate('/admin/courses')
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
    } finally {
      busy = false
    }
  }

  /**
   * Страницы, у которых больше нет комнаты.
   *
   * Удаление семинара по умолчанию оставляет чтение: розданную ссылку не
   * отозвать. Но дальше страница пропадала из панели совсем — все остальные
   * маршруты публикации спрашивают её по семинару, — и снять её можно было
   * только правкой базы. Здесь она видна и снимается.
   */
  let orphans = $state<AdminPublication[]>([])
  let orphanBusy = $state<string | null>(null)

  async function loadOrphans(): Promise<void> {
    try {
      orphans = (await adminApi.listPublications()).filter((p) => p.orphaned)
    } catch {
      // Не беда: это приписка к списку курсов, а не сам список.
      orphans = []
    }
  }

  async function actOnOrphan(id: string, what: () => Promise<void>): Promise<void> {
    orphanBusy = id
    errorText = null
    try {
      await what()
      await loadOrphans()
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => (explain(cause))
    } finally {
      orphanBusy = null
    }
  }

  const ROW = 'flex items-center gap-4 border-t border-line py-2.5'
  const ARROW =
    'flex h-8 w-8 items-center justify-center border border-line text-muted transition-colors ' +
    'duration-100 hover:border-faint hover:text-ink disabled:border-line-soft disabled:text-faint'
</script>

<!--
  Поля строки плана — одни на новую тему и на правку существующей. Тема
  обязательна (сервер без неё отказывает), неделя — нет: у темы «на потом»
  недели ещё может не быть.
-->
{#snippet planForm(label: string)}
  {#if plan}
    <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <input
        bind:this={planTopic}
        class="h-9 min-w-0 flex-[3_1_200px] border border-line bg-canvas px-3 text-ui text-ink
               placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
        placeholder={tr('admin.course.plannedTopic')}
        aria-label={tr('admin.course.plannedTopic')}
        maxlength={MAX_COURSE_NAME}
        bind:value={plan.name}
        onkeydown={planKeys}
      />
      <input
        class="h-9 min-w-0 flex-[1_1_150px] border border-line bg-canvas px-3 text-ui text-ink
               placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
        placeholder={tr('admin.course.plannedWhen')}
        aria-label={tr('admin.course.plannedWhenLabel')}
        maxlength={MAX_PLANNED_WHEN}
        bind:value={plan.when}
        onkeydown={planKeys}
      />
      <div class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          class="btn-primary h-9 px-3 text-2xs"
          disabled={busy || !planReady}
          onclick={() => void savePlan()}
        >
          {label}
        </button>
        <button type="button" class="btn-ghost h-9 px-3 text-2xs" onclick={() => (plan = null)}>
          {tr('admin.cancel')}
        </button>
      </div>
    </div>
  {/if}
{/snippet}

{#if !open}
  <AdminPage
    title={tr("admin.courses")}
    subtitle={tr("admin.group.seminars.on.a.course.page.and.set.their.order")}
  >
    {#snippet actions()}
      <button type="button" class="btn-primary" onclick={() => (creating = true)}>{tr("admin.new.course")}</button>
    {/snippet}

    <!-- Свой отступ — только от sm: у AdminPage он уже есть, и на телефоне
         двойной съедал под списком курсов почти треть ширины. -->
    <div class="py-6 sm:px-8">
      {#if error}
        <p class="pb-4 text-ui text-danger">{error}</p>
      {/if}

      {#if creating}
        <div class="mb-5 flex items-center gap-3 border border-line bg-surface px-4 py-3">
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="h-9 min-w-0 flex-1 border border-line bg-canvas px-3 text-ui text-ink"
            placeholder={tr("admin.course.name")}
            maxlength={MAX_COURSE_NAME}
            autofocus
            bind:value={draftName}
            onkeydown={(event) => {
              if (event.key === 'Enter') void create()
              if (event.key === 'Escape') creating = false
            }}
          />
          <button type="button" class="btn-primary shrink-0" disabled={busy} onclick={() => void create()}>
            {tr("admin.create")}
          </button>
          <button type="button" class="btn-ghost shrink-0" onclick={() => (creating = false)}>
            {tr("admin.cancel")}
          </button>
        </div>
      {/if}

      {#if courses.length === 0 && !creating}
        <div class="py-16 text-center">
          <p class="text-title font-semibold text-ink">{tr("admin.no.courses.yet")}</p>
          <p class="mx-auto mt-2 max-w-sm text-ui text-muted">
            {tr("admin.create.a.course.and.add.seminars.students.will.see.the.list.and.l")}
          </p>
        </div>
      {/if}

      {#each courses as item (item.id)}
        {@const tally = courseTally(item.items)}
        <!-- flex-wrap и basis-48: со счётом «по плану» строка счёта длиннее,
             чем осталось места на телефоне, и без переноса она вылезала за
             край, а название курса сжималось в ноль. -->
        <div class="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line py-3.5">
          <button
            type="button"
            class="min-w-0 flex-1 basis-48 text-left"
            onclick={() => navigate(`/admin/courses/${item.id}`)}
          >
            <p class="text-ui-lg font-semibold text-ink">{item.name}</p>
            <!-- Адрес печатается тот же, что диктуют классу: смысл имени в том,
                 что оно и есть ссылка, а не второй адрес рядом с ней. -->
            <p class="mt-0.5 font-mono text-2xs text-muted">/c/{addressOf(item)}</p>
          </button>
          <p class="shrink-0 text-ui text-muted">
            {tally.published} {tr("admin.published")} {tally.waiting} {tr("admin.not.yet")}
            {#if tally.planned > 0}{tr('admin.course.plannedCount', { count: tally.planned })}{/if}
          </p>
        </div>
      {/each}

      <!--
        Страницы без комнаты. Сервер их отдаёт и `make site` выкладывает, а в
        панели их не было видно нигде — снять оставшуюся после удалённого
        семинара страницу можно было только правкой базы.
      -->
      {#if orphans.length > 0}
        <div class="mt-8 border-t border-line pt-5">
          <p class="text-ui font-semibold text-ink">{tr("admin.pages.without.a.room")}</p>
          <p class="mt-1 max-w-xl text-2xs leading-relaxed text-muted">
            {tr("admin.the.seminar.was.deleted.but.its.publication.was.kept.you.can.with")}
          </p>
          {#each orphans as page (page.id)}
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line py-3">
              <div class="min-w-0 flex-1">
                <p class="truncate text-ui text-ink">{page.title}</p>
                <p class="mt-0.5 font-mono text-2xs text-muted">
                  /p/{addressOf(page)} · {page.steps}
                  {plural(page.steps, tr("admin.step"), tr("admin.steps"), tr("admin.steps.143"))}
                  {page.state === 'withdrawn' ? (" " + tr("admin.withdrawn")) : ''}
                </p>
              </div>
              <a class="shrink-0 text-ui text-accent-text" href={`/p/${addressOf(page)}`} target="_blank" rel="noreferrer">
                {tr("admin.open")}
              </a>
              {#if page.state === 'published'}
                <button
                  type="button"
                  class="shrink-0 text-ui font-semibold text-muted hover:text-ink"
                  disabled={orphanBusy === page.id}
                  onclick={() => void actOnOrphan(page.id, () => adminApi.withdrawPublication(page.id))}
                >
                  {tr("admin.withdraw.page")}
                </button>
              {:else}
                <button
                  type="button"
                  class="shrink-0 text-ui font-semibold text-muted hover:text-ink"
                  disabled={orphanBusy === page.id}
                  onclick={() => void actOnOrphan(page.id, () => adminApi.restorePublication(page.id))}
                >
                  {tr("admin.restore.page")}
                </button>
                <!-- Стереть — только владельцу и только у снятой: снятую можно
                     вернуть, стёртую нельзя, и надгробие в курсе теряет ссылку. -->
                {#if adminAuth.isOwner}
                  <button
                    type="button"
                    class="shrink-0 text-ui font-semibold text-danger"
                    disabled={orphanBusy === page.id}
                    onclick={() => {
                      if (!window.confirm(tr("admin.permanently.delete.page.p.it.cannot.be.restored.through.colloq", { p0: addressOf(page) }))) return
                      void actOnOrphan(page.id, () => adminApi.erasePublication(page.id))
                    }}
                  >
                    {tr("admin.delete.permanently")}
                  </button>
                {/if}
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </AdminPage>
{:else if course}
  {@const shown = course}
  <AdminPage title={shown.name}>
    {#snippet actions()}
      <!-- Копируется тот же адрес, что диктуют вслух: /c/<имя>, если имя дали.
           Иначе в чат уходил идентификатор, и у класса оказывалось два разных
           адреса одного курса. -->
      <button
        type="button"
        class="btn-ghost"
        onclick={() => void copy(`${location.origin}/c/${addressOf(shown)}`, 'link')}
      >
        {copied === 'link' ? tr("admin.copied") : tr("admin.copy.link")}
      </button>
      <a class="btn-ghost" href={`/c/${addressOf(shown)}`} target="_blank" rel="noreferrer">
        {tr("admin.open.course.page")}
      </a>
      <button type="button" class="btn-primary" onclick={() => (adding = !adding)}>
        {tr("admin.add.seminar")}
      </button>
    {/snippet}

    <div class="py-6 sm:px-8">
      <button
        type="button"
        class="mb-5 text-ui text-muted transition-colors hover:text-ink"
        onclick={() => navigate('/admin/courses')}
      >
        {tr("admin.all.courses")}
      </button>

      <!--
        Название и подпись — там же, где адрес: курс с опечаткой в названии
        нельзя было поправить нигде, а видит её весь класс.
      -->
      <div class="flex flex-wrap items-center gap-2 pb-4">
        <input
          class="h-9 w-[280px] max-w-full border border-line bg-canvas px-3 text-ui text-ink
                 focus:outline-none focus:ring-2 focus:ring-accent/40"
          maxlength={MAX_COURSE_NAME}
          aria-label={tr("admin.course.name")}
          bind:value={nameDraft}
          onkeydown={(event) => {
            if (event.key === 'Enter') void saveDetails()
          }}
        />
        <input
          class="h-9 min-w-[220px] flex-1 border border-line bg-canvas px-3 text-ui text-ink
                 placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
          placeholder={tr("admin.short.course.description.optional")}
          maxlength={MAX_COURSE_BLURB}
          aria-label={tr("admin.course.description")}
          bind:value={blurbDraft}
          onkeydown={(event) => {
            if (event.key === 'Enter') void saveDetails()
          }}
        />
        {#if detailsChanged}
          <button
            type="button"
            class="btn-primary h-9 shrink-0 px-3 text-2xs"
            disabled={busy}
            onclick={() => void saveDetails()}
          >
            {tr("admin.save.changes")}
          </button>
        {/if}
      </div>

      <!--
        Адрес курса — то, что диктуют классу вслух и пишут на доске. Поэтому он
        редактируется прямо здесь, а не прячется в настройках: восемь случайных
        символов запоминаются хуже, чем «ml-strong», и переспрашивают их чаще.
      -->
      <div class="flex flex-wrap items-center gap-2 pb-5">
        <span class="font-mono text-2xs text-muted">{location.host}/c/</span>
        <input
          class="h-9 w-[220px] border border-line bg-canvas px-2 font-mono text-2xs text-ink
                 placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
          placeholder={shown.id}
          maxlength={64}
          bind:value={slugDraft}
          onkeydown={(event) => {
            if (event.key === 'Enter') void saveSlug()
          }}
        />
        {#if slugDraft.trim() !== (shown.slug ?? '')}
          <button type="button" class="btn-primary h-9 px-3 text-2xs" disabled={busy} onclick={() => void saveSlug()}>
            {tr("admin.save.address")}
          </button>
        {/if}
        <!-- Имя держит не живой адрес, а память о розданной ссылке — и это
             единственный вид «занято», который владелец разрешает сам. Кнопка
             стоит у самого поля: искать её в другом месте экрана значит не
             найти вовсе. -->
        {#if held}
          <button
            type="button"
            class="btn-outline h-9 px-3 text-2xs"
            disabled={busy}
            onclick={() => (askingSlug = true)}
          >
            {tr("admin.release.previous.address")}
          </button>
        {/if}
        {#if shown.slug}
          <span class="text-2xs text-muted">{tr("admin.the.old.address.c")}{shown.id} {tr("admin.also.works")}</span>
        {/if}
      </div>

      {#if held}
        <p class="max-w-[640px] pb-5 text-2xs leading-snug text-muted">
          <span class="font-mono text-ink">/c/{held.slug}</span> {tr("admin.the.previous.address.of.the")}
          {held.holder.kind === 'course' ? tr("admin.course") : tr("admin.page")}
          {#if held.holder.name}«{held.holder.name}»{/if}{tr("admin.after.transfer.this.link.will.open.the.current.course.instead.of")}
        </p>
      {/if}

      <!--
        Прежние имена — под тем же полем, где их и меняли.

        Переименование не отменяет розданную ссылку: старое имя остаётся
        адресом этого курса навсегда — и держит его для всех остальных тоже.
        Курс следующего года получал «Адрес «ml-2025» — прежнее имя курса «ML
        2025»», а увидеть, что имя держится ЗДЕСЬ, было негде: строки с таким
        адресом в списке курсов нет. Цена отпускания названа рядом с кнопкой, а
        не только в вопросе после неё.
      -->
      {#if former.length > 0}
        <div class="mb-5 max-w-[640px] border border-line bg-surface">
          <div class="border-b border-line px-4 py-2.5">
            <p class="text-ui font-semibold text-ink">{tr("admin.previous.addresses")}</p>
            <p class="mt-0.5 text-2xs leading-snug text-muted">
              {tr("admin.these.links.open.the.current.course.releasing.an.address.stops.it")}
            </p>
          </div>
          {#each former as name (name)}
            <div class="flex items-center gap-3 border-b border-line-soft px-4 py-2 last:border-b-0">
              <span class="min-w-0 flex-1 truncate font-mono text-2xs text-ink">/c/{name}</span>
              <button
                type="button"
                class="btn-outline h-9 shrink-0 px-3 text-2xs"
                disabled={busy}
                onclick={() => (dropping = name)}
              >
                {tr("admin.release")}
              </button>
            </div>
          {/each}
        </div>
      {/if}

      {#if error}
        <p class="pb-4 text-ui text-danger">{error}</p>
      {/if}

      <!--
        Утверждение, а не переключатель: видимость курса ничем не управляется, и
        рисовать для неё тумблер значило бы обещать выбор, которого нет.
      -->
      <div class="mb-6 flex flex-wrap items-start gap-x-7 gap-y-2 border-y border-line py-4">
        <div class="w-[220px] shrink-0">
          <p class="text-ui font-semibold text-ink">{tr("admin.what.students.see")}</p>
          <p class="mt-0.5 text-2xs leading-snug text-muted">
            {tr("admin.the.page.is.accessible.by.link.without.signing.in")}
          </p>
        </div>
        <!-- basis: без неё flex-1 оставался в строке рядом с подписью шириной в
             тридцать пикселей и вылезал за край, вместо того чтобы уйти ниже. -->
        <p class="min-w-0 max-w-[640px] flex-1 basis-[260px] text-ui leading-relaxed text-muted">
          {tr("admin.the.course.page.shows.seminar.names.in.the.chosen.order.and.links")}
        </p>
      </div>

      {#if adding}
        <div class="mb-5 border border-line bg-surface p-3">
          {#if addable.length === 0}
            <p class="text-ui text-muted">{tr("admin.no.seminars.available.to.add")}</p>
          {:else}
            <div class="flex flex-wrap gap-2">
              {#each addable as session (session.id)}
                <button
                  type="button"
                  class="border border-line bg-canvas px-3 py-1.5 text-ui text-ink transition-colors
                         hover:border-faint disabled:text-faint"
                  disabled={busy}
                  onclick={() => add(session.id)}
                >
                  {session.name}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!--
        Список — в контейнере со своей шириной: колонка «Публикация» в 290px и
        стрелки не помещались рядом с названием уже на планшете с открытым
        меню, а на телефоне название сжималось в столбик и текст публикации
        ложился поверх него. Точка перелома — по ширине самого списка, а не
        окна: меню панели съедает разную ширину на разных экранах.
      -->
      <div class="course-rows">
      <div class="flex items-center gap-4 pb-2">
        <span class="w-[26px] shrink-0"></span>
        <span class="flex-1 text-micro font-bold uppercase tracking-caps text-muted">{tr("admin.seminar")}</span>
        <span class="course-head-state w-[290px] shrink-0 text-micro font-bold uppercase tracking-caps text-muted">
          {tr("admin.publication")}
        </span>
        <span class="w-[60px] shrink-0"></span>
      </div>

      {#each shown.items as item, index (index)}
        {@const editing = plan?.target?.at === index}
        <div class="course-row {ROW}">
          <span class="w-[26px] shrink-0 font-mono text-2xs text-faint">
            {String(index + 1).padStart(2, '0')}
          </span>
          {#if editing}
            {@render planForm(tr('admin.save'))}
          {:else if item.kind === 'planned'}
            <!--
              Строка плана: тема и неделя, и три действия с ней. «Поставить
              занятие» — главное из них и потому акцентом, как «Опубликовать» у
              занятия: это и есть жизнь такой строки — прошла неделя, комната
              встаёт на её место, нумерация недель не уезжает.
            -->
            <div class="course-name min-w-0 flex-1">
              <p class="text-ui text-ink">{item.name}</p>
              <p class="mt-0.5 text-2xs text-muted">
                {tr("admin.planned")}{item.when ? ` · ${item.when}` : ''}
              </p>
            </div>
            <div class="course-state flex w-[290px] shrink-0 items-baseline gap-3">
              <button
                type="button"
                class="whitespace-nowrap text-ui font-semibold text-accent-text disabled:text-faint"
                disabled={busy}
                aria-expanded={seating?.at === index}
                onclick={() => openSeat(index)}
              >
                {tr('admin.course.seat')}
              </button>
              <button
                type="button"
                class="whitespace-nowrap text-ui font-semibold text-muted hover:text-ink disabled:text-faint"
                disabled={busy}
                onclick={() => void openPlan(index)}
              >
                {tr('admin.course.editPlanned')}
              </button>
              <button
                type="button"
                class="whitespace-nowrap text-ui font-semibold text-muted hover:text-ink disabled:text-faint"
                disabled={busy}
                onclick={() => drop(index)}
              >
                {tr('admin.course.removePlanned')}
              </button>
            </div>
          {:else if item.kind === 'gone'}
            <div class="course-name min-w-0 flex-1">
              <p class="text-ui text-muted">{item.name}</p>
              <p class="mt-0.5 text-2xs text-muted">
                {tr("admin.seminar.deleted.position.in.list.kept")}
              </p>
            </div>
            <div class="course-state flex w-[290px] shrink-0 items-baseline gap-3">
              <!-- «Публиковать нечего» — правда только когда страницы нет.
                   Комнату удалили, а чтение осталось: с курса до него иначе не
                   дойти, хотя курс — единственный адрес, который дают классу. -->
              {#if item.publication}
                <a
                  class="text-ui text-accent-text"
                  href={`/p/${addressOf(item.publication)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {tr("admin.open.saved.publication")}
                </a>
              {:else}
                <span class="text-ui text-muted">{tr("admin.no.publication")}</span>
              {/if}
              <button
                type="button"
                class="text-ui font-semibold text-muted hover:text-ink disabled:text-faint"
                disabled={busy}
                onclick={() => drop(index)}
              >
                {tr("admin.remove.row")}
              </button>
            </div>
          {:else}
            <div class="course-name min-w-0 flex-1">
              <p class="text-ui font-semibold text-ink">{item.name}</p>
              <p class="mt-0.5 font-mono text-2xs text-muted">/s/{item.sessionId}</p>
            </div>
            <div class="course-state flex w-[290px] shrink-0 items-baseline gap-3">
              {#if item.publication}
                <a
                  class="text-ui text-accent-text"
                  href={`/p/${addressOf(item.publication)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {tr("admin.published.203")} {item.publication.steps}
                  {plural(item.publication.steps, tr("admin.step"), tr("admin.steps"), tr("admin.steps.206"))}
                </a>
              {:else}
                <span class="text-ui text-muted">{tr("admin.not.published.yet")}</span>
                <button
                  type="button"
                  class="text-ui font-semibold text-accent-text"
                  onclick={() => navigate(`/admin/publish/${item.sessionId}`)}
                >
                  {tr("admin.publish")}
                </button>
              {/if}
            </div>
          {/if}
          <!-- Пока строка правится, стрелок у неё нет: переставленная правка
               сохранялась бы уже в чужую позицию. -->
          {#if !editing}
            <div class="course-moves flex w-[60px] shrink-0 items-center justify-end gap-1">
              <button
                type="button"
                class={ARROW}
                disabled={index === 0 || busy}
                aria-label={tr("admin.move.up")}
                onclick={() => move(index, -1)}
              >
                <Icon name="chevron-up" size={11} />
              </button>
              <button
                type="button"
                class={ARROW}
                disabled={index === shown.items.length - 1 || busy}
                aria-label={tr("admin.move.down")}
                onclick={() => move(index, 1)}
              >
                <Icon name="chevron-down" size={11} />
              </button>
            </div>
          {/if}
        </div>

        <!-- Выбор занятия — под самой строкой, а не над списком: в плане на
             семестр нужная неделя стоит далеко внизу, и панель наверху
             оказывалась за краем экрана от кнопки, которая её открыла. -->
        {#if seating && seating.at === index}
          {@const place = seating}
          <div class="mb-2.5 ml-[42px] border border-line bg-surface p-3">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 pb-2.5">
              <p class="min-w-0 flex-1 text-2xs leading-snug text-muted">
                {tr('admin.course.seatQuestion', { name: place.was.name })}
              </p>
              <button
                type="button"
                class="shrink-0 text-2xs font-semibold text-muted hover:text-ink"
                onclick={() => (seating = null)}
              >
                {tr('admin.cancel')}
              </button>
            </div>
            {#if addable.length === 0}
              <p class="text-ui text-muted">{tr("admin.no.seminars.available.to.add")}</p>
            {:else}
              <div class="flex flex-wrap gap-2">
                {#each addable as session (session.id)}
                  <button
                    type="button"
                    class="border border-line bg-canvas px-3 py-1.5 text-ui text-ink transition-colors
                           hover:border-faint disabled:text-faint"
                    disabled={busy}
                    onclick={() => void seat(session.id)}
                  >
                    {session.name}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      {/each}

      {#if shown.items.length === 0 && !(plan && !plan.target)}
        <p class="border-t border-line py-8 text-center text-ui text-muted">
          {tr("admin.this.course.has.no.seminars.yet")}
        </p>
      {/if}

      <!--
        Новая тема — внизу списка, там, где она и окажется, и с номером, который
        получит. Кнопка стоит на месте строки, а не в шапке: план набирают подряд,
        и форма остаётся открытой, пока не нажали «Отмена».
      -->
      {#if plan && !plan.target}
        <div class="course-row {ROW}">
          <span class="w-[26px] shrink-0 font-mono text-2xs text-faint">
            {String(shown.items.length + 1).padStart(2, '0')}
          </span>
          {@render planForm(tr('admin.course.addToPlan'))}
        </div>
      {:else}
        <div class="border-t border-line py-2.5 pl-[42px]">
          <button
            type="button"
            class="text-ui font-semibold text-accent-text hover:brightness-110 disabled:text-faint"
            disabled={busy}
            onclick={() => void openPlan(null)}
          >
            {tr('admin.course.addPlanned')}
          </button>
        </div>
      {/if}
      </div>

      <p class="border-t border-line pt-4 text-2xs leading-relaxed text-muted">
        {tr("admin.use.the.arrows.to.reorder.seminars.the.new.order.appears.when.the")}
        {tr('admin.course.planHint')}
      </p>

      <!-- Удаление живёт внутри самого курса и называет ссылку, которую ломает:
           семинары и их страницы остаются, ломается адрес, который классу
           продиктовали в первую неделю. -->
      <div class="mt-8 flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <p class="min-w-0 flex-1 text-2xs text-muted">
          {tr("admin.deleting.the.course.removes.the.seminar.list.its.order.and.the.ad")}
          <span class="font-mono">/c/{addressOf(shown)}</span>{tr("admin.seminars.and.published.pages.will.be.kept")}
        </p>
        <button
          type="button"
          class="shrink-0 text-ui font-semibold text-danger hover:brightness-110"
          onclick={() => (doomed = true)}
        >
          {tr("admin.delete.course")}
        </button>
      </div>
    </div>
  </AdminPage>
{:else}
  <!--
    Курс по этому адресу не открылся. Адрес курса дают классу и им делятся с
    коллегой, так что по устаревшему сюда придут — а раньше здесь была пустая
    область без единого слова и без пути назад.
  -->
  <AdminPage title={tr("admin.course.218")}>
    <div class="px-8 py-16 text-center">
      {#if loadingOne}
        <p class="text-ui text-muted">{tr("admin.opening.course")}</p>
      {:else}
        <p class="text-title font-semibold text-ink">{tr("admin.could.not.open.course")}</p>
        <p class="mx-auto mt-2 max-w-sm text-ui text-muted">
          {error ?? tr("admin.check.the.address.or.return.to.the.course.list")}
        </p>
        <button type="button" class="btn-primary mt-4" onclick={() => navigate('/admin/courses')}>
          {tr("admin.all.courses")}
        </button>
      {/if}
    </div>
  </AdminPage>
{/if}

{#if doomed && course}
  {@const going = course}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="delete-course-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="delete-course-title" class="text-title font-semibold text-ink">
        {tr('admin.course.deleteHeading', { name: going.name })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr("admin.the.link")} <span class="font-mono text-ink">/c/{addressOf(going)}</span> {tr("admin.will.no.longer.open.the.course.the.seminar.list.and.its.order.wil")}
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (doomed = false)}>
          {tr("admin.cancel")}
        </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 disabled:opacity-40"
          disabled={busy}
          onclick={() => void destroy()}
        >
          {busy ? tr("admin.deleting") : tr("admin.delete.course.230")}
        </button>
      </div>
    </div>
  </div>
{/if}

<!--
  Освободить прежний адрес — вопросом, а не нажатием.

  Единственное необратимое здесь, кроме удаления курса: ссылка, записанная в
  чате прошлогодней группы, после этого отвечает 404, и вернуть её нечем.
  Поэтому второй шаг, и цена в нём названа тем самым адресом.
-->
{#if askingSlug && held}
  {@const going = held}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="release-slug-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="release-slug-title" class="text-title font-semibold text-ink">
        {tr('admin.course.releaseHeading', { address: going.slug })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr("admin.it.currently.leads.to.the")}
        {going.holder.kind === 'course' ? tr("admin.course.234") : tr("admin.page.235")}
        {#if going.holder.name}«{going.holder.name}»{/if}{tr("admin.after.transfer.this.link.will.open.the.current.course.instead.of")}
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (askingSlug = false)}>
          {tr("admin.cancel")}
        </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 disabled:opacity-40"
          disabled={busy}
          onclick={() => void releaseSlug()}
        >
          {busy ? tr("admin.transferring") : tr("admin.transfer.address")}
        </button>
      </div>
    </div>
  </div>
{/if}

<!--
  Отпустить своё прежнее имя — тот же вопрос, но никто его имени не ждёт.

  Здесь отпускают не затем, чтобы тут же занять: имя освобождается для всех, и
  единственное, что происходит наверняка, — ссылка с ним перестаёт открываться.
  Поэтому и вопрос другой, и кнопка называется другим глаголом.
-->
{#if dropping}
  {@const going = dropping}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="drop-slug-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="drop-slug-title" class="text-title font-semibold text-ink">
        {tr('admin.course.releaseHeading', { address: going })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr("admin.this.link.will.stop.opening.the.current.course.another.course.may")}
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (dropping = null)}>
          {tr("admin.cancel")}
        </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 disabled:opacity-40"
          disabled={busy}
          onclick={() => void dropFormer()}
        >
          {busy ? tr("admin.releasing") : tr("admin.release.address")}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /*
   * Узкий список: название — своей строкой, публикация и стрелки — под ним.
   *
   * Точка перелома — ширина самого списка (container), а не окна: меню панели
   * на md занимает 236px, и окно в 768 оставляет списку меньше, чем окно в 640
   * с узким меню. 559px — это номер, колонка «Публикация» в 290, стрелки и
   * хоть какое-то место для названия.
   */
  .course-rows {
    container-type: inline-size;
  }

  @container (max-width: 559px) {
    /* Номер — у названия, а не посередине двух строк: по центру он читался
       как номер строки публикации. */
    .course-row {
      flex-wrap: wrap;
      align-items: flex-start;
      row-gap: 0.5rem;
    }

    /* Номер 26px и зазор 16px — название забирает остаток первой строки. */
    .course-name {
      flex-basis: calc(100% - 42px);
    }

    .course-state {
      order: 1;
      flex: 1 1 0%;
      width: auto;
      min-width: 0;
      margin-left: 42px;
      flex-wrap: wrap;
      row-gap: 0.25rem;
    }

    .course-moves {
      order: 2;
    }

    .course-head-state {
      display: none;
    }
  }
</style>
