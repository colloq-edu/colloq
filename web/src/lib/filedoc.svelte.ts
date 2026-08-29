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
  /** Файла больше нет. Вкладку надо закрыть, а не показывать пустоту. */
  missing = $state(false)

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
      this.#hangUp()
    } else if (event?.code === MISSING) {
      this.missing = true
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

/** Закрыть всё: человек ушёл из комнаты. */
export function releaseAllFiles(): void {
  for (const doc of live.values()) doc.destroy()
  live.clear()
}
