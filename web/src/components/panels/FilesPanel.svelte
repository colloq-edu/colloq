<script lang="ts">
  import RowsSkeleton from '@/components/ui/RowsSkeleton.svelte'
  import { tr } from '@shared/i18n'
  /**
   * Папка семинара деревом.
   *
   * Список приходит с сервера уже в том порядке, в каком его рисуют — обход в
   * глубину, папки перед файлами, — так что здесь не строится никакое дерево:
   * строка знает свою глубину из числа косых черт в пути, а свёрнутая папка
   * прячет всё, что под ней. Это и есть причина, по которой сервер отдаёт
   * плоский список: дерево, собранное дважды с двух сторон, — два места, где
   * порядок может разойтись.
   *
   * Нажатие на файл открывает его, а не копирует строку для ячейки: открывать
   * стало чем.
   *
   * Всё остальное, что со строкой можно сделать, живёт в меню под правой
   * кнопкой — и только там. Полоса из трёх значков по наведению, стоявшая тут
   * раньше, умела ровно три вещи, занимала место размера файла и на планшете
   * доставалась только выделенной строке; в неё же упиралось каждое следующее
   * действие, потому что четвёртый значок в строку 26 пикселей высотой уже не
   * лез. Вместо полосы — одна кнопка «⋯», открывающая то же меню: правая
   * кнопка неочевидна, а на телефоне её нет вовсе.
   */
  import type { FileEntry } from '@shared/protocol'
  import { api } from '@/lib/api'
  import { getSessionState } from '@/lib/session.svelte'
  import { formatBytes, splitFileName } from '@/lib/utils'
  import ContextMenu, { type ContextMenuItem } from '@/components/ui/ContextMenu.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { copyText } from '@/lib/clipboard'
  import { iconFor } from '@/lib/file-icons'
  import { permitsIn } from '@/lib/may'
  import { dropFolder, movedPaths, planMove, readsInside, type Row } from '@/lib/tree-move'
  import { watchBooks } from '@/lib/yreactive.svelte'
  import {
    baseOf,
    joinPath,
    kindOf,
    parentOf,
    runnerFor,
    safeSegment,
    whySegmentRefused,
  } from '@shared/paths'

  /** One file still on the wire, and the bytes the browser has actually flushed. */
  interface Upload {
    id: number
    name: string
    size: number
    sent: number
  }

  interface Props {
    /** Открыть файл: редактор, читалка или просмотр — решает вызвавший. */
    onopen?: (path: string) => void
    /** Что открыто сейчас — эта строка подсвечена. */
    active?: string | null
    /** Файл переименовали: вкладка на него должна поехать следом. */
    onrename?: (from: string, to: string) => void
    /**
     * Запустить скрипт — тем же `file:run`, которым его запускает полоса над
     * редактором (editor/FileBar.svelte). Здесь этого действия не было, и
     * добавлено оно только пунктом меню: своей кнопки в строке дерева у запуска
     * нет и не должно быть — на .py в папке смотрят чаще, чем запускают.
     */
    onrun?: (path: string) => void
  }

  let { onopen, active = null, onrename, onrun }: Props = $props()

  const session = getSessionState()

  let dragDepth = $state(0)
  /** Папка, в которую сейчас ляжет то, что несут. Пустая строка — корень. */
  let dragInto = $state<string | null>(null)
  /** Папка, которая отказала бы: подсветка «сюда нельзя». */
  let dragDeny = $state<string | null>(null)
  /**
   * Несут файлы с диска, а не строку дерева.
   *
   * Рамка «уроните файлы сюда» принадлежит только первому случаю: своя строка,
   * пронесённая над панелью, зажигала бы приглашение к загрузке, которого никто
   * не звал.
   */
  let dragFiles = $state(false)
  /**
   * Строка, которую держат в руке.
   *
   * Помнить её приходится здесь: на весу браузер отдаёт только ТИПЫ буфера, а
   * содержимое — не раньше отпускания. Без этого подсветка не могла бы ответить
   * ни на один вопрос о том, что именно несут.
   */
  let carried = $state<Row | null>(null)
  let uploads = $state<Upload[]>([])
  /** Не ошибка, а предупреждение: загрузка прошла, но что-то заменила собой. */
  let note = $state<string | null>(null)
  let noteTimer: number | undefined
  let errorRender = $state<() => string | null>(() => null)
  const error = $derived(errorRender())
  /**
   * Что именно только что легло в буфер — самой строкой, а не словом.
   *
   * Отметка переехала из строки файла под дерево. В строке было место на одно
   * слово («скопировано»), а копировать можно и путь, и имя: слово на оба
   * случая оставляет гадать, что забрали. Под деревом место есть, и туда
   * помещается сам путь — то, что человек сейчас вставит в ячейку.
   */
  let copied = $state<string | null>(null)
  let confirming = $state<string | null>(null)
  const isHost = $derived(session.me.role === 'host')
  const may = $derived(permitsIn(session.session.rules, session.me.role, session.finished))
  /**
   * Кто может таскать строки по дереву.
   *
   * Правило комнаты — `may.files`, как у всего остального в этой панели. Роль
   * рядом с ним не лишняя: `tree:move` на сервере преподавательский, и строка,
   * которую дали взять в руку, а потом молча не перенесли, — обещание, которое
   * не сдержат. Отказ к тому же ушёл бы не сюда, а в общую полосу ошибок.
   */
  const mayDrag = $derived(may.files && isHost)
  /** Тетради комнаты: `.ipynb`, который уже открыт как тетрадь, — не файл. */
  const books = watchBooks(session.doc)
  const isBook = (path: string): boolean => books.current.some((book) => book.path === path)
  /**
   * Это МОЯ личная тетрадь.
   *
   * По правилам комнаты, а не по документу: автор и доступ живут в правилах
   * (shared/rules.ts · BookRule), потому что это право, а права не носят в
   * CRDT, где их может переписать любой. Тот же ответ даёт сервер.
   */
  const myBook = (path: string): boolean => {
    const root = books.current.find((book) => book.path === path)?.root
    const rule = root ? may.rules.books?.[root] : null
    return rule?.access === 'owner' && rule.owner === session.me.id
  }

  /** Folders open only by an explicit click or drag-hover, including on first sync. */
  let expanded = $state<Set<string>>(new Set())
  const collapsed = $derived(new Set(
    session.files.filter(entry => entry.dir && !expanded.has(entry.path)).map(entry => entry.path),
  ))
  /**
   * Строка, которой коснулись последней, — и единственный вход к её действиям
   * с пальца.
   *
   * Полоса действий (строка для ячейки, скачать, убрать) появлялась по
   * `hover`, а на планшете наведения нет: тап оставлял «наведённое» состояние
   * висеть до следующего касания, а после `future.hoverOnlyWhenSupported` в
   * tailwind.config.js не оставляет и его — с пальца до кнопок не добраться
   * вовсе. Тот же ответ, что у тулбара ячейки (CellView · `selected &&
   * opacity-100`): действия показывает ВЫДЕЛЕННАЯ строка, а выделяет её то же
   * нажатие, которым файл открывают. Мышь при этом ничего не теряет: `hover`
   * и `focus-within` остаются рядом.
   */
  let picked = $state<string | null>(null)
  /**
   * Куда лягут «новый файл», «новая папка» и загрузка. Пустая строка — корень.
   *
   * Цель — папка, которую открыли последней (или родитель открытого файла), и
   * живёт она ровно столько, сколько папка открыта: свернул — цель поднялась
   * к родителю. Так у неё есть очевидный выход, а не только «нажми на другой
   * файл», и подпись внизу всегда называет место, а не правило.
   */
  let target = $state('')
  /**
   * Та же папка строкой дерева — для броска на пунктирную кнопку внизу.
   *
   * Своего обработчика у кнопки не было, и событие всплывало в секцию, а та
   * целится в корень: надпись читалась «Файлы — в папку data», а файл ложился
   * рядом с ней. Нажатие на ту же кнопку при этом клало в `target` — один
   * элемент двумя жестами в две разные папки, и подпись врала про один из них.
   */
  const targetRow: Row | null = $derived(target ? { path: target, dir: true } : null)
  /** Строка ввода: заводим новое или переименовываем существующее. */
  let draft = $state<{ kind: 'file' | 'dir' | 'book' | 'rename'; dir: string; from?: string } | null>(
    null,
  )
  let draftName = $state('')
  let draftInput = $state<HTMLInputElement | null>(null)

  const visible = $derived(
    session.files.filter((entry) => {
      let folder = parentOf(entry.path)
      while (folder) {
        if (!expanded.has(folder)) return false
        folder = parentOf(folder)
      }
      return true
    }),
  )

  /**
   * Папки, внутри которых хоть что-то лежит.
   *
   * Список приходит плоским, и родитель читается из пути: собирать дерево ради
   * одного вопроса «пусто ли здесь» значило бы завести второй порядок обхода
   * рядом с первым — ровно то, чего сервер избегает, отдавая плоский список.
   */
  const filled = $derived(new Set(session.files.map((entry) => parentOf(entry.path))))

  /**
   * Что написать под раскрытой папкой, в которой ничего не видно, — и писать ли.
   *
   * Случая три, и «пусто» верно только в первом. Обрезанный список — не пусто:
   * обход до содержимого просто не дошёл, и об этом говорит строка внизу. Папка
   * на самом дне — тем более: туда обход не дойдёт никогда, строки внизу при
   * этом не будет (`truncated` считает только строки списка), а файлы в ней
   * лежат и место занимают — видно их одной ячейке.
   */
  function emptyWord(path: string): string | null {
    if (filled.has(path)) return null
    if (!readsInside(path)) return tr('room.ui.610')
    return truncated ? null : tr('room.ui.611')
  }

  const fileCount = $derived(session.files.filter((entry) => !entry.dir).length)
  const listed = $derived(session.files.length > 0 || uploads.length > 0)

  /**
   * Дерево показано не целиком.
   *
   * Сервер обходит папки уровень за уровнем и упирается в потолок (см.
   * `listTree` в workspace.ts): самое глубокое в список не попадает. Молчать
   * об этом нельзя — человек, не нашедший свой файл, ищет его заново, а не
   * догадывается о потолке.
   *
   * Признак едет рядом со списком, в сообщении `files`, и лежит в состоянии
   * комнаты (`session.filesTruncated`): он заменяется каждым кадром, так что
   * строка гаснет сама, как только дерево снова помещается целиком.
   */
  const truncated = $derived(session.filesTruncated)

  const depthOf = (path: string): number => path.split('/').length - 1

  /**
   * Кто держит файлы открытыми — из присутствия комнаты, одним проходом.
   *
   * Не курсоры: те живут в присутствии самого файла и до комнаты не доходят.
   * Здесь — только «кто здесь», и этого хватает, чтобы не начать править файл,
   * который в этот момент правит сосед, ничего об этом не зная.
   *
   * Карта по пути, а не поиск на каждую строку. `#readPeers` отдаёт новый
   * массив на КАЖДЫЙ чужой курсор, а прежний код на каждый такой кадр обходил
   * всех присутствующих для каждой видимой строки дерева: сто строк на
   * пятистах человек — пятьдесят тысяч сравнений за переход соседа между
   * ячейками. Теперь один проход по присутствию, и строки читают готовое.
   */
  const NOBODY: { id: string; color: string; name: string }[] = []

  const peersByPath = $derived.by(() => {
    const map = new Map<string, { id: string; color: string; name: string }[]>()
    for (const peer of session.peers) {
      const path = peer.user.editing
      if (peer.isSelf || !path) continue
      let here = map.get(path)
      if (!here) map.set(path, (here = []))
      // Три лица на строку: дальше они не поместятся, а вторая вкладка того же
      // человека — всё тот же человек.
      if (here.length >= 3 || here.some((seen) => seen.id === peer.user.id)) continue
      here.push({ id: peer.user.id, color: peer.user.color, name: peer.user.name })
    }
    return map
  })

  function peersIn(path: string): { id: string; color: string; name: string }[] {
    return peersByPath.get(path) ?? NOBODY
  }

  /**
   * Сорок пикселей — место под размер файла, и оно же под кнопку меню.
   *
   * Раньше ширина этой полосы считалась по числу значков в строке: полоса,
   * рассчитанная на две кнопки, третью выкладывала поверх имени файла — так
   * однажды и случилось, когда у PDF появилось «открыть». Кнопка теперь одна и
   * навсегда одна, сколько бы действий ни прибавилось в меню, так что считать
   * больше нечего.
   */
  const SIZE_LANE = 40

  function toggle(path: string): void {
    // Тап по стрелке — тоже прикосновение к строке: раскрыв папку пальцем,
    // человек должен видеть и то, что с ней можно сделать.
    picked = path
    const next = new Set(expanded)
    if (next.has(path)) {
      next.delete(path)
      // Свёрнутая папка целью не остаётся: файл лёг бы туда, где его не видно,
      // а вернуть цель в корень иначе было нечем — только открыть файл рядом.
      // Закрыть папку — и есть «снять выделение».
      if (target === path || target.startsWith(`${path}/`)) target = parentOf(path)
    } else {
      next.add(path)
      target = path
    }
    expanded = next
  }

  /**
   * Открыть или скачать — по одинарному щелчку.
   *
   * На том же имени висит и переименование по двойному, и второй щелчок
   * доезжал до `pick` вторым нажатием: двоичный файл заказывался и скачивался
   * дважды (два билета, два `a.click()` — датасет на гигабайт в загрузках
   * двумя копиями), папка схлопывалась и раскрывалась подряд, а студенту, у
   * которого переименования нет вовсе, оставались одни побочные действия.
   * `detail` браузер считает сам: 1 — первый щелчок, 2 — второй.
   */
  function pick(entry: FileEntry, detail = 1): void {
    if (detail > 1) return
    /*
     * Долгое нажатие пальцем кончается нажатием — и браузер шлёт `click`
     * следом за тем, как меню уже открылось. Без этой строки вызванное пальцем
     * меню открывало бы заодно файл, по которому его вызвали: вкладка поверх
     * меню, а меню всё ещё про файл, который в эту секунду грузится.
     */
    if (heldOpen) {
      heldOpen = false
      return
    }
    // Выделение — до любых отказов ниже: строка, по которой нажали, показывает
    // свои действия, даже если открыть файл правило комнаты не дало.
    picked = entry.path
    if (entry.dir) {
      // Цель ставит и снимает `toggle`: открытая папка — цель, закрытая — нет.
      toggle(entry.path)
      return
    }
    target = parentOf(entry.path)
    // Двоичное не открыть ничем: нажатие на нём означает «дай мне его сюда».
    if (kindOf(entry.path) === 'binary') {
      void download(entry.path)
      return
    }
    /*
     * Тетрадь, которой в комнате ещё нет, вносит сервер — и может отказать.
     * Вкладка на неё открылась бы сразу и осталась бы навсегда с «Открываю…»:
     * тетради, которую не завели, в комнате не появится, и закрывать вкладку
     * нечему. Отказ — здесь, до нажатия, теми же словами, которыми ответил бы
     * сервер.
     *
     * Спрашивается `ownBook`, а не `files`: внести .ipynb в комнату — значит
     * добавить тетрадь, и правило у этого своё (shared/rules.ts · ownBooks).
     * Положить файл в папку и внести его в комнату — разные вещи, и стояла
     * здесь проверка не та.
     */
    if (kindOf(entry.path) === 'notebook' && !may.ownBook && !isBook(entry.path)) {
      // Из `may`, как в двух соседних ветках: свои слова здесь после звонка
      // называли правило, которого никто не менял.
      errorRender = () => (may.ownBookWhy + '.')
      return
    }
    onopen?.(entry.path)
  }

  /**
   * Fetch a ticket, then let the browser take the file.
   *
   * The anchor is gone because an anchor could only carry the session token,
   * and that token opens the control socket: a link copied into the group chat
   * handed every reader Restart and Restore under the teacher's name. The
   * ticket in this URL is good for one file for five minutes.
   */
  async function download(path: string): Promise<void> {
    try {
      const { token } = await api.fileTicket(session.session.id, path, session.token)
      const a = document.createElement('a')
      a.href = api.fileUrl(session.session.id, path, token)
      a.download = baseOf(path)
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      errorRender = () => (err instanceof Error ? tr(err.message) : tr('room.ui.612'))
    }
  }

  /* ------------------------------------------------------- новое и имена */

  function startDraft(kind: 'file' | 'dir' | 'book'): void {
    draft = { kind, dir: target }
    // У тетради расширение подставлено и выделено не будет: человек набирает
    // имя, а `.ipynb` — не его забота.
    draftName = kind === 'book' ? '.ipynb' : ''
    queueMicrotask(() => {
      draftInput?.focus()
      draftInput?.setSelectionRange(0, 0)
    })
  }

  function startRename(entry: FileEntry): void {
    if (!isHost) return
    draft = { kind: 'rename', dir: parentOf(entry.path), from: entry.path }
    draftName = entry.name
    queueMicrotask(() => {
      draftInput?.focus()
      // Выделено имя без расширения: переименовывают обычно его, а не `.py`.
      const dot = draftName.lastIndexOf('.')
      draftInput?.setSelectionRange(0, dot > 0 ? dot : draftName.length)
    })
  }

  function commitDraft(): void {
    const current = draft
    if (!current) return
    const name = draftName.trim()
    /*
     * Черновик тетради начинается с подставленного `.ipynb`, и «ничего не
     * набрали» выглядит здесь не как пустая строка, а как одно расширение.
     * Без этой ветки уход из поля мимо давал отказ «имя начинается с точки», а
     * поле не закрывалось: каждый следующий щелчок мимо повторял ту же ошибку,
     * и выйти можно было только Escape. Пустое имя закрывает поле — так и у
     * файла, и у папки.
     */
    if (!name || (current.kind === 'book' && name === '.ipynb')) return cancelDraft()
    if (!safeSegment(name)) {
      errorRender = () => (whySegmentRefused(name))
      return
    }
    const path = joinPath(current.dir, current.kind === 'book' && !name.endsWith('.ipynb') ? name + '.ipynb' : name)
    if (current.kind === 'rename') {
      if (current.from && current.from !== path) {
        /*
         * Занятое имя видно отсюда — список файлов комнаты уже здесь.
         *
         * Вкладка переезжает на новое имя сразу и обязана: рассылка списка
         * приходит позже и закрыла бы её как вкладку на исчезнувший файл. Но
         * если сервер откажет, списка не будет вовсе, а вкладка уже стоит на
         * несуществующем пути — редактор отпустит документ вместе с историей
         * отмен и закроется по 4404. Поэтому то, чем сервер отказал бы,
         * проверяется до отправки, его же словами.
         */
        if (!session.files.some((entry) => entry.path === current.from)) {
          errorRender = () => (tr('room.ui.613', { p0: baseOf(current.from!) }))
          return
        }
        if (session.files.some((entry) => entry.path === path)) {
          errorRender = () => (tr('room.ui.614', { p0: baseOf(path) }))
          return
        }
        session.send({ t: 'tree:move', from: current.from, to: path })
        // Переименовать могли и папку — тогда переезжает всё, что в ней, и
        // вкладки на содержимое обязаны уехать вместе с ним.
        for (const moved of movedPaths(current.from, path, session.files)) {
          onrename?.(moved.from, moved.to)
        }
      }
    } else if (current.kind === 'dir') {
      session.send({ t: 'tree:mkdir', path })
    } else if (current.kind === 'book') {
      session.send({ t: 'tree:new', path })
      pendingOpen = path
    } else {
      session.send({ t: 'tree:new', path })
      // Открыть сразу: новый файл заводят, чтобы в него что-то написать, и
      // лишний поиск его же в дереве — это работа на ровном месте.
      pendingOpen = path
    }
    cancelDraft()
  }

  /**
   * Файл, который завели и хотят открыть, как только он появится в списке.
   *
   * Список приходит с сервера, а не сочиняется здесь: открывать файл до того,
   * как сервер подтвердил, что он есть, значило бы открывать вкладку на то,
   * чего может и не оказаться — имя занято, папка исчезла, правило поменялось.
   *
   * `$state`, а не обычная переменная, и это не украшение: эффект ниже читает
   * её первой строкой и на `null` выходит, ничего больше не прочитав. Обычная
   * переменная не была бы его зависимостью — эффект отработал бы один раз при
   * монтировании и не проснулся бы никогда, а файл открывался бы «когда-нибудь
   * потом», то есть при следующей чужой правке.
   */
  let pendingOpen = $state<string | null>(null)

  $effect(() => {
    if (!pendingOpen) return
    const waiting = pendingOpen
    if (!session.files.some((entry) => entry.path === waiting)) return
    pendingOpen = null
    onopen?.(waiting)
  })

  function cancelDraft(): void {
    draft = null
    draftName = ''
  }

  /*
   * A destructive question you cannot back out of with the keyboard is a trap,
   * and this one appears inline in a row rather than in a dialog you can see
   * the edges of. Escape cancels it; a delete already in flight is left alone,
   * because pretending to cancel something the server is doing would be a lie.
   */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    // Съеденный ключ помечается: ящик терминала закрывается по Escape, если он
    // никому не понадобился, и «отменил имя файла» — это как раз тот случай,
    // когда он понадобился.
    if (draft) {
      event.preventDefault()
      return cancelDraft()
    }
    if (!confirming || deleting) return
    event.preventDefault()
    confirming = null
  }
  let deleting = $state<string | null>(null)
  let picker: HTMLInputElement | null = $state(null)
  let copyTimer: number | undefined
  let nextUploadId = 0

  $effect(() => () => {
    window.clearTimeout(copyTimer)
    // Иначе таймер развернёт папку в панели, которой на экране уже нет.
    window.clearTimeout(hoverTimer)
    // А эти открыли бы меню на строке, которой уже нет, — и держали бы её
    // запись в памяти вместе со всем деревом.
    window.clearTimeout(holdTimer)
    window.clearTimeout(heldTimer)
    // И подсветку копии вместе с памятью о том, каким дерево было до неё.
    window.clearTimeout(freshTimer)
    window.clearTimeout(waitTimer)
  })

  function percent(upload: Upload): number {
    // A zero-byte file has nothing to report and is already there by the time
    // the row paints; anything else is a genuine fraction of the payload.
    if (upload.size === 0) return 100
    return Math.min(100, Math.round((upload.sent / upload.size) * 100))
  }

  /*
   * XMLHttpRequest rather than api.uploadFiles(), which is built on fetch —
   * fetch has no upload progress event at all, so a bar driven by it would be
   * an animation rather than a measurement. `xhr.upload.progress` reports bytes
   * handed to the socket, which is the only honest number available here.
   *
   * One request per file, in sequence: a batched multipart body can only report
   * a batch percentage, and the design puts the percentage on the row.
   */
  function put(
    file: File,
    dir: string,
    onSent: (sent: number) => void,
  ): Promise<{ files: FileEntry[]; replaced: string[] }> {
    return new Promise((resolve, reject) => {
      const form = new FormData()
      // Папка первой: busboy разбирает части по порядку, и поле, приехавшее
      // после файла, опоздало бы ровно на тот файл, ради которого его послали.
      form.append('dir', dir)
      form.append('file', file, file.name)

      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/sessions/${session.session.id}/files`)
      xhr.setRequestHeader('authorization', `Bearer ${session.token}`)
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onSent(event.loaded)
      }
      xhr.onload = () => {
        let body: { files?: FileEntry[]; replaced?: string[]; error?: string } = {}
        try {
          body = JSON.parse(xhr.responseText) as typeof body
        } catch {
          /* non-JSON error body */
        }
        if (xhr.status >= 200 && xhr.status < 300 && body.files) {
          resolve({ files: body.files, replaced: body.replaced ?? [] })
        } else reject(new Error(body.error || xhr.statusText || tr('room.ui.618')))
      }
      xhr.onerror = () => reject(new Error(tr('room.ui.618')))
      xhr.send(form)
    })
  }

  async function upload(list: FileList | File[] | null, dir: string) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    // Право — до первого байта: отказ, приходящий после выбора файла, человек
    // читает как поломку, а не как правило комнаты.
    if (!may.files) {
      errorRender = () => (may.filesWhy + '.')
      return
    }
    errorRender = () => (null)

    const queued: Upload[] = files.map((file) => ({
      id: nextUploadId++,
      name: file.name,
      size: file.size,
      sent: 0,
    }))
    uploads = [...uploads, ...queued]

    /*
     * Что легло поверх уже лежавшего.
     *
     * Одноимённый файл заменялся молча: человек роняет в комнату свою
     * `data.csv`, а под этим именем уже лежит чужая, на которой в семинаре
     * что-то считают. Отменить это нечем, но и узнавать об этом по числам —
     * слишком поздно. Собирается за весь заход и говорится одной строкой.
     */
    const overwritten: string[] = []

    for (let i = 0; i < files.length; i++) {
      const { id } = queued[i]
      try {
        const done = await put(files[i], dir, (sent) => {
          uploads = uploads.map((item) => (item.id === id ? { ...item, sent } : item))
        })
        session.files = done.files
        overwritten.push(...done.replaced)
      } catch (err) {
        errorRender = () => (err instanceof Error ? tr(err.message) : tr('room.ui.619', { p0: files[i].name }))
      } finally {
        uploads = uploads.filter((item) => item.id !== id)
      }
    }

    if (overwritten.length > 0 && !error) {
      note =
        overwritten.length === 1
          ? tr('room.ui.620', { p0: overwritten[0] })
          : tr('room.ui.621', { p0: overwritten.join(', ') })
      window.clearTimeout(noteTimer)
      noteTimer = window.setTimeout(() => (note = null), 8000)
    }
  }

  function remove(entry: FileEntry): void {
    deleting = entry.path
    errorRender = () => (null)
    session.send({ t: 'tree:remove', path: entry.path })
    confirming = null
    // Ответа нет: список файлов приходит комнате целиком, и строка исчезает
    // вместе с ним. Отказ, если он будет, придёт обычной строкой ошибки.
    window.setTimeout(() => (deleting = null), 600)
  }

  /**
   * Положить в буфер — и показать строкой, ЧТО именно туда легло.
   *
   * Одна дверь на оба пункта меню: путь и имя отличаются только текстом, а
   * отказ буфера у них общий (на http без localhost `navigator.clipboard`
   * попросту нет — см. lib/clipboard.ts).
   *
   * Две с половиной секунды, а не полторы: прочитать `data/train.csv` дольше,
   * чем увидеть галочку.
   */
  async function copyInto(text: string): Promise<void> {
    try {
      await copyText(text)
      copied = text
      window.clearTimeout(copyTimer)
      copyTimer = window.setTimeout(() => (copied = null), 2600)
    } catch {
      errorRender = () => (tr('room.ui.622'))
    }
  }

  /* --------------------------------------------------------------- меню */

  /**
   * Что сейчас под меню: строка дерева или пустое место панели.
   *
   * Запись, а не путь строкой: у меню спрашивают и `dir`, и имя, и расширение,
   * а искать строку в списке на каждый пункт значило бы искать её заново после
   * каждой чужой правки дерева. Пропажу самой строки ловит эффект ниже — он и
   * закрывает меню, повисшее над файлом, которого уже нет.
   */
  type MenuOn = { kind: 'entry'; entry: FileEntry } | { kind: 'panel' }

  /** Где стоит меню — в координатах окна. `null` — меню закрыто. */
  let menuAt = $state<{ x: number; y: number } | null>(null)
  let menuOn = $state<MenuOn | null>(null)
  /** Куда вернуть фокус, когда меню закроют: строка или кнопка «⋯». */
  let menuOpener = $state<HTMLElement | null>(null)
  /** Сама панель: по ней ходят стрелки вверх-вниз. */
  let panel = $state<HTMLElement | null>(null)

  function openMenu(
    point: { x: number; y: number },
    on: MenuOn,
    opener: HTMLElement | null,
  ): void {
    menuOn = on
    menuOpener = opener
    menuAt = point
    // Подсказка про правую кнопку нужна ровно до первого открытого меню.
    rememberTip()
  }

  function closeMenu(): void {
    menuAt = null
    menuOn = null
    menuOpener = null
  }

  /*
   * Строку, над которой висело меню, могли убрать — своей же кнопкой,
   * перетаскиванием или из соседней вкладки. Меню про исчезнувший файл — это
   * набор действий, каждое из которых ответит «его больше нет».
   */
  $effect(() => {
    const on = menuOn
    if (on?.kind !== 'entry') return
    if (!session.files.some((entry) => entry.path === on.entry.path)) closeMenu()
  })

  /** Кнопка имени внутри строки — то, чему возвращают фокус и по чему ходят стрелки. */
  function nameButtonIn(row: EventTarget | null): HTMLElement | null {
    return row instanceof HTMLElement ? row.querySelector<HTMLElement>('[data-row-name]') : null
  }

  function onRowMenu(event: MouseEvent, entry: FileEntry): void {
    event.preventDefault()
    // Своя строка перебивает панель: то же событие всплывает к секции, а та
    // открывает меню про корень папки занятия.
    event.stopPropagation()
    picked = entry.path
    openMenu({ x: event.clientX, y: event.clientY }, { kind: 'entry', entry }, nameButtonIn(event.currentTarget))
  }

  function onPanelMenu(event: MouseEvent): void {
    event.preventDefault()
    openMenu({ x: event.clientX, y: event.clientY }, { kind: 'panel' }, null)
  }

  /** «⋯» открывает то же меню — и вторым нажатием закрывает его. */
  function onMoreClick(event: MouseEvent, entry: FileEntry): void {
    event.stopPropagation()
    const button = event.currentTarget as HTMLElement
    if (menuOn?.kind === 'entry' && menuOn.entry.path === entry.path) {
      closeMenu()
      return
    }
    picked = entry.path
    const box = button.getBoundingClientRect()
    // От кнопки вниз, а не от указателя: нажать «⋯» можно и с клавиатуры, и
    // тогда никакого указателя нет вовсе. За правую кромку окна меню не уедет
    // — его прижмёт сам компонент.
    openMenu({ x: box.left, y: box.bottom + 2 }, { kind: 'entry', entry }, button)
  }

  /* ------------------------------------------------- клавиши на строке */

  /**
   * Клавиатура на строке дерева.
   *
   * Shift+F10 и клавиша «меню» — общесистемный способ позвать контекстное меню,
   * и он единственный, каким до него добирается тот, у кого нет мыши. F2 и
   * Delete — то же, что в любом файловом менеджере; стрелки ходят по строкам,
   * потому что Tab внутри дерева из ста файлов — это сто нажатий.
   */
  function onRowKeydown(event: KeyboardEvent, entry: FileEntry): void {
    const row = event.currentTarget as HTMLElement
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
      const box = row.getBoundingClientRect()
      picked = entry.path
      openMenu({ x: box.left + 8, y: box.bottom + 2 }, { kind: 'entry', entry }, row)
      return
    }
    if (event.key === 'F2') {
      event.preventDefault()
      if (mayRename) startRename(entry)
      else errorRender = () => whyEdit
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      askRemove(entry)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      step(row, event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  /**
   * Соседняя строка — по разметке, а не по списку `visible`.
   *
   * Список знает пути, а фокус ставят элементу, и сопоставлять одно с другим
   * пришлось бы через `querySelector` по пути — то есть через селектор,
   * собранный из имени файла, которое человек придумал сам (кавычка в имени, и
   * селектор невалиден). Порядок кнопок в разметке и есть порядок дерева.
   */
  function step(from: HTMLElement, by: number): void {
    if (!panel) return
    const rows = [...panel.querySelectorAll<HTMLElement>('[data-row-name]')]
    const now = rows.indexOf(from)
    if (now < 0) return
    // По краям — стоим. Круг по списку файлов уводил бы с последней строки на
    // первую, а дерево читают сверху вниз.
    rows[now + by]?.focus()
  }

  /* -------------------------------------------------- долгое нажатие */

  let holdTimer: number | undefined
  /** Откуда начали держать — чтобы отличить нажатие от прокрутки. */
  let holdFrom: { x: number; y: number } | null = null
  /** Меню открылось пальцем: следующий `click` по этой строке — эхо жеста. */
  let heldOpen = false
  let heldTimer: number | undefined

  /**
   * Полсекунды пальцем на строке — то же меню.
   *
   * Правой кнопки на телефоне нет, а «⋯» требует сперва попасть по строке и
   * только потом по значку. Полсекунды — общая для платформ планка долгого
   * нажатия; меньше срабатывало бы у тех, кто просто ведёт пальцем по списку.
   *
   * Android присылает `contextmenu` на то же самое нажатие, и меню от этого
   * открывается дважды подряд в одной точке — то есть ровно один раз на
   * экране. iOS `contextmenu` не шлёт вовсе, и без таймера меню там не
   * открывалось бы ничем.
   */
  function onRowPointerDown(event: PointerEvent, entry: FileEntry): void {
    if (event.pointerType !== 'touch') return
    const row = event.currentTarget
    holdFrom = { x: event.clientX, y: event.clientY }
    window.clearTimeout(holdTimer)
    holdTimer = window.setTimeout(() => {
      holdFrom = null
      heldOpen = true
      // Эхо живёт полсекунды: если `click` за ним так и не придёт (палец увели
      // с экрана), следующий настоящий тап не должен пропасть.
      window.clearTimeout(heldTimer)
      heldTimer = window.setTimeout(() => (heldOpen = false), 700)
      picked = entry.path
      openMenu({ x: event.clientX, y: event.clientY }, { kind: 'entry', entry }, nameButtonIn(row))
    }, 500)
  }

  /** Палец поехал — это прокрутка, а не нажатие. */
  function onRowPointerMove(event: PointerEvent): void {
    if (!holdFrom) return
    if (Math.abs(event.clientX - holdFrom.x) < 10 && Math.abs(event.clientY - holdFrom.y) < 10) {
      return
    }
    endHold()
  }

  function endHold(): void {
    window.clearTimeout(holdTimer)
    holdFrom = null
  }

  /* ------------------------------------------------------------ права */

  /**
   * Переименовать и убрать может преподаватель — и это не то же самое, что
   * `files`.
   *
   * `tree:move` на сервере преподавательский целиком (control.ts), а удаление
   * — преподавательское с одним исключением: СВОЮ личную тетрадь автор убирает
   * сам. Фраза выбирается так же, как везде в комнате: правило комнаты важно
   * ровно до звонка, после звонка человеку важно только то, что пара кончилась
   * (lib/may.ts · CLASS_IS_OVER).
   */
  const mayRename = $derived(isHost && may.files)
  const whyEdit = $derived(may.files ? tr('room.files.menu.hostOnly') : may.filesWhy)
  const mayRemove = (path: string): boolean => isHost || myBook(path)

  function askRemove(entry: FileEntry): void {
    if (!mayRemove(entry.path)) {
      errorRender = () => whyEdit
      return
    }
    confirming = entry.path
  }

  /**
   * Дерево в тот миг, когда попросили копию, — чтобы узнать её в лицо.
   *
   * Имя копии выбирает сервер (там нет гонки за занятое имя), и вкладке оно
   * приезжает обычным списком файлов. В дереве из сотни строк новая строка
   * появляется где-то посередине, и найти её глазами — та же работа, от
   * которой дублирование и избавляет. Поэтому список запоминается до отправки,
   * а появившийся путь подсвечивается на полторы секунды.
   *
   * `$state`, а не обычная переменная: эффект ниже читает её первой строкой, и
   * обычная не была бы его зависимостью — он не проснулся бы никогда.
   */
  let beforeCopy = $state<Set<string> | null>(null)
  /** Строка, которая только что появилась копией. */
  let freshCopy = $state<string | null>(null)
  let freshTimer: number | undefined
  let waitTimer: number | undefined

  function duplicate(entry: FileEntry): void {
    if (!may.files) {
      errorRender = () => (may.filesWhy + '.')
      return
    }
    errorRender = () => (null)
    beforeCopy = new Set(session.files.map((row) => row.path))
    // Сервер мог и отказать — тогда нового пути не появится вовсе. Без этого
    // срока память о запросе жила бы до конца пары и подсветила бы чужой файл,
    // который кто-нибудь загрузил через полчаса.
    window.clearTimeout(waitTimer)
    waitTimer = window.setTimeout(() => (beforeCopy = null), 5000)
    // Имя копии выбирает сервер: занятое имя здесь не отказ, а обычное дело —
    // дублируют одно и то же дважды подряд (shared/protocol.ts · tree:copy).
    session.send({ t: 'tree:copy', path: entry.path })
  }

  $effect(() => {
    const was = beforeCopy
    if (!was) return
    const added = session.files.filter((row) => !was.has(row.path))
    if (added.length === 0) return
    beforeCopy = null
    window.clearTimeout(waitTimer)
    // Первая из появившихся: копия одна, а всё остальное в этот же кадр —
    // чужие загрузки, и подсвечивать их незачем.
    freshCopy = added[0].path
    window.clearTimeout(freshTimer)
    freshTimer = window.setTimeout(() => (freshCopy = null), 1600)
  })

  /** Завести что-нибудь ВНУТРИ этой папки: цель переезжает туда же. */
  function startDraftIn(kind: 'file' | 'dir' | 'book', dir: string): void {
    // Свёрнутая папка раскрывается: строка ввода стоит там, где появится файл,
    // и в закрытой папке её не видно вовсе — поле молча ушло бы «никуда».
    if (dir && !expanded.has(dir)) expanded = new Set(expanded).add(dir)
    target = dir
    startDraft(kind)
  }

  function uploadInto(dir: string): void {
    if (dir && !expanded.has(dir)) expanded = new Set(expanded).add(dir)
    target = dir
    picker?.click()
  }

  /* ------------------------------------------------------ состав меню */

  function copyItem(text: string, label: string): ContextMenuItem {
    return { label, icon: 'copy', run: () => void copyInto(text) }
  }

  function fileItems(entry: FileEntry): ContextMenuItem[] {
    const path = entry.path
    const kind = kindOf(path)
    const runner = runnerFor(path)
    const items: ContextMenuItem[] = []
    /*
     * «Открыть» — ровно то же, что щелчок по строке, и поэтому его нет у
     * двоичного файла: щелчок по нему означает «дай мне его сюда», то есть уже
     * «Скачать». Два пункта, делающие одно и то же, читаются как два разных
     * действия, и одно из них человек выберет наугад.
     */
    if (kind !== 'binary') {
      items.push({
        label: tr('room.files.menu.open'),
        icon: kind === 'notebook' ? 'notebook' : 'file',
        // Внести .ipynb в комнату — ДОБАВИТЬ тетрадь, и правило у этого своё
        // (shared/rules.ts · ownBooks). Тот же ответ даёт сервер.
        disabled: kind === 'notebook' && !isBook(path) && !may.ownBook,
        why: may.ownBookWhy,
        run: () => pick(entry),
      })
    }
    if (runner && onrun) {
      items.push({
        label: tr('room.files.menu.run'),
        icon: 'play',
        disabled: !may.run,
        why: may.runWhy,
        run: () => onrun?.(path),
      })
    }
    items.push(
      { ...copyItem(path, tr('room.files.menu.copyPath')), gap: items.length > 0 },
      copyItem(entry.name, tr('room.files.menu.copyName')),
      {
        gap: true,
        label: tr('room.files.menu.download'),
        icon: 'download',
        run: () => void download(path),
      },
      {
        label: tr('room.files.menu.duplicate'),
        icon: 'copy-plus',
        // Копия ДОБАВЛЯЕТ файл, как «новый файл» и как загрузка, — значит и
        // правило у неё `files`, а не роль (server/src/control.ts · tree:copy).
        disabled: !may.files,
        why: may.filesWhy,
        run: () => duplicate(entry),
      },
      {
        gap: true,
        label: tr('room.files.menu.rename'),
        icon: 'pencil',
        keys: 'F2',
        disabled: !mayRename,
        why: whyEdit,
        run: () => startRename(entry),
      },
      {
        label: tr('room.files.menu.remove'),
        icon: 'trash',
        keys: 'Del',
        danger: true,
        disabled: !mayRemove(path),
        why: whyEdit,
        // В то же подтверждение строкой ниже, что и раньше: второе окно поверх
        // меню спрашивало бы одно и то же дважды.
        run: () => (confirming = path),
      },
    )
    return items
  }

  function folderItems(entry: FileEntry): ContextMenuItem[] {
    const path = entry.path
    const shut = collapsed.has(path)
    return [
      {
        label: shut ? tr('room.files.menu.expand') : tr('room.files.menu.collapse'),
        icon: shut ? 'chevron-right' : 'chevron-down',
        run: () => toggle(path),
      },
      {
        gap: true,
        label: tr('room.files.menu.newFileHere'),
        icon: 'file-plus',
        disabled: !may.files,
        why: may.filesWhy,
        run: () => startDraftIn('file', path),
      },
      {
        label: tr('room.files.menu.newDirHere'),
        icon: 'folder-plus',
        disabled: !may.files,
        why: may.filesWhy,
        run: () => startDraftIn('dir', path),
      },
      {
        label: tr('room.files.menu.newBookHere'),
        icon: 'notebook',
        disabled: !may.ownBook,
        why: may.ownBookWhy,
        run: () => startDraftIn('book', path),
      },
      {
        label: tr('room.files.menu.uploadHere'),
        icon: 'upload',
        disabled: !may.files,
        why: may.filesWhy,
        run: () => uploadInto(path),
      },
      { ...copyItem(path, tr('room.files.menu.copyPath')), gap: true },
      {
        label: tr('room.files.menu.duplicate'),
        icon: 'copy-plus',
        disabled: true,
        // Теми же словами, которыми отказал бы сервер: одна фраза на оба конца
        // (server/src/control.ts · tree:copy).
        why: tr('server.files.copyFolder'),
        run: () => {},
      },
      {
        gap: true,
        label: tr('room.files.menu.rename'),
        icon: 'pencil',
        keys: 'F2',
        disabled: !mayRename,
        why: whyEdit,
        run: () => startRename(entry),
      },
      {
        label: tr('room.files.menu.remove'),
        icon: 'trash',
        keys: 'Del',
        danger: true,
        disabled: !mayRemove(path),
        why: whyEdit,
        run: () => (confirming = path),
      },
    ]
  }

  /** Пустое место панели: только то, что кладут В папку занятия. */
  function panelItems(): ContextMenuItem[] {
    return [
      {
        label: tr('room.files.menu.newFile'),
        icon: 'file-plus',
        disabled: !may.files,
        why: may.filesWhy,
        run: () => startDraft('file'),
      },
      {
        label: tr('room.files.menu.newDir'),
        icon: 'folder-plus',
        disabled: !may.files,
        why: may.filesWhy,
        run: () => startDraft('dir'),
      },
      {
        label: tr('room.files.menu.newBook'),
        icon: 'notebook',
        disabled: !may.ownBook,
        why: may.ownBookWhy,
        run: () => startDraft('book'),
      },
      {
        gap: true,
        label: tr('room.files.menu.upload'),
        icon: 'upload',
        disabled: !may.files,
        why: may.filesWhy,
        run: () => picker?.click(),
      },
    ]
  }

  const menuItems = $derived.by(() => {
    const on = menuOn
    if (!on) return []
    if (on.kind === 'panel') return panelItems()
    return on.entry.dir ? folderItems(on.entry) : fileItems(on.entry)
  })

  const menuTitle = $derived(menuOn?.kind === 'entry' ? menuOn.entry.name : null)

  const menuLabel = $derived.by(() => {
    const on = menuOn
    if (!on) return ''
    if (on.kind === 'panel') return tr('room.files.menu.panel')
    return on.entry.dir ? tr('room.files.menu.folder') : tr('room.files.menu.file')
  })

  /* ----------------------------------------------------- подсказка раз */

  /**
   * «Правая кнопка — действия с файлом» — одной строкой и ровно до тех пор,
   * пока человек ни разу меню не открывал.
   *
   * Подсказка, висящая всегда, перестаёт быть подсказкой и становится частью
   * интерфейса, которую перестают читать. Флаг лежит в браузере, а не в
   * комнате: это про руку, а не про занятие, и в приватном окне его просто не
   * будет — тогда подсказка покажется ещё раз, и это не беда.
   */
  const TIP_KEY = 'colloq.files.menuTip'

  function tipWasSeen(): boolean {
    try {
      return localStorage.getItem(TIP_KEY) === '1'
    } catch {
      // Хранилище закрыто (приватное окно, запрет на куки) — считаем, что
      // показывать незачем: подсказка не стоит исключения на каждый кадр.
      return true
    }
  }

  let tipSeen = $state(tipWasSeen())

  function rememberTip(): void {
    if (tipSeen) return
    tipSeen = true
    try {
      localStorage.setItem(TIP_KEY, '1')
    } catch {
      /* хранилища нет — подсказка просто вернётся в следующий раз */
    }
  }

  /* ------------------------------------------------------- перетаскивание */

  /**
   * Свой тип в буфере — и путь в нём.
   *
   * `text/plain` кладётся рядом, но решает не он: текст в буфере есть у любого
   * выделения на странице, и панель, доверяющая ему, приняла бы за строку
   * дерева кусок вывода ячейки. Тип свой, потому что вопрос «своё ли это»
   * задаётся на весу, когда содержимое буфера ещё не читается.
   */
  const PATH_TYPE = 'application/x-colloq-path'

  /** Что несут: свою строку, файлы с диска — или ничего, что нам подходит. */
  function carriedKind(event: DragEvent): 'row' | 'files' | null {
    const types = event.dataTransfer?.types
    if (!types) return null
    if (types.includes(PATH_TYPE)) return 'row'
    if (types.includes('Files')) return 'files'
    return null
  }

  /**
   * Отказ, сказанный, пока запись ещё в руке.
   *
   * Цель, помеченную `dropEffect: 'none'`, браузер не отдаёт: события `drop` на
   * ней не будет вовсе, и сказать по отпусканию было бы негде. Значит, слова
   * появляются на весу — и снимаются сами, как только целятся туда, куда можно.
   * Флаг нужен, чтобы снять только СВОЁ: рядом в той же строке живут отказы
   * загрузки, и гасить их движением мыши нельзя.
   */
  let saidOnDrag = false

  function sayRefusal(why: string | null): void {
    if (why) {
      errorRender = () => (why)
      saidOnDrag = true
      return
    }
    if (!saidOnDrag) return
    saidOnDrag = false
    errorRender = () => (null)
  }

  function onDragStart(event: DragEvent, entry: FileEntry): void {
    const data = event.dataTransfer
    if (!data || !mayDrag) return
    // Прошлый отказ был про прошлый жест.
    sayRefusal(null)
    data.setData(PATH_TYPE, entry.path)
    // Рядом — обычным текстом: то же самое видно всему, что умеет принимать
    // текст, включая ячейку и терминал.
    data.setData('text/plain', entry.path)
    data.effectAllowed = 'move'
    carried = { path: entry.path, dir: entry.dir }
  }

  function onDragEnd(): void {
    carried = null
    endDrag()
  }

  /** Конец жеста: гаснет всё, что он зажёг, — и таймер тоже, обязательно. */
  function endDrag(): void {
    dragDepth = 0
    dragFiles = false
    dragInto = null
    dragDeny = null
    // И слова тоже: отказ был про этот жест, а жест кончился. Иначе отменённое
    // перетаскивание — Escape, указатель мимо панели — оставляло красную полосу
    // про отказ, которого уже нет, до следующего жеста или загрузки.
    sayRefusal(null)
    hoverOver(null)
  }

  /**
   * Свёрнутая папка под указателем разворачивается сама — но не сразу.
   *
   * Полсекунды: за меньшее дерево раскрывалось бы под рукой у всякого, кто
   * просто проносит запись мимо, и цель уезжала бы из-под указателя. Таймер
   * снимается на каждом уходе и на отпускании — иначе он развернёт папку, над
   * которой уже никого нет.
   *
   * Обычные переменные, а не `$state`: их никто не рисует, а состояние, которое
   * пишет таймер и читает разметка, — верный способ получить эффект, который
   * будит сам себя.
   */
  let hoverDir = ''
  let hoverTimer: number | undefined

  function hoverOver(dir: string | null): void {
    const wanted = dir !== null && collapsed.has(dir) ? dir : ''
    if (wanted === hoverDir) return
    hoverDir = wanted
    window.clearTimeout(hoverTimer)
    if (!wanted) return
    hoverTimer = window.setTimeout(() => {
      // Только разворачивает: свернуть папку под указателем — фокус, а не
      // помощь, и цель исчезла бы вместе со своими строками.
      const next = new Set(expanded)
      next.add(wanted)
      expanded = next
    }, 500)
  }

  /**
   * Куда сейчас целится жест.
   *
   * Зовётся из `dragover` — того самого события, которое обязано звать
   * `preventDefault`: без него браузер броска не примет вовсе, а файл с диска
   * просто откроет вместо страницы. Из него же, а не из `dragenter`, ставится
   * подсветка: `dragenter` на потомке строки приходит раньше, чем `dragleave`
   * на ней самой, и рамка гасла ровно над именем папки, в которую целятся.
   *
   * `stopPropagation` на строке — чтобы она перебивала секцию: то же событие
   * всплывает к ней, а секция целится в корень.
   */
  function aim(event: DragEvent, onto: Row | null): void {
    const kind = carriedKind(event)
    if (!kind) return
    event.preventDefault()
    if (onto) event.stopPropagation()
    const data = event.dataTransfer
    if (!data) return
    const into = dropFolder(onto)
    if (kind === 'files') {
      /*
       * Право известно уже сейчас — ждать отпускания незачем. Папка, светящаяся
       * акцентом тому, кому класть нельзя, обещает копию, которой не будет, и
       * панель в эту же секунду говорит обратное: пунктирная кнопка внизу
       * отключена и названа правилом. Слова — на весу, как и у строк дерева:
       * цель с `dropEffect: 'none'` события `drop` не отдаёт вовсе.
       */
      if (!may.files) {
        data.dropEffect = 'none'
        dragInto = null
        dragDeny = into
        // В пустой комнате то же самое написано во весь оверлей — повторять
        // одну фразу дважды на одном экране незачем.
        sayRefusal(listed ? may.filesWhy + '.' : null)
        return
      }
      data.dropEffect = 'copy'
      dragInto = into
      dragDeny = null
      sayRefusal(null)
      hoverOver(into)
      return
    }
    // Строка из другого окна: путь в буфере есть, а сверить его с этим деревом
    // нечем — на весу буфер не читается. Обещать переезд в таком случае нельзя.
    const plan = carried ? planMove(carried, onto, session.files) : null
    const goes = plan?.do === 'move'
    data.dropEffect = goes ? 'move' : 'none'
    dragInto = goes ? into : null
    dragDeny = plan?.do === 'refuse' ? into : null
    sayRefusal(plan?.do === 'refuse' ? plan.why : null)
    hoverOver(into)
  }

  function onDragEnter(event: DragEvent) {
    const kind = carriedKind(event)
    if (!kind) return
    dragDepth += 1
    if (dragDepth === 1) dragFiles = kind === 'files'
  }

  function onDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1)
    // Ушли из панели совсем: подсветка, оставшаяся на строке, над которой уже
    // никого нет, обещает переезд, которого не будет.
    if (dragDepth === 0) endDrag()
  }

  function onDrop(event: DragEvent, onto: Row | null) {
    event.preventDefault()
    event.stopPropagation()
    const kind = carriedKind(event)
    // Путь берётся из буфера, а не из `carried`: буфер переживает и смену
    // вкладки, и второе окно этой же комнаты.
    const path = kind === 'row' ? (event.dataTransfer?.getData(PATH_TYPE) ?? '') : ''
    endDrag()
    if (kind === 'row') {
      carried = null
      if (!path) return
      // Право спрашивают и здесь, а не только у `draggable`: строка могла
      // приехать из окна, открытого до того, как правила комнаты сменились.
      if (!mayDrag) {
        errorRender = () => (may.filesWhy + '.')
        saidOnDrag = false
        return
      }
      // Папка это или файл, знает список комнаты, а не буфер: `planMove` всё
      // равно первым делом сверяется с ним.
      const known = session.files.find((entry) => entry.path === path)
      const plan = planMove({ path, dir: known?.dir ?? false }, onto, session.files)
      // Три исхода, а не два: жест, кончившийся там же, где начался, — это
      // промах пальцем, и отказ на него был бы неправдой.
      if (plan.do === 'refuse') {
        errorRender = () => (plan.why)
        saidOnDrag = false
        return
      }
      if (plan.do !== 'move') return
      errorRender = () => (null)
      saidOnDrag = false
      session.send({ t: 'tree:move', from: plan.from, to: plan.to })
      // Вкладки едут следом сразу и обязаны: список файлов придёт позже и
      // закрыл бы их как вкладки на исчезнувший путь — вместе с историей отмен.
      // Вместе с СОДЕРЖИМЫМ: вкладка знает точный путь, и переезд папки,
      // сказанный одним её именем, не двигает ни одной из тех, ради которых
      // папку и таскают.
      for (const moved of movedPaths(plan.from, plan.to, session.files)) {
        onrename?.(moved.from, moved.to)
      }
      return
    }
    // Сказать до броска нельзя — но и молча съесть файл нельзя тем более:
    // отпущенный файл, о котором ничего не произошло, читается как поломка.
    if (!may.files) {
      errorRender = () => (may.filesWhy + '.')
      return
    }
    void upload(event.dataTransfer?.files ?? null, dropFolder(onto))
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Рамка вокруг всей панели — это «в корень»: у корня нет своей строки,
     которую можно было бы подсветить. Для файлов с диска её не рисуют: там про
     то же самое говорит пунктирная кнопка внизу. -->
<section
  bind:this={panel}
  class="relative flex shrink-0 flex-col gap-0 px-3 pb-1 pt-5 {!dragFiles && dragInto === ''
    ? 'ring-1 ring-inset ring-accent'
    : !dragFiles && dragDeny === ''
      ? 'ring-1 ring-inset ring-danger/50'
      : ''}"
  aria-label={tr('room.ui.585')}
  ondragenter={onDragEnter}
  ondragover={(event) => aim(event, null)}
  ondragleave={onDragLeave}
  ondrop={(event) => onDrop(event, null)}
  oncontextmenu={onPanelMenu}
>
  <!-- Полоса уводит заголовок к действиям, так что кнопки читаются как тихий
       конец заголовка, а не как значки, повешенные на него. -->
  <div class="flex items-center gap-2 px-1 pb-2">
    <h2 class="text-2xs font-bold uppercase tracking-section text-muted">{tr('room.ui.586')}</h2>
    <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
    <!--
      Кнопки появляются, если можно хоть что-нибудь: файлы и СВОЯ ТЕТРАДЬ — это
      два разных правила, и пара «файлы преподавательские, свои тетради
      разрешены» — обычная пара. Тетрадь при этом не прячется, а гаснет с
      причиной: спрятанная кнопка читается как «такого тут не бывает».
    -->
    {#if may.files || may.ownBook}
      <div class="-my-1 -mr-1 flex shrink-0 items-center gap-0.5">
        {#if may.files}
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            title={target ? tr('room.extra.258', { p0: target }) : tr('room.extra.259')}
            aria-label={tr('room.ui.587')}
            onclick={() => startDraft('file')}
          >
            <Icon name="file-plus" size={13} />
          </button>
        {/if}
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-40"
          disabled={!may.ownBook}
          title={may.ownBook
            ? target ? tr('room.extra.260', { p0: target }) : tr('room.extra.261')
            : may.ownBookWhy}
          aria-label={tr('room.ui.588')}
          onclick={() => startDraft('book')}
        >
          <Icon name="notebook" size={13} />
        </button>
        {#if may.files}
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            title={target ? tr('room.extra.262', { p0: target }) : tr('room.extra.263')}
            aria-label={tr('room.ui.589')}
            onclick={() => startDraft('dir')}
          >
            <Icon name="folder-plus" size={13} />
          </button>
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            title={tr('room.ui.590')}
            aria-label={tr('room.ui.590')}
            onclick={() => picker?.click()}
          >
            <Icon name="upload" size={13} />
          </button>
        {/if}
      </div>
    {:else if listed}
      <span class="font-mono text-micro tabular-nums text-muted">{fileCount}</span>
    {/if}
  </div>

  <input
    bind:this={picker}
    type="file"
    multiple
    class="hidden"
    onchange={(event) => {
      const input = event.currentTarget
      void upload(input.files, target)
      input.value = ''
    }}
  />

  {#snippet nameField()}
    <input
      bind:this={draftInput}
      bind:value={draftName}
      class="min-w-0 flex-1 border-0 bg-canvas px-1 py-0.5 font-mono text-code text-ink outline-none ring-1 ring-accent/50"
      spellcheck="false"
      autocomplete="off"
      onblur={commitDraft}
      onkeydown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commitDraft()
        }
        // Escape закрывает поле — и только его. Тот же ключ у окна закрывает
        // ящик терминала, если никто не сказал, что он уже занят делом.
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          cancelDraft()
        }
      }}
    />
  {/snippet}

  {#if !session.filesArrived && !listed}
    <div class="px-2"><RowsSkeleton /></div>
  {/if}

  {#each visible as entry (entry.path)}
    {@const depth = depthOf(entry.path)}
    {@const empty = entry.dir && !collapsed.has(entry.path) ? emptyWord(entry.path) : null}
    {@const here = peersIn(entry.path)}
    <div
      class="group relative flex h-[26px] items-center transition-colors duration-100
             {freshCopy === entry.path
        ? 'bg-accent/10'
        : active === entry.path || picked === entry.path
          ? 'bg-raised'
          : 'hover:bg-raised focus-within:bg-raised'}
             {dragInto === entry.path
        ? 'ring-1 ring-inset ring-accent'
        : dragDeny === entry.path
          ? 'ring-1 ring-inset ring-danger/50'
          : ''}"
      style={`padding-left:${4 + depth * 14}px`}
      draggable={mayDrag}
      ondragstart={(event) => onDragStart(event, entry)}
      ondragend={onDragEnd}
      ondragover={(event) => aim(event, entry)}
      ondrop={(event) => onDrop(event, entry)}
      oncontextmenu={(event) => onRowMenu(event, entry)}
      onpointerdown={(event) => onRowPointerDown(event, entry)}
      onpointermove={onRowPointerMove}
      onpointerup={endHold}
      onpointercancel={endHold}
      onpointerleave={endHold}
      role="presentation"
    >
      <!-- Открытый файл отмечен полосой у самого края: она не занимает места в
           строке и видна, даже когда имя ужато до многоточия. -->
      {#if active === entry.path}
        <span class="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden="true"></span>
      {/if}

      <!-- Стрелка — кнопка, а не картинка: нажатие на неё не делало ровно
           ничего, потому что ловить его было некому, и папка «не открывалась».
           Рисунок девять пикселей, а нажимают пальцем и пером: отрицательные
           поля растят цель до 22, не сдвигая колонку имён ни на пиксель. -->
      {#if entry.dir}
        <button
          type="button"
          class="-m-1 flex h-[22px] w-[22px] shrink-0 items-center justify-center p-1 text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
          aria-expanded={!collapsed.has(entry.path)}
          aria-label={`${collapsed.has(entry.path) ? tr('room.extra.265') : tr('room.extra.266')} ${entry.name}`}
          onclick={() => toggle(entry.path)}
        >
          <Icon name="chevron-down" size={9} class={collapsed.has(entry.path) ? '-rotate-90' : ''} />
        </button>
      {:else}
        <span class="h-3.5 w-3.5 shrink-0"></span>
      {/if}
      <span class="flex h-3.5 w-[18px] shrink-0 items-center justify-center">
        <Icon
          name={entry.dir ? 'folder' : iconFor(entry.path)}
          size={12}
          class={active === entry.path ? 'text-ink' : 'text-faint'}
        />
      </span>

      {#if draft?.kind === 'rename' && draft.from === entry.path}
        {@render nameField()}
      {:else}
        <!-- `draggable` и на имени: строку тянут за него, а часть браузеров
             жеста, начатого на кнопке, родителю не отдаёт. Обработчик один —
             событие всплывает в строку. -->
        <button
          type="button"
          draggable={mayDrag}
          data-row-name
          class="row-name flex min-w-0 flex-1 items-center self-stretch text-left font-mono text-code
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
                 focus-visible:ring-accent/40
                 {entry.dir
            ? 'font-medium text-ink'
            : active === entry.path
              ? 'font-semibold text-ink'
              : 'text-muted'}"
          title={entry.dir ? entry.path : tr('room.extra.269', { p0: entry.path })}
          onclick={(event) => pick(entry, event.detail)}
          ondblclick={() => startRename(entry)}
          onkeydown={(event) => onRowKeydown(event, entry)}
        >
          <span class="truncate">{splitFileName(entry.name).stem}</span>
          <span class="shrink-0">{splitFileName(entry.name).ext}</span>
        </button>

        <!--
          Полоса размера — она же место кнопки меню: обе начинаются в одном
          месте, так что числа стоят колонкой, а «⋯» не наезжает на имя.
        -->
        <div
          class="relative mr-2 flex h-6 shrink-0 items-center justify-end"
          style={`min-width:${entry.dir ? 0 : SIZE_LANE}px`}
        >
            {#if here.length > 0}
              <!-- Кто держит файл открытым. Стоит поверх размера и не прячется
                   под указателем: это то, ради чего на строку и смотрят. -->
              <span class="flex items-center gap-1 pr-0.5">
                {#each here as peer (peer.id)}
                  <span
                    class="h-1.5 w-1.5 rounded-full"
                    style={`background:${peer.color}`}
                    title={tr('room.extra.270', { p0: peer.name })}
                  ></span>
                {/each}
              </span>
            {:else if !entry.dir}
              <span
                class="whitespace-nowrap font-mono text-micro tabular-nums text-muted transition-opacity
                       duration-100 group-hover:opacity-0 group-focus-within:opacity-0
                       {picked === entry.path ? 'opacity-0' : ''}"
              >
                {formatBytes(entry.size)}
              </span>
            {/if}
            <!--
              Одна кнопка вместо прежней полосы из трёх значков: указателю — по
              наведению, пальцу — по выделенной строке (см. `picked`).
              `pointer-events-none`, пока её не видно, — не украшение: кнопка
              лежит поверх размера, и невидимой она ловила тап по правому краю
              строки.

              `after:-inset-2` растит цель до сорока пикселей, не сдвинув в
              строке ни одного пикселя: рисунок остаётся 24×24, а пальцем по
              нему попадают. Соседние строки этим не задеть — их кнопки в то же
              время `pointer-events-none`.
            -->
            <span
              class="absolute inset-y-0 right-0 flex items-center bg-raised transition-opacity
                     duration-100 group-hover:pointer-events-auto group-hover:opacity-100
                     group-focus-within:pointer-events-auto group-focus-within:opacity-100
                     {picked === entry.path ? 'opacity-100' : 'pointer-events-none opacity-0'}"
            >
              <button
                type="button"
                data-menu-button
                aria-haspopup="menu"
                aria-expanded={menuOn?.kind === 'entry' && menuOn.entry.path === entry.path}
                class="relative flex h-6 w-6 items-center justify-center text-muted
                       transition-colors duration-100 after:absolute after:-inset-2
                       after:content-[''] hover:text-ink focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-accent/40"
                title={tr('room.files.menu.more')}
                aria-label={tr('room.files.menu.moreFor', { p0: entry.name })}
                onclick={(event) => onMoreClick(event, entry)}
              >
                <Icon name="more" size={13} />
              </button>
            </span>
        </div>
      {/if}
    </div>

    {#if confirming === entry.path}
      <div
        class="flex h-[26px] items-center gap-2 bg-raised pr-2"
        style={`padding-left:${4 + depth * 14 + 32}px`}
      >
        <!-- Тетрадь спрашивает своё: с файлом уходят и её ячейки у всей
             комнаты, а вернуть их из истории нельзя — лента версий ведётся по
             тетради комнаты, а не по каждой открытой. -->
        <span class="min-w-0 flex-1 truncate text-2xs text-muted">
          {entry.dir
            ? tr('room.ui.599')
            : isBook(entry.path)
              ? tr('room.ui.600')
              : tr('room.ui.601')}
        </span>
        <button
          type="button"
          class="shrink-0 text-2xs font-bold uppercase tracking-caps text-danger transition-opacity duration-100 hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 disabled:opacity-50"
          disabled={deleting === entry.path}
          onclick={() => remove(entry)}
        >
          {deleting === entry.path ? tr('room.ui.542') : tr('room.ui.598')}
        </button>
        <button
          type="button"
          class="shrink-0 text-2xs font-bold uppercase tracking-caps text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onclick={() => (confirming = null)}
        > {tr('room.ui.29')} </button>
      </div>
    {/if}

    <!--
      Раскрытая пустая папка ничем не отличалась от свёрнутой: человек нажимал
      на стрелку, дерево не менялось ни на строку, и он читал это как «стрелка
      не работает». Строка стоит на уровень глубже — там, где появится первое,
      что в папку положат, — и принимает бросок сама.

      Слова выбирает `emptyWord`: «пусто» — не единственный ответ, и там, где
      панель просто не видит содержимого, оно было бы прямой неправдой.
    -->
    {#if empty}
      <div
        class="flex h-[22px] items-center text-2xs text-faint {dragInto === entry.path
          ? 'bg-accent/10'
          : ''}"
        style={`padding-left:${4 + (depth + 1) * 14 + 32}px`}
        title={readsInside(entry.path)
          ? undefined
          : tr('room.extra.275')}
        ondragover={(event) => aim(event, entry)}
        ondrop={(event) => onDrop(event, entry)}
        role="presentation"
      >
        {empty}
      </div>
    {/if}
  {/each}

  {#if draft && draft.kind !== 'rename'}
    <!-- Строка ввода стоит там, где файл появится: в выбранной папке, с её
         отступом. Отступ на единицу больше, потому что это её содержимое. -->
    <div
      class="flex h-[26px] items-center pr-2"
      style={`padding-left:${4 + (draft.dir ? depthOf(draft.dir) + 1 : 0) * 14}px`}
    >
      <span class="h-3.5 w-3.5 shrink-0"></span>
      <span class="flex h-3.5 w-[18px] shrink-0 items-center justify-center">
        <Icon
          name={draft.kind === 'dir'
            ? 'folder'
            : draft.kind === 'book'
              ? 'notebook'
              : iconFor(draftName || 'x.txt')}
          size={12}
          class="text-faint"
        />
      </span>
      {@render nameField()}
    </div>
  {/if}

  <!-- Список кончился, но папка — нет. Строка стоит там же, где кончается
       дерево: это ответ на вопрос «а где мой файл?», заданный глазами. -->
  {#if truncated}
    <p class="px-2 pt-1.5 text-2xs leading-snug text-muted"> {tr('room.ui.602')} <span class="font-mono">os.listdir()</span>.
    </p>
  {/if}

  {#each uploads as item (item.id)}
    {@const done = percent(item)}
    <div class="flex flex-col gap-1 px-2 pb-1 pt-1.5">
      <div class="flex items-center gap-2.5">
        <span class="h-4 w-[3px] shrink-0 bg-brand-2" aria-hidden="true"></span>
        <span class="flex min-w-0 flex-1 font-mono text-code text-muted" title={item.name}>
          <span class="truncate">{splitFileName(item.name).stem}</span>
          <span class="shrink-0">{splitFileName(item.name).ext}</span>
        </span>
        <span
          class="min-w-10 shrink-0 whitespace-nowrap text-right font-mono text-micro tabular-nums text-accent-text"
        >
          {done}%
        </span>
      </div>
      <!-- Scaled, not resized: a width transition would relayout the row on
           every progress event, and only transform is allowed to move. -->
      <div
        class="h-0.5 bg-line"
        role="progressbar"
        aria-label={tr('room.files.loading', { name: item.name })}
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          class="h-full origin-left bg-accent"
          style="transform: scaleX({done / 100}); transition: transform var(--speed-quick) linear"
        ></div>
      </div>
    </div>
  {/each}

  <!--
    Есть всегда, в любом состоянии: пустая комната иначе оставалась бы с
    абзацем и без цели. Там, где файлы кладёт преподаватель, кнопка остаётся на
    месте и называет правило — как оверлей для брошенного файла: открыть выбор
    и отказать после значит потратить чужое время на решение, известное заранее.
  -->
  <button
    type="button"
    class="mx-1 mt-2 flex h-9 shrink-0 items-center justify-center border border-dashed text-2xs transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed {dragDepth >
      0 && dragFiles && may.files
      ? 'border-accent bg-accent/10 text-accent-text'
      : 'border-line text-muted'} {may.files ? 'hover:border-faint hover:text-ink' : ''}"
    disabled={!may.files}
    title={may.files ? tr('room.extra.461') : undefined}
    onclick={() => picker?.click()}
    ondragover={(event) => aim(event, targetRow)}
    ondrop={(event) => onDrop(event, targetRow)}
  >
    {#if !may.files}
      {may.filesWhy}
    {:else}
      {target ? tr('room.ui.607', { p0: target }) : tr('room.ui.608')}
    {/if}
  </button>

  <!-- Правая кнопка — единственное, о чём в этой панели нельзя догадаться по
       виду: «⋯» появляется только под указателем, а меню под ним шире, чем
       одна кнопка. Строка уходит навсегда, как только меню открыли хоть раз, —
       подсказка, висящая всегда, перестаёт быть подсказкой. -->
  {#if !tipSeen && listed}
    <p class="px-2 pt-1.5 text-2xs leading-snug text-faint">{tr('room.files.menu.tip')}</p>
  {/if}

  <!-- Что легло в буфер — целиком и под деревом. В строке файла на это было
       место под одно слово, а кладут туда путь: «скопировано» без самого пути
       заставляет проверять буфер вставкой. Полоса той же формы, что у ошибки
       и у предупреждения выше, только цвет кромки другой. -->
  {#if copied}
    <div
      class="mt-1.5 flex items-baseline gap-1.5 border-l-2 border-positive bg-surface px-2 py-1"
    >
      <span class="shrink-0 text-2xs text-muted">{tr('room.files.menu.copied')}</span>
      <span class="min-w-0 flex-1 break-all font-mono text-2xs text-ink">{copied}</span>
    </div>
  {/if}

  <!-- Полоса прибита к нижнему краю видимого: панель лежит в одной
       прокручиваемой полосе с остальными, и в комнате, где список длиннее
       экрана, слова отказа дописывались ниже пунктирной кнопки — то есть за
       экраном. Оставались красная рамка и курсор «нельзя» без единого слова о
       причине, а сказать по отпусканию негде: цель с `dropEffect: 'none'`
       события `drop` не отдаёт. -->
  {#if error}
    <div
      class="sticky bottom-0 z-10 mt-1.5 flex items-start gap-2 border-l-2 border-danger bg-surface px-2 py-1 text-2xs text-danger"
    >
      <span class="min-w-0 flex-1 break-words">{error}</span>
      <button
        type="button"
        class="shrink-0 p-0.5 transition-opacity duration-100 hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
        aria-label={tr('room.ui.499')}
        onclick={() => (errorRender = () => null)}
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  {/if}

  <!-- Не ошибка: загрузка прошла — но прошла поверх чужого файла, и молчать
       об этом нельзя. Отдельная полоса, потому что цвет здесь другой. -->
  {#if note && !error}
    <div class="mt-1.5 flex items-start gap-2 border-l-2 border-line px-2 py-1 text-2xs text-muted">
      <span class="min-w-0 flex-1 break-words">{note}</span>
      <button
        type="button"
        class="shrink-0 p-0.5 transition-opacity duration-100 hover:opacity-70"
        aria-label={tr('room.ui.499')}
        onclick={() => (note = null)}
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  {/if}

  {#if dragDepth > 0 && dragFiles && !listed}
    <!-- Без списка светиться нечему, и панель становится целью сама. Комната,
         где файлы кладёт преподаватель, говорит это прямо здесь: узнать об
         отказе, уже отпустив файл, — то же самое, что не узнать. -->
    <div
      class="pointer-events-none absolute inset-x-4 inset-y-3 flex items-center justify-center border border-dashed text-2xs {may.files
        ? 'border-accent bg-accent/10 text-accent-text'
        : 'border-line bg-surface/80 text-muted'}"
    >
      {may.files ? tr('room.ui.608') : may.filesWhy}
    </div>
  {/if}
</section>

<!--
  Меню стоит ВНЕ панели и позиционируется от окна: панель лежит в одной
  прокручиваемой полосе с остальными, а `overflow` обрезает и по вертикали —
  меню, открытое у нижней строки, срезало бы ровно там, где на него смотрят.
  Тот же приём, что у меню бана и у меню доступа на вкладке тетради.
-->
<ContextMenu
  at={menuAt}
  label={menuLabel}
  title={menuTitle}
  items={menuItems}
  opener={menuOpener}
  onclose={closeMenu}
/>

<style>
  /*
   * Долгое нажатие по строке зовёт наше меню — и на iOS одновременно с ним
   * системную выноску «Копировать / Поделиться». Две панели поверх одной
   * строки, и верхняя не наша. Гасится ровно на именах строк: выделять текст
   * в панели файлов больше негде, а в остальной комнате выноска законна.
   */
  .row-name {
    -webkit-touch-callout: none;
  }
</style>
