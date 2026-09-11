import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createAnchoredFilesystem } from './secure-files.js'
import path from 'node:path'
import { config } from './config.js'
import type { FileEntry, FilesDelta } from '@shared/protocol'
import { MAX_DEPTH, MAX_PATH, baseOf, kindOf, normalizePath, parentOf } from '@shared/paths'

export const workspaceFs = createAnchoredFilesystem(config.workspaceDir, {
  allowUnsafeDevelopment: process.env.NODE_ENV !== 'production' &&
    (process.env.NODE_ENV === 'test' || process.env.COLLOQ_UNSAFE_DEV_FILES === '1'),
})

/**
 * Each session gets a directory under the shared /workspace volume. The kernel
 * container mounts the same volume, so `open('data.csv')` inside a cell and the
 * Files panel in the browser look at the same bytes.
 */
export function sessionDir(sessionId: string): string {
  const dir = path.join(config.workspaceDir, sessionId)
  const made = !workspaceFs.existsSync(dir)
  workspaceFs.mkdirSync(dir, { recursive: true })
  /*
   * Права выставляются явно, а не оставляются на umask процесса.
   *
   * В папку пишут двое: сервер и ядро комнаты — а это разные пользователи,
   * когда сервер работает на хосте от root, а ядро внутри контейнера от
   * runner. При umask 0022 папка выходит 0755, и первая же `open('a.txt','w')`
   * в ячейке падает PermissionError — на зелёном экране, без единого слова о
   * причине. 2775: пишут оба, а setgid держит группу на всём, что заведут
   * внутри, чтобы право не терялось на первой же вложенной папке.
   *
   * Только на своём создании: чужие права у уже существующей папки не наши,
   * а на Windows режим всё равно ничего не значит.
   */
  if (made && process.platform !== 'win32') {
    try {
      workspaceFs.chmodSync(dir, 0o2775)
    } catch {
      // Не наша папка — значит и права не наши. Работа комнаты от этого не
      // зависит: если писать нельзя, об этом скажет первая же запись.
    }
  }
  return dir
}

/** Kernel-side path (the kernel container mounts the volume at /workspace too). */
export function kernelCwd(sessionId: string): string {
  return `/workspace/${sessionId}`
}

/**
 * Все временные имена, какие в комнате бывают, — одним правилом.
 *
 * Пишут рядом и переименовывают двое: загрузка (`routes/files.ts`,
 * `.имя.uploading-<hex>`) и автосохранение редактора (`writeText` ниже,
 * `.имя.saving-<pid>-<время>`). Уборщик знал только первое имя, хотя обещал
 * убрать всё, что оставило падение посреди записи. Второе при этом копится
 * само собой: редактор сохраняется каждые несколько секунд, и падение процесса
 * оставляет полтора мегабайта, которых нет в дереве (имя с точки), нельзя
 * удалить из панели — и которые считает `sessionBytes`, то есть они отъедают
 * потолок комнаты до ручной чистки.
 *
 * Хвост после «что делаем» — неповторимая часть, шестнадцатеричная или
 * `<pid>-<время>`; шесть знаков минимум, чтобы под правило не попал файл,
 * который человек назвал `.заметки.saving-1`.
 */
const TEMP_FILE = /^\..+\.(?:uploading|saving)-[0-9a-z][0-9a-z-]{5,}$/i

/**
 * Clear away temp files an interrupted write left behind.
 *
 * An upload — and an editor autosave — writes beside its target and renames on
 * success, and every failure path removes its own temp: every path except the
 * process dying mid-write. What that leaves is a dotfile, so the room never
 * sees it and nobody can remove it from the panel either. Swept on the next
 * upload into the same seminar, which is the moment somebody is thinking about
 * that folder anyway.
 */
export function sweepStaleUploads(sessionId: string, olderThanMs = 60 * 60 * 1000): void {
  const root = sessionDir(sessionId)
  const cutoff = Date.now() - olderThanMs
  const walk = (rel: string, depth: number): void => {
    let names: string[]
    try {
      names = workspaceFs.readdirSync(path.join(root, rel))
    } catch {
      return
    }
    for (const name of names) {
      const here = rel ? `${rel}/${name}` : name
      const full = path.join(root, here)
      if (TEMP_FILE.test(name)) {
        try {
          if (workspaceFs.statSync(full).mtimeMs < cutoff) {
            workspaceFs.rmSync(full, { force: true })
            // Временных имён в дереве и так нет, но обход их считал в потолок
            // записей: убрали — значит, посчитанное устарело.
            forgetTree(sessionId)
          }
        } catch {
          /* somebody else got there first */
        }
        continue
      }
      // Папки тоже: загрузка теперь ложится в ту, на которую её принесли, и
      // недописанный файл остаётся там же. Скрытые пропускаются — кроме тех
      // самых временных, которые разобраны выше.
      if (name.startsWith('.') || depth + 1 >= MAX_DEPTH) continue
      try {
        if (workspaceFs.lstatSync(full).isDirectory()) walk(here, depth + 1)
      } catch {
        /* исчезла */
      }
    }
  }
  walk('', 0)
}

/**
 * То же самое по всем комнатам — один раз на запуске.
 *
 * Уборка висела на следующей загрузке файла в ту же комнату, и для загрузок
 * этого хватало: недописанная появляется там, где кто-то как раз возится с
 * папкой. Автосохранение редактора устроено иначе — оно идёт само, каждые
 * несколько секунд, в комнате, куда могут вообще ничего не загружать. Хвост от
 * упавшего процесса лежал бы там до ручной чистки, невидимый в дереве и
 * посчитанный в потолке комнаты.
 *
 * Запуск — правильный момент: временный файл переживает ровно то падение,
 * после которого мы и стартуем. Час выдержки остаётся: комнаты на общем
 * томе — редкость, но недописанный файл соседа убирать не нам.
 */
export function sweepAllStaleUploads(olderThanMs?: number): void {
  let rooms: string[]
  try {
    rooms = workspaceFs.readdirSync(config.workspaceDir)
  } catch {
    return // тома ещё нет — значит и мести нечего
  }
  for (const room of rooms) {
    try {
      if (!workspaceFs.lstatSync(path.join(config.workspaceDir, room)).isDirectory()) continue
    } catch {
      continue
    }
    sweepStaleUploads(room, olderThanMs)
  }
}

export function resolveInSession(sessionId: string, name: string): string | null {
  const rel = normalizePath(name)
  if (rel === null || rel === '') return null
  const dir = sessionDir(sessionId)
  const full = path.join(dir, rel)
  /*
   * The name check above is about the REQUEST: it stops `../` from leaving the
   * folder. This one is about the ENTRY: it stops a symlink inside the folder
   * from pointing out of it. They are different holes and only the first was
   * closed. The kernel container runs any Python a student types on the same
   * mounted workspace, so `os.symlink('/data/session-secret', 'key.txt')` put
   * a file in the room's list that the download route then streamed — the
   * secret every token in the product is signed with.
   */
  let realDir: string
  try {
    realDir = workspaceFs.realpathSync(dir)
  } catch {
    return null
  }
  return contained(full, realDir) ? full : null
}

/**
 * Лежит ли путь внутри папки семинара — с учётом того, что его может ещё не
 * быть.
 *
 * Раньше несуществующий путь пропускался как есть, и на плоской папке это было
 * верно: единственный сегмент подделать нечем. С папками — уже нет: ссылка
 * могла оказаться на промежуточной папке, а `realpath` на несуществующем файле
 * бросает, ничего про его родителей не сказав. Поэтому поднимаемся до
 * ближайшего существующего предка: если ОН внутри, то и всё, чего ещё нет под
 * ним, будет внутри — ссылке взяться неоткуда там, где ничего нет.
 */
function contained(full: string, realDir: string): boolean {
  let probe = full
  for (let up = 0; up <= MAX_DEPTH + 2; up++) {
    try {
      const real = workspaceFs.realpathSync(probe)
      return real === realDir || real.startsWith(realDir + path.sep)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      const parent = path.dirname(probe)
      if (parent === probe) return false
      probe = parent
    }
  }
  return false
}

/**
 * Сколько строк дерева отдаётся комнате.
 *
 * Потолок, а не страница: панель рисует дерево целиком, а `pip install` в
 * ячейке заводит в папке семинара тысячи файлов за один заход. Две тысячи строк
 * — это уже больше, чем кто-нибудь прочитает, и меньше, чем то, на чём
 * подавится отрисовка.
 */
const MAX_ENTRIES = 2000

/** Дерево комнаты — и признак того, что оно упёрлось в потолок. */
export interface FileTree {
  files: FileEntry[]
  /**
   * Список неполон: часть папок в потолок не поместилась и осталась
   * нераскрытой.
   *
   * Признак, а не молчание: обрезанный список — это не «в комнате столько
   * файлов», и всё, что считает по нему пропажу (тетради, доска, вкладки),
   * обязано знать разницу, иначе оно удалит живое.
   */
  truncated: boolean
}

/**
 * Чем новое дерево отличается от прошлого.
 *
 * Считается по двум обходам — тому, что комната уже видела, и свежему, — и
 * едет вместо всего списка (shared/protocol.ts · FilesDelta). Цена перемены
 * перестаёт зависеть от размера папки: заведённый файл — это одна запись в
 * кадре, а не две тысячи.
 *
 * `at` у новой записи — её место в ГОТОВОМ списке. Это работает потому, что
 * порядок дерева однозначно определён его составом (обход в глубину, папки
 * перед файлами, по имени): уцелевшие записи стоят друг относительно друга в
 * новом списке ровно так же, как в старом, и вставка по возрастанию `at` после
 * удалений даёт в точности новый список. Правило применения — одно, и живёт
 * оно на вкладке (web/src/lib/files-delta.ts), а проверено на обеих.
 */
export function treeDelta(before: readonly FileEntry[], after: readonly FileEntry[]): FilesDelta {
  const was = new Map<string, FileEntry>()
  for (const entry of before) was.set(entry.path, entry)
  const changed: FileEntry[] = []
  const added: { at: number; entry: FileEntry }[] = []
  const kept = new Set<string>()
  after.forEach((entry, at) => {
    const old = was.get(entry.path)
    if (!old) {
      added.push({ at, entry })
      return
    }
    kept.add(entry.path)
    // Имя — тоже: переименование внутри папки меняет путь целиком, но файл,
    // переехавший на диске мимо нас, может прийти с тем же путём и другим всем.
    if (
      old.dir !== entry.dir ||
      old.size !== entry.size ||
      old.modifiedAt !== entry.modifiedAt ||
      old.name !== entry.name
    )
      changed.push(entry)
  })
  const removed: string[] = []
  for (const entry of before) if (!kept.has(entry.path)) removed.push(entry.path)
  return { removed, changed, added }
}

/**
 * Папка семинара деревом — в том порядке, в каком её рисуют.
 *
 * Плоский список, а не вложенный: по нему одинаково просто и построить дерево в
 * панели, и пройти его целиком на сервере, и он влезает в то же сообщение
 * `files`, которое комната уже получает. Порядок — обход в глубину, папки перед
 * файлами на каждом уровне; клиенту остаётся отрисовать его как есть.
 *
 * Читается при этом не в глубину, а уровень за уровнем, и это не мелочь.
 * Раньше первая же разросшаяся подпапка (`!unzip` датасета, `pip install -t .`)
 * выедала потолок целиком, и файлы КОРНЯ — вместе с тетрадью комнаты — в
 * список не попадали вовсе; тетрадь, которой нет в списке, считалась удалённой
 * и стиралась у всех со всеми ячейками. Обрезаться должно самое глубокое, а не
 * самое верхнее, и об обрезке надо сказать вслух.
 */
/**
 * Короткая память обхода — на комнату.
 *
 * Обход стоит `readdir` плюс `lstat` на каждую из двух тысяч записей и делается
 * синхронно, в том же цикле, где сервер отвечает всем остальным. Дважды подряд
 * одно и то же спрашивают постоянно: рассылка комнате и ответ тому, кто нажал,
 * идут одним тиком (`routes/files.ts`), а после перезапуска сервера пятьсот
 * вкладок возвращаются в одну-две секунды и каждая спрашивает дерево сама.
 *
 * Окно маленькое нарочно: это память на пачку вызовов подряд, а не кэш. Всё,
 * что меняет дерево через этот модуль, память сбрасывает само (см. `forgetTree`
 * ниже по файлу).
 *
 * Но «через этот модуль» проходит не всякая запись, и на слово этому полагаться
 * нельзя. Загрузка кладёт файл `rename`'ом (`routes/files.ts`), ячейка пишет из
 * контейнера, редактор сохраняет открытый файл, проекция тетради — сбросить
 * память там некому, а спрашивают дерево сразу после записи и в том же тике.
 * Так память отвечала списком БЕЗ только что загруженного файла — тому самому,
 * кто его загрузил, и в ответе на его же запрос. Поэтому на попадании память
 * не верят на слово, а сверяют с диском: у каждой прочитанной папки записано
 * время её правки, и появление, исчезновение или переименование любой записи
 * его двигает — по одному `lstat` на папку против `readdir` плюс `lstat` на
 * каждую из двух тысяч записей.
 *
 * Что сверкой не ловится — правка СОДЕРЖИМОГО существующего файла: время
 * папки от неё не двигается, и размер с датой в списке могут отстать на окно.
 * Это и есть весь оставшийся предел опоздания: состав дерева всегда верен, а
 * цифра рядом с именем — не старше трёхсот миллисекунд.
 */
const TREE_MEMO_MS = 300

/** Время правки каждой папки, прочитанной обходом, — абсолютными путями. */
type TreeStamp = { path: string; mtimeMs: number }[]

const treeMemo = new Map<string, { at: number; tree: FileTree; stamp: TreeStamp }>()

/** Не поменялась ли ни одна из папок с тех пор, как их обошли. */
function stampHolds(stamp: TreeStamp): boolean {
  for (const dir of stamp) {
    let now: fs.Stats
    try {
      now = workspaceFs.lstatSync(dir.path)
    } catch {
      // Папку унесли — дерево точно не то. Пересчитать.
      return false
    }
    if (now.mtimeMs !== dir.mtimeMs) return false
  }
  return true
}

/** Дерево этой комнаты (или всех) посчитать заново, не дожидаясь окна. */
export function forgetTree(sessionId?: string): void {
  if (sessionId === undefined) treeMemo.clear()
  else treeMemo.delete(sessionId)
}

export function listTree(sessionId: string): FileTree {
  const known = treeMemo.get(sessionId)
  // Копия обёртки, а не самого списка: `files` читают, но не правят, и
  // копировать две тысячи записей ради этого значило бы вернуть половину цены
  // обхода обратно.
  if (known && Date.now() - known.at < TREE_MEMO_MS && stampHolds(known.stamp)) {
    return { files: known.tree.files, truncated: known.tree.truncated }
  }
  const { tree, stamp } = walkTree(sessionId)
  const now = Date.now()
  /*
   * Просроченное убирается здесь же, на промахе.
   *
   * Иначе карта росла бы записью на каждую комнату, которую инстанс когда-либо
   * показывал, — а в записи до двух тысяч строк дерева. Уборки по таймеру для
   * этого заводить незачем: промах и есть тот момент, когда о комнатах вообще
   * вспоминают, и стоит он рядом с обходом папки ничего.
   */
  for (const [id, entry] of treeMemo) if (now - entry.at >= TREE_MEMO_MS) treeMemo.delete(id)
  treeMemo.set(sessionId, { at: now, tree, stamp })
  return tree
}

function walkTree(sessionId: string): { tree: FileTree; stamp: TreeStamp } {
  const root = sessionDir(sessionId)
  /** Содержимое каждой прочитанной папки — в порядке отрисовки. */
  const children = new Map<string, FileEntry[]>()
  const stamp: TreeStamp = []
  let total = 0
  let truncated = false

  const read = (rel: string): FileEntry[] => {
    const dir = rel ? path.join(root, rel) : root
    /*
     * Время правки папки снимается ДО чтения, и порядок тут существенный.
     *
     * Запись, успевшая между `lstat` и `readdir`, попадёт в список с прежним
     * отпечатком — сверка увидит расхождение и лишний раз пересчитает.
     * Обратный порядок ошибается в другую сторону: список без новой записи с
     * уже новым временем сверку проходит, то есть врёт всё окно целиком.
     */
    let mtimeMs: number | null = null
    try {
      mtimeMs = workspaceFs.lstatSync(dir).mtimeMs
    } catch {
      /* исчезла — ниже это увидит и readdir */
    }
    let names: string[]
    try {
      names = workspaceFs.readdirSync(dir)
    } catch {
      return []
    }
    // Только прочитанные папки: непрочитанную сверять не по чему, а её
    // появление и пропажу видно по времени родителя.
    if (mtimeMs !== null) stamp.push({ path: dir, mtimeMs })
    const dirs: FileEntry[] = []
    const files: FileEntry[] = []
    for (const name of names) {
      if (name.startsWith('.') || name === '__pycache__') continue
      const here = rel ? `${rel}/${name}` : name
      let stat: fs.Stats
      try {
        // lstat, not stat: a symlink is not a file of this room, whatever it
        // points at, and listing it as one is how a link to a secret became a
        // download button. A symlinked DIRECTORY is refused by the same line —
        // it is neither isFile nor isDirectory under lstat.
        stat = workspaceFs.lstatSync(path.join(root, here))
      } catch {
        continue /* vanished between readdir and stat; skip */
      }
      if (stat.isDirectory())
        dirs.push({ name, path: here, dir: true, size: 0, modifiedAt: stat.mtimeMs })
      else if (stat.isFile())
        files.push({ name, path: here, dir: false, size: stat.size, modifiedAt: stat.mtimeMs })
    }
    const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name)
    dirs.sort(byName)
    files.sort(byName)
    return [...dirs, ...files]
  }

  let level = ['']
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level) {
      if (total >= MAX_ENTRIES) {
        truncated = true
        break
      }
      const here = read(dir)
      if (here.length > MAX_ENTRIES - total) {
        here.length = MAX_ENTRIES - total
        truncated = true
      }
      total += here.length
      children.set(dir, here)
      for (const entry of here) if (entry.dir) next.push(entry.path)
    }
    level = next
  }

  // Порядок отрисовки собирается уже из прочитанного: папка, следом её
  // содержимое, и так до самого низа.
  const out: FileEntry[] = []
  const emit = (dir: string): void => {
    for (const entry of children.get(dir) ?? []) {
      out.push(entry)
      if (entry.dir) emit(entry.path)
    }
  }
  emit('')
  return { tree: { files: out, truncated }, stamp }
}

/** То же дерево тем, кому нужен только список. */
export function listFiles(sessionId: string): FileEntry[] {
  return listTree(sessionId).files
}

/**
 * Сколько места занимает комната.
 *
 * Ограничение на один файл было всегда, на комнату целиком — нет: пятьдесят
 * мегабайт за раз и сто заходов дают пять гигабайт, а диск на этом сервере
 * общий с базой, снимками тетрадей и образами окружений. Кончится он молча и
 * сразу для всех.
 *
 * Считаются и недописанные загрузки: место они занимают ровно так же.
 */
export function sessionBytes(sessionId: string): number {
  const root = sessionDir(sessionId)
  let total = 0
  const walk = (rel: string, depth: number): void => {
    let names: string[]
    try {
      names = workspaceFs.readdirSync(path.join(root, rel))
    } catch {
      return
    }
    for (const name of names) {
      const here = rel ? `${rel}/${name}` : name
      try {
        // lstat: символическая ссылка занимает свой размер, а не размер цели —
        // и уж точно не даёт списать на комнату чужой гигабайт.
        const stat = workspaceFs.lstatSync(path.join(root, here))
        if (stat.isFile()) total += stat.size
        else if (stat.isDirectory() && depth + 1 < MAX_DEPTH) walk(here, depth + 1)
      } catch {
        /* исчез между readdir и stat */
      }
    }
  }
  walk('', 0)
  return total
}

/* ------------------------------------------------------- правка дерева */

/**
 * Чем кончилась попытка что-то поменять в дереве.
 *
 * Строка, а не исключение: у каждого исхода своя фраза в интерфейсе, и все они
 * — обычный ход дела, а не поломка. `busy` — про то, чего никакая проверка
 * заранее не увидит: файл, который в этот момент пишет ядро.
 *
 * `too-deep` и `not-a-folder` появились вместе с перетаскиванием: до него в
 * дереве только переименовывали на месте, и оба случая были недостижимы. Оба
 * раньше отвечали `busy`, то есть «попробуйте ещё раз через секунду», — совет,
 * от которого файл на месте папки папкой не становится.
 */
export type TreeResult =
  | 'ok'
  | 'bad-name'
  | 'exists'
  | 'missing'
  | 'busy'
  /** Содержимое переезжающей папки ушло бы за глубину, которую можно назвать. */
  | 'too-deep'
  /** Оно же — за длину пути: адресовать его после переезда будет нечем. */
  | 'too-long'
  /** Класть некуда: на месте папки, в которую целятся, лежит файл. */
  | 'not-a-folder'

/**
 * Отказ файловой системы — словом, за которым стоит правда.
 *
 * Раньше всякая ошибка становилась `busy`, а `busy` обещает «через секунду».
 * Ждать секунду человек будет и от файла на месте папки, и от непустого
 * каталога на месте цели: ни то ни другое от ожидания не проходит, и совет
 * тратит время ровно на то, чтобы убедиться, что совет был плохой.
 */
function whyFailed(err: unknown): TreeResult {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return 'exists'
  if (code === 'ENOTDIR' || code === 'EISDIR') return 'not-a-folder'
  if (code === 'ENOENT') return 'missing'
  return 'busy'
}

/** Завести папку. Промежуточные папки заводятся вместе с ней. */
export function makeDir(sessionId: string, rel: string): TreeResult {
  const full = resolveInSession(sessionId, rel)
  if (!full) return 'bad-name'
  if (workspaceFs.existsSync(full)) return 'exists'
  try {
    workspaceFs.mkdirSync(full, { recursive: true })
    forgetTree(sessionId)
    return 'ok'
  } catch (err) {
    return whyFailed(err)
  }
}

/**
 * Завести файл. Только новый: перезапись пустотой — это стирание, и у него своя
 * кнопка со своим правилом.
 */
export function makeFile(sessionId: string, rel: string, text = ''): TreeResult {
  const full = resolveInSession(sessionId, rel)
  if (!full) return 'bad-name'
  if (workspaceFs.existsSync(full)) return 'exists'
  try {
    workspaceFs.mkdirSync(path.dirname(full), { recursive: true })
    // 'wx' — отказ, а не перезапись, если файл появился между проверкой и
    // записью. Две вкладки, нажавшие «новый файл» одновременно, — не выдумка.
    workspaceFs.writeFileSync(full, text, { flag: 'wx' })
    forgetTree(sessionId)
    return 'ok'
  } catch (err) {
    // По коду ошибки, а не «раз не вышло, значит занято»: «„a.py“ уже есть» про
    // файл, которого нет, посылает человека искать его в дереве.
    return whyFailed(err)
  }
}

/**
 * Одна и та же запись под другим написанием — то есть смена регистра имени.
 *
 * На регистронезависимой файловой системе (macOS у половины машин) «Data» и
 * «data» одна папка, и `existsSync(цели)` отвечал «занято» самим источником:
 * сменить регистр имени было нельзя вовсе, а фраза объясняла это столкновением
 * файла с самим собой. На Linux то же переименование проходило всегда — одна
 * операция вела себя по-разному на машине разработчика и на сервере.
 *
 * Три условия, и каждое отсекает своё. Одна папка и имена, различающиеся только
 * регистром, — это про написание, а не про переезд. Совпадение inode и
 * устройства — про то, что запись действительно одна: на файловой системе, где
 * регистр различается, «Data» и «data» лежат рядом, и принять их за одну
 * значило бы переехать поверх живого файла. `ino === 0` не бывает на POSIX и
 * бывает на Windows, где сравнивать нечем, — там ответ «разные».
 *
 * Жёсткая ссылка (`os.link` из ячейки) под это не подходит намеренно: имена у
 * неё разные, и «b.txt уже есть» — правда.
 */
function spelledSame(source: string, target: string): boolean {
  if (path.dirname(source) !== path.dirname(target)) return false
  const was = path.basename(source)
  const now = path.basename(target)
  if (was === now || was.toLowerCase() !== now.toLowerCase()) return false
  try {
    const one = workspaceFs.lstatSync(source)
    const two = workspaceFs.lstatSync(target)
    return one.ino !== 0 && one.ino === two.ino && one.dev === two.dev
  } catch {
    return false
  }
}

/**
 * Уйдёт ли содержимое за адресуемое, если положить его сюда.
 *
 * `normalizePath` проверяет только тот путь, который ему прислали: папку с
 * седьмого уровня можно было положить на шестой, а папку с длинными именами
 * внутри — в папку с длинным именем. Всё, что оказывалось глубже восьмого
 * уровня, `listTree` уже не обходит — и об этом не говорит: `truncated`
 * ставится только по числу строк. Что оказалось длиннее четырёхсот символов,
 * в список попадает, но `resolveInSession` такой путь не пропускает. Оба конца
 * одинаковы на вид: комната получает список, который объявляет себя полным, а
 * файл в нём нельзя ни открыть, ни скачать, ни убрать поштучно — место он при
 * этом занимает по-прежнему.
 *
 * `levels` — сколько уровней остаётся под этой записью на новом месте,
 * `chars` — сколько символов. Обход идёт вглубь ровно до первого нарушения,
 * так что проверка стоит не больше, чем сам ответ.
 */
function outgrows(full: string, levels: number, chars: number): 'ok' | 'too-deep' | 'too-long' {
  let entries: fs.Dirent[]
  try {
    entries = workspaceFs.readdirSync(full, { withFileTypes: true })
  } catch {
    // Не папка — обычный случай, переезжает файл, — или её не прочитать.
    return 'ok'
  }
  for (const entry of entries) {
    // Считается то же, что показывает дерево: скрытое, `__pycache__` и
    // символические ссылки в него не попадают, и адресовать их нечем и сейчас.
    if (entry.name.startsWith('.') || entry.name === '__pycache__') continue
    if (!entry.isDirectory() && !entry.isFile()) continue
    if (levels <= 0) return 'too-deep'
    // Разделитель и имя: ровно то, чем путь прирастёт на этом уровне.
    const left = chars - 1 - entry.name.length
    if (left < 0) return 'too-long'
    if (entry.isDirectory()) {
      const inside = outgrows(path.join(full, entry.name), levels - 1, left)
      if (inside !== 'ok') return inside
    }
  }
  return 'ok'
}

/**
 * Переложить файл, не имея права заменить то, что уже лежит по новому имени.
 *
 * `rename(2)` молча заменяет цель, а проверка занятости случилась раньше него:
 * в окно между ними ячейка успевает дописать `out.csv` — и переезд стирает
 * свежий файл без единого слова. `link` в это окно не лезет: занятое имя он
 * отвергает сам, ровно как флаг `'wx'` у `makeFile` выше.
 *
 * `false` — жёстких ссылок на этой файловой системе нет; зовущий делает
 * по-старому. Занятое имя из этого ответа исключено: оно улетает исключением,
 * потому что это ответ человеку, а не свойство диска.
 */
function linked(source: string, target: string): boolean {
  try {
    workspaceFs.linkSync(source, target)
  } catch (err) {
    if (whyFailed(err) === 'exists') throw err
    return false
  }
  workspaceFs.unlinkSync(source)
  return true
}

/**
 * Переименовать или переложить. Одна операция, потому что на диске это одно и
 * то же, а в дереве переименование — это перетаскивание на месте.
 *
 * Порядок проверок несущий, и он не тот, что был. Сначала «тот же ли это путь»,
 * «не внутрь ли себя» и «не одна ли это запись под другим написанием», и только
 * потом «занято ли имя»: `existsSync`, стоявший первым, отвечал `exists` на
 * переезд в никуда — то есть объяснял человеку, что файл столкнулся сам с
 * собой, — и он же запрещал сменить регистр имени.
 */
export function movePath(sessionId: string, from: string, to: string): TreeResult {
  const landing = normalizePath(to)
  const source = resolveInSession(sessionId, from)
  const target = resolveInSession(sessionId, to)
  if (!source || !target || !landing) return 'bad-name'
  if (!workspaceFs.existsSync(source)) return 'missing'
  // Переезд в никуда: оно уже лежит там, куда просят его положить. Отказывать
  // не в чем — а `existsSync` ниже отвечал на это «уже есть», то есть находил
  // столкновение файла с самим собой. Комната до сюда и не доходит: `tree:move`
  // отвечает на такой жест молчанием, потому что ничего не произошло.
  if (target === source) return 'ok'
  /*
   * Папку нельзя положить внутрь себя же. `rename` на такой паре отвечает
   * EINVAL, и это был бы понятный отказ, — но на файловых системах, где он
   * отвечает успехом, поддерево уезжает из дерева навсегда.
   *
   * Слова про это говорит `control.ts`: `bad-name` здесь — граница, а не
   * объяснение, и `whySegmentRefused` пожаловалось бы на имя, которое ни при
   * чём.
   */
  if (target.startsWith(source + path.sep)) return 'bad-name'
  const same = spelledSame(source, target)
  if (!same && workspaceFs.existsSync(target)) return 'exists'
  const inside = outgrows(source, MAX_DEPTH - landing.split('/').length, MAX_PATH - landing.length)
  if (inside !== 'ok') return inside
  try {
    workspaceFs.mkdirSync(path.dirname(target), { recursive: true })
    /*
     * Смена написания и папка едут `rename`: на первой `link` ответил бы
     * «занято» самой записью, а жёстких ссылок на каталоги не бывает вовсе.
     * Непустой каталог `rename` не заменит — ответит ENOTEMPTY; пустой
     * заменит, и терять в нём нечего.
     */
    if (same || workspaceFs.lstatSync(source).isDirectory()) workspaceFs.renameSync(source, target)
    else if (!linked(source, target)) workspaceFs.renameSync(source, target)
    forgetTree(sessionId)
    return 'ok'
  } catch (err) {
    return whyFailed(err)
  }
}

/**
 * Убрать файл или папку.
 *
 * Папка убирается со всем, что в ней, и это осознанно: пустая папка, которую
 * нельзя убрать, пока не убрал всё внутри поштучно, — это работа, которую
 * панель перекладывает на человека вместо одного вопроса «точно?». Спрашивает
 * тот, кто рисует кнопку; здесь уже делают.
 */
export function deleteFile(sessionId: string, name: string): boolean {
  const full = resolveInSession(sessionId, name)
  if (!full) return false
  try {
    const stat = workspaceFs.lstatSync(full)
    if (stat.isDirectory()) workspaceFs.rmSync(full, { recursive: true, force: true })
    else workspaceFs.unlinkSync(full)
    forgetTree(sessionId)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------- содержимое */

/**
 * Потолок на текст, который открывается в редакторе.
 *
 * Полтора мегабайта — это примерно тридцать тысяч строк: больше, чем бывает у
 * файла, который правят на семинаре, и меньше, чем то, на чём CodeMirror
 * начинает думать над каждым нажатием. Файл крупнее в редакторе не открывается
 * вовсе — ни целиком, ни началом: сохранить обрезок поверх целого значит
 * потерять хвост молча, а показать начало, которое нельзя ни править, ни
 * сохранить, значит обещать редактор там, где его нет. Скачать такой файл и
 * прочитать его из ячейки можно по-прежнему.
 *
 * Цена названа вслух — и сказана вслух же: по нажатию на трёхмегабайтный CSV
 * вкладка не закрывается молча, а объясняет, что файл велик для редактора.
 * Для этого у сокета файла есть третий код закрытия, 4413, рядом с «правку не
 * приняли» и «файла нет» (см. `TOO_BIG` в collab/files.ts).
 */
export const MAX_TEXT_BYTES = 1_500_000

export interface TextFile {
  text: string
  /** Файл больше потолка: в `text` только его начало, целиком он не прочитан. */
  truncated: boolean
  /** Не текст вовсе — в нём нулевые байты. */
  binary: boolean
  modifiedAt: number
  size: number
}

/**
 * Прочитать файл как текст.
 *
 * Нулевой байт в первых восьми килобайтах — признак, по которому это делают
 * все: расширение врёт (студент назвал архив `data.csv`), а содержимое нет.
 * Открыть архив в редакторе — это показать мусор и предложить его сохранить.
 */
export function readText(sessionId: string, rel: string, maxBytes = MAX_TEXT_BYTES): TextFile | null {
  const full = resolveInSession(sessionId, rel)
  if (!full) return null
  let stat: fs.Stats
  let held: ReturnType<typeof workspaceFs.openRead>
  try {
    held = workspaceFs.openRead(full)
    stat = fs.fstatSync(held.fd)
  } catch {
    return null
  }
  const truncated = stat.size > maxBytes
  let buf: Buffer
  try {
    buf = Buffer.alloc(Math.min(stat.size, maxBytes))
    const read = fs.readSync(held.fd, buf, 0, buf.length, 0)
    buf = buf.subarray(0, read)
  } catch {
    return null
  } finally {
    held.close()
  }
  const binary = buf.subarray(0, 8192).includes(0)
  return {
    text: binary ? '' : buf.toString('utf8'),
    truncated,
    binary,
    modifiedAt: stat.mtimeMs,
    size: stat.size,
  }
}

/**
 * Записать файл целиком.
 *
 * Рядом и переименованием, не поверх: `writeFileSync` сначала обрезает файл до
 * нуля и наполняет его потом, так что ячейка, читающая этот CSV прямо сейчас,
 * успевает прочитать половину и закончить без ошибки. Тот же довод записан над
 * загрузкой в routes/files.ts, и он одинаково верен для редактора, который
 * сохраняется сам каждые несколько секунд.
 */
export function writeText(sessionId: string, rel: string, text: string): boolean {
  const full = resolveInSession(sessionId, rel)
  if (!full) return false
  const tmp = path.join(
    path.dirname(full),
    `.${baseOf(rel)}.saving-${randomUUID()}`,
  )
  try {
    workspaceFs.mkdirSync(path.dirname(full), { recursive: true })
    workspaceFs.writeFileSync(tmp, text, { flag: 'wx' })
    workspaceFs.renameSync(tmp, full)
    forgetTree(sessionId)
    return true
  } catch {
    try { workspaceFs.rmSync(tmp, { force: true }) } catch { /* parent was replaced */ }
    return false
  }
}

/** Существует ли путь, и что это. `null` — ничего нет. */
export function statPath(
  sessionId: string,
  rel: string,
): { dir: boolean; size: number; modifiedAt: number } | null {
  const full = resolveInSession(sessionId, rel)
  if (!full) return null
  try {
    const stat = workspaceFs.lstatSync(full)
    if (!stat.isFile() && !stat.isDirectory()) return null
    return { dir: stat.isDirectory(), size: stat.size, modifiedAt: stat.mtimeMs }
  } catch {
    return null
  }
}

/**
 * Свободное имя рядом с занятым: `train.py` -> `train 2.py`.
 *
 * Нужно ровно там, где отказ был бы хуже: оракул создаёт файл, который уже
 * есть, и отменить весь ход из-за имени — потерять работу. Человеку, который
 * набрал имя руками, по-прежнему отвечают «занято»: он имел в виду именно его.
 */
export function freeName(sessionId: string, rel: string): string {
  if (!statPath(sessionId, rel)) return rel
  const dir = parentOf(rel)
  const base = baseOf(rel)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let n = 2; n < 100; n++) {
    const candidate = `${dir ? dir + '/' : ''}${stem} ${n}${ext}`
    if (!statPath(sessionId, candidate)) return candidate
  }
  return rel
}

/** Текстовый ли это файл по имени и по содержимому разом. */
export function isEditable(sessionId: string, rel: string): boolean {
  if (kindOf(rel) !== 'text') return false
  const read = readText(sessionId, rel)
  return read !== null && !read.binary && !read.truncated
}
