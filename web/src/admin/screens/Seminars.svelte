<script lang="ts">
  import ContentSkeleton from '@/components/ui/ContentSkeleton.svelte'
  import { tr, getLocale } from '@shared/i18n'
  import { onMount } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { people, ruleRefusal, runningLine } from '@/admin/panel'
  import { seminarLink } from '@/lib/seminar-link'
  import { cn } from '@/lib/utils'
  import {
    LIMITS,
    type AdminEnvironment,
    type AdminSeminar,
    type ImportPreview,
    type InstanceResources,
  } from '@shared/admin'
  import { copyText } from '@/lib/clipboard'
  import { plural } from '@/lib/plural'
  import RoomRulesRows from '@/components/RoomRulesRows.svelte'
  import Resources from '@/admin/ui/Resources.svelte'
  import type { RoomRules } from '@shared/rules'

  /**
   * The seminar list, and the one thing a teacher comes here to do: get the
   * link. It is on every row as a button, it is on the running banner, and it
   * is focused the moment a seminar is created — because the alternative is
   * opening a room to find its address, which is how a class starts late.
   */

  let seminars = $state<AdminSeminar[]>([])
  let loading = $state(true)
  let loadErrorText = $state<(() => string | null) | null>(null)
  const loadError = $derived(loadErrorText?.() ?? null)
  let query = $state('')
  /** Ticks with the poll below so "started 12 min ago" does not freeze at 12. */
  let now = $state(Date.now())

  interface Props {
    /** Hands over to the full New seminar screen; absent keeps the inline row. */
    onfull?: () => void
    /**
     * A seminar made on the other screen, so this one can put the room at the
     * top and the cursor on its Copy button — the same landing the inline form
     * has always given.
     */
    arrived?: string | null
    /**
     * Приземление состоялось — можно забыть про него.
     *
     * Без этого `arrived` живёт до перезагрузки страницы: возврат на вкладку
     * семинаров через месяц снова сбрасывал поиск и подсвечивал ту комнату как
     * только что созданную.
     */
    onarrived?: () => void
    /** Уводит на экран публикации: это решение, а не пункт меню с эффектом. */
    onpublish?: (sessionId: string) => void
  }

  let { onfull, arrived = null, onarrived, onpublish }: Props = $props()

  /**
   * Снять или вернуть публичную страницу.
   *
   * Снятая страница отвечает «преподаватель её снял», а не 404: ссылку у
   * студентов не отозвать, и упереться в ошибку там, где вчера был семинар, —
   * худшее из двух.
   */
  async function withdraw(seminar: AdminSeminar, hide: boolean): Promise<void> {
    try {
      if (hide) await adminApi.withdraw(seminar.id)
      else await adminApi.republish(seminar.id)
      // Перечитываем список: у строки поменялось состояние публикации.
      local(await adminApi.listSeminars())
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      rowError = { id: seminar.id, message: () => (tr("admin.could.not.update.the.publication", { p0: explain(cause) })) }
    }
  }

  /** Адрес, который диктуют вслух: имя, если его дали, иначе идентификатор. */
  const addressOf = (item: { id: string; slug: string | null }): string => item.slug ?? item.id

  async function copyPublished(seminar: AdminSeminar): Promise<void> {
    if (!seminar.publication) return
    const link = `${location.origin}/p/${addressOf(seminar.publication)}`
    try {
      await copyText(link)
    } catch {
      // Как и у ссылки на комнату: буфер закрыт на незащищённом источнике —
      // обычный способ держать инстанс кафедры. Ссылка и есть смысл нажатия,
      // поэтому она уходит на экран, а не в необработанный промис.
      rowError = { id: seminar.id, message: () => (tr("admin.could.not.copy.the.link.copy.it.manually", { p0: link })) }
      return
    }
    if (rowError?.id === seminar.id) rowError = null
    copiedId = seminar.id
    setTimeout(() => (copiedId = copiedId === seminar.id ? null : copiedId), 1600)
  }

  /*
   * Coming back from the New seminar screen. The list is reloaded rather than
   * patched by hand: the two creation paths return different shapes — a blank
   * seminar and an import — and reloading is the one branch that is right for
   * both. Any filter is cleared first, because a filter that hides the room you
   * just made sends the teacher hunting for a seminar they are looking at.
   */
  $effect(() => {
    if (!arrived) return
    query = ''
    justCreatedId = arrived
    void load()
    onarrived?.()
  })

  let creating = $state(false)
  /**
   * Окружения для выпадающего списка. Грузятся один раз и только когда форма
   * открылась: на экране со списком семинаров они не нужны, а запрос ходит в
   * docker и стоит заметно дороже, чем чтение таблицы.
   */
  let environments = $state<AdminEnvironment[] | null>(null)
  let newEnvironment = $state('')

  /*
   * Импорт с GitHub. Материал преподавателя почти никогда не лежит в этом
   * продукте — он лежит в репозитории курса, по ноутбуку на неделю, и рядом
   * лежит csv, который этот ноутбук читает. Просить перенести всё руками —
   * значит просить не пользоваться инструментом.
   *
   * Предпросмотр отдельным шагом нарочно: «сто десять ячеек и train.csv» надо
   * увидеть ДО того, как появится комната, а не после.
   */
  let fromGithub = $state(false)
  let githubUrl = $state('')
  let preview = $state<ImportPreview | null>(null)
  let previewing = $state(false)
  let previewErrorText = $state<(() => string | null) | null>(null)
  const previewError = $derived(previewErrorText?.() ?? null)

  let previewTimer: number | undefined
  $effect(() => {
    const url = githubUrl.trim()
    window.clearTimeout(previewTimer)
    preview = null
    previewErrorText = null
    if (!fromGithub || url.length < 20) return
    // Пауза, а не запрос на каждый символ: ссылку вставляют целиком, но её же
    // и дописывают руками, а каждый запрос уходит наружу к GitHub.
    previewTimer = window.setTimeout(() => {
      previewing = true
      void adminApi
        .previewImport(url)
        .then((p) => {
          preview = p
          if (!newName.trim()) newName = p.name
        })
        .catch((cause) => (previewErrorText = () => (explain(cause))))
        .finally(() => (previewing = false))
    }, 500)
    return () => window.clearTimeout(previewTimer)
  })

  async function importFromGithub(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const url = githubUrl.trim()
    if (!url || createBusy || !preview) return
    createBusy = true
    createErrorText = null
    try {
      const done = await adminApi.importSeminar({
        url,
        name: newName.trim() || undefined,
        environment: newEnvironment || null,
      })
      local(await adminApi.listSeminars())
      query = ''
      justCreatedId = done.id
      creating = false
      fromGithub = false
      githubUrl = ''
      newName = ''
      newEnvironment = ''
      preview = null
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      createErrorText = () => (explain(cause))
    } finally {
      createBusy = false
    }
  }
  let newName = $state('')
  let createBusy = $state(false)
  let createErrorText = $state<(() => string | null) | null>(null)
  const createError = $derived(createErrorText?.() ?? null)
  let nameInput = $state<HTMLInputElement | null>(null)
  let justCreatedId = $state<string | null>(null)

  let copiedId = $state<string | null>(null)
  let copyTimer: number | undefined

  let renamingId = $state<string | null>(null)
  let renameValue = $state('')

  /** At most one row is ever explaining itself; a second failure replaces the first. */
  let rowError = $state<{ id: string; message: () => string } | null>(null)
  let openMenuId = $state<string | null>(null)
  /**
   * Куда поставить открытое меню, в координатах окна.
   *
   * Меню нельзя оставить absolute внутри строки: таблица лежит в контейнере с
   * `overflow-x: auto`, а по спецификации ось, объявленная `visible`, рядом с
   * не-`visible` сама становится `auto`. Измерено в этой панели — контейнер
   * отдаёт `overflowY: "auto"`, хотя в разметке про Y нет ни слова. Из-за этого
   * меню обрезается нижним краем таблицы, а сам список обзаводится собственной
   * полосой прокрутки и на глаз становится ниже.
   *
   * `position: fixed` от прямоугольника кнопки не знает ни о какой обрезке.
   */
  let menuStyle = $state('')

  function openMenu(seminar: AdminSeminar, button: HTMLElement): void {
    if (openMenuId === seminar.id) {
      openMenuId = null
      menuStyle = ''
      return
    }
    const box = button.getBoundingClientRect()
    // right, а не left: меню выравнивается по правому краю кнопки, как и было.
    const right = Math.round(window.innerWidth - box.right)
    const below = window.innerHeight - box.bottom - 8
    const above = box.top - 8
    /*
     * Прикрепляемся к той стороне, где больше места, и ограничиваем высоту ею
     * же. Высоту меню знать не нужно: снизу задаём top, сверху — bottom, и в
     * обоих случаях оно растёт в свободную сторону. Измерено на окне 560px:
     * жёсткое «всегда вниз» уводило меню на 191 пиксель за край экрана, откуда
     * до пункта «удалить» уже не добраться.
     */
    /*
     * transform-origin едет здесь же, а не в классе .row-menu: меню растёт из
     * своей кнопки, а на какой она стороне — уже решено двумя строками выше.
     * Отдельная переменная только повторила бы этот выбор и однажды разошлась
     * бы с ним; при перевороте вниз якорем становится нижний правый угол, и
     * меню разворачивается вверх, а не вниз от невидимой точки.
     */
    menuStyle =
      below >= above
        ? `top: ${Math.round(box.bottom + 4)}px; right: ${right}px; max-height: ${Math.round(below)}px; transform-origin: top right`
        : `bottom: ${Math.round(window.innerHeight - box.top + 4)}px; right: ${right}px; max-height: ${Math.round(above)}px; transform-origin: bottom right`
    openMenuId = seminar.id
  }

  let doomed = $state<AdminSeminar | null>(null)
  let deleteBusy = $state(false)
  let deleteErrorText = $state<(() => string | null) | null>(null)
  const deleteError = $derived(deleteErrorText?.() ?? null)
  let cancelButton = $state<HTMLButtonElement | null>(null)

  const live = $derived(seminars.filter((s) => s.status === 'live'))
  const needle = $derived(query.trim().toLowerCase())
  /**
   * Archived seminars are off the list until asked for.
   *
   * The button says "To take it off the list… archive it" and the list did not
   * take it off anything: a term of archived rooms sat between this week's,
   * and the word meant nothing. They are still reachable — a checkbox away,
   * with a count, because archiving is a label and not a deletion.
   */
  let showArchived = $state(false)
  const archivedCount = $derived(seminars.filter((s) => s.archivedAt).length)
  const shown = $derived(
    seminars
      .filter((s) => showArchived || !s.archivedAt)
      .filter((s) => (needle ? s.name.toLowerCase().includes(needle) : true)),
  )
  const canDelete = $derived(adminAuth.isOwner)
  /** Чей это семинар — сверяется с createdBy, который пишется тем же именем. */
  const me = $derived(adminAuth.me?.teacher ?? null)

  const TABBTN =
    'inline-flex h-7 items-center px-3 text-2xs font-bold uppercase tracking-label text-muted ' +
    'transition-colors duration-100 hover:text-ink focus-visible:outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-accent/50'

  const ITEM = 'flex w-full items-center px-2.5 py-1.5 text-left text-ui transition-colors duration-100'

  /* ----------------------------------------------------------- formatting */

  /**
   * The link this row is about. Not `seminar.url` verbatim: that is built from
   * PUBLIC_URL, and a PUBLIC_URL left on localhost hands the room a link only
   * this machine can open — and costs the teacher their own host seat, because
   * another origin carries neither the staff cookie nor the staff hint. See
   * lib/seminar-link.ts for the rule and what it was measured against.
   */
  const linkOf = (seminar: AdminSeminar): string =>
    seminarLink(seminar.url, location.origin, seminar.id)

  /** `/s/abc` — the half of the URL that is worth reading in a dense row. */
  function pathOf(seminar: AdminSeminar): string {
    return `/s/${seminar.id}`
  }

  function hostPathOf(seminar: AdminSeminar): string {
    try {
      const url = new URL(linkOf(seminar))
      return `${url.host}${url.pathname}`
    } catch {
      return `/s/${seminar.id}`
    }
  }

  function stamp(ts: number): string {
    const date = new Date(ts)
    return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`
  }

  const count = (n: number, noun: string): string => tr(`admin.count.${noun}`, { count: n })

  /**
   * Nobody can act on a dead cookie. Hand it to the shell, which swaps the
   * whole panel for the sign-in screen rather than arguing in a red line.
   *
   * И с причиной: печенье сюда доехало — его отвергли. Без неё экран входа
   * рассказывал про настройки печенья тому, кому ротировали ссылку.
   *
   * Живёт отдельно от `explain()`, потому что зовут это оба перевода отказа —
   * английский для строк таблицы и русский для окна правил, — а смена экрана
   * от языка не зависит.
   */
  function noteDeadCookie(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') {
      void adminAuth.refresh('revoked')
    }
  }

  function explain(cause: unknown): string {
    if (cause instanceof AdminApiError) return cause.message
    return cause instanceof Error ? cause.message : tr("admin.the.server.did.not.respond")
  }

  /* ---------------------------------------------------------------- data */

  /**
   * Список, за который отвечаем мы, а не отставший опрос.
   *
   * Ответ, ушедший до правки, приезжает после неё и возвращает на экран старое
   * имя или архивированную строку — до следующего тика, то есть на двадцать
   * секунд, за которые преподаватель успевает нажать «Архивировать» второй раз.
   * Каждая местная правка двигает счётчик, и ответ, начатый раньше, молча
   * отбрасывается: сервер её уже принял, и показывать вместо неё вчерашнюю
   * правду незачем.
   */
  let generation = 0

  function local(next: AdminSeminar[]): void {
    seminars = next
    generation += 1
  }

  function patch(id: string, fields: Partial<AdminSeminar>): void {
    local(seminars.map((s) => (s.id === id ? { ...s, ...fields } : s)))
  }

  function replace(updated: AdminSeminar): void {
    local(seminars.map((s) => (s.id === updated.id ? updated : s)))
  }

  /*
   * The sidebar's "Seminars 5" is the length of this list, so it is mirrored
   * from here rather than fetched twice — otherwise the count keeps standing at
   * the number it had before the row you just deleted.
   */
  $effect(() => {
    if (!loading) navCounts.seminars = seminars.length
  })

  async function load(silent = false): Promise<void> {
    if (!silent) loading = true
    const started = generation
    try {
      const list = await adminApi.listSeminars()
      // Пока ответ ехал, на экране что-то изменили. Их правка новее.
      if (started !== generation) return
      seminars = list
      loadErrorText = null
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      // A poll that fails leaves the list it already has: the screen was right a
      // minute ago, and a banner over live data is worse than data a minute old.
      if (!silent) loadErrorText = () => (explain(cause))
    } finally {
      if (!silent) loading = false
    }
  }

  onMount(() => {
    void load()

    // "8 in the room" is a claim about this second, so it is re-asked. A hidden
    // tab is not looking at the claim and does not need to spend the request.
    const tick = window.setInterval(() => {
      now = Date.now()
      if (document.visibilityState === 'visible') void load(true)
    }, 20_000)

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (doomed) {
        if (!deleteBusy) doomed = null
        return
      }
      openMenuId = null
      menuStyle = ''
    }
    const onClick = () => {
      openMenuId = null
      menuStyle = ''
    }
    // Меню стоит в координатах окна, поэтому при прокрутке оно уехало бы от
    // своей кнопки. Закрыть — честнее, чем тащить его следом: прокрутка это и
    // есть «я передумал».
    //
    // Кроме прокрутки внутри самого меню: в коротком окне оно обрезано по
    // свободному месту, и колёсико над ним — единственный способ дойти до
    // «Delete…». Слушатель стоит в фазе захвата, поэтому такие события сюда
    // тоже приходят, и первый же тик закрывал меню, до которого только что
    // добрались.
    const onScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest('[role=menu]')) return
      openMenuId = null
      menuStyle = ''
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('click', onClick)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.clearInterval(tick)
      window.clearTimeout(copyTimer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('click', onClick)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  })

  /* -------------------------------------------------------------- create */

  function startCreate(): void {
    /*
     * The inline row stays for the seminar you make in a hurry between two
     * classes. Anything that needs a decision — the room's rules, the oracle,
     * a notebook off GitHub — has a screen of its own, and this hands over to
     * it rather than growing a form inside a table cell.
     */
    if (onfull) {
      onfull()
      return
    }
    creating = true
    if (environments === null) {
      void adminApi
        .listEnvironments()
        .then((r) => {
          environments = r.environments
          /*
           * Предвыбираем то, что стоит умолчанием на инстансе. Пустого варианта
           * «как на инстансе» здесь нет намеренно: он был третьим состоянием и
           * противоречил обещанию, что окружение комнаты выбирается один раз и
           * дальше под ней не меняется. Незаполненный список — это просто
           * пустое поле, из которого непонятно, что получит семинар.
           */
          if (!newEnvironment) newEnvironment = r.environments.find((e) => e.active)?.name ?? ''
        })
        // Не беда: без списка форма просто не покажет выбор, и семинар
        // получит окружение по умолчанию — то же, что было всегда.
        .catch(() => (environments = []))
    }
    createErrorText = null
  }

  function cancelCreate(): void {
    creating = false
    newName = ''
    createErrorText = null
  }

  // The field lands a paint after the row does, so focus follows the element.
  $effect(() => {
    if (creating) nameInput?.focus()
  })

  /**
   * Строка, на Copy которой курсор уже ставили. Не $state: это память эффекта о
   * самом себе, и перерисовывать из-за неё нечего.
   */
  let focused: string | null = null

  /**
   * The row exists before this runs, so the button is really there. Queried
   * rather than bound: the binding would have to live on one row out of many,
   * and every row would carry the branch for the one that was just made.
   */
  $effect(() => {
    const id = justCreatedId
    /*
     * `seminars` is read on purpose, not by accident. A seminar made on the
     * other screen sets this id and then reloads the list, so at the moment
     * the id changes the row does not exist yet, the query finds nothing, and
     * the cursor is left on the body — the teacher then goes hunting for the
     * link this was meant to hand them. Depending on the list as well runs
     * this again once the rows land.
     */
    void seminars.length
    if (!id || id === focused) return
    const button = document.querySelector<HTMLButtonElement>(`[data-copy="${id}"]`)
    if (!button) return
    /*
     * И ровно один раз. Опрос списка присваивает `seminars` каждые двадцать
     * секунд, а `justCreatedId` не гаснет — фокус возвращался на Copy снова и
     * снова: из поля поиска, из открытого переименования, которое коммитится по
     * blur и уносило в шапку всем в комнате полслова. Отмечаем строку только
     * когда кнопка нашлась: до этого приземляться некуда.
     */
    focused = id
    button.focus()
  })

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const name = newName.trim()
    if (!name || createBusy) return

    createBusy = true
    createErrorText = null
    try {
      const seminar = await adminApi.createSeminar({ name, environment: newEnvironment || null })
      // A filter that hides the row you just made would send the teacher
      // hunting for a seminar they are looking straight at.
      query = ''
      local([seminar, ...seminars.filter((s) => s.id !== seminar.id)])
      justCreatedId = seminar.id
      creating = false
      newName = ''
      newEnvironment = ''
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      createErrorText = () => (explain(cause))
    } finally {
      createBusy = false
    }
  }

  /* ---------------------------------------------------------------- link */

  async function copy(seminar: AdminSeminar): Promise<void> {
    try {
      await copyText(linkOf(seminar))
    } catch {
      // Blocked on an insecure origin, which is a normal way to self-host. The
      // link is the point of the click, so it goes on screen instead.
      rowError = { id: seminar.id, message: () => (tr("admin.could.not.copy.the.link.copy.it.manually", { p0: linkOf(seminar) })) }
      return
    }
    if (rowError?.id === seminar.id) rowError = null
    copiedId = seminar.id
    window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => (copiedId = null), 1600)
  }

  /* -------------------------------------------------------------- rename */

  function startRename(seminar: AdminSeminar): void {
    renamingId = seminar.id
    renameValue = seminar.name
    rowError = null
  }

  /**
   * Чужая комната, и в ней прямо сейчас люди.
   *
   * Один вопрос на три места: переименование, звонок и диалог правил меняют
   * для одной и той же чужой аудитории то, что видно ей мгновенно. Спрашиваем
   * только когда сходятся оба условия — правку своей опечатки это не трогает.
   */
  function othersLive(seminar: AdminSeminar): boolean {
    const mine = !seminar.createdBy || seminar.createdBy === me?.name
    return !mine && seminar.liveCount > 0
  }

  /** «There are 12 people in “ML week 3” right now, and Мария set it up». */
  function crowdIn(seminar: AdminSeminar): string {
    const crowd = seminar.liveCount === 1 ? tr("admin.is.1.person") : tr("admin.are.people", { p0: seminar.liveCount })
    return tr("admin.there.in.right.now.and.set.it.up", { p0: crowd, p1: seminar.name, p2: seminar.createdBy ?? tr("admin.unknown.teacher") })
  }

  async function commitRename(seminar: AdminSeminar): Promise<void> {
    const name = renameValue.trim()
    renamingId = null
    if (!name || name === seminar.name) return

    /*
     * Чужую живую комнату не трогают молча.
     *
     * Имя семинара стоит в шапке у всех, кто сейчас внутри, и меняется у них
     * мгновенно: посреди пары заголовок над тетрадью вдруг становится другим.
     * Для своей комнаты это ожидаемо — ты и переименовываешь. Для чужой, где
     * идёт занятие, стоит спросить.
     */
    if (othersLive(seminar)) {
      const ok = window.confirm(
        (tr("admin.the.new.name.appears.in.their.header.immediately", { p0: crowdIn(seminar) }) + " ") +
          tr("admin.rename.it.to", { p0: name }),
      )
      if (!ok) return
    }

    // Safe to paint: a name is one string, and putting the old one back costs
    // the teacher nothing but the correction they were going to make anyway.
    const before = seminar.name
    patch(seminar.id, { name })
    try {
      replace(await adminApi.updateSeminar(seminar.id, { name }))
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      patch(seminar.id, { name: before })
      rowError = { id: seminar.id, message: () => (tr("admin.could.not.rename.the.seminar", { p0: explain(cause) })) }
    }
  }

  /* --------------------------------------------------------------- rules */

  /**
   * Правила существующего семинара.
   *
   * Раньше они задавались один раз, при создании: `updateSeminar` звали только с
   * `{name}` или `{archived}`, и преподаватель, решивший закрыть тетрадь в
   * прошлонедельной комнате, не мог ничего — только завести вторую.
   *
   * Один переключатель — один запрос, как и в самой комнате: маршрут
   * накладывает присланное на текущее и сам рассылает `{t:'rules'}`, так что
   * открытая комната узнаёт сразу.
   */
  let ruling = $state<AdminSeminar | null>(null)
  let rulesBusy = $state(false)
  /**
   * Отказ — в самом диалоге, а не в строке таблицы под затемнением.
   *
   * Переключатель не красится наперёд, так что при отказе на экране не меняется
   * ничего: истёкшее печенье выглядело как «щелчок не сработал», и щёлкали ещё
   * и ещё, а сообщение ждало в строке, закрытой веялью.
   */
  let rulesErrorText = $state<(() => string | null) | null>(null)
  const rulesError = $derived(rulesErrorText?.() ?? null)

  /* ------------------------------------------------------------- ресурсы */

  /**
   * Чем располагает машина — то же чтение, что и в форме нового занятия.
   *
   * Спрашивается при открытии окна настроек, а не при загрузке списка: список
   * открывают на каждой смене вкладки, а свободная память нужна ровно тому,
   * кто пришёл её менять.
   */
  let resources = $state<InstanceResources | null>(null)
  /**
   * Ответ ещё в пути.
   *
   * Окно настроек открывают с чистого листа каждый раз, и первые кадры в нём —
   * это кадры без чисел: `null` тут значил и «ещё не знаем», и «спросили и не
   * узнали», а раздел на оба случая показывал пустое включённое поле памяти.
   * Пока флаг поднят, на месте полей стоят заглушки их размера.
   */
  let resourcesLoading = $state(true)
  let memoryBusy = $state(false)
  let memoryErrorText = $state<(() => string | null) | null>(null)
  const memoryError = $derived(memoryErrorText?.() ?? null)

  function readResources(): void {
    // Флаг поднимается только на ПЕРВОМ чтении: перечитывание после
    // сохранения идёт под уже нарисованными числами, и подменять их заглушками
    // значило бы мигать разделом на каждое изменение памяти.
    resourcesLoading = resources === null
    void adminApi
      .resources()
      .then((r: InstanceResources) => (resources = r))
      .catch(() => (resources = null))
      .finally(() => (resourcesLoading = false))
  }

  /**
   * Поменять память комнате — и она поменяется прямо сейчас.
   *
   * Сервер применяет число к живому контейнеру через `docker update`, без
   * перезапуска ядра: преподаватель, чьё ядро только что убили по памяти,
   * добавляет гигабайты и запускает ту же ячейку заново, не потеряв ни
   * переменных семинара, ни открытого терминала. Здесь поэтому нет ни
   * подтверждения, ни предупреждения о потере состояния — терять нечего.
   */
  async function setMemory(seminar: AdminSeminar, mb: number | null): Promise<void> {
    memoryBusy = true
    memoryErrorText = null
    try {
      const updated = await adminApi.updateSeminar(seminar.id, { memoryMb: mb })
      replace(updated)
      ruling = updated
      // Полоска «сколько машины занято» после этого другая: свободная память
      // изменилась ровно на то, что комната только что взяла или отдала.
      readResources()
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      memoryErrorText = () =>
        cause instanceof AdminApiError ? cause.message : tr('admin.resources.notSaved')
    } finally {
      memoryBusy = false
    }
  }

  /**
   * Ядра — той же дверью и тем же окном, что и память.
   *
   * Оговорка про потоки живёт в подсказке под полем, а не здесь: сервер
   * применяет число к контейнеру сразу, а numpy с торчем внутри уже
   * запущенного ядра считают прежним их числом до перезапуска.
   */
  async function setCpus(seminar: AdminSeminar, cores: number | null): Promise<void> {
    memoryBusy = true
    memoryErrorText = null
    try {
      const updated = await adminApi.updateSeminar(seminar.id, { cpus: cores })
      replace(updated)
      ruling = updated
      readResources()
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      memoryErrorText = () =>
        cause instanceof AdminApiError ? cause.message : tr('admin.resources.notSaved')
    } finally {
      memoryBusy = false
    }
  }

  async function setRule(seminar: AdminSeminar, patchRules: Partial<RoomRules>): Promise<void> {
    rulesBusy = true
    rulesErrorText = null
    try {
      const updated = await adminApi.updateSeminar(seminar.id, { rules: patchRules })
      replace(updated)
      ruling = updated
    } catch (cause: unknown) {
      /*
       * Причина — на языке инстанса и без непереведённого хвоста сервера.
       *
       * Здесь стоял общий `explain()`, а он английский на всю панель: в русском
       * подвале этого окна выходило «Правило не сохранилось — The server did
       * not respond» — половина фразы на языке, которого в окне больше нигде
       * нет (admin-17). Слова — в panel.ts, одним списком и без браузера;
       * отвергнутое печенье при этом по-прежнему уводит на экран входа.
       */
      noteDeadCookie(cause)
      rulesErrorText = () => (ruleRefusal(cause instanceof AdminApiError ? cause : null))
    } finally {
      rulesBusy = false
    }
  }

  /**
   * Закончить занятие — и открыть его обратно.
   *
   * Та же дверь, что кнопка в самой комнате: преподаватель, закрывший вкладку и
   * вспомнивший про это в метро, не должен возвращаться в неё ради одного
   * нажатия. Правила при этом не переписываются — сервер накладывает конец
   * занятия поверх них и отступает, не тронув настройку, — поэтому обратное
   * движение здесь же и стоит ровно одного нажатия.
   *
   * Красится наперёд, как «Архивировать»: это одно поле, и вернуть его на место
   * стоит того же нажатия, которое человек и собирался сделать.
   */
  async function finish(seminar: AdminSeminar, finished: boolean): Promise<void> {
    /*
     * И звонок — тем более.
     *
     * Переименование чужой живой комнаты спрашивает, а конец занятия — один
     * клик в том же меню, соседний с ним, — не спрашивал ничего, хотя меняет
     * для тех же людей несравнимо больше: правила становятся преподавательскими
     * у всех сразу, класс посреди пары теряет правку и запуск.
     */
    if (othersLive(seminar)) {
      const ok = window.confirm(
        finished
          ? (tr("admin.ending.the.class.disables.editing.and.running.for.students", { p0: crowdIn(seminar) }) + " ") +
            tr("admin.end.the.class.1110")
          : (tr("admin.reopening.the.class.restores.its.configured.access.rules", { p0: crowdIn(seminar) }) + " ") +
            tr("admin.reopen.the.class.1112"),
      )
      if (!ok) return
    }
    const before = seminar.finishedAt
    // Прошлый отказ этой строки — про прошлое нажатие. Оставить его под
    // перекрашенной пометкой значит показать рядом две противоположные правды.
    if (rowError?.id === seminar.id) rowError = null
    patch(seminar.id, { finishedAt: finished ? Date.now() : null })
    try {
      replace(await adminApi.updateSeminar(seminar.id, { finished }))
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      patch(seminar.id, { finishedAt: before })
      rowError = {
        id: seminar.id,
        message: () => (finished
          ? tr("admin.could.not.end.the.class", { p0: explain(cause) })
          : tr("admin.could.not.reopen.the.class", { p0: explain(cause) })),
      }
    }
  }

  async function archive(seminar: AdminSeminar, archived: boolean): Promise<void> {
    const before = seminar.archivedAt
    patch(seminar.id, { archivedAt: archived ? Date.now() : null })
    try {
      replace(await adminApi.updateSeminar(seminar.id, { archived }))
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      patch(seminar.id, { archivedAt: before })
      rowError = { id: seminar.id, message: () => (tr("admin.could.not.change.the.archive.status", { p0: explain(cause) })) }
    }
  }

  /* -------------------------------------------------------------- delete */

  /**
   * Судьба публичной страницы, если она у комнаты есть.
   *
   * Умолчание сервера — оставить: розданную классу ссылку не отозвать, и 404
   * там, где вчера был семинар, хуже страницы без комнаты. Но вопрос сервер
   * объявляет отдельным, а панель его никогда не задавала — и «удалить, чтобы
   * убрать выложенное», ровно тот случай, ради которого сюда и приходят,
   * оставлял копию тетради открытой всем. Снять её потом можно на вкладке
   * курсов, в списке страниц без комнаты.
   */
  let dropReading = $state(false)

  function confirmDelete(seminar: AdminSeminar): void {
    doomed = seminar
    deleteErrorText = null
    dropReading = false
  }

  $effect(() => {
    // Focus lands on the way out, never on the button that destroys the room.
    if (doomed) cancelButton?.focus()
  })

  async function destroy(): Promise<void> {
    const target = doomed
    if (!target || deleteBusy) return

    deleteBusy = true
    deleteErrorText = null
    try {
      await adminApi.deleteSeminar(target.id, dropReading)
      local(seminars.filter((s) => s.id !== target.id))
      doomed = null
    } catch (cause: unknown) {
      noteDeadCookie(cause)
      // Already gone: the list is the thing that is wrong, so correct the list
      // rather than asking the owner to delete something that does not exist.
      if (cause instanceof AdminApiError && cause.status === 404) {
        local(seminars.filter((s) => s.id !== target.id))
        doomed = null
      } else {
        deleteErrorText = () => (explain(cause))
      }
    } finally {
      deleteBusy = false
    }
  }
</script>

<AdminPage title={tr("admin.seminars")}>
  {#snippet actions()}
    <!--
      An empty instance gets one path, not three. The search has nothing to
      search and the button in the corner duplicates the one in the middle of
      the page, which is where the eye already is.
    -->
    {#if seminars.length > 0}
    <!--
      Шапка на телефоне — столбик во всю ширину.

      220px поиска и кнопка рядом с ним укладываются в строку, которой на
      390px-экране нет: рельс забирает 56, поля страницы ещё 56, и на всё про
      всё остаётся 278. Поиск и «Новое занятие» вставали друг под друга и так,
      но каждый шириной по содержимому — два коротких огрызка у левого края.
      Высота там же вырастает до 44px: 34 — это размер для мыши, а сюда тычут
      пальцем.
    -->
    <div
      class="flex h-[34px] w-[220px] max-w-full items-center gap-2 border border-line bg-canvas px-3
             focus-within:border-accent max-[640px]:h-11 max-[640px]:w-full"
    >
      <Icon name="search" size={13} class="shrink-0 text-faint" />
      <input
        type="search"
        bind:value={query}
        placeholder={tr("admin.search.seminars")}
        aria-label={tr("admin.search.seminars.by.name")}
        class="min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-faint"
      />
    </div>
    {#if archivedCount}
      <label
        class="flex h-[34px] cursor-pointer select-none items-center gap-2 border border-line
               bg-canvas px-3 text-2xs font-bold uppercase tracking-caps text-muted
               hover:text-ink max-[640px]:h-11 max-[640px]:w-full"
        title="{seminars.length - archivedCount} {tr("admin.active")} {archivedCount} {tr("admin.archived")}"
      >
        <input type="checkbox" bind:checked={showArchived} class="accent-accent" />
        {tr("admin.archived.903")}
        <span class="tabular-nums text-faint">{archivedCount}</span>
      </label>
    {/if}
    <button
      type="button"
      onclick={startCreate}
      class="btn-primary h-[34px] gap-2 px-3.5 text-2xs font-bold uppercase tracking-caps
             max-[640px]:h-11 max-[640px]:w-full"
    >
      <Icon name="plus" size={14} />
      {tr("admin.new.seminar")}
    </button>
    {/if}
  {/snippet}

  <!-- Nothing live, no banner. An empty "running now" is a lie with a border. -->
  {#each live as seminar (seminar.id)}
    <!--
      Wrapping, and a floor under the name lane. The plate is three things in a
      row and the row ran out at 860px: RUNNING NOW broke across two lines into
      the sentence beside it, and the seminar name was squeezed past its own
      ellipsis. Three items that wrap onto a second line say the same thing at
      any width; a fixed 74px height is what turned the overflow into an
      overlap, so it is a floor now rather than a lid.
    -->
    <!--
      И столбик на телефоне.

      Ряд из трёх частей умеет переноситься, но не умеет ужиматься: группа
      кнопок справа стоит `shrink-0`, внутри неё моноширинный адрес во всю
      длину хоста, и на 390px она уезжала за правый край — «Открыть» было видно
      наполовину, а нажать его было нечем. Измерено на стенде: группа занимала
      84…430px при экране в 390. Ниже 640 ряд становится столбиком, каждая
      часть — во всю ширину, а адрес ужимается до `/s/…`, потому что хост здесь
      и так известен: панель открыта на нём.

      Отрицательные поля остаются `-mx-7` при любой ширине — ровно потому, что
      поля страницы (AdminPage · px-7) тоже одни на все ширины. Разъехавшись,
      эти два числа дают плашку, вылезающую за край на телефоне и не достающую
      до него на столе.
    -->
    <section
      class="-mx-7 flex min-h-[74px] flex-wrap items-center gap-x-[22px] gap-y-3 border-b
             border-b-line border-l-[3px] border-l-accent bg-raised py-3 pl-[25px] pr-7
             max-[640px]:min-h-0 max-[640px]:flex-col max-[640px]:flex-nowrap
             max-[640px]:items-stretch max-[640px]:gap-y-2.5 max-[640px]:py-3.5"
    >
      <div class="flex min-w-[180px] flex-col gap-[3px] max-[640px]:min-w-0">
        <p
          class="flex items-center gap-[7px] whitespace-nowrap text-2xs font-bold uppercase
                 tracking-label text-accent-text"
        >
          <span class="h-[7px] w-[7px] shrink-0 rounded-full bg-accent"></span>
          {tr("admin.running.now")}
        </p>
        <!-- Две строки с обрезкой, а не одна: на телефоне в одну строку
             помещается треть названия семинара, и «Машинное обучение и анализ
             данн…» не отличить от такого же соседнего. -->
        <h2
          class="truncate text-title font-bold tracking-tight text-ink
                 max-[640px]:line-clamp-2 max-[640px]:whitespace-normal"
        >
          {seminar.name}
        </h2>
      </div>

      <!--
        The artboard stacks the faces of the room here. AdminSeminar carries a
        head-count and nothing else, so there is nobody to draw: blank discs
        read as avatars that failed to load, and the roster endpoint answers
        with everyone who ever joined, which is a different set from the one
        this line is counting. The sentence is the honest version of the stack
        until the contract carries the people — see AvatarStack.
      -->
      <!--
        Двое часов, и называются они разными словами (admin/panel.ts ·
        runningLine): «started» — только когда сервер сказал, с какого момента
        в комнате кто-то есть. Комнату заводят за неделю до пары, и «started 6
        days ago» под надписью «Running now» было неправдой в самом заметном
        месте панели.
      -->
      <p
        class="shrink-0 text-ui text-muted"
        title="{tr("admin.created.906")} {new Date(seminar.createdAt).toLocaleString(getLocale())}"
      >
        {runningLine(seminar, now)}
      </p>

      <!-- `ml-0` в столбике обязателен: `margin-left: auto` на элементе
           колоночного flex'а отменяет растяжение и прижимает ряд к правому
           краю — ровно то, чего здесь быть не должно. -->
      <div class="ml-auto flex shrink-0 items-center gap-2.5 max-[640px]:ml-0 max-[640px]:gap-2">
        <button
          type="button"
          onclick={() => copy(seminar)}
          title="{tr("admin.copy")}  {linkOf(seminar)}"
          class={cn(
            'flex h-8 items-center gap-2 border border-line bg-canvas px-3 font-mono text-code',
            'transition-colors duration-100 hover:border-faint hover:text-ink',
            // Палец, а не курсор: 44px высоты и вся оставшаяся ширина строки.
            'max-[640px]:h-11 max-[640px]:min-w-0 max-[640px]:flex-1 max-[640px]:justify-between',
            copiedId === seminar.id ? 'text-positive' : 'text-muted',
          )}
        >
          <span class="max-[640px]:hidden">{hostPathOf(seminar)}</span>
          <span class="hidden max-[640px]:block max-[640px]:truncate">{pathOf(seminar)}</span>
          <Icon name={copiedId === seminar.id ? 'check' : 'copy'} size={13} class="shrink-0" />
        </button>
        <a
          href={linkOf(seminar)}
          target="_blank"
          rel="noreferrer"
          class="btn h-8 bg-accent px-3.5 text-2xs font-bold uppercase tracking-caps text-accent-ink
                 hover:brightness-110 max-[640px]:h-11 max-[640px]:shrink-0 max-[640px]:px-4"
        >
          {tr("admin.open")}
        </a>
      </div>
    </section>
  {/each}

  {#if loadError}
    <div class="mt-6 border border-danger/40 bg-surface px-4 py-3">
      <p class="text-ui text-danger">{tr("admin.could.not.load.seminars")} {loadError}</p>
      <button type="button" class="btn-outline mt-2.5" onclick={() => void load()}>{tr("admin.try.again")}</button>
    </div>
  {/if}

  <!-- Flush against the header, as on the artboard: the rule under the topbar
       is the table's own top rule, and a gap there reads as a missing row. -->
  <!--
    The columns after the name are fixed and add up to 466px, and table-fixed
    hands the name whatever is left: at 800px of window that was 42px and at
    768px it was 10px, so the names vanished and the headings printed on top of
    each other. The min-width is those 466px plus a lane a name can be read in.
    It is set where the lane actually dies rather than where it starts to
    tighten — every window that works today still gets no scrollbar — and it
    scrolls inside this box, so the page itself still never moves sideways.
  -->
  <!--
    Ниже 640 таблицы нет — есть карточки-строки.

    Шесть колонок держат 600px минимума и уезжают вбок в собственной прокрутке:
    на 390px за краем оставались «Дата», «Входили», «Статус» и — самое дорогое —
    кнопка действий, до которой надо было догадаться доскроллить вбок коробку,
    которая ничем не показывает, что она скроллится.

    Карточки сделаны не второй разметкой, а разблокировкой этой же: `table`,
    `tbody` и `tr` становятся блоками и flex'ом, `thead` уходит, ячейки
    раскладываются `order`'ом — название и меню в первую строку, окружение,
    дата, входили и состояние во вторую. Вторая разметка означала бы два списка
    действий, и однажды один из них отстал бы от другого — а в меню строки
    лежит «Удалить».
  -->
  <div class="-mx-1 overflow-x-auto px-1">
  <table class="w-full min-w-[600px] table-fixed max-[640px]:block max-[640px]:min-w-0">
    <colgroup class="max-[640px]:hidden">
      <col />
      <col class="w-[132px]" />
      <col class="w-[104px]" />
      <col class="w-[74px]" />
      <col class="w-[116px]" />
      <col class="w-10" />
    </colgroup>
    <thead class={cn('max-[640px]:hidden', shown.length === 0 && !creating && 'sr-only')}>
      <tr class="border-b border-line text-micro font-bold uppercase tracking-label text-muted">
        <th scope="col" class="py-3 text-left">{tr("admin.seminar")}</th>
        <!--
          The environment this room's kernel is ACTUALLY on, which is not always
          the one configured: a seminar that was live through a switch keeps the
          image it came up on until its own kernel restarts. That gap is the
          only reason this column is worth a lane of its own.
        -->
        <th scope="col" class="py-3 text-left">{tr("admin.environment.919")}</th>
        <th scope="col" class="py-3 text-left">{tr("admin.date")}</th>
        <!--
          "Joined", not "People". This column is everyone who ever joined; the
          banner above it counts who is connected right now. Both were labelled
          people, so the same view could read "2 people in the room" beside an
          11 and give the reader no way to tell which number was wrong.
        -->
        <th scope="col" class="py-3 text-right">{tr("admin.joined")}</th>
        <th scope="col" class="py-3 text-right">{tr("admin.status")}</th>
        <th scope="col" class="py-3"><span class="sr-only">{tr("admin.actions")}</span></th>
      </tr>
    </thead>
    <tbody class="max-[640px]:block">
      {#if creating}
        <tr class="border-b border-line-soft bg-surface max-[640px]:block">
          <td colspan="6" class="py-3 max-[640px]:block">
            <!-- Две двери в одну комнату: пустой семинар и семинар из готового
                 материала. Переключатель, а не вторая кнопка в шапке: это одно
                 действие «создать», у которого два источника. -->
            <div class="mb-2.5 flex items-center gap-1">
              <button
                type="button"
                class={cn(TABBTN, !fromGithub && 'bg-raised text-ink')}
                onclick={() => ((fromGithub = false), (preview = null))}
              >
                {tr("admin.blank")}
              </button>
              <button
                type="button"
                class={cn(TABBTN, fromGithub && 'bg-raised text-ink')}
                onclick={() => (fromGithub = true)}
              >
                {tr("admin.from.github")}
              </button>
            </div>

            {#if fromGithub}
              <form class="flex flex-col gap-2.5" onsubmit={importFromGithub}>
                <div class="flex flex-wrap items-center gap-2">
                  <input
                    bind:value={githubUrl}
                    class="field min-w-[420px] flex-1 font-mono text-code-lg
                           max-[640px]:w-full max-[640px]:min-w-0"
                    placeholder="https://github.com/sleep3r/ml_hse/tree/main/week02"
                    autocomplete="off"
                    spellcheck="false"
                    aria-label={tr("admin.github.link.to.a.notebook.or.a.folder")}
                  />
                  <button
                    class="btn-primary"
                    type="submit"
                    disabled={!preview || createBusy}
                  >
                    {#if createBusy}
                      <Icon name="spinner" size={15} class="animate-spin" />
                      {tr("admin.importing")}
                    {:else}
                      {tr("admin.import")}
                    {/if}
                  </button>
                  <button class="btn-ghost" type="button" onclick={cancelCreate}>{tr("admin.cancel")}</button>
                </div>

                <!--
                  Имя и окружение стоят ЗДЕСЬ, а не внутри предпросмотра: они
                  относятся к создаваемой комнате, а не к прочитанной ссылке.
                  Спрятанные за предпросмотром, они появлялись только после
                  удачного чтения репозитория — и выглядели так, будто выбора
                  окружения при импорте нет вовсе.
                -->
                <div class="flex flex-wrap items-center gap-2">
                  <input
                    bind:value={newName}
                    class="field max-w-[380px]"
                    placeholder={tr("admin.name.filled.in.from.the.link")}
                    maxlength={LIMITS.seminarName}
                    autocomplete="off"
                    aria-label={tr("admin.seminar.name")}
                  />
                  {#if environments && environments.length > 1}
                    <select
                      bind:value={newEnvironment}
                      class="field h-[38px] max-w-[240px] font-mono text-code-lg"
                      aria-label={tr("admin.python.environment")}
                    >
                      {#each environments as env (env.name)}
                        <option value={env.name} disabled={env.state !== 'ready'}>
                          {env.name}{env.active ? (" " + tr("admin.default.937")) : ''}{env.state === 'ready'
                            ? ''
                            : (" " + tr("admin.not.built.939"))}
                        </option>
                      {/each}
                    </select>
                  {/if}
                </div>

                {#if previewing}
                  <p class="text-2xs text-muted">{tr("admin.reading.the.repository")}</p>
                {:else if previewError}
                  <p class="text-2xs text-danger">{previewError}</p>
                {:else if preview}
                  <!-- Что именно приедет. Показано до создания, а не после. -->
                  <div class="flex flex-wrap items-center gap-2 text-2xs text-muted">
                    <span class="font-mono text-ink">{preview.notebook}</span>
                    <span>·</span>
                    <span>{preview.cells} {tr("admin.cells")}</span>
                    {#if preview.files.length > 0}
                      <span>·</span>
                      {#each preview.files as f (f.name)}
                        <span class="bg-surface px-2 py-0.5 font-mono text-micro">{f.name}</span>
                      {/each}
                    {/if}
                    <span>·</span>
                    <span class="font-mono">{preview.source}</span>
                    <span>·</span>
                    <span>{tr("admin.outputs.not.imported")}</span>
                  </div>
                  <!--
                    И то, что не приедет. Отдельной строкой, а не ещё одной
                    плашкой в общем ряду: перечисленные рядом с привезёнными,
                    эти имена читались бы как «тоже едут». Сумма ограничена так
                    же, как у загрузки через панель (server/src/routes/admin-import.ts
                    · withinRoomBudget), и узнать об остатке после импорта поздно
                    — файлы к тому моменту уже не приехали в созданную комнату.
                  -->
                  {#if preview.skipped.length > 0}
                    <div class="flex flex-wrap items-center gap-2 text-2xs text-warning">
                      <span>
                        {tr("admin.count.skippedFiles", { count: preview.skipped.length })}
                      </span>
                      {#each preview.skipped as name (name)}
                        <span
                          class="bg-surface px-2 py-0.5 font-mono text-micro text-muted line-through"
                        >
                          {name}
                        </span>
                      {/each}
                    </div>
                  {/if}
                {/if}
              </form>
            {:else}
            <form class="flex flex-wrap items-center gap-2" onsubmit={create}>
              <input
                bind:this={nameInput}
                bind:value={newName}
                class="field max-w-[380px]"
                placeholder={tr("admin.computer.vision.seminar.25.08")}
                maxlength={LIMITS.seminarName}
                autocomplete="off"
                aria-label={tr("admin.name.of.the.new.seminar")}
              />

              <!--
                Окружение выбирается ОДИН раз, здесь. Дальше это Python этой
                комнаты навсегда: семинар, у которого пакеты поменялись посреди
                пары, хуже семинара без самых новых пакетов.
              -->
              {#if environments && environments.length > 1}
                <select
                  bind:value={newEnvironment}
                  class="field h-[38px] max-w-[220px] font-mono text-code-lg"
                  aria-label={tr("admin.python.environment.for.the.new.seminar")}
                >
                                    {#each environments as env (env.name)}
                    <option value={env.name} disabled={env.state !== 'ready'}>
                      {env.name}{env.active ? ' — default' : ''}{env.state === 'ready' ? '' : ' — not built'}
                    </option>
                  {/each}
                </select>
              {/if}

              <button class="btn-primary" type="submit" disabled={!newName.trim() || createBusy}>
                {#if createBusy}
                  <Icon name="spinner" size={15} class="animate-spin" />
                  {tr("admin.creating")}
                {:else}
                  {tr("admin.create")}
                {/if}
              </button>
              <button class="btn-ghost" type="button" onclick={cancelCreate}>{tr("admin.cancel")}</button>
            </form>
            {/if}
            {#if createError}
              <p class="mt-2 text-ui text-danger">{createError}</p>
            {/if}
          </td>
        </tr>
      {/if}

      {#each shown as seminar (seminar.id)}
        {@const fresh = seminar.id === justCreatedId}
        <!--
          Ниже 640 строка — карточка: `order` собирает её в две строки, а
          `basis` первой из них раздаёт ровно 100% (название + 44px под меню),
          чтобы остальные ячейки перенеслись, а не ужались до буквы.
        -->
        <tr
          class={cn(
            'group border-b border-line-soft',
            'max-[640px]:flex max-[640px]:flex-wrap max-[640px]:items-center max-[640px]:py-1',
            fresh && 'bg-accent/10',
          )}
        >
          <td
            class="py-2 pr-4 align-top max-[640px]:order-1 max-[640px]:min-w-0
                   max-[640px]:basis-[calc(100%_-_44px)] max-[640px]:pr-2"
          >
            {#if renamingId === seminar.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                bind:value={renameValue}
                class="field max-w-[380px] max-[640px]:w-full"
                maxlength={LIMITS.seminarName}
                autocomplete="off"
                autofocus
                aria-label="{tr("admin.rename")} {seminar.name}"
                onblur={() => void commitRename(seminar)}
                onkeydown={(event) => {
                  if (event.key === 'Enter') void commitRename(seminar)
                  if (event.key === 'Escape') renamingId = null
                }}
              />
            {:else}
              <!-- Единственное место, где порог назван с обеих сторон:
                   `truncate` держит `white-space: nowrap`, и зажим в две строки
                   под ним молча остаётся одной строкой. Два непохожих правила
                   проще развести по ширинам, чем спорить внутри одного класса. -->
              <a
                href={linkOf(seminar)}
                target="_blank"
                rel="noreferrer"
                class="block text-ui font-semibold text-ink hover:underline
                       max-[640px]:line-clamp-2 min-[641px]:truncate"
              >
                {seminar.name}
              </a>
            {/if}

            <!-- Wraps as whole parts, not word by word: "link not shared yet"
                 broke into four stacked words in a narrow window and made every
                 row in the table four times as tall. -->
            <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <button
                type="button"
                data-copy={seminar.id}
                onclick={() => copy(seminar)}
                title="{tr("admin.copy")}  {linkOf(seminar)}"
                class={cn(
                  // -my-1 py-1: the row's path is 16px of type, which is too small
                  // a thing to aim at. The target grows to 24 and the row does not.
                  'flex -my-1 items-center gap-1.5 py-1 font-mono text-2xs transition-colors duration-100',
                  'hover:text-ink focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/30',
                  // 24 — это цель для мыши. Пальцу нужно 44, и они берутся
                  // высотой самой цели, а не ростом строки: отрицательное поле
                  // выше возвращает карточке прежний рост.
                  'max-[640px]:min-h-[44px]',
                  copiedId === seminar.id ? 'text-positive' : 'text-muted',
                )}
              >
                {pathOf(seminar)}
                <!--
                  Три входа, и ни один не лишний.

                  `hover:` теперь действует только там, где есть настоящий
                  курсор (tailwind.config.js · hoverOnlyWhenSupported), — а
                  значок «скопировать» был у этой строки ЕДИНСТВЕННОЙ подсказкой
                  о том, что она нажимается. На iPad, откуда панель и открывают
                  чаще всего, он перестал появляться вовсе: тап копировал, но
                  узнать об этом было неоткуда. Поэтому там, где наведения не
                  бывает, значок стоит всегда; клавиатуре его показывает фокус
                  внутри строки — тот же приём, что в дереве файлов
                  (FilesPanel.svelte · group-focus-within).
                -->
                <Icon
                  name={copiedId === seminar.id ? 'check' : 'copy'}
                  size={12}
                  class={cn(
                    'transition-opacity duration-100',
                    copiedId === seminar.id || fresh
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 ' +
                        '[@media(hover:none)]:opacity-100',
                  )}
                />
              </button>
              {#if seminar.status === 'draft'}
                <span class="whitespace-nowrap text-2xs text-muted">{tr("admin.link.not.shared.yet")}</span>
              {/if}
              {#if seminar.archivedAt}
                <span class="whitespace-nowrap text-2xs text-muted"> {tr("admin.archived")}</span>
              {/if}
              <!--
                Кто завёл комнату. Хранилось с самого начала и не показывалось
                нигде: на общем инстансе кафедры список — это чужие семинары
                вперемешку со своими, и «удалить» стоит рядом с каждым. Правит
                по-прежнему любой преподаватель — это одна кафедра, а не
                арендаторы, — но чьё это, теперь видно до нажатия.
              -->
              {#if seminar.createdBy}
                <span class="whitespace-nowrap text-2xs text-faint">{tr("admin.by")} {seminar.createdBy}</span>
              {/if}
              <!-- Курс и публикация — в той же строке, что и ссылка: это факты
                   об этом семинаре, а не второй столбец в таблице, где их уже
                   шесть. -->
              {#each seminar.courses as course (course.id)}
                <!-- `max-w-full truncate`: имя курса — чужая строка любой
                     длины, и на 360px одна такая распирала карточку за край. -->
                <a
                  class="max-w-full truncate whitespace-nowrap text-2xs text-accent-text"
                  href={`/admin/courses/${course.id}`}
                >
                  · {course.name}
                </a>
              {/each}
              {#if seminar.publication?.state === 'published'}
                <a
                  class="whitespace-nowrap text-2xs text-muted underline decoration-line underline-offset-2"
                  href={`/p/${addressOf(seminar.publication)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {tr("admin.published.978")} {count(seminar.publication.steps, 'step')}
                </a>
              {:else if seminar.publication}
                <span class="whitespace-nowrap text-2xs text-muted">{tr("admin.page.taken.down")}</span>
              {/if}
            </div>

            {#if rowError?.id === seminar.id}
              <p class="mt-1 text-2xs text-danger">{rowError.message()}</p>
            {/if}
          </td>

          <td
            class="py-2 pr-3 align-middle max-[640px]:order-3 max-[640px]:pb-2.5 max-[640px]:pt-0"
          >
            {#if seminar.environment}
              <a
                href="/admin/environments"
                class="truncate font-mono text-code text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
                title="{tr("admin.selected.environment")} {seminar.environment}"
              >
                {seminar.environment}
              </a>
            {:else}
              <!-- No kernel has started here, so there is nothing to report. It
                   will get whatever is configured when somebody presses Run —
                   saying that name now would be a guess dressed as a fact. -->
              <span class="font-mono text-code text-faint" title={tr("admin.no.environment.recorded.for.this.seminar")}>
                —
              </span>
            {/if}
          </td>

          <td
            class="py-2 align-middle text-ui text-muted max-[640px]:order-4 max-[640px]:pb-2.5
                   max-[640px]:pr-3 max-[640px]:pt-0"
          >
            <span title={new Date(seminar.createdAt).toLocaleString(getLocale())}>
              {stamp(seminar.createdAt)}
            </span>
          </td>

          <td
            class="py-2 text-right align-middle font-mono text-code text-ink max-[640px]:order-5
                   max-[640px]:pb-2.5 max-[640px]:pr-3 max-[640px]:pt-0"
          >
            <span title="{people(seminar.totalParticipants)} {tr("admin.joined.in.total")}">
              <!-- Заголовка колонки на телефоне нет, а голое число рядом с
                   «base · 19.09» читается как что угодно. Слово то же, что в
                   шапке таблицы, — колонка и подпись не расходятся. -->
              <span class="hidden text-2xs font-bold uppercase tracking-caps text-faint max-[640px]:inline">
                {tr("admin.joined")}
              </span>
              {seminar.totalParticipants > 0 ? seminar.totalParticipants : '—'}
            </span>
          </td>

          <td class="py-2 align-middle max-[640px]:order-6 max-[640px]:ml-auto max-[640px]:pb-2.5 max-[640px]:pt-0">
            <div class="flex items-center justify-end gap-2">
              {#if seminar.status === 'finished'}
                <!--
                  Решение преподавателя стоит там же, где остальные три слова, и
                  сильнее их: раньше «сейчас никого» и «занятие закончено»
                  показывались одним словом Ended, так что звонок ничего в
                  списке не менял. Точка слева — если в законченной комнате
                  всё-таки кто-то есть: перечитывают разбор, и это видно.
                -->
                <span
                  class="chip h-6 gap-1.5 bg-warning/[0.14] px-2 text-2xs font-bold uppercase tracking-caps text-warning"
                  title="{tr("admin.class.ended")} {new Date(
                    seminar.finishedAt ?? 0,
                  ).toLocaleString(getLocale())} {tr("admin.student.editing.and.execution.are.disabled")}"
                >
                  {#if seminar.liveCount > 0}
                    <span
                      class="h-[5px] w-[5px] rounded-full bg-accent"
                      title="{people(seminar.liveCount)} {tr("admin.in.the.room.right.now")}"
                    ></span>
                  {/if}
                  {tr("admin.finished")}
                </span>
              {:else if seminar.status === 'live'}
                <span
                  class="chip h-6 gap-1.5 bg-accent/15 px-2 text-2xs font-bold uppercase tracking-caps text-accent-text"
                >
                  <span class="h-[5px] w-[5px] rounded-full bg-accent"></span>
                  {tr("admin.live.990")}
                  <!-- Сколько человек — только на телефоне: там колонки
                       «Входили» рядом нет, а «идёт» без числа не отличает
                       комнату с одним заглянувшим от комнаты с потоком. На
                       столе число стоит в своей колонке, и второй его копии
                       в значке быть не должно. -->
                  <span
                    class="hidden tabular-nums max-[640px]:inline"
                    title="{people(seminar.liveCount)} {tr("admin.in.the.room.right.now")}"
                  >
                    · {seminar.liveCount}
                  </span>
                </span>
              {:else if seminar.status === 'draft'}
                <span
                  class="chip h-6 border border-line px-2 text-2xs font-bold uppercase tracking-caps text-muted"
                >
                  {tr("admin.draft")}
                </span>
              {:else}
                <!-- Bare, so the four states share one right-hand lane: an empty
                     room is a fact, not a badge. Слово честное: заходили, а
                     сейчас никого — «закончено» это не значит. -->
                <span class="text-2xs font-bold uppercase tracking-caps text-muted">{tr("admin.empty")}</span>
              {/if}
            </div>
          </td>

          <!--
            Меню — рядом с названием, в первой строке карточки, и ровно 44px
            шириной: `basis` названия выше отмерен под эту цифру.

            `px-0` здесь обязателен. У ячейки таблицы есть `padding: 1px` из
            стилей браузера, и его никто не снимает: `min-width: auto` у
            элемента flex'а считает по содержимому, выходило 46 вместо 44, а
            234 + 46 > 278 — и кнопка меню съезжала на третью строку карточки,
            под дату. Измерено на стенде при экране 390px.
          -->
          <td
            class="py-2 align-middle max-[640px]:order-2 max-[640px]:basis-11 max-[640px]:self-start
                   max-[640px]:px-0"
          >
            <div class="relative flex justify-end">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={openMenuId === seminar.id}
                aria-label="{tr("admin.actions.for")} {seminar.name}"
                onclick={(event) => {
                  event.stopPropagation()
                  openMenu(seminar, event.currentTarget as HTMLElement)
                }}
                class="flex h-8 w-8 items-center justify-center text-faint transition-colors duration-100 hover:bg-raised hover:text-ink max-[640px]:h-11 max-[640px]:w-11"
              >
                <Icon name="more" size={15} />
              </button>

              {#if openMenuId === seminar.id}
                <div
                  role="menu"
                  tabindex="-1"
                  class="row-menu fixed z-50 w-48 overflow-y-auto border border-line bg-canvas p-1 shadow-pop"
                  style={menuStyle}
                >
                  <button role="menuitem" type="button" class="{ITEM} text-ink hover:bg-raised" onclick={() => copy(seminar)}>
                    {tr("admin.copy.link")}
                  </button>
                  <a
                    role="menuitem"
                    href={linkOf(seminar)}
                    target="_blank"
                    rel="noreferrer"
                    class="{ITEM} text-ink hover:bg-raised"
                  >
                    {tr("admin.open.seminar")}
                  </a>
                  <button role="menuitem" type="button" class="{ITEM} text-ink hover:bg-raised" onclick={() => startRename(seminar)}>
                    {tr("admin.rename")}
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    class="{ITEM} text-ink hover:bg-raised"
                    onclick={() => {
                      ruling = seminar
                      memoryErrorText = null
                      // Числа прошлого открытия — числа прошлой минуты: с тех
                      // пор чужую комнату закрыли, память освободилась. Окно
                      // открывается с заглушками и ждёт свежего ответа.
                      resources = null
                      readResources()
                    }}
                  >
                    {tr('admin.seminar.settingsMenu')}
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    class="{ITEM} text-ink hover:bg-raised"
                    onclick={() => void finish(seminar, !seminar.finishedAt)}
                  >
                    {seminar.finishedAt ? tr("admin.reopen.the.class") : tr("admin.end.the.class")}
                  </button>
                  <div class="my-1 border-t border-line-soft"></div>
                  <button
                    role="menuitem"
                    type="button"
                    class="{ITEM} text-ink hover:bg-raised"
                    onclick={() => onpublish?.(seminar.id)}
                  >
                    {seminar.publication ? tr("admin.publish.again") : tr("admin.publish")}
                  </button>
                  {#if seminar.publication?.state === 'published'}
                    <button
                      role="menuitem"
                      type="button"
                      class="{ITEM} text-ink hover:bg-raised"
                      onclick={() => void copyPublished(seminar)}
                    >
                      {tr("admin.copy.public.link")}
                    </button>
                    <button
                      role="menuitem"
                      type="button"
                      class="{ITEM} text-ink hover:bg-raised"
                      onclick={() => void withdraw(seminar, true)}
                    >
                      {tr("admin.take.the.page.down")}
                    </button>
                  {:else if seminar.publication}
                    <button
                      role="menuitem"
                      type="button"
                      class="{ITEM} text-ink hover:bg-raised"
                      onclick={() => void withdraw(seminar, false)}
                    >
                      {tr("admin.put.the.page.back")}
                    </button>
                  {/if}
                  <button
                    role="menuitem"
                    type="button"
                    class="{ITEM} text-ink hover:bg-raised"
                    onclick={() => void archive(seminar, !seminar.archivedAt)}
                  >
                    {seminar.archivedAt ? tr("admin.move.back.to.the.list") : tr("admin.archive")}
                  </button>
                  {#if canDelete}
                    <div class="my-1 border-t border-line-soft"></div>
                    <button
                      role="menuitem"
                      type="button"
                      class="{ITEM} text-danger hover:bg-danger/[0.08]"
                      onclick={() => confirmDelete(seminar)}
                    >
                      {tr("admin.delete")}
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          </td>
        </tr>
      {/each}

      {#if loading && seminars.length === 0}
        <tr class="max-[640px]:block">
          <td colspan="6" class="px-3 py-4 max-[640px]:block"><ContentSkeleton variant="rows" label={tr('admin.loading.seminars')} /></td>
        </tr>
      {:else if shown.length === 0 && !creating}
        <tr class="max-[640px]:block">
          <td colspan="6" class="py-12 text-center max-[640px]:block">
            {#if needle}
              <p class="text-ui text-muted">{tr('admin.seminar.noMatch', { query: query.trim() })}</p>
              <button type="button" class="btn-ghost mt-2" onclick={() => (query = '')}>
                {tr("admin.show.all")} {count(seminars.length, 'seminar')}
              </button>
            {:else if !loadError}
              <p class="text-ui text-muted">{tr("admin.no.seminars.yet")}</p>
              <p class="mt-1 text-ui text-muted">
                {tr("admin.create.a.seminar.and.share.its.link.with.your.students")}
              </p>
              <button type="button" class="btn-primary mt-3" onclick={startCreate}>
                <Icon name="plus" size={15} />
                {tr("admin.new.seminar")}
              </button>
            {/if}
          </td>
        </tr>
      {/if}
    </tbody>
  </table>
  </div>

  {#if seminars.length > 0}
    <p class="mt-4 text-2xs text-muted">
      {#if needle}
        {tr("admin.showing")} {shown.length} {tr("admin.of")} {count(seminars.length, 'seminar')}
      {:else}
        {count(seminars.length, 'seminar')} {tr("admin.total")}
      {/if}
    </p>
  {/if}
</AdminPage>

{#if ruling}
  <!--
    Тот же список и теми же словами, что в самой комнате: настройка, которую в
    двух местах называют по-разному, — это две настройки.

    И потому это окно РУССКОЕ ЦЕЛИКОМ — заголовок, предупреждение, причина
    отказа в подвале (panel.ts · ruleRefusal) и «Готово» вокруг строк, — хотя
    меню, из которого его открывают, английское, как и весь экран. Решение
    записано один раз, в шапке компонента этих строк
    (components/RoomRulesRows.svelte): подписи правил живут в языке КОМНАТЫ,
    потому что тот же компонент рисует пульт правил внутри неё, а комната
    русская вся. Перевод одной рамки вокруг русских строк сделал бы двуязычным
    само окно — ровно то, что находка admin-17 и называет дефектом в меню.
    Двуязычие меню чинилось там, где оно было: в самом меню строки.
  -->
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="seminar-rules-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card flex max-h-full w-full max-w-[560px] flex-col border border-line bg-canvas shadow-pop">
      <div class="flex flex-col gap-1.5 border-b border-line px-5 py-3.5">
        <div class="flex items-baseline gap-3">
          <h2 id="seminar-rules-title" class="min-w-0 truncate text-title font-semibold text-ink">
            {ruling.name}
          </h2>
          <span class="shrink-0 text-2xs text-muted">{tr('admin.seminar.settingsSubtitle')}</span>
        </div>
        <!--
          Чужая комната, и в ней идёт пара. Подтверждения здесь нет намеренно:
          переключателей девять, и спрашивать на каждый — значит научить
          прощёлкивать вопрос. Но знать, что каждое переключение прилетает
          двумстам людям посреди чужого занятия, надо ДО первого щелчка.
        -->
        {#if othersLive(ruling)}
          <p class="text-2xs leading-snug text-warning">
            {tr("admin.in.the.room.1023")} {ruling.liveCount}
            {plural(ruling.liveCount, tr("admin.person"), tr("admin.people.1025"), tr("admin.person"))}{tr("admin.created.by")} {ruling.createdBy}{tr("admin.rule.changes.apply.immediately")}
          </p>
        {/if}
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-5">
        <!--
          Числа занятия и потолок машины — в строку правила «Личные тетради»:
          «как у занятия» обязано называть, СКОЛЬКО это, а список — не
          предлагать того, чего машина не даст.
        -->
        <RoomRulesRows
          rules={ruling.rules}
          busy={rulesBusy}
          own={{
            roomMemoryMb: ruling.memoryMb ?? resources?.kernel.defaultMemoryMb ?? null,
            roomCpus: ruling.cpus ?? resources?.kernel.defaultCpus ?? null,
            maxMemoryMb: resources?.limits.max ?? null,
            maxCpus: resources?.limits.cpus.max ?? null,
          }}
          onchange={(patch) => void setRule(ruling as AdminSeminar, patch)}
        />

        <!--
          Тот же раздел и тот же компонент, что в форме нового занятия.

          Настройка, которую в двух местах называют по-разному и считают
          по-разному, — это две настройки; здесь она вдобавок применяется к
          ЖИВОЙ комнате, и ровно за этим сюда и приходят: ядро убили по памяти,
          пара идёт, добавить гигабайты надо сейчас.
        -->
        <div class="border-t border-line-soft py-4">
          <h3 class="text-ui font-semibold text-ink">{tr('admin.resources.title')}</h3>
          <p class="mb-3 mt-1.5 text-2xs text-muted">{tr('admin.resources.description')}</p>
          <Resources
            {resources}
            loading={resourcesLoading}
            environment={ruling.environment ?? ''}
            memoryMb={ruling.memoryMb ?? null}
            cpus={ruling.cpus ?? null}
            busy={memoryBusy}
            refusal={memoryError}
            roomId={ruling.id}
            onmemory={(mb) => void setMemory(ruling as AdminSeminar, mb)}
            oncpus={(cores) => void setCpus(ruling as AdminSeminar, cores)}
          />
        </div>
      </div>
      <div class="flex items-center gap-3 border-t border-line px-5 py-3">
        <p class={cn('min-w-0 flex-1 text-2xs', rulesError ? 'text-danger' : 'text-muted')}>
          {#if rulesError}
            {rulesError}
          {:else}
            {tr("admin.changes.apply.immediately.participants.do.not.need.to.sign.in.aga")}
            <!-- Пока занятие закончено, выбранное здесь не действует: конец занятия
                 накладывается поверх правил и настройку не трогает (shared/rules.ts ·
                 rulesAfterClass). Без этой строки список читается как неправда — в комнате
                 всё преподавательское, а здесь написано другое, — и преподаватель идёт
                 чинить то, что не сломано. -->
            {#if ruling.finishedAt}
              <span class="text-ink">
                {tr("admin.the.class.has.ended.the.selected.student.permissions.will.take.ef")}
              </span>
            {/if}
          {/if}
        </p>
        <button
          type="button"
          class="btn-primary shrink-0"
          onclick={() => {
            ruling = null
            rulesErrorText = null
          }}
        >
          {tr("admin.done")}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if doomed}
  <!-- Nothing is painted before the server agrees: this is the one action on
       the screen that cannot be put back if the request never lands. -->
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="delete-seminar-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="delete-seminar-title" class="text-title font-semibold text-ink">
        {tr('admin.seminar.deleteHeading', { name: doomed.name })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr("admin.this.deletes.the.notebook")}{count(doomed.cellCount, 'cell')}{tr("admin.and")} {count(
          doomed.fileCount,
          'file',
        )} {tr("admin.in.its.workspace")}
        {#if !doomed.publication}
          {tr("admin.you.cannot.restore.the.seminar.through.colloq.after.deletion")}
        {/if}
      </p>

      <!--
        Публикация — это и есть вторая копия тетради: ячейки и выводы, отданные
        всем по прямой ссылке. Обещать рядом с ней «второй копии нет» — врать в
        том самом случае, ради которого чаще всего и удаляют: убрать выложенное.
      -->
      {#if doomed.publication}
        <label class="mt-3 flex cursor-pointer items-start gap-2.5 border border-line p-3">
          <input
            type="checkbox"
            bind:checked={dropReading}
            disabled={deleteBusy}
            class="mt-0.5 accent-accent"
          />
          <span class="text-ui leading-relaxed text-muted">
            {tr("admin.delete.the.public.page.as.well")}
            <span class="font-mono text-code text-ink">/p/{addressOf(doomed.publication)}</span>{tr("admin.a.second.copy.of.the.notebook.in")} {count(doomed.publication.steps, 'step')}{tr("admin.outputs.included")}
            {#if dropReading}
              {tr("admin.the.link.the.class.was.given.stops.opening")}
            {:else}
              {tr("admin.the.publication.is.retained.with.its.current.visibility")}
            {/if}
          </span>
        </label>
      {/if}
      {#if doomed.liveCount > 0}
        <p class="mt-2 text-ui font-medium text-warning">
          {doomed.liveCount === 1
            ? tr("admin.someone.is.in.the.room.right.now")
            : tr("admin.people.are.in.the.room.right.now", { p0: doomed.liveCount })} {tr("admin.deleting.the.seminar.will.disconnect.them")}
        </p>
      {/if}
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr("admin.archiving.removes.the.seminar.from.the.active.list.and.keeps.its")}
      </p>

      {#if deleteError}
        <p class="mt-3 text-ui text-danger">{tr("admin.could.not.delete.the.seminar")} {deleteError}</p>
      {/if}

      <div class="mt-5 flex justify-end gap-2">
        <button
          bind:this={cancelButton}
          type="button"
          class="btn-outline"
          disabled={deleteBusy}
          onclick={() => (doomed = null)}
        >
          {tr("admin.cancel")}
        </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 active:brightness-95"
          disabled={deleteBusy}
          onclick={() => void destroy()}
        >
          {#if deleteBusy}
            <Icon name="spinner" size={15} class="animate-spin" />
            {tr("admin.deleting")}
          {:else}
            <Icon name="trash" size={15} />
            {tr("admin.delete.seminar")}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}
