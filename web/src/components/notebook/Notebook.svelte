<script lang="ts">
  import { tr } from '@shared/i18n'
  import { tick } from 'svelte'
  import { findCell, isCellOpen, type CellType } from '@shared/notebook'
  import { isLectureRoom } from '@shared/rules'
  import Icon from '@/components/ui/Icon.svelte'
  import { controlDisabled, controlTitle } from '@/lib/controls'
  import {
    cellLockMatters,
    LECTURE_CELL,
    mayEditThisCell,
    mayRunThisCell,
    permitsIn,
  } from '@/lib/may'
  import { selectionHere, stepPlan } from './command-mode'
  import { deleteCell, insertCell, setCellType } from '@/lib/notebook-ops'
  import { getSessionState } from '@/lib/session.svelte'
  import { cn, modKey, prefersReducedMotion } from '@/lib/utils'
  import { watchBooks, watchCellIds, watchNotebookMeta } from '@/lib/yreactive.svelte'
  import CellView from './CellView.svelte'

  interface Props {
    /**
     * Путь тетради: она такой же файл, как всё остальное в папке семинара.
     *
     * Корень в документе выводится из пути, а не приходит сюда: путь — это то,
     * что видит человек в дереве и во вкладке, а корень — внутреннее имя,
     * которое у первой тетради осталось прежним ради истории и кеша.
     */
    book: string
    /**
     * Эта тетрадь показана, а не спрятана за другой вкладкой.
     *
     * Клавиатура комнаты — одна на всё окно (`<svelte:window onkeydown>`), а
     * тетрадей смонтировано столько, сколько открыто вкладок: скрытые прячутся
     * классом, а не размонтируются, чтобы не терять курсор. Без этой проверки
     * нажатие «a» вставляло ячейку в КАЖДУЮ открытую тетрадь, а Shift+Enter
     * отправлял два запуска — и оба в разные листы.
     */
    active: boolean
  }

  let { book, active }: Props = $props()

  const session = getSessionState()
  const books = watchBooks(session.doc)
  const root = $derived(books.current.find((entry) => entry.path === book)?.root ?? '')
  const ids = watchCellIds(session.doc, () => root)
  const notebook = watchNotebookMeta(session.doc)

  /*
   * $derived, not a plain const: the control socket reports the role the server
   * will actually act on as soon as it opens, and a teacher whose token was
   * minted before they signed in arrives here as a participant and is corrected
   * a moment later. A value captured at init would never hear about it.
   */
  const isHost = $derived(session.me.role === 'host')
  const kernel = $derived(notebook.current.kernelStatus)
  const queued = $derived(notebook.current.queue.length)

  /*
   * Whoever started the running cell may stop it, teacher or not: only one cell
   * runs at a time, and a seminar with nobody senior in the room otherwise has
   * no way to end a loop. The server enforces the same rule from its own record
   * of the queue; this only decides how the control is drawn.
   */
  const runningIsMine = $derived.by(() => {
    const running = notebook.current.runningCellId
    if (!running) return false
    const found = findCell(session.doc, running)
    /*
     * Ячейку могли удалить, пока она считалась: удаление работающей ячейки
     * клиент разрешает, meta продолжает называть исчезнувший id, а «стоп» на
     * самой ячейке ушёл вместе с ней. Сервер помнит, кто её запустил, документ
     * — уже нет; гасить единственную оставшуюся кнопку по незнанию значит
     * оставить комнату без преподавателя с бесконечным циклом и без выхода.
     * Право проверит сервер, здесь мы только не мешаем нажать.
     */
    if (!found) return true
    return (found.cell.get('runById') as string | null) === session.me.id
  })
  const canInterrupt = $derived(isHost || runningIsMine)

  /**
   * Что шлёт «Interrupt» из полосы.
   *
   * Безымянное нажатие сервер понимает как «разобрать очередь целиком» и
   * отказывает участнику, пока в ней стоят чужие ячейки, — а кнопка при этом
   * горит и обещает остановить выполняющуюся. Не-хост называет цель, и тогда
   * ветка про чужую очередь не срабатывает вовсе: он останавливает ровно свою
   * ячейку. У преподавателя нажатие остаётся безымянным — тем и отличается
   * комнатная кнопка от кнопки на ячейке.
   */
  function interruptMessage(): { t: 'interrupt'; cellId?: string } {
    const running = notebook.current.runningCellId
    if (isHost || !running) return { t: 'interrupt' }
    return { t: 'interrupt', cellId: running }
  }

  /* --------------------------------------------------------- navigation */

  function reveal(id: string) {
    document.querySelector(`[data-cell-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  function select(id: string) {
    session.selectCell(id)
    // Keyboard navigation must not walk the selection off screen — and the
    // target may have been parked, so let it take its real height first.
    void tick().then(() => reveal(id))
  }

  function enter(id: string) {
    window.dispatchEvent(new CustomEvent('colloq:enter-cell', { detail: { cellId: id } }))
  }

  async function addAt(index: number, type: CellType) {
    /*
     * Вслух, а не молча — и на клавише тоже. Отказ, о котором не сказали,
     * читается как поломка, а не как решение преподавателя; а без этой
     * проверки нажатие «a» уходило в общий документ, сервер отказывал кадру, и
     * человек оставался с курсором в ячейке, которой нет ни у кого.
     */
    if (!may.add) {
      session.showError(may.structureWhy + '.')
      return
    }
    const created = insertCell(session.doc, root, type, index)
    select(created)
    // The new cell has to exist in the DOM before it can take focus.
    await tick()
    enter(created)
  }

  /**
   * Нажали по ячейке — одной, или добавили к выделенным.
   *
   * Cmd на маке и Ctrl на остальном — тот же модификатор, которым выделяют
   * вразбивку везде; Shift — диапазон, включая поле кода другой ячейки.
   * В уже активном редакторе Shift продолжает выделять текст. Обработчик тела
   * вызывается в capture-фазе: редактор не должен перехватить этот жест или
   * получить фокус и сбросить выделение своим onfocus.
   */
  function pick(id: string, event?: MouseEvent | PointerEvent): void {
    if (event && event.button !== 0) return
    if (event?.shiftKey && !event.metaKey && !event.ctrlKey) {
      const editor = (event.target as Element | null)?.closest('.cm-editor')
      if (editor?.contains(document.activeElement)) return
    }
    if (event && (event.metaKey || event.ctrlKey || event.shiftKey)) {
      event.preventDefault()
      event.stopPropagation()
      // Keep subsequent notebook shortcuts out of the previously focused editor.
      const focused = document.activeElement
      if (focused instanceof HTMLElement && focused.closest('.cm-editor')) focused.blur()
    }
    if (event && (event.metaKey || event.ctrlKey)) {
      session.toggleCell(id)
      return
    }
    if (event?.shiftKey && session.selectedCellId) {
      session.extendTo(id, ids.current)
      return
    }
    session.selectCell(id)
  }

  /** A cell handing off to its neighbour; only this component knows the order. */
  $effect(() => {
    const onStep = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          cellId: string
          direction: -1 | 1
          focus?: boolean
          fallback?: boolean
          /** Make a cell when there is none to step to; Shift+Enter only. */
          grow?: boolean
        }>
      ).detail
      if (!detail) return
      const list = ids.current
      // Shift+Enter on the last cell has nowhere to go, so it makes somewhere:
      // that is how a notebook grows while somebody types down the page, and
      // it is what the same key does in the tool this room already knows. Без
      // права добавлять — просто остаётся на месте: см. stepPlan.
      const plan = stepPlan(list, detail.cellId, detail.direction, {
        fallback: detail.fallback,
        grow: detail.grow,
        mayAdd: may.add,
      })
      if (plan.kind === 'stay') return
      if (plan.kind === 'grow') {
        void addAt(plan.at, 'code')
        return
      }
      select(plan.cellId)
      if (detail.focus !== false) enter(plan.cellId)
    }
    window.addEventListener('colloq:step-cell', onStep)
    return () => window.removeEventListener('colloq:step-cell', onStep)
  })

  /* ------------------------------------------------------ холодный кадр */

  /**
   * Тетрадь ещё не прочитана — ни с диска, ни из сети.
   *
   * `hydrated` говорит только про переигранную копию из IndexedDB, а у
   * студента, открывшего ссылку впервые, её нет вовсе: тетрадь рисовалась
   * пустой, с живыми «+ Code / + Text» и счётчиком «0 cells», пока не придёт
   * первый кадр по сокету. При пятистах одновременных заходах это секунды — и
   * нажатие в эти секунды вставляло ячейку в пустой документ, которая после
   * слияния появлялась у всей комнаты рядом с настоящими.
   *
   * «Не прочитано» и «пусто» — разные вещи, и различает их `synced` провайдера:
   * сервер сказал, что документ у нас полный. Пустая тетрадь после `synced` —
   * настоящая пустая тетрадь, и она рисуется как раньше.
   */
  let collabSynced = $state(session.provider.synced)
  $effect(() => {
    const onSync = (isSynced: boolean) => (collabSynced = isSynced)
    session.provider.on('sync', onSync)
    // Могло синхронизироваться до того, как эта тетрадь смонтировалась.
    collabSynced = session.provider.synced
    return () => session.provider.off('sync', onSync)
  })
  /*
   * Пустая тетрадь без ответа сервера — но только пока ответа ЖДУТ. Оборванная
   * связь — это уже всё, что мы узнаем: там человек работает офлайн, и скелет
   * вместо тетради был бы вторым враньём вместо первого.
   */
  const cold = $derived(
    ids.current.length === 0 && !collabSynced && (!session.hydrated || session.connected),
  )

  /* ----------------------------------------------------------- viewport */

  /**
   * Every mounted code cell is a CodeMirror instance, and a seminar notebook is
   * tens of them. Cells far outside the viewport keep their component — and
   * every Yjs subscription with it — but swap the editor and the outputs for a
   * placeholder the height of what they last measured, so the scrollbar stays
   * honest and coming back is a render rather than a rebuild.
   *
   * A cell the observer has not ruled on yet falls back to its position, which
   * is what keeps a cold start from building forty editors before the first
   * IntersectionObserver callback lands.
   */
  const EAGER = 10
  const NEAR_MARGIN = '1200px 0px'

  let ruling = $state.raw(new Map<string, boolean>())

  const viewport =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            let next: Map<string, boolean> | null = null
            for (const entry of entries) {
              const id = (entry.target as HTMLElement).dataset.cellSlot
              if (!id || ruling.get(id) === entry.isIntersecting) continue
              next ??= new Map(ruling)
              next.set(id, entry.isIntersecting)
            }
            if (next) ruling = next
          },
          { rootMargin: NEAR_MARGIN },
        )

  $effect(() => () => viewport?.disconnect())

  function isNear(id: string, index: number): boolean {
    return ruling.get(id) ?? index < EAGER
  }

  function slot(node: HTMLElement, id: string) {
    node.dataset.cellSlot = id
    viewport?.observe(node)
    return {
      destroy() {
        viewport?.unobserve(node)
        // In place on purpose: a ruling for a cell that no longer exists cannot
        // change anything on screen and must not schedule a render.
        ruling.delete(id)
      },
    }
  }

  /* ----------------------------------------------------------- keyboard */

  /** Two taps of D delete; the chord expires so a stray D is never destructive. */
  const CHORD_MS = 700
  let armedDeleteAt = 0

  /** True when the keystroke already belongs to whatever has focus. */
  function claimedByFocus(target: EventTarget | null, key: string): boolean {
    const element = target as HTMLElement | null
    if (!element || typeof element.closest !== 'function') return false
    if (element.isContentEditable) return true
    const tag = element.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (element.closest('.cm-editor')) return true
    // A focused control activates on Enter/Space; navigation must not eat that.
    return (key === 'Enter' || key === ' ') && element.closest('button, a, [role="button"]') !== null
  }

  /**
   * Запустить ячейку её собственными правилами.
   *
   * Ни одной проверки здесь нет намеренно: их все делает `CellView.run` — та же
   * функция, что стоит за кнопкой на ячейке и за Cmd+Enter в редакторе, — и она
   * же говорит слова отказа. Копия проверок в этом файле уже однажды разошлась
   * с оригиналом и врала про открытую ячейку в лекции.
   */
  function runCell(cellId: string, step: boolean): void {
    window.dispatchEvent(new CustomEvent('colloq:run-cell', { detail: { cellId, step } }))
  }

  /** Сменить вид ячейки — по правам НА НЕЁ, с замком, как у тулбара и сервера. */
  function convertCell(cellId: string, to: CellType): void {
    const found = findCell(session.doc, cellId)
    if (!found) return
    const open = isCellOpen(found.cell)
    if (mayEditThisCell(may, open)) {
      setCellType(session.doc, cellId, to)
      return
    }
    // Те же слова, что у самой ячейки: запертая говорит про занятие, а не про
    // поле в правилах (см. CellView · editWhy).
    const shut = cellLockMatters(may) && !mayRunThisCell(may, open)
    session.showError((shut ? tr(LECTURE_CELL) : may.editWhy) + '.')
  }

  function onkeydown(event: KeyboardEvent) {
    if (!active) return
    if (event.defaultPrevented) return
    if (claimedByFocus(event.target, event.key)) return

    /*
     * Undo, from the notebook rather than from inside a cell.
     *
     * The undo manager existed and nothing was ever bound to it: inside a cell
     * CodeMirror handles Mod+Z through yCollab, and in command mode — which is
     * where cells are DELETED, by D-D or by the trash — Ctrl+Z did nothing at
     * all. The one action the room cannot get back any other way was the one
     * action without an undo.
     *
     * Checked before the modifier guard below, which exists to let the browser
     * keep its own shortcuts and would otherwise swallow this one. By code,
     * not by key: on a Russian layout the letter is я.
     */
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.code === 'KeyZ') {
      event.preventDefault()
      if (event.shiftKey) session.undoManager.redo()
      else session.undoManager.undo()
      return
    }
    /*
     * Запуск из командного режима — через саму ячейку, а не своими проверками.
     *
     * Здесь лежала копия проверок `CellView.run` — и она уже разошлась с
     * оригиналом: тут спрашивали `may.run` (правило КОМНАТЫ), а ячейка и сервер
     * — `mayRunThisCell` (правило ПЛЮС замок). На лекции преподаватель
     * открывает ячейку: кнопка на ней живая, Cmd+Enter в редакторе работает, а
     * Shift+Enter отсюда отвечал тостом про правило — про ячейку, которая
     * открыта. И второе: на заметке отсюда уходил `run`, который сервер молча
     * выбрасывает.
     *
     * Теперь решает ячейка: все проверки, все слова отказа и шаг — в одном
     * месте (CellView · colloq:run-cell). Заодно отсюда работает и Cmd+Enter,
     * который подвал тетради обещает в строке подсказки, а модификаторный
     * гард ниже съедал целиком.
     */
    if (
      event.key === 'Enter' &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey
    ) {
      const { id: only } = selectionHere(session.selectedCellId, ids.current)
      if (!only) return
      event.preventDefault()
      runCell(only, false)
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return

    const list = ids.current
    if (list.length === 0) return
    /*
     * Выделение общее на все тетради и при смене вкладки не сбрасывается:
     * чужое считается пустым, иначе `d d` удаляла бы ячейку из другой
     * тетради. См. command-mode.ts · selectionHere.
     */
    const { id: current, at } = selectionHere(session.selectedCellId, list)

    if (event.key === 'Enter' && event.shiftKey) {
      if (!current) return
      event.preventDefault()
      runCell(current, true)
      return
    }
    /*
     * Shift со стрелкой растягивает выделение — до общего запрета на Shift ниже.
     *
     * Растягивают ОТ ЯКОРЯ: он не двигается, пока Shift держат, и это то же
     * поведение, что у списка файлов в любой системе. Обычная стрелка ниже
     * выделение схлопывает — тоже как везде.
     */
    if (event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      const edge = session.selection.length > 0 ? session.selection : current ? [current] : []
      const step = event.key === 'ArrowUp' ? -1 : 1
      /*
       * Кончик — это край, которым выделение ушло ОТ якоря, а не тот, что
       * совпал с направлением стрелки. Иначе Shift+↑ после двух Shift+↓ не
       * сжимал диапазон снизу, а тянул новый вверх от якоря: 3,4,5 → 2,3, и
       * вопрос оракулу уходил не про те ячейки.
       *
       * Края берём как минимум и максимум, а не как первый и последний
       * элемент: Cmd-кликом выделение собирается в порядке нажатий.
       */
      let low = list.length
      let high = -1
      for (const id of edge) {
        const seat = list.indexOf(id)
        if (seat === -1) continue
        if (seat < low) low = seat
        if (seat > high) high = seat
      }
      const tip = high === -1 ? -1 : at === -1 ? (step === -1 ? low : high) : high !== at ? high : low
      const next = list[Math.max(0, Math.min(list.length - 1, (tip === -1 ? at : tip) + step))]
      if (next) {
        session.extendTo(next, list)
        reveal(next)
      }
      return
    }
    if (event.shiftKey) return

    /*
     * By code, not by key.
     *
     * `event.key` on a Russian layout is ф, и, ь, н, в — so every command-mode
     * shortcut simply stopped existing for anybody typing in Russian, which in
     * this product is most of the room. The physical key is what the shortcut
     * was ever about; Ctrl+` was already done this way.
     */
    switch (event.code === 'Escape' || event.key.startsWith('Arrow') || event.key === 'Enter' ? event.key : LETTERS[event.code] ?? event.key) {
      case 'ArrowUp':
        event.preventDefault()
        select(list[at <= 0 ? 0 : at - 1])
        break
      case 'ArrowDown':
        event.preventDefault()
        select(list[at < 0 ? 0 : Math.min(at + 1, list.length - 1)])
        break
      case 'Enter':
        if (!current) return
        event.preventDefault()
        enter(current)
        break
      case 'Escape':
        /*
         * Выйти из состояния «выбрано» было нельзя вообще: `selectCell(null)`
         * не звался нигде во всём приложении, и выделение жило до перезагрузки
         * страницы. Escape в командном режиме проваливался в `default`.
         */
        if (session.selection.length === 0) return
        event.preventDefault()
        session.selectCell(null)
        break
      case 'a':
        event.preventDefault()
        void addAt(at < 0 ? 0 : at, 'code')
        break
      case 'b':
        event.preventDefault()
        void addAt(at < 0 ? list.length : at + 1, 'code')
        break
      /*
       * M и Y спрашивали `may.edit` — правило КОМНАТЫ, — а тулбар ячейки и
       * сервер спрашивают `mayEditThisCell`, то есть правило плюс замок. На
       * открытой ячейке лекции кнопка «Convert» была включена, а клавиша
       * отвечала «Тетрадь принадлежит преподавателю». Слова отказа — оттуда же,
       * откуда их берёт ячейка.
       */
      case 'm':
        if (!current) return
        event.preventDefault()
        convertCell(current, 'markdown')
        break
      case 'y':
        if (!current) return
        event.preventDefault()
        convertCell(current, 'code')
        break
      case 'd': {
        if (!current) return
        event.preventDefault()
        if (!may.remove) {
          session.showError(may.structureWhy + '.')
          break
        }
        const now = Date.now()
        if (now - armedDeleteAt < CHORD_MS) {
          armedDeleteAt = 0
          const next = list[at + 1] ?? list[at - 1] ?? null
          deleteCell(session.doc, current)
          if (next) select(next)
        } else {
          armedDeleteAt = now
        }
        break
      }
      default:
        return
    }
    if ((LETTERS[event.code] ?? event.key) !== 'd') armedDeleteAt = 0
  }

  /* --------------------------------------------------- hold to restart */

  /*
   * Restart throws away every variable in the room, and it used to be a plain
   * click on a button the same size and the same voice as Clear, two slots
   * away, in a strip the host sweeps through all seminar. The file has already
   * made this exact judgement once, on the other input path: deleting a cell by
   * keyboard is two taps of D inside CHORD_MS above, "so a stray D is never
   * destructive". The pointer path of the control that wipes the WHOLE room
   * never got it. This is that reasoning, applied where the damage is larger.
   *
   * 900ms is picked over CHORD_MS's 700 rather than being a round number: the
   * pointer is not allowed to be more forgiving than the keyboard, so 700 is
   * the floor, and a host restarting in front of twenty people should not have
   * to stand on a button for the two seconds a hold-to-delete usually takes.
   * 900 clears the floor and is still four times the longest stray click.
   *
   * Scope: the second Restart, in the kernel-dead pill below, stays an instant
   * click. The kernel is already gone there, so there is nothing left to
   * protect, and that button is the way back — slowing down the one press the
   * room is desperate to make would be theatre.
   */
  const HOLD_MS = 900

  /*
   * Letting go, and the fade after the send. WAAPI takes numbers, not custom
   * properties, so these two spell out index.css's --speed-quick (0.1s) and
   * --ease-out instead of inventing a third speed and a fourth curve. Release
   * is feedback and belongs in the 100-160ms tier; the curve is ease-out
   * because a release is something leaving.
   */
  const RELEASE_MS = 100
  const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)'

  /** Physical keys the command mode uses, so the layout does not matter. */
  const LETTERS: Record<string, string> = {
    KeyA: 'a',
    KeyB: 'b',
    KeyM: 'm',
    KeyY: 'y',
    KeyD: 'd',
  }

  const may = $derived(permitsIn(session.session.rules, session.me.role, session.finished))
  const rules = $derived(may.rules)
  /*
   * Комната идёт по лекционному пресету.
   *
   * Не «мне тут ничего нельзя», а свойство комнаты: полоса нужна и
   * преподавателю — она объясняет, почему у него одного всё живо, и почему
   * двадцать человек рядом смотрят на серую тетрадь.
   *
   * Консилиум сюда входит: по правам это та же лекция, а «как открывается
   * ячейка» — не право, и `isLectureRoom` его не сравнивает. Поток на пятьсот
   * человек без этой полосы видел бы серую тетрадь без единого объяснения.
   *
   * `may.rules` — уже с наложенным концом занятия, и закончившееся занятие
   * читается отсюда как лекция (об этом сказано у самой `isLectureRoom`). Это
   * не ошибка, но и не то, о чём стоит говорить дважды: после звонка о комнате
   * рассказывает свой признак, поэтому полоса уступает ему место.
   */
  const lecture = $derived(!may.finished && isLectureRoom(rules))
  /*
   * В комнате с замком поле слева от ячейки шире — там стоит сам замок, — и на
   * ту же величину съезжают две вещи, подводимые под ячейки: черта, по которой
   * вставляют, и нижний ряд «Code / Text». Свойство комнаты, а не ячейки, так
   * что считается здесь один раз на тетрадь; ширину держит CellView.svelte.
   */
  const gutter = $derived(cellLockMatters(may) ? '4.5rem' : '3rem')
  const mayRun = $derived(may.run)
  /* Run All и Run Above — отдельное право: при «по одной» ядро одно, и разница
     между «двадцать человек считают» и «двадцать человек забили очередь на
     восемьсот ячеек» ровно в этом. */
  const mayRunAll = $derived(may.bulk)
  const restartDisabled = $derived(controlDisabled(session.connected, may.restart))
  /*
   * The room's own rule, read where the button is drawn.
   *
   * The server has enforced this since rules existed; the interface never
   * asked. A seminar set to "teacher runs the cells" showed everybody a live
   * Run button whose every press came back refused — and Shift+Enter went
   * further, stepping down the sheet and adding an empty cell at the end of
   * the shared document for a run that never happened.
   */

  let holdFill = $state<HTMLElement | null>(null)
  let holdAnim: Animation | null = null

  /** Back to a cold overlay: no fill left applied, no restart still armed. */
  function clearHold(): void {
    holdAnim = null
    for (const running of holdFill?.getAnimations() ?? []) running.cancel()
  }

  /*
   * One clock, not two. The obvious build is a CSS transition on the overlay
   * plus a setTimeout that sends the restart — and then the bar and the timer
   * agree only by luck. A throttled tab, or any rule that shortens the
   * transition, makes the bar read "done" while the send is still pending: a
   * progress indicator lying about a destructive control. Here `finished` and
   * the pixels come off the same animation, so the frame the bar fills is the
   * frame the message goes. It is also why nothing here waits on `transitionend`,
   * which a backgrounded tab never delivers at all.
   *
   * The information here is the CLOCK, not the 90px of travel, so reduced
   * motion takes the travel and keeps the clock: the tint ramps its opacity in
   * place over the same 900ms instead of sweeping across the button. A hold
   * with no visible progress is worse for that reader than one that moves —
   * they would be standing on a destructive button with no way to know how much
   * longer — and an opacity ramp reports elapsed time just as honestly while
   * displacing nothing. Being scripted rather than declarative puts this out of
   * reach of every CSS override, which is what makes this the only place the
   * preference can be honoured at all, not a reason to skip it.
   */
  /** The two ends of the fill, in whichever property this reader gets it. */
  function holdFrames(from: number, to: number): Keyframe[] {
    return prefersReducedMotion()
      ? [
          { opacity: from, transform: 'scaleX(1)' },
          { opacity: to, transform: 'scaleX(1)' },
        ]
      : [{ transform: `scaleX(${from})` }, { transform: `scaleX(${to})` }]
  }

  function startHold(): void {
    const el = holdFill
    if (!el || holdAnim || restartDisabled) return
    clearHold()
    const anim = el.animate(holdFrames(0, 1), {
      duration: HOLD_MS,
      // linear: constant motion reporting elapsed time. An eased fill would
      // misreport how much of the hold is left, and this is not an entrance.
      easing: 'linear',
      fill: 'forwards',
    })
    holdAnim = anim
    // cancel() rejects this promise, and a hold somebody let go of is not an
    // error — swallow it rather than letting it surface as an unhandled one.
    void anim.finished.then(
      () => {
        if (holdAnim === anim) fireRestart(el)
      },
      () => {},
    )
  }

  /** Every way out of a hold: fingers, keys, a dead socket, a hidden tab. */
  function cancelHold(): void {
    const anim = holdAnim
    if (!anim) return
    holdAnim = null
    // Where the fill actually is, read before the cancel wipes it: the
    // snap-back has to leave from there, not from a full bar it never reached.
    const progress = anim.effect?.getComputedTiming().progress ?? 0
    anim.cancel()
    holdFill?.animate(holdFrames(progress, 0), {
      duration: RELEASE_MS,
      easing: EASE_OUT,
      fill: 'forwards',
    })
  }

  function fireRestart(el: HTMLElement): void {
    holdAnim = null
    session.send({ t: 'restart' })
    // The send is the one moment in this interaction that must read, and a bar
    // that simply sits full until the finger lifts hides it. The overlay
    // leaves; the `restarting…` pill at the end of this bar takes it from here.
    el.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: RELEASE_MS,
      easing: EASE_OUT,
      fill: 'forwards',
    })
  }

  /*
   * Keyboard parity, not an afterthought: the onclick this button used to carry
   * is gone, and a native <button> turns Enter into a click on keydown and
   * Space into one on keyup — leaving it would have handed the keyboard an
   * instant restart straight past the hold. So the keys drive the same hold.
   */
  function onRestartKeyDown(event: KeyboardEvent): void {
    // A finger aborts by sliding off the button; a key has nowhere to slide,
    // so Escape is its way out.
    if (event.key === 'Escape') {
      cancelHold()
      return
    }
    if (event.key !== 'Enter' && event.key !== ' ') return
    // A held key repeats; only the first one starts the clock.
    if (event.repeat) return
    // Space scrolls the page, and both keys synthesise the click removed above.
    event.preventDefault()
    startHold()
  }

  function onRestartKeyUp(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') cancelHold()
  }

  /*
   * The hold has to survive the room, not just the button. A tab sent to the
   * background stops painting the fill while the hold is still nominally live,
   * which is the one case where a restart could land with no visible frame of
   * warning behind it. Tearing down mid-hold is the same story from the other
   * end: the animation would outlive the notebook and resolve into a room
   * nobody is in.
   */
  $effect(() => {
    const onHidden = () => {
      if (document.hidden) cancelHold()
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      clearHold()
    }
  })

  /*
   * And the third way the button can go quiet under the finger: CAP carries
   * `disabled:pointer-events-none`, so if the socket drops mid-hold no
   * pointerup, pointerleave or pointercancel will ever arrive, and the timer
   * would fire a restart into a session that cannot hear it.
   */
  $effect(() => {
    if (restartDisabled) cancelHold()
  })

  /* Both adders speak the artboard's caps voice; the inline one sits on a
     raised ground because it lands on top of the hairline it interrupts. */
  const ADD_LABEL = 'text-2xs font-bold uppercase tracking-label'
  const ADD =
    `inline-flex h-6 items-center gap-1.5 border border-line bg-canvas px-2.5 ${ADD_LABEL} ` +
    'text-muted transition-colors duration-[var(--speed-quick)] hover:text-ink ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'

  /*
   * Whether the run bar has more to the right than the window is showing. Only
   * true on a screen too narrow for the whole strip — a laptop never sees it.
   */
  let runBar = $state<HTMLElement | null>(null)
  let runBarMore = $state(false)
  function measureRunBar(): void {
    const el = runBar
    if (!el) return
    runBarMore = el.scrollWidth - el.clientWidth - el.scrollLeft > 4
  }
  /*
   * One read per frame, not one per event. scrollWidth, clientWidth and
   * scrollLeft each force a synchronous layout — on the only device that ever
   * sees the overflow state, a phone mid-touch-scroll, that was the frame
   * budget being spent to answer the same question twenty times between two
   * paints. (The bar's ground is opaque, not blurred: see the note on its
   * class list.)
   */
  let measureFrame = 0
  function scheduleRunBarMeasure(): void {
    if (measureFrame) return
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0
      measureRunBar()
    })
  }
  $effect(() => {
    const el = runBar
    if (!el) return
    measureRunBar()
    // Re-measure when the window changes, and when the strip itself does: the
    // terminal tab appears and disappears with the drawer.
    const observer = new ResizeObserver(scheduleRunBarMeasure)
    observer.observe(el)
    for (const child of el.children) observer.observe(child)
    return () => {
      observer.disconnect()
      if (measureFrame) cancelAnimationFrame(measureFrame)
      measureFrame = 0
    }
  })

  /*
   * The run bar is four caps-tracked words, and only the first one is filled.
   * The artboard runs each button the full height of the bar with no rounding
   * and no border, so the hover ground is the whole slot rather than a pill
   * floating inside it.
   */
  /*
   * shrink-0: the strip scrolls when the window is too narrow for it, so a
   * button that gave way would be squeezed to nothing rather than moving out of
   * view where it can be scrolled back to.
   */
  /*
   * The transition is spelled out rather than `transition-colors` plus the
   * `.press` helper, and this is the trap JoinScreen.svelte:428-441 documents:
   * a Tailwind `transition-*` utility is emitted after @layer components and
   * rewrites `transition-property` wholesale, so the helper's `transform` would
   * never be in the list and the 0.97 would snap in and snap back. Listing the
   * three properties together is the only way one control can both settle a
   * colour and travel under the finger. border-color is in the list because
   * `transition-colors` carried it and the terminal tab toggles its underline
   * with it — the point is to add the transform, not to drop a property.
   *
   * It lives in CAP rather than on one button because the strip is one strip:
   * Interrupt, Restart, Clear, Format and the terminal tab all press with the
   * same 3% and the same curve, or none of them should.
   */
  const CAP =
    'inline-flex h-full shrink-0 items-center px-4 text-2xs font-semibold uppercase tracking-label ' +
    'text-ink transition-[color,background-color,border-color,transform] duration-press ease-out ' +
    'enabled:active:scale-[0.97] hover:bg-raised ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset ' +
    'focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-40'

  /** Bordered, square, mono: the voice every status readout in the sheet uses. */
  const PILL = 'inline-flex h-6 shrink-0 items-center gap-2 border px-2.5 font-mono'

  /** Same button, at the foot of the sheet, where nothing needs to hide a rule. */
  const ADD_FOOT =
    `inline-flex h-6 items-center gap-1.5 border border-line px-2.5 ${ADD_LABEL} text-muted ` +
    'transition-colors duration-[var(--speed-quick)] hover:text-ink ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
</script>

<svelte:window {onkeydown} />

{#snippet adder(index: number)}
  <div class="group/add relative flex h-6 items-center justify-center">
    <div
      style:left={gutter}
      class="pointer-events-none absolute right-0 top-1/2 h-px bg-line-soft opacity-0
             transition-opacity duration-[var(--speed-quick)] group-hover/add:opacity-100"
    ></div>
    <!--
      Прозрачное — значит не нажимается.

      `opacity-0` убирает кнопки с глаз, но не из hit-testing: на планшете
      наведения и нажатия приходят одним касанием, так что тап ровно по стыку
      двух ячеек «проявлял» кнопку и тут же жал её — ячейка вставлялась всей
      комнате (или, в лекции, прилетал тост-отказ) без единого видимого
      предвестника. `pointer-events` снимается тем же условием, каким
      возвращается видимость, так что нажать можно ровно то, что видно;
      клавиатуре это не мешает — фокус ходит и по элементу без указателя, а
      `focus-within` возвращает и то, и другое.
    -->
    <div
      class="pointer-events-none relative flex items-center gap-1 opacity-0 transition-opacity
             duration-[var(--speed-quick)] focus-within:pointer-events-auto focus-within:opacity-100
             group-hover/add:pointer-events-auto group-hover/add:opacity-100"
    >
      <button type="button" class={ADD} title={tr('room.ui.440')} onclick={() => addAt(index, 'code')}>
        <Icon name="plus" size={11} /> {tr('room.ui.441')} </button>
      <button
        type="button"
        class={ADD}
        title={tr('room.ui.442')}
        onclick={() => addAt(index, 'markdown')}
      >
        <Icon name="plus" size={11} /> {tr('room.ui.443')} </button>
    </div>
  </div>
{/snippet}

<!--
  The notebook fills its column. It used to be capped at 900px and centred, which
  on anything wider than a laptop left the cells and the whole toolbar stranded in
  the middle with empty gutters either side — the artboard shows the strip running
  edge to edge and the cells using the room they are given. The panels beside it
  are what bound the measure; this element should not bound it a second time.
-->
<div class="w-full pb-40">
  <!--
    Полоса режима — над тетрадью и НЕ липкая, в отличие от ряда кнопок под ней.

    Это не состояние, за которым следят, а условие, в котором работают: его
    читают один раз, входя в комнату. Прибитая к верху, она отняла бы строку
    экрана у каждой ячейки до конца пары; уехавшая вверх — оставляет вместо себя
    замки на самих ячейках, которые говорят то же самое там, где нажимают.

    Тёплая, а не тревожная: в лекции ничего не сломалось. Тем и отличается от
    жёлтых предупреждений в этом продукте, что у неё нет ни значка «внимание»,
    ни кнопки, — только замок, слово и объяснение.
  -->
  {#if lecture}
    <div
      class="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line
             bg-warning/[0.07] px-4 py-2"
    >
      <Icon name="lock" size={13} class="shrink-0 text-warning" />
      <span class="text-ui font-semibold text-ink">{tr('room.ui.444')}</span>
      <span class="text-ui text-muted"> {tr('room.ui.445')} </span>
    </div>
  {/if}
  <div
    bind:this={runBar}
    onscroll={scheduleRunBarMeasure}
    class={cn(
      /*
       * Непрозрачная подложка, а не размытая.
       *
       * Полоса липкая и висит над тетрадью на две сотни ячеек, а
       * `backdrop-blur` заставляет браузер пересчитывать размытие подложки на
       * КАЖДЫЙ кадр прокрутки — на встроенной графике студенческого ноутбука
       * это дорогой слой на весь сеанс. Смотрят на полосу ради кнопок, а не
       * ради того, что под ней; `contain: paint` рядом отрезает её рисование
       * от остальной страницы.
       */
      `sticky top-0 z-30 mb-4 flex h-10 items-center overflow-x-auto overflow-y-hidden
       border-b border-line bg-canvas [contain:paint] [scrollbar-width:none]
       [&::-webkit-scrollbar]:hidden`,
      // A phone fits Run all, Interrupt, Restart and Clear and no more, and the
      // bar cut off flush with the screen edge: the terminal was still there,
      // one swipe away, with nothing on screen to say so. The fade is the only
      // thing that says the row continues.
      runBarMore && '[mask-image:linear-gradient(to_right,#000_calc(100%-40px),transparent)]',
    )}
  >
    <button
      type="button"
      class="inline-flex h-full shrink-0 items-center gap-2 bg-primary px-5 text-2xs font-bold uppercase
             tracking-label text-primary-ink transition-[opacity,transform] duration-press ease-out
             enabled:active:scale-[0.97] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2
             focus-visible:ring-inset focus-visible:ring-primary-ink/60
             disabled:pointer-events-none disabled:opacity-40"
      disabled={controlDisabled(session.connected, mayRun && mayRunAll)}
      title={controlTitle(
        session.connected,
        !mayRun ? may.runWhy : mayRunAll ? tr('room.extra.177') : may.bulkWhy,
      )}
      onclick={() => session.send({ t: 'runAll', book })}
    >
      <Icon name="play" size={12} /> {tr('room.ui.446')} </button>
    <button
      type="button"
      class={CAP}
      disabled={controlDisabled(session.connected, canInterrupt)}
      title={controlTitle(
        session.connected,
        canInterrupt ? tr('room.extra.151') : tr('room.extra.152'),
      )}
      onclick={() => session.send(interruptMessage())}
    > {tr('room.ui.395')} </button>
    <!--
      Hold, not click — the reasoning and the 900ms are at HOLD_MS above. This
      is the one place in the notebook where slow is right: the user is
      deciding, so the press takes its time, while everything the system
      answers with stays fast. The press comes from CAP, which carries it for
      the whole strip: the `.press` helper cannot be used beside a Tailwind
      `transition-*` utility, because the utility rewrites transition-property
      and leaves the helper's transform out of it.
    -->
    <button
      type="button"
      class={cn(CAP, 'relative select-none overflow-hidden')}
      disabled={restartDisabled}
      aria-label={tr('room.ui.447')}
      title={controlTitle(
        session.connected,
        may.restart
          ? tr('room.extra.180')
          : may.restartWhy,
      )}
      onpointerdown={(event) => {
        // A secondary button opens a context menu instead of pressing, and must
        // not arm a restart on its way there.
        if (event.button === 0) startHold()
      }}
      onpointerup={cancelHold}
      onpointerleave={cancelHold}
      onpointercancel={cancelHold}
      onblur={cancelHold}
      onkeydown={onRestartKeyDown}
      onkeyup={onRestartKeyUp}
    >
      <!--
        Scaled, not clipped and not resized: the vocabulary is the upload bar's
        in FilesPanel, where a width transition would relayout on every progress
        event and only transform is allowed to move. It is the first child so
        the label, which is positioned, keeps painting on top of the tint.
      -->
      <span
        bind:this={holdFill}
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 origin-left bg-danger/[0.18]"
        style="transform: scaleX(0)"
      ></span>
      <span class="relative">{tr('room.ui.448')}</span>
    </button>
    <button
      type="button"
      class={CAP}
      disabled={controlDisabled(session.connected, may.wipe)}
      title={controlTitle(session.connected, may.wipe ? tr('room.extra.181') : may.wipeWhy)}
      onclick={() => session.send({ t: 'clearOutputs', book })}
    > {tr('room.ui.449')} </button>
    <!--
      Форматирование стоит здесь, а не в меню ячейки: оно про весь ноутбук.
      Ячейку, которую black прочитать не может — магию, строку с ! или код,
      который сейчас дописывают, — оно оставляет как есть и идёт дальше, и
      именно поэтому кнопка одна на всю панель, а не по одной на ячейку.
    -->
    <button
      type="button"
      class={CAP}
      disabled={controlDisabled(session.connected, may.edit && may.bulk)}
      title={controlTitle(
        session.connected,
        !may.edit
          ? may.editWhy
          : !may.bulk
            ? may.bulkWhy
            : tr('room.extra.182'),
      )}
      onclick={() => session.send({ t: 'format', book })}
    > {tr('room.ui.450')} </button>

    <div class="ml-auto flex shrink-0 items-center gap-2.5">
      <!--
        The artboard's run bar carries the queue and the cell count and nothing
        else — a healthy kernel is reported in the masthead. An unhealthy one is
        not reported anywhere else yet, so it keeps its pill here.
      -->
      {#if kernel === 'dead'}
        <span class={cn(PILL, 'border-danger/40 bg-danger/[0.05] text-2xs text-danger')}>
          <span class="h-1.5 w-1.5 rounded-full bg-danger"></span> {tr('room.ui.451')} <!-- По правилу, а не по роли: кнопка в полосе слушается may.restart,
               и в открытой лаборатории без преподавателя плашка без кнопки
               оставляла студентов гадать, что Restart есть где-то выше. -->
          {#if may.restart}
            <button
              type="button"
              class="text-2xs font-bold uppercase tracking-label text-ink
                     transition-opacity duration-[var(--speed-quick)] hover:opacity-70
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40
                     disabled:pointer-events-none disabled:opacity-40"
              disabled={controlDisabled(session.connected)}
              title={controlTitle(session.connected, tr('room.extra.184'))}
              onclick={() => session.send({ t: 'restart' })}
            > {tr('room.ui.448')} </button>
          {/if}
        </span>
      {:else if kernel === 'starting' || kernel === 'restarting'}
        <!-- Opacity, not a background sweep: the same information for one
             composited property instead of a repaint every frame. -->
        <span class={cn(PILL, 'animate-pulse border-line text-2xs text-muted')}>
          <span class="h-1.5 w-1.5 rounded-full bg-faint"></span>
          {kernel === 'starting' ? tr('room.kernel.starting') : tr('room.kernel.restarting')}
        </span>
      {/if}

      {#if queued > 0}
        <span
          class={cn(PILL, 'border-line text-2xs text-muted')}
          title={tr('room.ui.452')}
        >
          <span class="h-1.5 w-1.5 rounded-full bg-muted"></span>
          {queued} {tr('room.ui.453')} </span>
      {/if}
      <!-- The least load-bearing thing in the strip, and the first to go when
           there is not room for all of it: how many cells there are is visible
           by scrolling the notebook. -->
      <!-- Пока тетрадь не прочитана, счётчика нет вовсе: «0 cells» на холодном
           кадре — это не число, это неправда. -->
      {#if !cold}
        <span class="hidden pl-0.5 pr-5 font-mono text-2xs text-muted xl:inline">
          {tr('room.notebook.cellCount', { count: ids.current.length })}
        </span>
      {/if}
    </div>
  </div>
  <!-- 24px, the artboard's: its cells are 822 wide in an 868 column, while the
       run bar above them is the full 868 and touches both panels. -->
  <div class="px-6">

  {#if cold}
    <!--
      Три серые ячейки вместо пустой тетради с живыми кнопками.

      Не «загрузка…» и не крутилка: место, которое сейчас займут настоящие
      ячейки, — тот же приём, что у резерва под вывод. Пульс общий на все три,
      чтобы это читалось как одно ожидание, а не как три предмета.
    -->
    <div class="animate-pulse" aria-hidden="true">
      {#each [180, 96, 132] as height, index (index)}
        <div class="flex gap-4 pb-4">
          <div class={cn('h-7 shrink-0', gutter === '4.5rem' ? 'w-14' : 'w-8')}></div>
          <div class="min-w-0 flex-1 border-l-4 border-line bg-surface/50" style="height: {height}px"></div>
        </div>
      {/each}
    </div>
    <p class="pl-1 text-2xs text-muted" role="status">{tr('room.ui.454')}</p>
  {:else}
  {#each ids.current as id, index (id)}
    {@render adder(index)}
    <div use:slot={id}>
      <CellView
        {id}
        {index}
        bookRoot={root}
        last={index === ids.current.length - 1}
        selected={session.selection.includes(id)}
        anchor={session.selectedCellId === id}
        near={isNear(id, index)}
        onselect={(event) => pick(id, event)}
      />
    </div>
  {/each}

  {@render adder(ids.current.length)}

  <div
    style:padding-left={gutter}
    class={cn('mt-1 flex items-center gap-3', ids.current.length === 0 && 'mt-8')}
  >
    <button
      type="button"
      class={ADD_FOOT}
      title={tr('room.ui.455')}
      onclick={() => addAt(ids.current.length, 'code')}
    >
      <Icon name="plus" size={11} /> {tr('room.ui.441')} </button>
    <button
      type="button"
      class={ADD_FOOT}
      title={tr('room.ui.456')}
      onclick={() => addAt(ids.current.length, 'markdown')}
    >
      <Icon name="text" size={11} /> {tr('room.ui.443')} </button>
    <div class="h-px flex-1 bg-line-soft"></div>
    <!-- Shift+Enter and the platform's own modifier now mean different things —
         run and move on, run and stay — so the hint says both. `modKey` reads
         ⌘ on a Mac and Ctrl everywhere else. -->
    <span class="hidden shrink-0 font-mono text-2xs text-muted sm:inline"> {tr('room.ui.457')} {modKey}{tr('room.ui.458')} </span>
  </div>
  {/if}
  </div>
</div>
