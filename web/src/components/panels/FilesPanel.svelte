<script lang="ts">
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
   * стало чем. Строка для ячейки осталась кнопкой в полосе действий, и она
   * по-прежнему первая — на семинаре по данным её нажимают чаще всего.
   */
  import type { FileEntry } from '@shared/protocol'
  import { api } from '@/lib/api'
  import { getSessionState } from '@/lib/session.svelte'
  import { formatBytes, splitFileName } from '@/lib/utils'
  import Icon from '@/components/ui/Icon.svelte'
  import { copyText } from '@/lib/clipboard'
  import { iconFor } from '@/lib/file-icons'
  import { permitsIn } from '@/lib/may'
  import { dropFolder, movedPaths, planMove, readsInside, type Row } from '@/lib/tree-move'
  import { watchBooks } from '@/lib/yreactive.svelte'
  import { baseOf, joinPath, kindOf, parentOf, safeSegment, whySegmentRefused } from '@shared/paths'

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
  }

  let { onopen, active = null, onrename }: Props = $props()

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
  let error = $state<string | null>(null)
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

  /** Свёрнутые папки. Всё, чего здесь нет, развёрнуто: дерево видно целиком. */
  let collapsed = $state<Set<string>>(new Set())
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
  /** Куда лягут «новый файл» и «новая папка». Пустая строка — корень. */
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
      for (const folder of collapsed) {
        if (entry.path.startsWith(folder + '/')) return false
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
    if (!readsInside(path)) return 'глубже не видно'
    return truncated ? null : 'пусто'
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

  /** Кнопка 24 пикселя, зазор между ними два; сорок — место под размер файла. */
  const BUTTON = 24
  const GAP = 2
  const SIZE_LANE = 40

  /**
   * Ширина полосы действий — по числу кнопок в строке, а не константой.
   *
   * Действия лежат absolute и в раскладке не участвуют: полоса, рассчитанная на
   * две кнопки, третью выкладывает поверх имени файла. Так это однажды и
   * случилось, когда у PDF появилось «открыть».
   */
  const laneWidth = $derived(
    Math.max(SIZE_LANE, (isHost ? 3 : 2) * BUTTON + ((isHost ? 3 : 2) - 1) * GAP),
  )

  function toggle(path: string): void {
    // Тап по стрелке — тоже прикосновение к строке: раскрыв папку пальцем,
    // человек должен видеть и то, что с ней можно сделать.
    picked = path
    const next = new Set(collapsed)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    collapsed = next
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
    // Выделение — до любых отказов ниже: строка, по которой нажали, показывает
    // свои действия, даже если открыть файл правило комнаты не дало.
    picked = entry.path
    if (entry.dir) {
      target = entry.path
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
     * Тетрадь, которой в комнате ещё нет, вносит сервер — и по правилу `files`
     * может отказать. Вкладка на неё открылась бы сразу и осталась бы навсегда
     * с «Открываю…»: тетради, которую не завели, в комнате не появится, и
     * закрывать вкладку нечему. Отказ — здесь, до нажатия, теми же словами,
     * которыми ответил бы сервер.
     */
    if (kindOf(entry.path) === 'notebook' && !may.files && !isBook(entry.path)) {
      // Из `may`, как в двух соседних ветках: свои слова здесь после звонка
      // называли правило, которого никто не менял.
      error = may.filesWhy + '.'
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
      error = err instanceof Error ? err.message : 'Не удалось скачать файл.'
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
      error = whySegmentRefused(name)
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
          error = `«${baseOf(current.from)}» в комнате больше нет.`
          return
        }
        if (session.files.some((entry) => entry.path === path)) {
          error = `«${baseOf(path)}» в этой папке уже есть.`
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
  })

  /** The line a student would actually type to open this file from a cell. */
  function snippetFor(name: string): string {
    const path = `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    switch (ext) {
      case 'csv':
        return `pd.read_csv(${path})`
      case 'tsv':
        return `pd.read_csv(${path}, sep='\\t')`
      case 'jsonl':
      case 'ndjson':
        return `pd.read_json(${path}, lines=True)`
      case 'parquet':
        return `pd.read_parquet(${path})`
      case 'xlsx':
      case 'xls':
        return `pd.read_excel(${path})`
      case 'json':
        return `json.load(open(${path}))`
      case 'npy':
      case 'npz':
        return `np.load(${path})`
      case 'pt':
      case 'pth':
        return `torch.load(${path})`
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'webp':
        return `Image.open(${path})`
      case 'py':
        // Скрипт запускают, а не читают: `%run` — то, что человек на самом деле
        // хочет напечатать в ячейке, когда несёт туда имя файла.
        return `%run ${name}`
      case 'txt':
      case 'md':
        return `open(${path}).read()`
      default:
        return `open(${path}, 'rb').read()`
    }
  }

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
        } else reject(new Error(body.error || xhr.statusText || 'Upload failed'))
      }
      xhr.onerror = () => reject(new Error('Upload failed'))
      xhr.send(form)
    })
  }

  async function upload(list: FileList | File[] | null, dir: string) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    // Право — до первого байта: отказ, приходящий после выбора файла, человек
    // читает как поломку, а не как правило комнаты.
    if (!may.files) {
      error = may.filesWhy + '.'
      return
    }
    error = null

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
        error = err instanceof Error ? err.message : `Не удалось загрузить ${files[i].name}`
      } finally {
        uploads = uploads.filter((item) => item.id !== id)
      }
    }

    if (overwritten.length > 0 && !error) {
      note =
        overwritten.length === 1
          ? `${overwritten[0]} лёг поверх файла, который уже был здесь.`
          : `Поверх уже лежавших легли: ${overwritten.join(', ')}`
      window.clearTimeout(noteTimer)
      noteTimer = window.setTimeout(() => (note = null), 8000)
    }
  }

  function remove(entry: FileEntry): void {
    deleting = entry.path
    error = null
    session.send({ t: 'tree:remove', path: entry.path })
    confirming = null
    // Ответа нет: список файлов приходит комнате целиком, и строка исчезает
    // вместе с ним. Отказ, если он будет, придёт обычной строкой ошибки.
    window.setTimeout(() => (deleting = null), 600)
  }

  async function copySnippet(path: string) {
    try {
      await copyText(snippetFor(path))
      copied = path
      window.clearTimeout(copyTimer)
      copyTimer = window.setTimeout(() => (copied = null), 1400)
    } catch {
      error = 'Браузер не дал доступ к буферу обмена'
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
      error = why
      saidOnDrag = true
      return
    }
    if (!saidOnDrag) return
    saidOnDrag = false
    error = null
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
      const next = new Set(collapsed)
      next.delete(wanted)
      collapsed = next
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
        error = may.filesWhy + '.'
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
        error = plan.why
        saidOnDrag = false
        return
      }
      if (plan.do !== 'move') return
      error = null
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
      error = may.filesWhy + '.'
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
  class="relative flex shrink-0 flex-col gap-0 px-3 pb-1 pt-5 {!dragFiles && dragInto === ''
    ? 'ring-1 ring-inset ring-accent'
    : !dragFiles && dragDeny === ''
      ? 'ring-1 ring-inset ring-danger/50'
      : ''}"
  aria-label="Файлы семинара"
  ondragenter={onDragEnter}
  ondragover={(event) => aim(event, null)}
  ondragleave={onDragLeave}
  ondrop={(event) => onDrop(event, null)}
>
  <!-- Полоса уводит заголовок к действиям, так что кнопки читаются как тихий
       конец заголовка, а не как значки, повешенные на него. -->
  <div class="flex items-center gap-2 px-1 pb-2">
    <h2 class="text-2xs font-bold uppercase tracking-section text-muted">Файлы</h2>
    <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
    {#if may.files}
      <div class="-my-1 -mr-1 flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={target ? `Новый файл в ${target}` : 'Новый файл'}
          aria-label="Новый файл"
          onclick={() => startDraft('file')}
        >
          <Icon name="file-plus" size={13} />
        </button>
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={target ? `Новая тетрадь в ${target}` : 'Новая тетрадь'}
          aria-label="Новая тетрадь"
          onclick={() => startDraft('book')}
        >
          <Icon name="notebook" size={13} />
        </button>
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={target ? `Новая папка в ${target}` : 'Новая папка'}
          aria-label="Новая папка"
          onclick={() => startDraft('dir')}
        >
          <Icon name="folder-plus" size={13} />
        </button>
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title="Загрузить файлы"
          aria-label="Загрузить файлы"
          onclick={() => picker?.click()}
        >
          <Icon name="upload" size={13} />
        </button>
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

  {#each visible as entry (entry.path)}
    {@const depth = depthOf(entry.path)}
    {@const empty = entry.dir && !collapsed.has(entry.path) ? emptyWord(entry.path) : null}
    {@const here = peersIn(entry.path)}
    <div
      class="group relative flex h-[26px] items-center transition-colors duration-100
             {active === entry.path || picked === entry.path
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
          aria-label={`${collapsed.has(entry.path) ? 'Раскрыть' : 'Свернуть'} ${entry.name}`}
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
          class="flex min-w-0 flex-1 items-center self-stretch text-left font-mono text-code
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
                 focus-visible:ring-accent/40
                 {entry.dir
            ? 'font-medium text-ink'
            : active === entry.path
              ? 'font-semibold text-ink'
              : 'text-muted'}"
          title={entry.dir ? entry.path : `${entry.path} — открыть`}
          onclick={(event) => pick(entry, event.detail)}
          ondblclick={() => startRename(entry)}
        >
          <span class="truncate">{splitFileName(entry.name).stem}</span>
          <span class="shrink-0">{splitFileName(entry.name).ext}</span>
        </button>

        {#if copied === entry.path}
          <span class="flex shrink-0 items-center gap-1 pr-2 text-2xs font-medium text-positive">
            <Icon name="check" size={11} />
            скопировано
          </span>
        {:else}
          <!--
            Полоса размера — она же полоса действий: обе начинаются в одном
            месте, так что числа стоят колонкой, а действия не наезжают на имя.
            Ширина считается по числу кнопок в ЭТОЙ строке.
          -->
          <div
            class="relative mr-2 flex h-6 shrink-0 items-center justify-end"
            style={`min-width:${entry.dir ? 0 : laneWidth}px`}
          >
            {#if here.length > 0}
              <!-- Кто держит файл открытым. Стоит поверх размера и не прячется
                   под указателем: это то, ради чего на строку и смотрят. -->
              <span class="flex items-center gap-1 pr-0.5">
                {#each here as peer (peer.id)}
                  <span
                    class="h-1.5 w-1.5 rounded-full"
                    style={`background:${peer.color}`}
                    title={`${peer.name} — здесь`}
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
              Полоса действий: указателю — по наведению, пальцу — по выделенной
              строке (см. `picked`). `pointer-events-none`, пока её не видно, —
              не украшение: полоса лежит поверх размера, и невидимая «Убрать»
              ловила тап по правому краю строки.
            -->
            <span
              class="absolute inset-y-0 right-0 flex items-center gap-0.5 bg-raised transition-opacity
                     duration-100 group-hover:pointer-events-auto group-hover:opacity-100
                     group-focus-within:pointer-events-auto group-focus-within:opacity-100
                     {picked === entry.path ? 'opacity-100' : 'pointer-events-none opacity-0'}"
            >
              {#if !entry.dir}
                <button
                  type="button"
                  class="flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  title={`Скопировать ${snippetFor(entry.path)}`}
                  aria-label="Скопировать строку для ячейки"
                  onclick={() => void copySnippet(entry.path)}
                >
                  <Icon name="copy" size={12} />
                </button>
                <button
                  type="button"
                  class="flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  title="Скачать"
                  aria-label={`Скачать ${entry.name}`}
                  onclick={() => void download(entry.path)}
                >
                  <Icon name="download" size={12} />
                </button>
              {/if}
              <!-- Убрать файл — преподавательское: папка общая в обе стороны, и
                   раздатка, по которой работает класс, была в одном нажатии от
                   любого. -->
              {#if isHost}
                <button
                  type="button"
                  class="flex h-6 w-6 items-center justify-center text-faint transition-colors duration-100 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
                  title="Убрать"
                  aria-label={`Убрать ${entry.name}`}
                  onclick={() => (confirming = entry.path)}
                >
                  <Icon name="trash" size={12} />
                </button>
              {/if}
            </span>
          </div>
        {/if}
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
            ? 'Убрать папку со всем, что в ней?'
            : isBook(entry.path)
              ? 'Убрать тетрадь и её ячейки у всей комнаты?'
              : 'Убрать?'}
        </span>
        <button
          type="button"
          class="shrink-0 text-2xs font-bold uppercase tracking-caps text-danger transition-opacity duration-100 hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 disabled:opacity-50"
          disabled={deleting === entry.path}
          onclick={() => remove(entry)}
        >
          {deleting === entry.path ? 'Убираю' : 'Убрать'}
        </button>
        <button
          type="button"
          class="shrink-0 text-2xs font-bold uppercase tracking-caps text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onclick={() => (confirming = null)}
        >
          Отмена
        </button>
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
          : 'Глубже комната не смотрит: такому пути уже нет имени. Что в ней лежит, видно из ячейки — os.listdir().'}
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
    <p class="px-2 pt-1.5 text-2xs leading-snug text-muted">
      Файлов в комнате больше, чем помещается в список: самые глубокие папки не раскрыты. Их видно
      из ячейки — <span class="font-mono">os.listdir()</span>.
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
        aria-label="Загружается {item.name}"
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
    onclick={() => picker?.click()}
    ondragover={(event) => aim(event, targetRow)}
    ondrop={(event) => onDrop(event, targetRow)}
  >
    {#if !may.files}
      {may.filesWhy}
    {:else}
      {target ? `Файлы — в папку ${target}` : 'Файлы — общие с комнатой'}
    {/if}
  </button>

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
        aria-label="Убрать"
        onclick={() => (error = null)}
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
        aria-label="Убрать"
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
      {may.files ? 'Файлы — общие с комнатой' : may.filesWhy}
    </div>
  {/if}
</section>
