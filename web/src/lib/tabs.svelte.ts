/**
 * Что открыто в центре экрана.
 *
 * Всё — файлы, включая тетради: тетрадь перестала быть особой вкладкой,
 * приколоченной первой, и стала тем, чем она и является, — файлом, который
 * открывается ячейками. Первая тетрадь комнаты открывается сама при первом
 * заходе; дальше она закрывается и открывается, как любой другой файл.
 *
 * Три правила, из которых состоит вся эта модель.
 *
 * **Ничего открытого — это состояние, а не поломка.** Закрыв последнюю вкладку,
 * человек видит пустой центр и подсказку слева. Раньше такого состояния не
 * было, потому что тетрадь закрыть было нельзя.
 *
 * **Общий документ — вкладка у всех.** Он приходит с сервера и появляется у
 * каждого, включая тех, кто зашёл в середине занятия. Закрыть его у комнаты
 * может тот, кому это разрешает правило; остальные могут только уйти от него,
 * и вкладка остаётся стоять.
 *
 * **Свои вкладки переживают перезагрузку.** Список путей лежит в localStorage
 * рядом с состоянием панелей. Файла может уже не быть — тогда вкладка тихо
 * исчезает при первом же списке файлов; это ровно то, что должно случиться, и
 * поэтому проверяется не при чтении из хранилища, а от списка.
 */

/** Ключ вкладки: путь файла, или `null` — не открыто ничего. */
export type TabKey = string | null

const STORE_PREFIX = 'colloq.tabs.'
/** Сколько своих вкладок помним между заходами. Больше — это уже не вкладки. */
const MAX_REMEMBERED = 12

export class Tabs {
  /** Пути, которые открыл этот человек, в порядке открытия. */
  mine = $state<string[]>([])
  /** Что показано сейчас. `null` — тетрадь. */
  active = $state<TabKey>(null)

  /**
   * Человек в этой комнате впервые — ему открывают тетрадь.
   *
   * Отличается от «закрыл всё»: у второго в хранилище лежит пустой список, и
   * открывать ему тетрадь заново значило бы отменять его же решение каждым
   * заходом.
   */
  readonly firstVisit: boolean

  readonly #key: string

  constructor(sessionId: string) {
    this.#key = STORE_PREFIX + sessionId
    this.firstVisit = readRaw(this.#key) === null
    this.mine = read(this.#key)
  }

  /**
   * Полный ряд вкладок: тетрадь, общий документ, свои.
   *
   * Общий стоит вторым и не дублируется тем, кто открыл его же себе: одна
   * вкладка на файл, кто бы её ни завёл.
   */
  row(...pinned: (string | null)[]): string[] {
    /*
     * Приколотые — те, что комната открыла всем: общий экран и лекция. Они идут
     * первыми и не дублируются теми, кто открыл их же себе: одна вкладка на
     * файл, кто бы её ни завёл.
     */
    const first = pinned.filter((path): path is string => typeof path === 'string' && path !== '')
    const seen = new Set(first)
    return [...new Set(first), ...this.mine.filter((path) => !seen.has(path))]
  }

  /** Открыть файл и перейти на него. Уже открытый просто становится текущим. */
  open(path: string): void {
    if (!this.mine.includes(path)) {
      this.mine = [...this.mine, path]
      this.#remember()
    }
    this.active = path
  }

  /** Показать вкладку, не открывая ничего нового. */
  show(key: TabKey): void {
    this.active = key
  }

  /**
   * Убрать вкладку у себя.
   *
   * Возвращает, осталась ли она в ряду: общий документ у себя не закрывается —
   * закрыть его можно только у всей комнаты, и это отдельное действие с
   * отдельным правом. Уйти от него в тетрадь всё равно можно, и это здесь и
   * происходит.
   */
  close(path: string, board: string | null): boolean {
    const wasActive = this.active === path
    if (this.mine.includes(path)) {
      this.mine = this.mine.filter((open) => open !== path)
      this.#remember()
    }
    const stays = board === path
    if (wasActive) this.active = stays ? null : this.#neighbour(path, board)
    return stays
  }

  /**
   * Файлы, которых больше нет, уходят вместе со своими вкладками.
   *
   * Зовётся от списка файлов комнаты: файл мог убрать преподаватель, а мог
   * переписать `os.remove` в ячейке. Вкладка на исчезнувший файл — это пустая
   * область без объяснения.
   */
  keepOnly(paths: Set<string>): void {
    const kept = this.mine.filter((path) => paths.has(path))
    if (kept.length === this.mine.length) return
    this.mine = kept
    this.#remember()
    if (typeof this.active === 'string' && !paths.has(this.active)) this.active = null
  }

  /** Переименованный файл остаётся открытым — под новым именем. */
  rename(from: string, to: string): void {
    if (!this.mine.includes(from)) return
    this.mine = this.mine.map((path) => (path === from ? to : path))
    this.#remember()
    if (this.active === from) this.active = to
  }

  /**
   * Куда уйти, закрыв вкладку.
   *
   * К соседу слева, а не в тетрадь: закрывая третий из четырёх открытых файлов,
   * человек занимается файлами, и выкидывать его из них — это лишний путь
   * обратно.
   */
  #neighbour(closing: string, board: string | null): TabKey {
    const row = this.row(board).filter((path) => path !== closing)
    if (row.length === 0) return null
    const at = this.row(board).indexOf(closing)
    return row[Math.max(0, at - 1)] ?? null
  }

  #remember(): void {
    try {
      localStorage.setItem(this.#key, JSON.stringify(this.mine.slice(0, MAX_REMEMBERED)))
    } catch {
      /* приватный режим или полный диск — вкладки просто не переживут заход */
    }
  }
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function read(key: string): string[] {
  try {
    const raw = readRaw(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .slice(0, MAX_REMEMBERED)
  } catch {
    return []
  }
}
