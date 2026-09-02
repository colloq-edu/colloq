/**
 * Разбор входящего Yjs-кадра на глаголы — до того, как он применён.
 *
 * Документ семинара общий, и это и есть CRDT: любой, кто подключён, может
 * записать в него что угодно — чужой вывод, чужой `stdin`, «ядро умерло»,
 * строку в терминал от чужого имени. Правила комнаты («студенты не удаляют
 * ячейки») бессмысленны, пока байты применяются раньше, чем кто-то посмотрел,
 * что в них.
 *
 * Смотреть надо ДО применения. Применить и откатить нельзя: Yjs не умеет
 * разудалять — undo копирует, — и откат удаления оставляет всех, у кого эта
 * ячейка открыта, печатать в надгробие: нажатия пропадают без исключения, без
 * ошибки и без единого сработавшего наблюдателя. Правило, которое должно было
 * защитить преподавателя от студента, выдало бы студенту оружие против
 * преподавателя. Плюс `broadcastDocUpdate`, `record()` и запись на диск висят
 * синхронно внутри `applyUpdate` — откат успел бы разъехаться по двадцати
 * вкладкам и записаться в историю.
 *
 * Модуль чистый: сюда ходит тест, и здесь нет ни сокетов, ни базы.
 *
 * Мера цены (500 ячеек, 114 КБ): разбор нажатия — 0.36 мкс, полная
 * классификация с разрешением родителей — 1.77 мкс, применение тех же байт —
 * 67 мкс. Двадцать печатающих дают ~160 кадров в секунду.
 */
import * as Y from 'yjs'
import {
  allCellArrays,
  CELLS_KEY,
  CHAT_KEY,
  isBookRoot,
  META_KEY,
  TERMINAL_KEY,
} from '@shared/notebook'
import { allows, allowsStructure, type RoomRules } from '@shared/rules'

/** Что кадр делает — в терминах правил комнаты, а не байтов. */
export type GateRule = 'structure' | 'edit' | 'title'

export interface Verdict {
  rule: GateRule
  /** Только для `structure`: что именно с составом тетради. */
  verb?: 'add' | 'remove'
  /** Ячейка, если её удалось назвать, — для сообщения человеку. */
  cellId: string | null
  /** Разрешённый путь, для сообщения и для теста. */
  path: string
}

export type Judgement =
  | {
      ok: true
      verdicts: Verdict[]
      /**
       * Ячейки, у которых кадр меняет `type`.
       *
       * Клиент теперь пишет только сам тип; сброс состояния выполнения
       * (`state`, `execCount`, `startedAt`, `ranMs`, `outputs`) делает сервер
       * сразу после применения — единственное место, где клиент писал
       * серверные поля, перестало существовать.
       */
      retyped: string[]
      /**
       * Ячейки, которые кадр создаёт.
       *
       * Сервер приводит их в согласие с собой сразу после применения: чужой
       * вывод стирает, свой — если это отмена удаления — возвращает по
       * собственной записи. Ячейка, чьё имя уже занято живой, сюда не попадает:
       * приведение ищет по имени и досталось бы не ей, а той, что уже в
       * тетради. Пришедшую копию снимает наблюдатель за двойниками.
       */
      created: string[]
      /**
       * Ячейки, которые кадр удаляет.
       *
       * Сервер запоминает их ДО применения: после применения читать уже нечего,
       * а без этого Ctrl+Z вернул бы ячейку без вывода. И говорит о них ядру
       * ПОСЛЕ применения (`collab/index.ts · onCellsRemoved`): убрать можно и
       * ту ячейку, которую оно сейчас считает.
       */
      removed: string[]
    }
  | { ok: false; why: string; path: string }

/**
 * Потолок на кадр, до всякой классификации и одинаковый для всех.
 *
 * Не право: преподаватель вставляет из буфера ровно так же. `MAX_WS_PAYLOAD`
 * равен 16 МБ, и такой кадр ретранслируется в каждый сокет, целиком уезжает в
 * SQLite-блоб и ещё раз копируется в ключевой кадр истории. Классификатор без
 * этого потолка просто аккуратно разбирает бомбу.
 */
export const MAX_SYNC_FRAME_BYTES = 256 * 1024

/**
 * Сколько элементов классификатор согласен обойти в одном кадре.
 *
 * Задел от вырожденного набора удалений: диапазон длиной в миллиард стоит
 * несколько байт на проводе. Настоящее удаление, даже «выделить всё в большой
 * ячейке», не даёт и тысячи. Упереться в потолок — отказ, а не пропуск.
 */
const MAX_WALK = 100_000

/** Ключи ячейки, которые пишет только сервер. Клиенту они закрыты всегда. */
const SERVER_OWNED = new Set([
  'outputs',
  'state',
  'execCount',
  'runBy',
  'runById',
  'startedAt',
  'ranMs',
  'stdin',
])

/** Что несёт свежесозданная ячейка. Ничего сверх — иначе отказ. */
const FRESH_KEYS = new Set([
  'id',
  'type',
  'source',
  'outputs',
  'state',
  'execCount',
  'runBy',
  'runById',
  'startedAt',
  'ranMs',
])

class Refusal extends Error {
  constructor(
    readonly why: string,
    readonly path: string,
  ) {
    super(`${why} (${path})`)
  }
}

/**
 * Набор удалений так, как его отдаёт `decodeUpdate`.
 *
 * Тип не экспортирован из yjs; описан здесь ровно в той части, которую читает
 * классификатор, — по клиенту список диапазонов.
 */
interface DeleteSet {
  clients: Map<number, { clock: number; len: number }[]>
}

/** Любая структура из кадра: Item, GC или Skip — Yjs не сужает этот тип. */
type Struct = Y.Item | { id: Y.ID; length: number }

/** Куда разрешилась ссылка: в надгробие, в свежую структуру или в живой элемент. */
type Target = { kind: 'gc' } | { kind: 'fresh'; struct: Y.Item } | { kind: 'item'; item: Y.Item }

/** Место: контейнер, в котором вещь лежит, и ключ, если контейнер — Y.Map. */
interface Place {
  container: string[]
  sub: string | null
  /** Структура, занимающая место `cells/[]` на этом пути, если он туда ведёт. */
  cell: Target | null
  /** Создаётся ли эта ячейка прямо в этом кадре. */
  cellIsFresh: boolean
}

function isItem(struct: Struct): struct is Y.Item {
  return struct instanceof Y.Item
}

function segment(sub: string | null): string {
  return sub === null ? '[]' : `::${sub}`
}

/**
 * Один разбор одного кадра.
 *
 * Класс, а не набор функций, ради памятки разрешённых путей: удаление ячейки,
 * которая считалась, задевает шестнадцать элементов, и разрешать их родителей
 * по одному значило бы шестнадцать раз пройти дерево до корня.
 */
class Frame {
  private readonly byId = new Map<string, Y.Item>()
  private readonly placeMemo = new Map<Y.Item, Place>()
  private walked = 0

  constructor(
    private readonly doc: Y.Doc,
    private readonly dec: { structs: Struct[]; ds: DeleteSet },
  ) {
    // Каждая структура покрывает столько тактов, сколько в ней длины: запись в
    // ячейку, созданную этим же кадром, ищется именно так.
    for (const struct of this.dec.structs) {
      if (!isItem(struct)) continue
      for (let i = 0; i < struct.length; i += 1) {
        this.byId.set(`${struct.id.client}:${struct.id.clock + i}`, struct)
      }
    }
  }

  private step(path: string): void {
    this.walked += 1
    if (this.walked > MAX_WALK) throw new Refusal('кадр слишком велик для разбора', path)
  }

  /**
   * Разрешение ссылки — и вся безопасность гейта держится на нём.
   *
   * Такт выше того, что сервер видел, значит: этого содержимого у сервера нет.
   * Если оно есть в этом же кадре — разрешаем через кадр. Если нет — отказ, и
   * никогда не «пропустим, разберёмся потом».
   *
   * Пропустить нельзя, и это измерено, а не выведено: кадр из нуля структур с
   * одним диапазоном удаления, начинающимся на текущем такте ведущего, Yjs
   * кладёт в `store.pendingDs` и переприменяет внутри каждого следующего
   * `applyUpdate`. Ведущий печатает « world» — у него на экране «hello world»,
   * на сервере «hello», и каждое следующее нажатие удаляется по прибытии.
   * Молча. Навсегда.
   *
   * Надгробие — не этот случай, и такт их механически разводит. Когда одна
   * удалила ячейку, в которой печатает другой, его структура разрешается через
   * origin на такте 8 при состоянии 16: такт ниже, `getItem` возвращает GC, и
   * кадр проходит. Запись в надгробие не меняет ничего, что кто-нибудь увидит.
   *
   * `getItem` бросает на клиенте, о котором хранилище не слышало, — поэтому
   * проверка состояния идёт первой, а не в `catch` после.
   */
  private resolve(id: Y.ID, path: string): Target {
    this.step(path)
    if (id.clock >= Y.getState(this.doc.store, id.client)) {
      const fresh = this.byId.get(`${id.client}:${id.clock}`)
      if (!fresh) throw new Refusal('ссылка на содержимое, которого у семинара нет', path)
      return { kind: 'fresh', struct: fresh }
    }
    const found = Y.getItem(this.doc.store, id)
    if (!(found instanceof Y.Item)) return { kind: 'gc' }
    return { kind: 'item', item: found }
  }

  /**
   * Путь корневого типа — и заодно ячейка, внутри которой мы оказались.
   *
   * Ячейка нужна ради сообщения человеку: «правку в ячейке N не приняли»
   * читается, а «правку по пути cells/[]/::source/[]» — нет.
   */
  private pathOfType(type: Y.AbstractType<unknown>): {
    segs: string[]
    cell: Y.Item | null
  } {
    const segs: string[] = []
    let cell: Y.Item | null = null
    let current: Y.AbstractType<unknown> = type
    for (;;) {
      this.step(segs.join('/'))
      const item = current._item
      if (item === null) {
        // `findRootTypeKey` бросает на оторванном типе — до неё надо дойти живым.
        if (!current.doc) throw new Refusal('запись в тип вне документа', segs.join('/'))
        segs.unshift(Y.findRootTypeKey(current))
        return { segs, cell }
      }
      segs.unshift(segment(item.parentSub))
      const parent = item.parent
      if (!(parent instanceof Y.AbstractType)) {
        throw new Refusal('родитель не разрешается', segs.join('/'))
      }
      // Элемент, лежащий прямо в корне cells, и есть ячейка.
      if (item.parentSub === null && parent._item === null && parent.doc) {
        if (isBookRoot(Y.findRootTypeKey(parent))) cell = item
      }
      current = parent
    }
  }

  /**
   * Место вещи: где лежит и под каким ключом.
   *
   * Родитель приходит в трёх видах, и все три встречаются на проводе: строкой
   * (имя корня записано в байты буквально), идентификатором (элемент, в
   * котором лежит тип) и `null`.
   *
   * `null` — не редкость и не поломка: Yjs пишет родителя только тогда, когда
   * у элемента нет ни левого, ни правого соседа. `meta.set('title')` поверх
   * существующего заголовка соседа имеет — и `parentSub` на проводе НЕТ.
   * Ключ в этом случае берётся у соседа; версия, доверяющая `struct.parentSub`,
   * ошибётся молча и на тестах не покажется: `set('title')` и
   * `set('kernelStatus')` дают побайтово одинаковые структуры.
   */
  private place(target: Target, path: string): Place {
    if (target.kind === 'gc')
      return { container: ['<gc>'], sub: null, cell: null, cellIsFresh: false }

    if (target.kind === 'item') {
      const item = target.item
      const memo = this.placeMemo.get(item)
      if (memo) return memo
      const parent = item.parent
      if (!(parent instanceof Y.AbstractType)) {
        throw new Refusal('родитель не разрешается', path)
      }
      const { segs: container, cell } = this.pathOfType(parent)
      const here: Place = {
        container,
        sub: item.parentSub,
        cell: cell ? { kind: 'item', item: cell } : null,
        cellIsFresh: false,
      }
      if (container.length === 1 && isBookRoot(container[0]) && item.parentSub === null) {
        here.cell = target
      }
      this.placeMemo.set(item, here)
      return here
    }

    const struct = target.struct
    const memo = this.placeMemo.get(struct)
    if (memo) return memo
    this.step(path)

    let here: Place
    const parent = struct.parent
    if (typeof parent === 'string') {
      here = {
        container: [parent],
        sub: struct.parentSub,
        cell: null,
        cellIsFresh: false,
      }
    } else if (parent instanceof Y.ID) {
      const owner = this.resolve(parent, path)
      here = {
        container: this.slot(owner, path),
        sub: struct.parentSub,
        cell: this.place(owner, path).cell,
        cellIsFresh: this.place(owner, path).cellIsFresh,
      }
    } else {
      // Родителя на проводе нет — берём его у соседа, вместе с ключом.
      const neighbourId = struct.origin ?? struct.rightOrigin
      if (!neighbourId) throw new Refusal('структура без родителя и без соседа', path)
      const neighbour = this.resolve(neighbourId, path)
      const beside = this.place(neighbour, path)
      here = {
        container: beside.container,
        sub: beside.sub,
        cell: beside.cell,
        cellIsFresh: beside.cellIsFresh,
      }
    }

    if (here.container.length === 1 && isBookRoot(here.container[0]) && here.sub === null) {
      here.cell = target
      here.cellIsFresh = true
    }
    this.placeMemo.set(struct, here)
    return here
  }

  /** Полный путь самой вещи: место контейнера плюс её собственный сегмент. */
  private slot(target: Target, path: string): string[] {
    if (target.kind === 'gc') return ['<gc>']
    const here = this.place(target, path)
    return [...here.container, segment(here.sub)]
  }

  /** Имя ячейки, если его можно прочитать: только ради сообщения человеку. */
  private cellIdOf(place: Place): string | null {
    const cell = place.cell
    if (!cell || cell.kind !== 'item') return null
    const content = cell.item.content
    if (!(content instanceof Y.ContentType)) return null
    const map = content.type
    if (!(map instanceof Y.Map)) return null
    const id: unknown = map.get('id')
    return typeof id === 'string' ? id : null
  }

  /** Правило для разрешённого пути. `null` — глагол, который никого не касается. */
  private verdictFor(slot: string[], place: Place, op: 'insert' | 'delete'): Verdict | null {
    const path = slot.join('/')
    if (slot[0] === '<gc>') return null

    if (isBookRoot(slot[0])) {
      const cellId = this.cellIdOf(place)
      // Сам состав тетради.
      if (slot.length === 2 && slot[1] === '[]') {
        return {
          rule: 'structure',
          verb: op === 'insert' ? 'add' : 'remove',
          cellId,
          path,
        }
      }
      if (slot.length < 3) throw new Refusal('запись в неизвестное место тетради', path)

      const key = slot[2].startsWith('::') ? slot[2].slice(2) : null
      if (key === null) throw new Refusal('запись в неизвестное место тетради', path)

      // Ячейка, созданная этим же кадром, — часть создания целиком; её значения
      // проверяются отдельно, в checkFresh.
      if (place.cellIsFresh) return { rule: 'structure', verb: 'add', cellId, path }

      if (SERVER_OWNED.has(key)) {
        throw new Refusal('это поле пишет сервер, а не браузер', path)
      }
      if (key === 'id') throw new Refusal('имя ячейки не меняется', path)
      if (key === 'source') {
        // Внутрь текста — правка; замена самого ключа — нет: она сносит Y.Text,
        // в котором в этот момент стоят чужие курсоры.
        if (slot.length === 3) throw new Refusal('текст ячейки заменяется целиком', path)
        return { rule: 'edit', cellId, path }
      }
      if (key === 'type') {
        if (slot.length !== 3) throw new Refusal('запись в неизвестное место тетради', path)
        return { rule: 'edit', cellId, path }
      }
      throw new Refusal('неизвестный ключ ячейки', path)
    }

    if (slot[0] === META_KEY) {
      if (slot.length === 2 && slot[1] === '::title') {
        return { rule: 'title', cellId: null, path }
      }
      throw new Refusal('это поле семинара пишет сервер', path)
    }

    if (slot[0] === CHAT_KEY || slot[0] === TERMINAL_KEY) {
      throw new Refusal('эту ленту пишет сервер', path)
    }

    throw new Refusal('запись в раздел, которого у документа нет', path)
  }

  /**
   * Значения новой ячейки, а не только путь.
   *
   * Иначе разрешение «создавать ячейки» открывало бы дыру: свежая ячейка с
   * поддельным `stdin` рисует преподавателю приглашение ввести пароль и
   * складывает нажатия в чужую переменную. Поле, которого нет в `FRESH_KEYS`,
   * — отказ; всё, что ячейка вправе принести, но не вправе объявлять о себе
   * сама (вывод, «In [7]»), сервер гасит после применения, а не отказом: см.
   * ниже, где это разобрано целиком.
   */
  private checkFresh(fresh: Map<Y.Item, Map<string, Y.Item>>): string[] {
    const namesHere = new Set<string>()
    const created: string[] = []
    for (const keys of fresh.values()) {
      const path = `${CELLS_KEY}/[]`
      for (const key of keys.keys()) {
        if (!FRESH_KEYS.has(key)) throw new Refusal(`новая ячейка несёт лишнее поле «${key}»`, path)
      }
      const id = valueOf(keys.get('id'))
      if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
        throw new Refusal('у новой ячейки нет имени', path)
      }
      /*
       * Имя обязано быть новым. Совпадающее имя — не опечатка, а захват:
       * «Запустить» преподавателя ищет ячейку по имени и выполнит чужой
       * исходник.
       */
      if (namesHere.has(id)) throw new Refusal('две новые ячейки с одним именем', path)
      namesHere.add(id)
      /*
       * Во ВСЕХ тетрадях комнаты, а не в одной: ячейку ищут по имени, не зная,
       * в какой она тетради (см. `findCell`), и совпадение имён в двух разных
       * тетрадях означало бы, что «Запустить» иногда запускает не ту.
       *
       * Но совпадение — не отказ, см. ниже.
       */
      const taken = allCellArrays(this.doc).some((cells) =>
        cells.toArray().some((c) => c instanceof Y.Map && c.get('id') === id),
      )

      const type = valueOf(keys.get('type'))
      if (type !== 'code' && type !== 'markdown') throw new Refusal('у новой ячейки нет вида', path)

      if (!isType(keys.get('source'), Y.Text))
        throw new Refusal('текст новой ячейки не Y.Text', path)
      if (!isType(keys.get('outputs'), Y.Array))
        throw new Refusal('вывод новой ячейки не Y.Array', path)

      /*
       * Ни готовый вывод, ни «In [7]», ни занятое имя отказом не судятся, и
       * это одно решение с двумя половинами.
       *
       * Обе — Ctrl+Z. Yjs отменяет удаление КОПИЕЙ, так что отмена удаления
       * посчитавшей ячейки приходит новой ячейкой с готовым выводом; а если
       * кто-то успел вернуть ту же ячейку из истории (возврат воссоздаёт её с
       * ПРЕЖНИМ именем), то ещё и с занятым именем. Судилось это памятью
       * сервера об удалениях — десять минут и тридцать штук, — и за этими
       * границами обычный жест стоил человеку закрытого сокета, стёртого кэша
       * и перезагрузки страницы посреди пары: ровно того, чего память и должна
       * была не допустить.
       *
       * Отличать незачем: `ops.ts · settleFresh` и так приводит КАЖДУЮ новую
       * ячейку к чистой и возвращает вывод из записи СЕРВЕРА, а не из кадра, —
       * пол цел и без отказа. А занятое имя разводит наблюдатель за двойниками
       * (collab/index.ts): он снимает именно пришедшую копию, так что подменить
       * чужую ячейку своей по имени по-прежнему нельзя.
       *
       * В `created` занятое имя не попадает: `settleFresh` ищет по имени и
       * привёл бы к чистой ту ячейку, что уже живёт в тетради, — то есть стёр
       * бы комнате чужой вывод по одному совпадению.
       */
      if (!taken) created.push(id)
    }
    return created
  }

  /** Разбор всего кадра. Бросает `Refusal` — кадр не применяется целиком. */
  judge(): {
    verdicts: Verdict[]
    retyped: string[]
    created: string[]
    removed: string[]
  } {
    const verdicts: Verdict[] = []
    const seen = new Set<string>()
    const retyped: string[] = []
    /** Свежие ячейки: карта ключей, которые кадр в них кладёт. */
    const fresh = new Map<Y.Item, Map<string, Y.Item>>()

    const keep = (verdict: Verdict | null): void => {
      if (!verdict) return
      const key = `${verdict.rule}:${verdict.verb ?? ''}:${verdict.path}:${verdict.cellId ?? ''}`
      if (seen.has(key)) return
      seen.add(key)
      verdicts.push(verdict)
    }

    for (const struct of this.dec.structs) {
      if (!isItem(struct)) continue
      /*
       * Новизна — не оптимизация, а то, что даёт гейту пережить обычную
       * перезагрузку страницы. `y-indexeddb` переигрывает локальный кэш при
       * каждом открытии, а `y-websocket` пересылает всё, что не он сам, — то
       * есть каждый браузер заново предлагает серверу весь свой документ,
       * вместе с `terminal`, `chat` и выводами. Без этой проверки такой кадр
       * отказывался бы в любой комнате, при любых правилах, а предписанная
       * перестройка стирала бы студенту кэш.
       */
      if (struct.id.clock + struct.length <= Y.getState(this.doc.store, struct.id.client)) continue

      const target: Target = { kind: 'fresh', struct }
      const place = this.place(target, CELLS_KEY)
      const slot = this.slot(target, CELLS_KEY)
      const verdict = this.verdictFor(slot, place, 'insert')
      keep(verdict)

      if (place.cellIsFresh && place.cell?.kind === 'fresh') {
        const cell = place.cell.struct
        const keys = fresh.get(cell) ?? new Map<string, Y.Item>()
        fresh.set(cell, keys)
        // Ключи ячейки лежат на глубине 3; глубже — уже содержимое.
        if (slot.length === 3 && slot[2].startsWith('::')) keys.set(slot[2].slice(2), struct)
        else if (slot.length > 3 && slot[2] !== '::source') {
          // Готовый вывод у новой ячейки в документе не остаётся: сервер
          // приводит всякую новую ячейку к чистой сразу после применения
          // (ops.ts · settleFresh). Всё прочее содержимое — отказ.
          if (slot[2] !== '::outputs') {
            throw new Refusal('новая ячейка несёт готовое содержимое', slot.join('/'))
          }
        }
      } else if (verdict?.rule === 'edit' && slot.length === 3 && slot[2] === '::type') {
        const value = valueOf(struct)
        if (value !== 'code' && value !== 'markdown') {
          throw new Refusal('такого вида ячейки не бывает', slot.join('/'))
        }
        if (verdict.cellId) retyped.push(verdict.cellId)
      }
    }

    const created = this.checkFresh(fresh)

    for (const [client, ranges] of this.dec.ds.clients) {
      for (const range of ranges) {
        let clock = range.clock
        const end = range.clock + range.len
        while (clock < end) {
          this.step(`${CELLS_KEY}#${client}`)
          const target = this.resolve(Y.createID(client, clock), `${CELLS_KEY}#${client}`)
          if (target.kind === 'gc') {
            clock += 1
            continue
          }
          const struct = target.kind === 'item' ? target.item : target.struct
          const step = Math.max(1, struct.id.clock + struct.length - clock)
          clock += step
          // Уже удалённое ничего не меняет — и это тот же кэш из IndexedDB.
          if (target.kind === 'item' && target.item.deleted) continue
          keep(this.verdictFor(...this.outermost(target)))
        }
      }
    }

    const removed = verdicts
      .filter((v) => v.rule === 'structure' && v.verb === 'remove' && v.cellId)
      .map((v) => v.cellId as string)
    return { verdicts, retyped, created, removed }
  }

  /**
   * Самый внешний предок, удаляемый этим же кадром, — и приговор выносится ему.
   *
   * Правило «взять внешний элемент диапазона» здесь неверно, и это измерено:
   * удаление одной ячейки, которая хоть раз считалась, даёт диапазоны под
   * ДВУМЯ клиентами — кроме браузера, свой такт есть у сервера, писавшего
   * `outputs` и `state`. Внутри серверного диапазона внешний элемент — это
   * запись вывода, которую пол объявляет серверной, так что по тому правилу
   * любое законное удаление посчитавшей ячейки отказывалось бы в любой
   * комнате при разрешающих умолчаниях.
   *
   * По вложенности удаление ячейки с выводом сворачивается из шестнадцати
   * путей в ровно один приговор — «удаление, родитель которого корень cells» —
   * и пятнадцать поглощённых.
   */
  private outermost(target: Target): [string[], Place, 'delete'] {
    let best = target
    let current = target
    for (;;) {
      this.step('')
      const owner = this.ownerOf(current)
      if (!owner) break
      if (owner.kind === 'gc') break
      const id = owner.kind === 'item' ? owner.item.id : owner.struct.id
      if (!Y.isDeleted(this.dec.ds, id)) break
      best = owner
      current = owner
    }
    return [this.slot(best, ''), this.place(best, ''), 'delete']
  }

  /** Элемент, в котором лежит контейнер этой вещи, — на один уровень выше. */
  private ownerOf(target: Target): Target | null {
    if (target.kind === 'gc') return null
    if (target.kind === 'item') {
      const parent = target.item.parent
      if (!(parent instanceof Y.AbstractType)) return null
      return parent._item ? { kind: 'item', item: parent._item } : null
    }
    const parent = target.struct.parent
    if (typeof parent === 'string') return null
    if (parent instanceof Y.ID) return this.resolve(parent, '')
    const neighbourId = target.struct.origin ?? target.struct.rightOrigin
    if (!neighbourId) return null
    return this.ownerOf(this.resolve(neighbourId, ''))
  }
}

/** Значение простого ключа Y.Map из структуры кадра. */
function valueOf(struct: Y.Item | undefined): unknown {
  if (!struct) return undefined
  const content = struct.content
  if (content instanceof Y.ContentAny) return content.arr[0]
  if (content instanceof Y.ContentString) return content.str
  if (content instanceof Y.ContentType) return content.type
  return undefined
}

function isType(struct: Y.Item | undefined, kind: unknown): boolean {
  if (!struct) return false
  const content = struct.content
  return content instanceof Y.ContentType && content.type instanceof (kind as never)
}

/**
 * Разобрать кадр. Не применяет ничего и не трогает документ.
 */
export function classify(doc: Y.Doc, payload: Uint8Array): Judgement {
  if (payload.byteLength > MAX_SYNC_FRAME_BYTES) {
    return { ok: false, why: 'слишком большой кадр', path: '' }
  }
  try {
    const dec = Y.decodeUpdate(payload) as unknown as {
      structs: Struct[]
      ds: DeleteSet
    }
    const { verdicts, retyped, created, removed } = new Frame(doc, dec).judge()
    return { ok: true, verdicts, retyped, created, removed }
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, why: err.why, path: err.path }
    // Развалившийся разбор — отказ, а не пропуск: пропустить то, что не смогли
    // прочитать, значит выполнить это после того, как проверка перестала смотреть.
    return { ok: false, why: 'кадр не разбирается', path: '' }
  }
}

/**
 * Разрешают ли правила комнаты то, что кадр делает.
 *
 * Отдельно от разбора нарочно: разбор говорит, ЧТО в кадре, и не знает ни про
 * комнату, ни про роль; правила говорят, кому это можно. Тест на разбор от
 * правил не зависит, и наоборот.
 */
export function permits(
  verdicts: Verdict[],
  rules: RoomRules,
  role: 'host' | 'participant',
): { ok: true } | { ok: false; rule: GateRule; message: string } {
  for (const verdict of verdicts) {
    if (verdict.rule === 'title') {
      if (role === 'host') continue
      return {
        ok: false,
        rule: 'title',
        message: 'Имя семинара меняет преподаватель.',
      }
    }
    if (verdict.rule === 'edit') {
      if (allows(rules.edit, role)) continue
      return {
        ok: false,
        rule: 'edit',
        message:
          'В этом семинаре тетрадь принадлежит преподавателю — написанное вами не отправлено.',
      }
    }
    const verb = verdict.verb ?? 'add'
    if (allowsStructure(rules.structure, role, verb)) continue
    return {
      ok: false,
      rule: 'structure',
      message:
        verb === 'add'
          ? 'В этом семинаре ячейки добавляет преподаватель.'
          : 'В этом семинаре ячейки убирает преподаватель.',
    }
  }
  return { ok: true }
}
