<script lang="ts">
  import { onMount } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { seminarLink } from '@/lib/seminar-link'
  import { cn } from '@/lib/utils'
  import { LIMITS, type AdminEnvironment, type AdminSeminar, type ImportPreview } from '@shared/admin'
  import { copyText } from '@/lib/clipboard'
  import { plural } from '@/lib/plural'
  import RoomRulesRows from '@/components/RoomRulesRows.svelte'
  import type { RoomRules } from '@shared/rules'

  /**
   * The seminar list, and the one thing a teacher comes here to do: get the
   * link. It is on every row as a button, it is on the running banner, and it
   * is focused the moment a seminar is created — because the alternative is
   * opening a room to find its address, which is how a class starts late.
   */

  let seminars = $state<AdminSeminar[]>([])
  let loading = $state(true)
  let loadError = $state<string | null>(null)
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
      rowError = { id: seminar.id, message: `Не получилось — ${explain(cause)}` }
    }
  }

  /** Адрес, который диктуют вслух: имя, если его дали, иначе идентификатор. */
  const addressOf = (item: { id: string; slug: string | null }): string => item.slug ?? item.id

  async function copyPublished(seminar: AdminSeminar): Promise<void> {
    if (!seminar.publication) return
    await copyText(`${location.origin}/p/${addressOf(seminar.publication)}`)
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
  let previewError = $state<string | null>(null)

  let previewTimer: number | undefined
  $effect(() => {
    const url = githubUrl.trim()
    window.clearTimeout(previewTimer)
    preview = null
    previewError = null
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
        .catch((cause) => (previewError = explain(cause)))
        .finally(() => (previewing = false))
    }, 500)
    return () => window.clearTimeout(previewTimer)
  })

  async function importFromGithub(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const url = githubUrl.trim()
    if (!url || createBusy || !preview) return
    createBusy = true
    createError = null
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
      createError = explain(cause)
    } finally {
      createBusy = false
    }
  }
  let newName = $state('')
  let createBusy = $state(false)
  let createError = $state<string | null>(null)
  let nameInput = $state<HTMLInputElement | null>(null)
  let justCreatedId = $state<string | null>(null)

  let copiedId = $state<string | null>(null)
  let copyTimer: number | undefined

  let renamingId = $state<string | null>(null)
  let renameValue = $state('')

  /** At most one row is ever explaining itself; a second failure replaces the first. */
  let rowError = $state<{ id: string; message: string } | null>(null)
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
  let deleteError = $state<string | null>(null)
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

  /**
   * How long the room has been going. createdAt is the only clock the contract
   * carries — a live seminar is one somebody made for the class they are in, so
   * "created" and "started" are the same minute in every case but a stale room.
   */
  function startedAgo(from: number, at: number): string {
    const minutes = Math.max(0, Math.round((at - from) / 60_000))
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes} min ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} h ago`
    const days = Math.floor(hours / 24)
    return days === 1 ? 'yesterday' : `${days} days ago`
  }

  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
  const people = (n: number): string => (n === 1 ? '1 person' : `${n} people`)

  function explain(cause: unknown): string {
    if (cause instanceof AdminApiError) {
      // Nobody can act on a dead cookie. Hand it to the shell, which swaps the
      // whole panel for the sign-in screen rather than arguing in a red line.
      if (cause.reason === 'unauthenticated') void adminAuth.refresh()
      return cause.message
    }
    return cause instanceof Error ? cause.message : 'The server did not respond'
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
      loadError = null
    } catch (cause: unknown) {
      // A poll that fails leaves the list it already has: the screen was right a
      // minute ago, and a banner over live data is worse than data a minute old.
      if (!silent) loadError = explain(cause)
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
    createError = null
  }

  function cancelCreate(): void {
    creating = false
    newName = ''
    createError = null
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
    createError = null
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
      createError = explain(cause)
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
      rowError = { id: seminar.id, message: `The browser blocked the clipboard. The link is ${linkOf(seminar)}` }
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

  async function commitRename(seminar: AdminSeminar): Promise<void> {
    const name = renameValue.trim()
    renamingId = null
    if (!name || name === seminar.name) return

    /*
     * Чужую живую комнату не переименовывают молча.
     *
     * Имя семинара стоит в шапке у всех, кто сейчас внутри, и меняется у них
     * мгновенно: посреди пары заголовок над тетрадью вдруг становится другим.
     * Для своей комнаты это ожидаемо — ты и переименовываешь. Для чужой, где
     * идёт занятие, стоит спросить.
     *
     * Спрашиваем только когда сходятся оба условия: в комнате есть люди и
     * завёл её кто-то другой. Правку своей опечатки это не трогает.
     */
    const mine = !seminar.createdBy || seminar.createdBy === me?.name
    if (!mine && seminar.liveCount > 0) {
      const crowd = seminar.liveCount === 1 ? 'is 1 person' : `are ${seminar.liveCount} people`
      const ok = window.confirm(
        `There ${crowd} in “${seminar.name}” right now, and ${seminar.createdBy} set it up. ` +
          `The new name appears in their header immediately. Rename it to “${name}”?`,
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
      patch(seminar.id, { name: before })
      rowError = { id: seminar.id, message: `Could not rename it — ${explain(cause)}` }
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
  let rulesError = $state<string | null>(null)

  async function setRule(seminar: AdminSeminar, patchRules: Partial<RoomRules>): Promise<void> {
    rulesBusy = true
    rulesError = null
    try {
      const updated = await adminApi.updateSeminar(seminar.id, { rules: patchRules })
      replace(updated)
      ruling = updated
    } catch (cause: unknown) {
      rulesError = `Правило не сохранилось — ${explain(cause)}`
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
    const before = seminar.finishedAt
    // Прошлый отказ этой строки — про прошлое нажатие. Оставить его под
    // перекрашенной пометкой значит показать рядом две противоположные правды.
    if (rowError?.id === seminar.id) rowError = null
    patch(seminar.id, { finishedAt: finished ? Date.now() : null })
    try {
      replace(await adminApi.updateSeminar(seminar.id, { finished }))
    } catch (cause: unknown) {
      patch(seminar.id, { finishedAt: before })
      rowError = {
        id: seminar.id,
        message: finished
          ? `Занятие не закончилось — ${explain(cause)}`
          : `Занятие не открылось обратно — ${explain(cause)}`,
      }
    }
  }

  async function archive(seminar: AdminSeminar, archived: boolean): Promise<void> {
    const before = seminar.archivedAt
    patch(seminar.id, { archivedAt: archived ? Date.now() : null })
    try {
      replace(await adminApi.updateSeminar(seminar.id, { archived }))
    } catch (cause: unknown) {
      patch(seminar.id, { archivedAt: before })
      rowError = { id: seminar.id, message: `Could not archive it — ${explain(cause)}` }
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
    deleteError = null
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
    deleteError = null
    try {
      await adminApi.deleteSeminar(target.id, dropReading)
      local(seminars.filter((s) => s.id !== target.id))
      doomed = null
    } catch (cause: unknown) {
      // Already gone: the list is the thing that is wrong, so correct the list
      // rather than asking the owner to delete something that does not exist.
      if (cause instanceof AdminApiError && cause.status === 404) {
        local(seminars.filter((s) => s.id !== target.id))
        doomed = null
      } else {
        deleteError = explain(cause)
      }
    } finally {
      deleteBusy = false
    }
  }
</script>

<AdminPage title="Seminars">
  {#snippet actions()}
    <!--
      An empty instance gets one path, not three. The search has nothing to
      search and the button in the corner duplicates the one in the middle of
      the page, which is where the eye already is.
    -->
    {#if seminars.length > 0}
    <div
      class="flex h-[34px] w-[220px] max-w-full items-center gap-2 border border-line bg-canvas px-3
             focus-within:border-accent"
    >
      <Icon name="search" size={13} class="shrink-0 text-faint" />
      <input
        type="search"
        bind:value={query}
        placeholder="Search seminars…"
        aria-label="Search seminars by name"
        class="min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-faint"
      />
    </div>
    {#if archivedCount}
      <label
        class="flex h-[34px] cursor-pointer select-none items-center gap-2 border border-line
               bg-canvas px-3 text-2xs font-bold uppercase tracking-caps text-muted
               hover:text-ink"
        title="{seminars.length - archivedCount} active · {archivedCount} archived"
      >
        <input type="checkbox" bind:checked={showArchived} class="accent-accent" />
        Archived
        <span class="tabular-nums text-faint">{archivedCount}</span>
      </label>
    {/if}
    <button
      type="button"
      onclick={startCreate}
      class="btn-primary h-[34px] gap-2 px-3.5 text-2xs font-bold uppercase tracking-caps"
    >
      <Icon name="plus" size={14} />
      New seminar
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
    <section
      class="-mx-7 flex min-h-[74px] flex-wrap items-center gap-x-[22px] gap-y-3 border-b
             border-b-line border-l-[3px] border-l-accent bg-raised py-3 pl-[25px] pr-7"
    >
      <div class="flex min-w-[180px] flex-col gap-[3px]">
        <p
          class="flex items-center gap-[7px] whitespace-nowrap text-micro font-bold uppercase
                 tracking-label text-accent-text"
        >
          <span class="h-[7px] w-[7px] shrink-0 rounded-full bg-accent"></span>
          Running now
        </p>
        <h2 class="truncate text-title font-bold tracking-tight text-ink">{seminar.name}</h2>
      </div>

      <!--
        The artboard stacks the faces of the room here. AdminSeminar carries a
        head-count and nothing else, so there is nobody to draw: blank discs
        read as avatars that failed to load, and the roster endpoint answers
        with everyone who ever joined, which is a different set from the one
        this line is counting. The sentence is the honest version of the stack
        until the contract carries the people — see AvatarStack.
      -->
      <p class="shrink-0 text-ui text-muted" title={new Date(seminar.createdAt).toLocaleString()}>
        {people(seminar.liveCount)} in the room · started {startedAgo(seminar.createdAt, now)}
      </p>

      <div class="ml-auto flex shrink-0 items-center gap-2.5">
        <button
          type="button"
          onclick={() => copy(seminar)}
          title="Copy {linkOf(seminar)}"
          class={cn(
            'flex h-8 items-center gap-2 border border-line bg-canvas px-3 font-mono text-code',
            'transition-colors duration-100 hover:border-faint hover:text-ink',
            copiedId === seminar.id ? 'text-positive' : 'text-muted',
          )}
        >
          {hostPathOf(seminar)}
          <Icon name={copiedId === seminar.id ? 'check' : 'copy'} size={13} />
        </button>
        <a
          href={linkOf(seminar)}
          target="_blank"
          rel="noreferrer"
          class="btn h-8 bg-accent px-3.5 text-2xs font-bold uppercase tracking-caps text-accent-ink
                 hover:brightness-110"
        >
          Open
        </a>
      </div>
    </section>
  {/each}

  {#if loadError}
    <div class="mt-6 border border-danger/40 bg-surface px-4 py-3">
      <p class="text-ui text-danger">Could not load your seminars — {loadError}</p>
      <button type="button" class="btn-outline mt-2.5" onclick={() => void load()}>Try again</button>
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
  <div class="-mx-1 overflow-x-auto px-1">
  <table class="w-full min-w-[600px] table-fixed">
    <colgroup>
      <col />
      <col class="w-[132px]" />
      <col class="w-[104px]" />
      <col class="w-[74px]" />
      <col class="w-[116px]" />
      <col class="w-10" />
    </colgroup>
    <thead class={shown.length === 0 && !creating ? 'sr-only' : ''}>
      <tr class="border-b border-line text-micro font-bold uppercase tracking-label text-muted">
        <th scope="col" class="py-3 text-left">Seminar</th>
        <!--
          The environment this room's kernel is ACTUALLY on, which is not always
          the one configured: a seminar that was live through a switch keeps the
          image it came up on until its own kernel restarts. That gap is the
          only reason this column is worth a lane of its own.
        -->
        <th scope="col" class="py-3 text-left">Environment</th>
        <th scope="col" class="py-3 text-left">Date</th>
        <!--
          "Joined", not "People". This column is everyone who ever joined; the
          banner above it counts who is connected right now. Both were labelled
          people, so the same view could read "2 people in the room" beside an
          11 and give the reader no way to tell which number was wrong.
        -->
        <th scope="col" class="py-3 text-right">Joined</th>
        <th scope="col" class="py-3 text-right">Status</th>
        <th scope="col" class="py-3"><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      {#if creating}
        <tr class="border-b border-line-soft bg-surface">
          <td colspan="6" class="py-3">
            <!-- Две двери в одну комнату: пустой семинар и семинар из готового
                 материала. Переключатель, а не вторая кнопка в шапке: это одно
                 действие «создать», у которого два источника. -->
            <div class="mb-2.5 flex items-center gap-1">
              <button
                type="button"
                class={cn(TABBTN, !fromGithub && 'bg-raised text-ink')}
                onclick={() => ((fromGithub = false), (preview = null))}
              >
                Blank
              </button>
              <button
                type="button"
                class={cn(TABBTN, fromGithub && 'bg-raised text-ink')}
                onclick={() => (fromGithub = true)}
              >
                From GitHub
              </button>
            </div>

            {#if fromGithub}
              <form class="flex flex-col gap-2.5" onsubmit={importFromGithub}>
                <div class="flex flex-wrap items-center gap-2">
                  <input
                    bind:value={githubUrl}
                    class="field min-w-[420px] flex-1 font-mono text-code-lg"
                    placeholder="https://github.com/sleep3r/ml_hse/tree/main/week02"
                    autocomplete="off"
                    spellcheck="false"
                    aria-label="GitHub link to a notebook or a folder"
                  />
                  <button
                    class="btn-primary"
                    type="submit"
                    disabled={!preview || createBusy}
                  >
                    {#if createBusy}
                      <Icon name="spinner" size={15} class="animate-spin" />
                      Importing…
                    {:else}
                      Import
                    {/if}
                  </button>
                  <button class="btn-ghost" type="button" onclick={cancelCreate}>Cancel</button>
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
                    placeholder="Name — filled in from the link"
                    maxlength={LIMITS.seminarName}
                    autocomplete="off"
                    aria-label="Seminar name"
                  />
                  {#if environments && environments.length > 1}
                    <select
                      bind:value={newEnvironment}
                      class="field h-[38px] max-w-[240px] font-mono text-code-lg"
                      aria-label="Python environment"
                    >
                      {#each environments as env (env.name)}
                        <option value={env.name} disabled={env.state !== 'ready'}>
                          {env.name}{env.active ? ' — default' : ''}{env.state === 'ready'
                            ? ''
                            : ' — not built'}
                        </option>
                      {/each}
                    </select>
                  {/if}
                </div>

                {#if previewing}
                  <p class="text-2xs text-muted">Reading the repository…</p>
                {:else if previewError}
                  <p class="text-2xs text-danger">{previewError}</p>
                {:else if preview}
                  <!-- Что именно приедет. Показано до создания, а не после. -->
                  <div class="flex flex-wrap items-center gap-2 text-2xs text-muted">
                    <span class="font-mono text-ink">{preview.notebook}</span>
                    <span>·</span>
                    <span>{preview.cells} cells</span>
                    {#if preview.files.length > 0}
                      <span>·</span>
                      {#each preview.files as f (f.name)}
                        <span class="bg-surface px-2 py-0.5 font-mono text-micro">{f.name}</span>
                      {/each}
                    {/if}
                    <span>·</span>
                    <span class="font-mono">{preview.source}</span>
                    <span>·</span>
                    <span>outputs not imported</span>
                  </div>
                {/if}
              </form>
            {:else}
            <form class="flex flex-wrap items-center gap-2" onsubmit={create}>
              <input
                bind:this={nameInput}
                bind:value={newName}
                class="field max-w-[380px]"
                placeholder="Computer Vision Seminar — 25.08"
                maxlength={LIMITS.seminarName}
                autocomplete="off"
                aria-label="Name of the new seminar"
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
                  aria-label="Python environment for the new seminar"
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
                  Creating…
                {:else}
                  Create
                {/if}
              </button>
              <button class="btn-ghost" type="button" onclick={cancelCreate}>Cancel</button>
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
        <tr class={cn('group border-b border-line-soft', fresh && 'bg-accent/10')}>
          <td class="py-2 pr-4 align-top">
            {#if renamingId === seminar.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                bind:value={renameValue}
                class="field max-w-[380px]"
                maxlength={LIMITS.seminarName}
                autocomplete="off"
                autofocus
                aria-label="Rename {seminar.name}"
                onblur={() => void commitRename(seminar)}
                onkeydown={(event) => {
                  if (event.key === 'Enter') void commitRename(seminar)
                  if (event.key === 'Escape') renamingId = null
                }}
              />
            {:else}
              <a
                href={linkOf(seminar)}
                target="_blank"
                rel="noreferrer"
                class="block truncate text-ui font-semibold text-ink hover:underline"
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
                title="Copy {linkOf(seminar)}"
                class={cn(
                  // -my-1 py-1: the row's path is 16px of type, which is too small
                  // a thing to aim at. The target grows to 24 and the row does not.
                  'flex -my-1 items-center gap-1.5 py-1 font-mono text-2xs transition-colors duration-100',
                  'hover:text-ink focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/30',
                  copiedId === seminar.id ? 'text-positive' : 'text-muted',
                )}
              >
                {pathOf(seminar)}
                <Icon
                  name={copiedId === seminar.id ? 'check' : 'copy'}
                  size={12}
                  class={cn(
                    'transition-opacity duration-100',
                    copiedId === seminar.id || fresh
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100',
                  )}
                />
              </button>
              {#if seminar.status === 'draft'}
                <span class="whitespace-nowrap text-2xs text-muted">link not shared yet</span>
              {/if}
              {#if seminar.archivedAt}
                <span class="whitespace-nowrap text-2xs text-muted">archived</span>
              {/if}
              <!--
                Кто завёл комнату. Хранилось с самого начала и не показывалось
                нигде: на общем инстансе кафедры список — это чужие семинары
                вперемешку со своими, и «удалить» стоит рядом с каждым. Правит
                по-прежнему любой преподаватель — это одна кафедра, а не
                арендаторы, — но чьё это, теперь видно до нажатия.
              -->
              {#if seminar.createdBy}
                <span class="whitespace-nowrap text-2xs text-faint">by {seminar.createdBy}</span>
              {/if}
              <!-- Курс и публикация — в той же строке, что и ссылка: это факты
                   об этом семинаре, а не второй столбец в таблице, где их уже
                   шесть. -->
              {#each seminar.courses as course (course.id)}
                <a
                  class="whitespace-nowrap text-2xs text-accent-text"
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
                  · опубликован · {seminar.publication.steps}
                  {plural(seminar.publication.steps, 'шаг', 'шага', 'шагов')}
                </a>
              {:else if seminar.publication}
                <span class="whitespace-nowrap text-2xs text-muted">· страница снята</span>
              {/if}
            </div>

            {#if rowError?.id === seminar.id}
              <p class="mt-1 text-2xs text-danger">{rowError.message}</p>
            {/if}
          </td>

          <td class="py-2 pr-3 align-middle">
            {#if seminar.environment}
              <a
                href="/admin/environments"
                class="truncate font-mono text-code text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
                title="This room's kernel is running the {seminar.environment} image"
              >
                {seminar.environment}
              </a>
            {:else}
              <!-- No kernel has started here, so there is nothing to report. It
                   will get whatever is configured when somebody presses Run —
                   saying that name now would be a guess dressed as a fact. -->
              <span class="font-mono text-code text-faint" title="No kernel started in this room yet">
                —
              </span>
            {/if}
          </td>

          <td class="py-2 align-middle text-ui text-muted">
            <span title={new Date(seminar.createdAt).toLocaleString()}>
              {stamp(seminar.createdAt)}
            </span>
          </td>

          <td class="py-2 text-right align-middle font-mono text-code text-ink">
            <span title="{people(seminar.totalParticipants)} joined in total">
              {seminar.totalParticipants > 0 ? seminar.totalParticipants : '—'}
            </span>
          </td>

          <td class="py-2 align-middle">
            <div class="flex items-center justify-end gap-2">
              <!--
                Решение преподавателя, а не подсчёт подключённых — и потому
                рядом со статусом, а не вместо него. `status` отвечает на «есть
                ли кто-то в комнате сейчас»: семинар без единого человека может
                идти, а законченный — стоять с полным залом, который
                перечитывает разбор.
              -->
              {#if seminar.finishedAt}
                {@const over = new Date(seminar.finishedAt).toLocaleString()}
                <span
                  class="whitespace-nowrap text-2xs text-muted"
                  title="Закончено {over} — в комнате теперь только читают"
                >
                  занятие закончено
                </span>
              {/if}
              {#if seminar.status === 'live'}
                <span
                  class="chip h-[22px] gap-1.5 bg-accent/15 px-2 text-micro font-bold uppercase tracking-caps text-accent-text"
                >
                  <span class="h-[5px] w-[5px] rounded-full bg-accent"></span>
                  Live
                </span>
              {:else if seminar.status === 'draft'}
                <span
                  class="chip h-[22px] border border-line px-2 text-micro font-bold uppercase tracking-caps text-muted"
                >
                  Draft
                </span>
              {:else}
                <!-- Bare, so the three states share one right-hand lane: an ended
                     seminar is a fact, not a badge. -->
                <span class="text-micro font-bold uppercase tracking-caps text-muted">Ended</span>
              {/if}
            </div>
          </td>

          <td class="py-2 align-middle">
            <div class="relative flex justify-end">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={openMenuId === seminar.id}
                aria-label="Actions for {seminar.name}"
                onclick={(event) => {
                  event.stopPropagation()
                  openMenu(seminar, event.currentTarget as HTMLElement)
                }}
                class="flex h-6 w-6 items-center justify-center p-1 text-faint transition-colors duration-100 hover:bg-raised hover:text-ink"
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
                    Copy link
                  </button>
                  <a
                    role="menuitem"
                    href={linkOf(seminar)}
                    target="_blank"
                    rel="noreferrer"
                    class="{ITEM} text-ink hover:bg-raised"
                  >
                    Open seminar
                  </a>
                  <button role="menuitem" type="button" class="{ITEM} text-ink hover:bg-raised" onclick={() => startRename(seminar)}>
                    Rename
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    class="{ITEM} text-ink hover:bg-raised"
                    onclick={() => (ruling = seminar)}
                  >
                    Rules…
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    class="{ITEM} text-ink hover:bg-raised"
                    onclick={() => void finish(seminar, !seminar.finishedAt)}
                  >
                    {seminar.finishedAt ? 'Продолжить занятие' : 'Закончить занятие'}
                  </button>
                  <div class="my-1 border-t border-line-soft"></div>
                  <button
                    role="menuitem"
                    type="button"
                    class="{ITEM} text-ink hover:bg-raised"
                    onclick={() => onpublish?.(seminar.id)}
                  >
                    {seminar.publication ? 'Опубликовать снова…' : 'Опубликовать…'}
                  </button>
                  {#if seminar.publication?.state === 'published'}
                    <button
                      role="menuitem"
                      type="button"
                      class="{ITEM} text-ink hover:bg-raised"
                      onclick={() => void copyPublished(seminar)}
                    >
                      Копировать публичную ссылку
                    </button>
                    <button
                      role="menuitem"
                      type="button"
                      class="{ITEM} text-ink hover:bg-raised"
                      onclick={() => void withdraw(seminar, true)}
                    >
                      Снять страницу
                    </button>
                  {:else if seminar.publication}
                    <button
                      role="menuitem"
                      type="button"
                      class="{ITEM} text-ink hover:bg-raised"
                      onclick={() => void withdraw(seminar, false)}
                    >
                      Вернуть страницу
                    </button>
                  {/if}
                  <button
                    role="menuitem"
                    type="button"
                    class="{ITEM} text-ink hover:bg-raised"
                    onclick={() => void archive(seminar, !seminar.archivedAt)}
                  >
                    {seminar.archivedAt ? 'Move back to the list' : 'Archive'}
                  </button>
                  {#if canDelete}
                    <div class="my-1 border-t border-line-soft"></div>
                    <button
                      role="menuitem"
                      type="button"
                      class="{ITEM} text-danger hover:bg-danger/[0.08]"
                      onclick={() => confirmDelete(seminar)}
                    >
                      Delete…
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          </td>
        </tr>
      {/each}

      {#if loading && seminars.length === 0}
        <tr>
          <td colspan="6" class="py-6 text-ui text-muted">Loading seminars…</td>
        </tr>
      {:else if shown.length === 0 && !creating}
        <tr>
          <td colspan="6" class="py-12 text-center">
            {#if needle}
              <p class="text-ui text-muted">Nothing here is called “{query.trim()}”.</p>
              <button type="button" class="btn-ghost mt-2" onclick={() => (query = '')}>
                Show all {count(seminars.length, 'seminar')}
              </button>
            {:else if !loadError}
              <p class="text-ui text-muted">No seminars yet.</p>
              <p class="mt-1 text-ui text-muted">
                Make one and you get a link to paste into the group chat.
              </p>
              <button type="button" class="btn-primary mt-3" onclick={startCreate}>
                <Icon name="plus" size={15} />
                New seminar
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
        Showing {shown.length} of {count(seminars.length, 'seminar')}
      {:else}
        All {count(seminars.length, 'seminar')} this term
      {/if}
    </p>
  {/if}
</AdminPage>

{#if ruling}
  <!-- Тот же список и теми же словами, что в самой комнате: настройка, которую
       в двух местах называют по-разному, — это две настройки. -->
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="seminar-rules-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card flex max-h-full w-full max-w-[560px] flex-col border border-line bg-canvas shadow-pop">
      <div class="flex items-baseline gap-3 border-b border-line px-5 py-3.5">
        <h2 id="seminar-rules-title" class="min-w-0 truncate text-title font-semibold text-ink">
          {ruling.name}
        </h2>
        <span class="shrink-0 text-2xs text-muted">что можно делать в комнате</span>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-5">
        <RoomRulesRows
          rules={ruling.rules}
          busy={rulesBusy}
          onchange={(patch) => void setRule(ruling as AdminSeminar, patch)}
        />
      </div>
      <div class="flex items-center gap-3 border-t border-line px-5 py-3">
        <p class={cn('min-w-0 flex-1 text-2xs', rulesError ? 'text-danger' : 'text-muted')}>
          {#if rulesError}
            {rulesError}
          {:else}
            Открытая комната узнаёт сразу — перезаходить никому не нужно.
            <!-- Пока занятие закончено, выбранное здесь не действует: конец занятия
                 накладывается поверх правил и настройку не трогает (shared/rules.ts ·
                 rulesAfterClass). Без этой строки список читается как неправда — в комнате
                 всё преподавательское, а здесь написано другое, — и преподаватель идёт
                 чинить то, что не сломано. -->
            {#if ruling.finishedAt}
              <span class="text-ink">
                Занятие закончено: пока его не продолжат, в комнате всё преподавательское, а
                выбранное здесь включится вместе с занятием.
              </span>
            {/if}
          {/if}
        </p>
        <button
          type="button"
          class="btn-primary shrink-0"
          onclick={() => {
            ruling = null
            rulesError = null
          }}
        >
          Готово
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
        Delete “{doomed.name}”?
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        Deleting it takes the notebook ({count(doomed.cellCount, 'cell')}) and {count(
          doomed.fileCount,
          'file',
        )} in its workspace with it.
        {#if !doomed.publication}
          Colloq keeps no second copy of either.
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
            Delete the public page as well —
            <span class="font-mono text-code text-ink">/p/{addressOf(doomed.publication)}</span>, a
            second copy of the notebook in {count(doomed.publication.steps, 'step')}, outputs
            included.
            {#if dropReading}
              The link the class was given stops opening.
            {:else}
              Left alone, it stays readable by everyone who has the link.
            {/if}
          </span>
        </label>
      {/if}
      {#if doomed.liveCount > 0}
        <p class="mt-2 text-ui font-medium text-warning">
          {doomed.liveCount === 1
            ? 'Someone is in the room right now'
            : `${doomed.liveCount} people are in the room right now`} — they lose the notebook
          mid-seminar.
        </p>
      {/if}
      <p class="mt-2 text-ui leading-relaxed text-muted">
        To take it off the list without losing anything, archive it instead.
      </p>

      {#if deleteError}
        <p class="mt-3 text-ui text-danger">Could not delete it — {deleteError}</p>
      {/if}

      <div class="mt-5 flex justify-end gap-2">
        <button
          bind:this={cancelButton}
          type="button"
          class="btn-outline"
          disabled={deleteBusy}
          onclick={() => (doomed = null)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 active:brightness-95"
          disabled={deleteBusy}
          onclick={() => void destroy()}
        >
          {#if deleteBusy}
            <Icon name="spinner" size={15} class="animate-spin" />
            Deleting…
          {:else}
            <Icon name="trash" size={15} />
            Delete seminar
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}
