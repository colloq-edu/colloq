/**
 * «Где это определено» — поиск по документу комнаты и по файлам семинара.
 *
 * Разбор Python живёт отдельно и ничего не знает ни про комнату, ни про диск
 * (shared/python-defs.ts). Здесь — вторая половина: ПОРЯДОК, в котором смотрят.
 * И порядок этот не оптимизация, а сама фича: ответов на «где определено
 * `helper`» в живой комнате обычно несколько — в своей ячейке, в соседней
 * тетради, в `utils.py`, — и вопрос не в том, чтобы найти хоть один, а в том,
 * чтобы выбрать ТОТ, который человек и имел в виду.
 *
 * Отсюда правила, каждое из которых записано в коде ниже отдельным шагом:
 *
 * - Своё раньше чужого. Щёлкнутый исходник, потом его тетрадь, потом остальные
 *   тетради, потом .py-файлы папки. Ближнее определение и есть то, о котором
 *   спрашивают.
 * - Выше раньше нижнего. Внутри тетради берётся БЛИЖАЙШАЯ ячейка сверху:
 *   тетрадь читают и запускают сверху вниз, и переопределение выше — это то,
 *   что действует в момент клика. Ниже смотрим только когда выше нет вовсе.
 * - Цепочка от данных не ищется НИКОГДА. `df.head` — это `opaque`, и здесь на
 *   него не тратится ни одного чтения: `def head` в тетради почти наверняка
 *   найдётся, переход сработает, и человек уйдёт читать чужой класс, думая,
 *   что читает свой. Из всех промахов этот единственный невидим — см. довод у
 *   `resolveChain`.
 *
 * Почему сервер, а не браузер, у которого уже есть и грамматика, и текст
 * открытой ячейки: текста ОСТАЛЬНЫХ у него нет. Тетрадь строит редакторы
 * только рядом с экраном (Notebook.svelte · data-cell-deferred), файл семинара
 * читается лишь когда его открыли вкладкой, а чужая тетрадь может быть не
 * загружена вовсе. На сервере же и документ, и папка лежат под рукой — и
 * ровно поэтому здесь нужны потолки: см. MAX_FILES_READ.
 */
import * as Y from 'yjs'
import {
  allBooks,
  allCellArrays,
  cellId as idOfCell,
  cellType,
  type YCell,
} from '@shared/notebook'
import type { DefinitionHit, DefinitionMiss } from '@shared/protocol'
import {
  modulePaths,
  pickDefinition,
  questionAt,
  resolveChain,
  scanPython,
  type Definition,
  type Import,
  type Scan,
} from '@shared/python-defs'
import { currentText } from './collab/files.js'
import { getSessionDoc } from './collab/index.js'
import { listFiles } from './workspace.js'

/** Куда идти — или почему некуда. Ровно одно из двух. */
export interface DefineAnswer {
  hit?: DefinitionHit
  miss?: DefinitionMiss
}

/**
 * Сколько .py один клик вправе прочитать.
 *
 * Папка семинара — это не десяток учебных модулей: одна строка `pip install` в
 * ячейке заводит в ней тысячи файлов (workspace.ts · MAX_ENTRIES про то же).
 * Сквозной поиск по имени без потолка означал бы тысячи чтений с диска на
 * КАЖДЫЙ Cmd-щелчок — и восемьдесят из них уже больше, чем бывает своих
 * модулей у семинара. Восемьдесят прочитанных файлов — это верх; обычный клик
 * не доходит и до одного, потому что имя находится раньше, в тетради.
 */
const MAX_FILES_READ = 80

/**
 * И насколько крупный файл ещё имеет смысл разбирать.
 *
 * Полмегабайта .py — это пятнадцать тысяч строк: чужая сборка, выгрузка
 * данных в виде кода, всё что угодно, кроме того, что писали руками на
 * семинаре. Размер берётся из обхода папки, то есть ДО чтения: крупный файл
 * не читается вовсе, а не читается и отбрасывается.
 */
const MAX_FILE_BYTES = 512 * 1024

/** Тот же потолок подписи, что у `Definition.text`: строка, а не абзац. */
const MAX_TEXT = 160

/** Имя годится в предфильтр только если оно и есть имя. */
const NAME = /^[A-Za-z_]\w*$/

/**
 * Предфильтр: встречается ли имя в тексте СЛОВОМ.
 *
 * Обязателен, и это измерено: восемьдесят ячеек тетради, разобранных подряд, —
 * десятки миллисекунд на один щелчок; те же восемьдесят с этой проверкой —
 * доли миллисекунды, потому что разбирается из них одна-две. `\b` вместо
 * `includes` не придирка: `helper` встречается внутри `my_helper_util`, и без
 * границ слова фильтр пропускал бы почти всё.
 */
function wordOf(name: string): RegExp | null {
  if (!NAME.test(name)) return null
  return new RegExp(`\\b${name}\\b`)
}

/** Папка, в которой лежит этот путь. Корень — пустая строка. */
function folderOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/** Модуль, названный так, как его написали в коде: с точками относительности. */
function named(module: string, level: number, fallback: string): string {
  return `${'.'.repeat(level)}${module || fallback}`
}

/** Первая непустая строка файла — подпись к переходу «в начало модуля». */
function firstLine(code: string): string {
  for (const line of code.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
  }
  return ''
}

/**
 * Текст ячейки — БЕЗ побочной записи в документ.
 *
 * `cellSource` из shared/notebook.ts заводит `Y.Text`, если его нет, и это
 * правильно для того, кто собирается печатать. Здесь же путь читающий: клик по
 * имени не имеет права родить правку документа и разослать её всей комнате —
 * тем более на ячейке, у которой что-то не так со схемой.
 */
function sourceOf(cell: YCell): string {
  const raw: unknown = cell.get('source')
  if (raw instanceof Y.Text) return raw.toString()
  return typeof raw === 'string' ? raw : ''
}

/** Лист документа: ячейки и путь тетради, которой они принадлежат. */
interface Sheet {
  /** Путь файла тетради — им подписывают переход, когда тетрадей несколько. */
  path: string | undefined
  cells: Y.Array<YCell>
}

/**
 * Тетради комнаты по порядку.
 *
 * Запасной путь через `allCellArrays` — для документа, у которого списка
 * тетрадей ещё нет: комната, открытая впервые после появления нескольких
 * тетрадей, и документ теста, собранный из одного корня. Оба обязаны вести
 * себя как комната с одной тетрадью, иначе переход по соседним ячейкам молча
 * перестаёт работать (тот же довод — у самого `allCellArrays`).
 */
function sheetsOf(doc: Y.Doc): Sheet[] {
  const books = allBooks(doc)
  if (books.length > 0) return books.map(({ book, cells }) => ({ path: book.path, cells }))
  return allCellArrays(doc).map((cells) => ({ path: undefined, cells }))
}

/**
 * Импорты, действующие в этой ячейке, — то есть импорты ВСЕЙ её тетради.
 *
 * Область видимости в тетради — не ячейка, а ядро: `import case_cian as cian`
 * стоит в третьей ячейке и действует до конца занятия. Пока здесь читались
 * импорты только щёлкнутой ячейки, `cian.fig_range_audit(...)` из шестнадцатой
 * отвечал «что такое cian, отсюда не видно» — то есть фича разваливалась ровно
 * на самом частом устройстве учебной тетради: шапка с импортами наверху,
 * работа ниже.
 *
 * Порядок важен: свои первыми, потом остальные сверху вниз. `resolveChain`
 * берёт ПЕРВОЕ совпадение по имени, и если человек переопределил `np` у себя в
 * ячейке, действует его.
 *
 * Предфильтр по слову `import` — чтобы не разбирать восемьдесят ячеек ради
 * шапки из трёх строк: у большинства ячеек тетради импортов нет вовсе.
 */
function importsAround(
  own: Scan,
  sheets: readonly Sheet[],
  book: string | undefined,
): { imports: Import[]; stars: Scan['stars'] } {
  const imports = [...own.imports]
  const stars = [...own.stars]
  for (const sheet of sheets) {
    if (book !== undefined && sheet.path !== book) continue
    for (let i = 0; i < sheet.cells.length; i++) {
      const cell = sheet.cells.get(i)
      if (cellType(cell) !== 'code') continue
      const text = sourceOf(cell)
      if (!text.includes('import')) continue
      const scan = scanPython(text)
      if (scan.magic) continue
      imports.push(...scan.imports)
      stars.push(...scan.stars)
    }
  }
  return { imports, stars }
}

/** Один поиск: что ищем, откуда считаем относительные импорты и сколько ещё можно прочитать. */
interface Hunt {
  sessionId: string
  /** Папка, от которой считаются относительные импорты: файла или тетради. */
  dir: string
  /** Имя, которое ищут, — оно же поедет в ответ. */
  name: string
  /** Предфильтр по этому имени; `null` — имя не годится в регулярное выражение. */
  word: RegExp | null
  /** Имя щёлкнутой ячейки: от него `inSheet` считает, что такое «выше». */
  from: string | undefined
  /** Обход папки — один на запрос, и только если до файлов дойдёт дело. */
  files: Map<string, number> | null
  /** Сколько файлов ещё позволено прочитать. См. MAX_FILES_READ. */
  budget: number
}

/** Файлы папки семинара: путь — размер. Обход ленивый: тетради дешевле. */
function tree(hunt: Hunt): Map<string, number> {
  if (hunt.files) return hunt.files
  const known = new Map<string, number>()
  for (const entry of listFiles(hunt.sessionId)) if (!entry.dir) known.set(entry.path, entry.size)
  hunt.files = known
  return known
}

/**
 * Текст файла папки семинара — живой, с несохранёнными правками.
 *
 * `null` — файла нет, он крупнее потолка, или потолок чтений на этот запрос
 * уже выбран. Через `currentText`, а не с диска: открытый вкладкой файл правят
 * прямо сейчас, и определение, дописанное минуту назад, обязано находиться.
 */
function readFile(hunt: Hunt, path: string): string | null {
  const size = tree(hunt).get(path)
  if (size === undefined || size > MAX_FILE_BYTES) return null
  return readExact(hunt, path)
}

/**
 * То же, но БЕЗ обхода папки: путь уже известен точно.
 *
 * Обход стоит дорого и на ровном месте. Замерено на комнате курса: переход в
 * свой модуль целиком — 41,9 мс, из них 41,4 мс — `listFiles` на холодную, то
 * есть 99 % цены уходит на перепись всей папки ради двух заранее известных
 * имён (`eda_tools.py` и `eda_tools/__init__.py`). `currentText` сам отвечает
 * `null`, если файла нет, — спрашивать у обхода разрешения незачем.
 *
 * Обход остаётся там, где он по делу: в сквозном проходе, которому нужен
 * СПИСОК файлов, и в проверке размера перед чтением чужого крупного файла.
 */
function readExact(hunt: Hunt, path: string): string | null {
  if (hunt.budget <= 0) return null
  hunt.budget -= 1
  const text = currentText(hunt.sessionId, path)
  if (text === null) return null
  if (text.length > MAX_FILE_BYTES) return null
  return text
}

function hitInFile(path: string, def: Definition, name: string): DefinitionHit {
  return { where: 'file', path, line: def.line, column: def.column, text: def.text, name }
}

function hitInCell(id: string, book: string | undefined, def: Definition, name: string): DefinitionHit {
  return {
    where: 'cell',
    cellId: id,
    ...(book ? { path: book } : {}),
    line: def.line,
    column: def.column,
    text: def.text,
    name,
  }
}

/** Начало модуля: туда ведут, когда спросили про сам модуль, а не про имя в нём. */
function hitAtTop(hunt: Hunt, path: string, known?: string | null): DefinitionHit {
  // `known` — текст, который вызывающий уже прочитал: второе чтение того же
  // файла ради одной первой строки тратило и время, и единицу потолка.
  const text = known === undefined ? readExact(hunt, path) : known
  return { where: 'file', path, line: 1, column: 0, text: text === null ? '' : firstLine(text), name: hunt.name }
}

/** Файл модуля в папке семинара — или `null`, если такого модуля у семинара нет. */
function moduleFile(hunt: Hunt, module: string, level: number): string | null {
  for (const cand of modulePaths(module, level, hunt.dir)) {
    if (currentText(hunt.sessionId, cand) !== null) return cand
  }
  return null
}

/** Имя ВНУТРИ модуля: `utils.py` или `utils/__init__.py`, верхний уровень. */
function inModule(hunt: Hunt, module: string, level: number, member: string): DefinitionHit | null {
  for (const cand of modulePaths(module, level, hunt.dir)) {
    const text = readExact(hunt, cand)
    if (text === null) continue
    const def = pickDefinition(scanPython(text), member)
    if (def) return hitInFile(cand, def, hunt.name)
  }
  return null
}

/**
 * Импорт — в переход.
 *
 * Одна дорога на два входа: и на цепочку `utils.helper` (там модуль назвал сам
 * `resolveChain`), и на голое имя, связанное импортом в этой же ячейке. Формы
 * импорта при этом разные, и разница у них ровно одна — спрашивают про МОДУЛЬ
 * или про имя в нём:
 *
 *   import utils            -> модуль; вести в начало файла
 *   from utils import f     -> имя `f` в `utils.py`
 *   from . import util      -> `util` — это ПОДМОДУЛЬ рядом, а не имя в модуле
 *   from pkg import sub     -> и так же, если в `pkg` нет имени `sub`
 *
 * Последние два и есть тот случай, ради которого здесь второй заход: модуль
 * назван пакетом, а искомое — файл внутри него. Порядок между ними — сперва
 * имя, потом подмодуль: `from pkg import sub`, где в `pkg/__init__.py` есть
 * `sub = ...`, значит именно эту переменную.
 */
function throughImport(hunt: Hunt, module: string, level: number, member: string | null): DefineAnswer {
  if (member === null) {
    const file = moduleFile(hunt, module, level)
    if (file) return { hit: hitAtTop(hunt, file) }
    return { miss: { why: 'outside', name: hunt.name, module: named(module, level, hunt.name) } }
  }

  const found = inModule(hunt, module, level, member)
  if (found) return { hit: found }

  const sub = moduleFile(hunt, [module, member].filter(Boolean).join('.'), level)
  if (sub) return { hit: hitAtTop(hunt, sub) }

  /*
   * Ни одного файла-кандидата в папке нет — значит модуль чужой: `numpy`,
   * `sklearn.metrics`, что угодно из окружения. Это НЕ «не нашлось»: сказать
   * «numpy не в папке семинара» значит объяснить, а «не нашлось, где
   * определено» — обвинить человека в опечатке, которой он не делал.
   */
  if (moduleFile(hunt, module, level) === null) {
    return { miss: { why: 'outside', name: hunt.name, module: named(module, level, member) } }
  }
  // Файл модуля наш, а имени в нём нет: опечатка или его ещё не написали.
  return { miss: { why: 'unknown', name: hunt.name } }
}

/**
 * Определение в одном листе — ближайшее СВЕРХУ от щёлкнутой ячейки.
 *
 * `at` — место щёлкнутой ячейки в этом листе; если её здесь нет (чужая
 * тетрадь, клик в файле), весь лист считается лежащим выше, и берётся
 * последнее определение в нём — то же правило, что и внутри одного исходника
 * (`pickDefinition`: побеждает последнее переопределение).
 *
 * Два прохода, а не один с запоминанием: обход вверх от каретки останавливается
 * на первом же попадании, и это не косметика — каждая пройденная ячейка стоит
 * снятия `Y.Text` в строку.
 */
function inSheet(hunt: Hunt, sheet: Sheet): DefinitionHit | null {
  const word = hunt.word
  if (word === null) return null
  const cells = sheet.cells
  let at = cells.length

  const look = (index: number): DefinitionHit | null => {
    const cell = cells.get(index)
    if (cellType(cell) !== 'code') return null
    const source = sourceOf(cell)
    if (!word.test(source)) return null
    const scan = scanPython(source)
    // Ячейка на чужом языке: `def` в `%%bash` определением не является.
    if (scan.magic) return null
    const def = pickDefinition(scan, hunt.name)
    /*
     * Строка импорта в ЧУЖОЙ ячейке приземлением не считается.
     *
     * Клик по `load_dataset` уводил в шапку, на `from eda_tools import
     * load_dataset`, — то есть на строку, из которой надо прыгать второй раз.
     * Через импорт этой шапки поиск уже прошёл выше (шаг 4б) и, если модуль
     * семинарский, туда и привёл; а если нет — честнее сказать «из библиотеки»,
     * чем показать строку, которую человек и так видел.
     */
    if (!def || def.kind === 'import') return null
    return hitInCell(idOfCell(cell), sheet.path, def, hunt.name)
  }

  if (hunt.from !== undefined) {
    for (let i = 0; i < cells.length; i++) {
      if (idOfCell(cells.get(i)) === hunt.from) {
        at = i
        break
      }
    }
  }
  // Щёлкнутая ячейка пропущена в обе стороны: её ЖИВОЙ текст уже разобран
  // отдельно (шаг 4а) — тем самым, что приехал в кадре, а не тем, что успел
  // доехать до документа.
  for (let i = at - 1; i >= 0; i--) {
    const hit = look(i)
    if (hit) return hit
  }
  for (let i = at + 1; i < cells.length; i++) {
    const hit = look(i)
    if (hit) return hit
  }
  return null
}

/**
 * Голое имя: по своему исходнику, по тетрадям, по файлам.
 *
 * Порядок шагов — тот, что описан в шапке модуля, и каждый следующий дороже
 * предыдущего. Обычный клик кончается на первом или втором: имя, по которому
 * щёлкнули, чаще всего определено здесь же или парой ячеек выше.
 */
function byName(
  hunt: Hunt,
  own: Scan,
  scope: { imports: readonly Import[]; stars: Scan['stars'] },
  sheets: Sheet[],
  cellId: string | undefined,
  path: string | undefined,
  book: string | undefined,
): DefineAnswer {
  const name = hunt.name

  // 4а. Свой исходник — тот, что приехал в кадре.
  const mine = pickDefinition(own, name)
  if (mine && mine.kind !== 'import') {
    if (cellId) return { hit: hitInCell(cellId, book, mine, name) }
    if (path) return { hit: hitInFile(path, mine, name) }
    // Ни ячейки, ни файла: адреса у ответа не будет — ищем дальше, там он есть.
  }

  /*
   * 4б. Имя связано импортом в этой же ячейке.
   *
   * Отказ здесь НЕ окончателен, и это не перестраховка: `from utils import *`
   * рядом с `import numpy as np` — обычная шапка тетради, и имя, приехавшее из
   * библиотеки, вполне может быть переопределено ниже своим. Поэтому причина
   * запоминается, а поиск продолжается; и запоминается только `outside` —
   * «не нашлось» и так стоит последним ответом.
   */
  /*
   * Свой импорт раньше чужого, и это не мелочь порядка.
   *
   * `lastImport` берёт ПОСЛЕДНИЙ по списку, а список теперь идёт по всей
   * тетради — значит «последний» стал означать «в самой нижней ячейке». В
   * ячейке своими глазами написано `from case_cian import load`, а переход
   * уводил в `case_rohlik.py` только потому, что тот импорт стоит ниже по
   * тетради. Сначала спрашиваем ту ячейку, в которой щёлкнули.
   */
  let outside: DefinitionMiss | null = null
  const bound = lastImport(own.imports, name) ?? lastImport(scope.imports, name)
  if (bound) {
    const through = throughImport(hunt, bound.module, bound.level, bound.member)
    if (through.hit) return through
    if (through.miss?.why === 'outside') outside = through.miss
  }

  /*
   * И само НАЗВАНИЕ модуля в строке импорта — `pandas` в `import pandas as pd`.
   *
   * Связанного имени здесь нет вовсе: `import pandas as pd` кладёт в область
   * видимости `pd`, а слово `pandas` не значит ничего. Из-за этого щелчок по
   * нему падал в конец поиска и отвечал «не нашлось ни в тетрадях, ни в
   * файлах» — правда, но не та: искали-то модуль, и человеку надо знать, что
   * он ИЗ БИБЛИОТЕКИ, а не что его нигде нет. Свой модуль семинара тем же
   * щелчком открывается: `import eda_tools` — слово и есть связанное имя, и
   * туда дорога уже нашлась выше.
   *
   * Берётся первый сегмент пути: у `import os.path` щелчок по `os` — это `os`,
   * а щелчок по `path` придёт сюда цепочкой и до этой ветки не доберётся.
   */
  if (!mine) {
    const asModule = scope.imports.find((one) => one.module.split('.')[0] === name)
    if (asModule) {
      const through = throughImport(hunt, name, asModule.level, null)
      if (through.hit) return through
      if (through.miss?.why === 'outside') outside = through.miss
    }
  }

  // 4в–4г. Своя тетрадь раньше остальных; внутри каждой — ближайшая сверху.
  const mineFirst = book
    ? [...sheets.filter((one) => one.path === book), ...sheets.filter((one) => one.path !== book)]
    : sheets
  for (const sheet of mineFirst) {
    const hit = inSheet(hunt, sheet)
    if (hit) return { hit }
  }

  /*
   * 4д. `from x import *` — и это НАЗВАННЫЙ модуль, а не догадка.
   *
   * Раньше этот шаг стоял последним, после сквозного прохода по всем .py, и от
   * него почти ничего не зависело: проход и так находит `def figure`, где бы
   * тот ни лежал. Но находит он ПЕРВЫЙ по алфавиту пути, а звёздный импорт
   * прямо называет, из какого модуля имя пришло. Когда `def figure` есть и в
   * `plotstyle.py`, и в `case_cian.py`, правильный ответ знает только строка
   * `from plotstyle import *` — и знает точно.
   *
   * Звёзды берутся по всей тетради, как и обычные импорты: шапка стоит в
   * третьей ячейке и действует до конца занятия.
   */
  for (const star of scope.stars) {
    const hit = inModule(hunt, star.module, star.level, name)
    if (hit) return { hit }
  }

  // 4е. И только теперь — сквозной проход по .py-файлам папки: здесь уже догадка.
  const inFiles = sweepFiles(hunt, path)
  if (inFiles) return { hit: inFiles }

  return { miss: outside ?? { why: 'unknown', name } }
}

/** Последний импорт, связавший это имя: ниже по исходнику — значит он и действует. */
function lastImport(imports: readonly Import[], local: string): Import | null {
  for (let i = imports.length - 1; i >= 0; i--) if (imports[i].local === local) return imports[i]
  return null
}

/**
 * Определение верхнего уровня в .py-файлах папки — по алфавиту пути.
 *
 * Здесь кончается знание и начинается догадка: файл, в котором имя нашлось, с
 * щёлкнутой ячейкой может быть не связан ничем — его никто не импортировал.
 * Поэтому шаг стоит последним, и поэтому порядок АЛФАВИТНЫЙ, а не порядок
 * обхода папки: обход меняется от одного `pip install` до другого, и ответ на
 * тот же клик менялся бы вместе с ним. Догадка, если уж она догадка, обязана
 * быть хотя бы одной и той же.
 *
 * Только верхний уровень (`owner === null`, так работает `pickDefinition` без
 * владельца): метод чужого класса, случайно названный так же, — это тот самый
 * уверенный переход не туда.
 *
 * Предфильтр здесь бережёт не чтение, а разбор: чтобы узнать, есть ли в файле
 * имя, файл надо прочитать. Само чтение держат два потолка выше — число файлов
 * и размер каждого.
 */
/**
 * Папки, в которых лежит чужой код, а не материалы занятия.
 *
 * Одна строка `!pip install -t .` в ячейке заводит в папке тысячи .py, и
 * сквозной проход, отсортированный по алфавиту, выбирал потолок чтений на них
 * ещё до первого своего модуля: `use_style` переставал находиться вовсе, а сам
 * щелчок дорожал с 8 до 63 мс. Проход ищет то, что писали на занятии, — а
 * установленное пришло с готовым определением, до которого всё равно не
 * дотянуться.
 */
const NOT_OURS = new Set([
  'site-packages',
  'dist-packages',
  '__pycache__',
  'node_modules',
  'venv',
  'env',
  'build',
  'dist',
  'lib',
  'lib64',
  'bin',
])

function ours(path: string): boolean {
  return !path
    .split('/')
    .slice(0, -1)
    .some((part) => NOT_OURS.has(part) || part.startsWith('.'))
}

function sweepFiles(hunt: Hunt, clicked: string | undefined): DefinitionHit | null {
  if (hunt.word === null) return null
  /*
   * Ближе к корню — раньше: свои модули семинара лежат рядом с тетрадью, а
   * чужие — в глубине. Сортировка по глубине, потом по алфавиту: алфавит один
   * не годится, он менялся бы от одной установки пакетов до другой, и ответ на
   * тот же щелчок менялся бы вместе с ним.
   */
  const paths = [...tree(hunt).keys()]
    .filter((p) => p.endsWith('.py') && p !== clicked && ours(p))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0))
  for (const path of paths) {
    const text = readFile(hunt, path)
    if (text === null) continue
    if (!hunt.word.test(text)) continue
    const def = pickDefinition(scanPython(text), hunt.name)
    /*
     * Строка импорта чужим файлом не считается — по тому же доводу, что и в
     * ячейке: `import numpy as np` в `case_bpm.py` делал вид, что `np`
     * определён там, и щелчок по `np` в шапке лекции открывал чужой модуль.
     * Сквозной проход — и так догадка; догадываться ещё и по чужим импортам
     * значит гадать дважды.
     */
    if (def && def.kind !== 'import') return hitInFile(path, def, hunt.name)
  }
  return null
}

/**
 * Куда ведёт имя под кареткой — или почему никуда.
 *
 * `cellId` и `path` — откуда спрашивают: имя ячейки или путь файла. Оба
 * необязательны и оба про одно и то же — про ОТКУДА: от них считается и
 * порядок поиска (своя тетрадь раньше чужих), и папка относительных импортов
 * (`from . import util` — рядом с ЭТИМ файлом, а не с корнем семинара).
 *
 * Синхронно и без ядра: всё, что нужно ответу, уже лежит в памяти процесса —
 * документ комнаты и папка семинара. Поэтому переход работает и у того, кто
 * только что открыл тетрадь и ничего не запускал.
 */
export function defineIn(
  sessionId: string,
  code: string,
  cursor: number,
  cellId?: string,
  path?: string,
  cut = 0,
): DefineAnswer {
  /*
   * Присланное окно — это ещё не исходник, и разбирать надо исходник.
   *
   * Потолок кадра 24 КБ, а `case_cian.py` живого курса — 886 КБ: клик в
   * крупном файле приезжает сюда КУСКОМ (session.svelte.ts · windowAroundCursor
   * сообщает, сколько срезано слева). Считать по куску нельзя дважды: строки в
   * нём свои, и приземление уходило на сотни строк мимо; а определение,
   * оставшееся за краем окна, «не находилось» — и поиск шёл дальше, в чужие
   * файлы, где имя совпало.
   *
   * Целый текст у сервера есть: файл отдаёт `currentText`, ячейку — документ
   * комнаты. Сверка по содержимому, а не по одному числу: между отправкой и
   * ответом человек мог успеть напечатать, и тогда честнее найти окно заново,
   * чем поверить сдвигу.
   */
  if (cut > 0) {
    const whole = wholeSource(sessionId, cellId, path)
    const at = whole === null ? -1 : whole.startsWith(code, cut) ? cut : whole.indexOf(code)
    if (whole !== null && at !== -1) {
      code = whole
      cursor += at
    } else {
      /*
       * Целого текста не нашлось. Тогда по куску ищем ТОЛЬКО за его пределами:
       * своё приземление из окна дало бы уверенно неверную строку, а это хуже
       * отказа. `cellId` и `path` не передаются дальше — значит шаг «своя
       * ячейка/свой файл» пропускается, а имя ищется по соседям.
       */
      cellId = undefined
      path = undefined
    }
  }

  const question = questionAt(code, cursor)
  if (!question) return { miss: { why: 'nothing' } }

  const own = scanPython(code)
  /*
   * Ячейка на чужом языке — и молчание вместо ответа.
   *
   * `%%bash` с `python train.py` внутри: слово под указателем есть, а имени
   * Python в нём нет. Ответить «не нашлось» было бы полуправдой, а поискать
   * `train` по тетради — тем самым уверенным переходом не туда. `nothing`
   * здесь и значит ровно то, что значит: имени под указателем не было.
   */
  if (own.magic) return { miss: { why: 'nothing' } }

  /*
   * Документ берётся на один вызов и не держится: `holdRoom` нужен тому, кто
   * работает с `Y.Doc` дольше одного обращения (collab/index.ts), а здесь всё
   * чтение укладывается в этот синхронный проход. Отпускать тоже нечего —
   * кадр пришёл по живому сокету, то есть в комнате сидит как минимум тот, кто
   * щёлкнул.
   */
  const doc = getSessionDoc(sessionId).doc
  const sheets = sheetsOf(doc)
  const book = cellId ? bookOfCell(sheets, cellId) : undefined
  const home = path ?? book

  /*
   * Цепочка разрешается ПОСЛЕ документа, и только поэтому она разрешается.
   *
   * У файла область видимости — он сам, у ячейки — вся тетрадь: см.
   * `importsAround`. Разложить это на две ветки нельзя было бы аккуратнее, чем
   * одним списком, который для файла равен его собственным импортам.
   */
  const scope = cellId ? importsAround(own, sheets, book) : { imports: own.imports, stars: own.stars }
  const target = resolveChain(question, scope.imports)
  if (target.kind === 'opaque') {
    return { miss: { why: 'opaque', name: target.name, owner: target.owner } }
  }

  const hunt: Hunt = {
    sessionId,
    dir: folderOf(home ?? ''),
    name: target.name,
    word: wordOf(target.name),
    files: null,
    budget: MAX_FILES_READ,
    from: cellId,
  }

  if (target.kind === 'member') return throughImport(hunt, target.module, target.level, target.name)
  return byName(hunt, own, scope, sheets, cellId, path, book)
}

/**
 * Целый исходник того, где щёлкнули, — файла или ячейки.
 *
 * `null` — достать неоткуда: файла уже нет, ячейку удалили, имени не дали.
 */
function wholeSource(
  sessionId: string,
  cellId: string | undefined,
  path: string | undefined,
): string | null {
  if (path) return currentText(sessionId, path)
  if (!cellId) return null
  for (const sheet of sheetsOf(getSessionDoc(sessionId).doc)) {
    for (let i = 0; i < sheet.cells.length; i++) {
      const cell = sheet.cells.get(i)
      if (idOfCell(cell) === cellId) return sourceOf(cell)
    }
  }
  return null
}

/** Путь тетради, в которой лежит эта ячейка. */
function bookOfCell(sheets: readonly Sheet[], id: string): string | undefined {
  for (const sheet of sheets) {
    for (let i = 0; i < sheet.cells.length; i++) {
      if (idOfCell(sheet.cells.get(i)) === id) return sheet.path
    }
  }
  return undefined
}
