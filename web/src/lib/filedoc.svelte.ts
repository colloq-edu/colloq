/**
 * Открытый файл в браузере: документ Yjs, сокет к нему и счётчик вкладок.
 *
 * Каждый файл — свой документ и своё соединение, заведённые в тот момент, когда
 * его открыли, и закрытые, когда закрылась последняя вкладка на нём. Комната
 * этим не платит: семинар без открытых файлов держит ровно те два сокета,
 * которые держал всегда.
 *
 * **Локального кеша тут нет, и это важное отличие от тетради.** Тетрадь
 * складывается в IndexedDB, потому что её единственная копия — в комнате, и
 * набранное в оффлайне нельзя потерять. У файла копия есть всегда: он лежит на
 * диске семинара, и ядро с терминалом пишут в него мимо всякого браузера.
 * Кешированный вчерашний текст, слитый в сегодняшний файл при открытии вкладки,
 * — это не спасение работы, а её порча: он вернёт строки, которые скрипт
 * переписал, и сделает это молча.
 *
 * Отсюда же и правило про отказ: сокет, закрытый с 4403, больше не
 * переподключается. Слияние CRDT — объединение, и ничто в протоколе не умеет
 * забрать у клиента текст, который сервер не принял; единственный честный ход —
 * перестать говорить и сказать об этом человеку.
 *
 * Молчание при этом держится ПРИЧИНОЙ, а не навсегда: конец занятия проходит, и
 * вкладка, замолчавшая из-за него, оживает (`reopen`) — иначе студент сидит с
 * мёртвым файлом до перезагрузки страницы, а перезагрузку ему никто не
 * подсказывает.
 */
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { Awareness } from 'y-protocols/awareness'
import type { AwarenessUser } from '@shared/protocol'

/** Текст внутри документа файла. Он там один — как и в модуле на сервере. */
const TEXT_KEY = 'text'

/** Правку не приняли: правило комнаты или подделанный клиент. */
const REFUSED = 4403
/** Файла больше нет, или он не открывается как текст. */
const MISSING = 4404
/**
 * Файл есть, но он слишком велик, чтобы его редактировать.
 *
 * Отдельно от 4404, потому что это разные ответы человеку: «файла нет» —
 * вкладку закрыть, «файл на сто мегабайт» — предложить скачать его или
 * прочитать из ячейки. Раньше и то и другое приходило кодом 4404, и вкладка на
 * живой файл молча закрывалась.
 */
const TOO_BIG = 4413

/**
 * Имя комнаты для одного файла: путь в base64url.
 *
 * `btoa` работает с байтами, а не с символами, — отсюда TextEncoder: без него
 * `данные/треть.csv` роняет кодирование целиком.
 */
function roomFor(path: string): string {
  const bytes = new TextEncoder().encode(path)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function wsBase(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}`
}

export class FileDoc {
  readonly path: string
  readonly doc: Y.Doc
  readonly text: Y.Text
  readonly provider: WebsocketProvider
  readonly awareness: Awareness
  readonly undoManager: Y.UndoManager

  /** Сокет открыт. Печатать можно и без него — догонит. */
  connected = $state(false)
  /**
   * Сервер прислал то, что у него есть.
   *
   * До этого пустой документ значит «ещё не прочитан», а не «файл пуст», — и
   * разница между заготовкой и неправдой ровно здесь: редактор, показавший
   * пустоту, приглашает в неё печатать.
   */
  ready = $state(false)
  /** Правку не приняли — дальше документ только читают. */
  refused = $state(false)
  /**
   * Почему не приняли — словами сервера, или `null`.
   *
   * У файлового сокета нет управляющего канала, по которому комната досылает
   * фразу отказа, и единственное место, куда она помещается, — поле `reason`
   * кадра закрытия (server/src/collab/files.ts · refuse). Причины там разные:
   * правило комнаты, конец занятия, файл, переросший потолок, — и человеку,
   * которому вкладка вдруг стала «только чтение», важна именно эта разница.
   *
   * `null` — сервер закрыл молча (старый рядом с новой страницей): тогда
   * говорит сама вкладка, своей фразой.
   */
  refusedWhy = $state<string | null>(null)
  /** Файла больше нет. Вкладку надо закрыть, а не показывать пустоту. */
  missing = $state(false)
  /** Файл слишком велик для редактора. Вкладка остаётся — с объяснением. */
  tooBig = $state(false)

  #tabs = 0
  #closed = false

  constructor(sessionId: string, path: string, token: string) {
    this.path = path
    this.doc = new Y.Doc()
    this.text = this.doc.getText(TEXT_KEY)
    /*
     * Путь уезжает в ИМЯ КОМНАТЫ, а не в параметры, и это не косметика.
     *
     * y-websocket заводит BroadcastChannel по формуле `serverUrl + '/' +
     * roomname` — параметры в неё не входят. Оставь путь параметром, и два
     * РАЗНЫХ файла одного семинара, открытых в двух вкладках браузера, попадают
     * в один канал: правки `utils.py` применяются к документу `train.py` в
     * соседней вкладке. Не отказ и не ошибка — просто чужой текст, приехавший в
     * файл, и Yjs добросовестно сохранит его на диск.
     *
     * base64url, потому что имя комнаты едет в адресе сокета, а в пути бывают и
     * косые черты, и кириллица.
     */
    this.provider = new WebsocketProvider(
      `${wsBase()}/file/${sessionId}`,
      roomFor(path),
      this.doc,
      {
        params: { token },
        connect: true,
      },
    )
    this.awareness = this.provider.awareness
    this.undoManager = new Y.UndoManager(this.text, {
      // Отменяется только своё: чужую работу Ctrl+Z не забирает.
      trackedOrigins: new Set([null, 'local']),
      captureTimeout: 400,
    })

    this.provider.on('status', this.#onStatus)
    this.provider.on('sync', this.#onSync)
    this.provider.on('connection-close', this.#onClose)
  }

  #onStatus = ({ status }: { status: string }) => {
    this.connected = status === 'connected'
  }

  #onSync = (synced: boolean) => {
    if (synced) this.ready = true
  }

  #onClose = (event: CloseEvent | null) => {
    if (event?.code === REFUSED) {
      this.refused = true
      // Пустая строка — это «сервер не сказал», а не причина: пустой пузырь на
      // экране хуже, чем своя фраза вкладки.
      this.refusedWhy = event.reason || null
      this.#hangUp()
    } else if (event?.code === MISSING) {
      this.missing = true
      this.#hangUp()
    } else if (event?.code === TOO_BIG) {
      this.tooBig = true
      this.#hangUp()
    }
  }

  /**
   * Перестать переподключаться.
   *
   * `shouldConnect` — то, на что смотрит сам провайдер, решая, вставать ли
   * снова: без него `disconnect()` держится ровно до следующего его же таймера.
   */
  #hangUp(): void {
    this.provider.shouldConnect = false
    this.provider.disconnect()
  }

  /**
   * Причина ушла — снова говорить с сервером.
   *
   * Тот же документ, а не пересобранный: пересборка означала бы новый `Y.Doc`
   * под уже привязанным редактором, а текст, который сервер не принял, лежит
   * здесь — и уедет к нему первым же кадром синхронизации, потому что теперь он
   * разрешён. Если разрешён не он (замолчали не из-за занятия, а по правилу
   * комнаты), сервер откажет снова, и вкладка вернётся ровно туда, откуда
   * вышла, — уже с той причиной, которая действует сейчас.
   *
   * `connect()` сам ставит `shouldConnect` обратно — то самое поле, которым
   * держится молчание (см. `#hangUp`).
   */
  reopen(): void {
    if (this.#closed || !this.refused) return
    this.refused = false
    this.refusedWhy = null
    this.provider.connect()
  }

  /** Кем показывать курсор в этом файле. */
  setUser(user: AwarenessUser): void {
    this.awareness.setLocalStateField('user', user)
  }

  /** Столько вкладок на этом файле сейчас открыто. */
  hold(): void {
    this.#tabs += 1
  }

  release(): boolean {
    this.#tabs -= 1
    return this.#tabs <= 0
  }

  destroy(): void {
    if (this.#closed) return
    this.#closed = true
    this.undoManager.destroy()
    this.provider.destroy()
    this.doc.destroy()
  }
}

/*
 * Открытые документы этой вкладки браузера. Ключ — комната и путь: один
 * человек не бывает в двух комнатах разом, но вкладка при переходе между ними
 * не перезагружается, и файл `train.py` в двух семинарах — это два файла.
 */
const live = new Map<string, FileDoc>()

function keyOf(sessionId: string, path: string): string {
  return `${sessionId}\u0000${path}`
}

/**
 * Открыть файл — или взять уже открытый.
 *
 * Считает держателей: две вкладки на одном файле (тетрадь и редактор рядом,
 * если такое появится) не заводят два соединения и не рвут одно, закрываясь.
 */
export function holdFile(sessionId: string, path: string, token: string): FileDoc {
  const key = keyOf(sessionId, path)
  const existing = live.get(key)
  if (existing) {
    existing.hold()
    return existing
  }
  const made = new FileDoc(sessionId, path, token)
  made.hold()
  live.set(key, made)
  return made
}

/** Отпустить. Последний закрывает соединение. */
export function releaseFile(sessionId: string, path: string): void {
  const key = keyOf(sessionId, path)
  const existing = live.get(key)
  if (!existing) return
  if (!existing.release()) return
  live.delete(key)
  existing.destroy()
}

/**
 * Оживить файлы комнаты, замолчавшие после отказа.
 *
 * Живёт здесь, у карты открытых документов, а не у экрана с вкладками: экран
 * знает только то, что открыто прямо сейчас, а замолчать успел и файл, вкладку
 * которого закрыли минуту назад, — он ещё жив в этой карте, если его держит
 * вторая. Зовёт это комната, когда сервер сказал, что занятие продолжили
 * (lib/session.svelte.ts, кадр `class`): повод приезжает сам, и опрашивать
 * что-либо по таймеру незачем.
 */
export function reopenRefusedFiles(sessionId: string): void {
  const prefix = keyOf(sessionId, '')
  for (const [key, doc] of live) if (key.startsWith(prefix)) doc.reopen()
}

/** Закрыть всё: человек ушёл из комнаты. */
export function releaseAllFiles(): void {
  for (const doc of live.values()) doc.destroy()
  live.clear()
}
