/**
 * «Где это определено» — разбор Python ровно настолько, насколько нужен переход.
 *
 * Нарочно крошечное подмножество, и по тому же доводу, что у разметки
 * опубликованной страницы (server/src/publish/render.ts): полноценная грамматика
 * здесь уже есть — @codemirror/lang-python с деревом lezer, — но живёт она в
 * браузере и в редакторе. Искать определение приходится не в той ячейке, где
 * щёлкнули, а во ВСЕХ ячейках тетради и в .py-файлах папки семинара, и делает
 * это сервер: у него на руках и документ, и файлы. Тащить в сервер CodeMirror
 * ради этого — тот же вес и вторая копия грамматики; замерено на живой тетради:
 * восемьдесят ячеек через lezer — 17 мс, построчным разбором — доли миллисекунды.
 *
 * Что подмножество знает: `def`, `async def`, `class`, присваивание на верхнем
 * уровне и в теле класса, `import` во всех формах. Чего НЕ знает — и это честнее
 * назвать, чем обойти:
 *
 * - Тип переменной. `df.head` сюда приходит цепочкой из двух имён, и разобрать
 *   его нечем: `df` — это данные, а не модуль. См. `resolveChain` — там про то,
 *   почему в таком случае лучше НЕ найти ничего, чем увести в чужой `def head`.
 * - Динамику: `globals()[name] = ...`, `exec`, декораторы, подменяющие имя.
 * - Условные определения: `def f` в обеих ветках `if` даст два определения, и
 *   выбирать между ними будет порядок, а не условие.
 *
 * Всё это — промахи в сторону «не нашёл», и такой промах виден человеку сразу.
 * Единственный промах, которого здесь быть не должно, — уверенный переход не
 * туда: жест сработал, и человек читает чужой код, думая, что читает свой.
 */

/** Имя и точка — из чего состоит цепочка `utils.helper`. */
const WORD = /[A-Za-z0-9_]/

/** Что искали: цепочка имён через точку и границы последнего звена. */
export interface Question {
  /** Слева направо: `['utils', 'helper']` для `utils.helper`. */
  chain: string[]
  /** Границы ЩЁЛКНУТОГО звена в исходнике — по нему рисуют подчёркивание. */
  from: number
  to: number
  /**
   * Слева от цепочки стоит не имя, а ВЫРАЖЕНИЕ: `df[["a"]].head`, `f(x).head`.
   *
   * Цепочка обрывается на скобке, и `head` выглядит голым именем — а он метод
   * чего-то, чего отсюда не видно. Без этой пометки щелчок по `.head(4)`
   * находил первый попавшийся `def head` в папке и уверенно уводил в него:
   * тот самый промах, которого человек не замечает.
   */
  viaExpression: boolean
}

/** Чем имя стало в исходнике. */
export type DefKind = 'def' | 'class' | 'assign' | 'import'

/** Найденное определение — одно имя в одном исходнике. */
export interface Definition {
  name: string
  kind: DefKind
  /** Строка, считая с единицы: так их показывают человеку. */
  line: number
  /** Колонка начала ИМЕНИ, считая с нуля. */
  column: number
  /** Класс, в чьём теле оно объявлено, — или `null` на верхнем уровне. */
  owner: string | null
  /** Сама строка, обрезанная: ею подписывают, куда прыгнули. */
  text: string
}

/** Что связало это имя с чужим модулем. */
export interface Import {
  /** Имя, которым это зовут в коде: после `as`, если он был. */
  local: string
  /** Модуль как написан: `numpy`, `pkg.sub`; пусто у `from . import x`. */
  module: string
  /** Имя ВНУТРИ модуля — или `null` у `import mod`. */
  member: string | null
  /** Сколько точек в начале: 0 — абсолютный импорт, 1 — рядом, 2 — выше. */
  level: number
  line: number
  text: string
}

/** Разобранный исходник. */
export interface Scan {
  defs: Definition[]
  imports: Import[]
  /** `from x import *` — модули, из которых сюда приехало неизвестно что. */
  stars: { module: string; level: number }[]
  /**
   * Ячейка целиком не Python: `%%bash`, `%%sql`, `%%writefile`.
   *
   * Такую надо пропускать, а не разбирать: её содержимое — чужой язык, и `def`
   * в шелл-скрипте определением не является. Пока этой проверки не было,
   * `%%writefile utils.py` с целым модулем внутри давал определения, к которым
   * переход вёл в ячейку, где их нет.
   */
  magic: boolean
}

const MAX_TEXT = 160

/**
 * Ключевые слова: под указателем они есть, а определения у них нет и быть не может.
 *
 * Без этого списка `if`, `None`, `for` подчёркивались наравне с именами и на
 * щелчок отвечали «не нашлось» — обещание, которого фича никогда не сдержит, и
 * заметная доля всех щелчков в живой тетради.
 */
const KEYWORDS: ReadonlySet<string> = new Set(
  `False None True and as assert async await break class continue def del elif
   else except finally for from global if import in is lambda match nonlocal not
   or pass raise return try while with yield case`
    .trim()
    .split(/\s+/),
)

/** Буквы, которыми Python помечает литерал: r, b, u, f и их сочетания. */
const PREFIX = /[A-Za-z]{1,3}$/

/**
 * Код строки за вычетом литералов и комментария.
 *
 * Литералы не вырезаются, а ЗАМАЗЫВАЮТСЯ пробелами: смещения внутри строки
 * обязаны остаться прежними, иначе колонка определения уедет, а `questionAt`
 * ответит про имя, стоящее левее. Тройная кавычка переносится между строками
 * состоянием — `def` внутри docstring определением не является, и это не
 * редкость, а нормальная учебная тетрадь.
 *
 * Два исключения, и оба стоили ошибок на живой лекции.
 *
 * БУКВА ПЕРЕД КАВЫЧКОЙ замазывается вместе с литералом. `f"{x}"` оставлял
 * висеть одинокое `f`, и щелчок по нему уводил в `def f(x)` из соседней ячейки
 * — жест срабатывал и уверенно врал про место, где имени нет вовсе.
 *
 * ВНУТРИ f-СТРОКИ содержимое `{…}` — это КОД, и замазывать его нельзя:
 * `f"{cian_summary} строк"` в тетради обычнее, чем вызов, и половина имён
 * живёт именно там. Скобки-удвоения `{{` и `}}` — литеральные, они остаются
 * замазанными.
 */
function bareLine(line: string, triple: string | null): { code: string; triple: string | null } {
  let out = ''
  let open = triple
  let i = 0
  while (i < line.length) {
    if (open) {
      if (line.startsWith(open, i)) {
        out += ' '.repeat(open.length)
        i += open.length
        open = null
        continue
      }
      out += ' '
      i++
      continue
    }
    const ch = line[i]
    if (ch === '#') {
      out += ' '.repeat(line.length - i)
      break
    }
    if (ch === '"' || ch === "'") {
      // Буква литерала стоит слева и уже записана — стираем её задним числом.
      const mark = PREFIX.exec(out)
      const formatted = mark !== null && /f/i.test(mark[0])
      if (mark) out = out.slice(0, out.length - mark[0].length) + ' '.repeat(mark[0].length)
      const three = line.slice(i, i + 3)
      if (three === ch.repeat(3)) {
        out += '   '
        i += 3
        open = three
        continue
      }
      let j = i + 1
      let body = ' '
      while (j < line.length) {
        if (line[j] === '\\') {
          body += '  '
          j += 2
          continue
        }
        if (line[j] === ch) break
        /*
         * Внутри f-строки `{…}` остаётся кодом. Глубина считается, потому что
         * в подстановке бывают и словари: `f"{ {'a': 1}['a'] }"`.
         */
        if (formatted && line[j] === '{' && line[j + 1] !== '{') {
          let depth = 0
          const from = j
          while (j < line.length) {
            if (line[j] === '{') depth++
            else if (line[j] === '}') {
              depth--
              if (depth === 0) {
                j++
                break
              }
            } else if (line[j] === ch) break
            j++
          }
          body += ` ${line.slice(from + 1, Math.max(from + 1, j - 1))} `
          continue
        }
        body += ' '
        j++
      }
      /*
       * Литерал, не закрытый до конца строки, переносится обратным слешем.
       *
       * `sql = "select \\` продолжается следующей строкой, и `def` в ней —
       * часть текста запроса, а не определение. Пока состояние не переносилось,
       * разбор выдумывал `def fake` из середины SQL и уверенно вёл в строку,
       * где никакой функции нет.
       */
      if (j >= line.length && /\\$/.test(line)) {
        out += ' '.repeat(line.length - i)
        return { code: out, triple: ch }
      }
      const end = Math.min(j + 1, line.length)
      /*
       * Длина обязана совпасть со съеденным куском — иначе поедут ВСЕ смещения
       * правее, и колонка определения вместе с ними. Закрывающая кавычка в
       * `body` не попадает, поэтому добивка пробелами; длиннее нужного `body`
       * быть не может, но если вдруг — честнее замазать целиком, чем сдвинуть.
       */
      while (body.length < end - i) body += ' '
      out += body.length === end - i ? body : ' '.repeat(end - i)
      i = end
      continue
    }
    out += ch
    i++
  }
  return { code: out, triple: open }
}

const DEF = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/
const CLASS = /^\s*class\s+([A-Za-z_]\w*)/
const ASSIGN = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::[^=]+)?=(?!=)/
/** Поле с одной аннотацией и без значения: так объявлены поля dataclass. */
const FIELD = /^\s*([A-Za-z_]\w*)\s*:\s*[^=]+$/
/**
 * Имена, которые связывает не присваивание, а сам оператор.
 *
 * `for column in columns:` и `with open(path) as handle:` — это половина
 * настоящего семинара, и `column` с `handle` определены в них так же
 * по-настоящему, как в `x = 1`. Пока их тут не было, клик по имени переменной
 * цикла отвечал «не нашлось», хотя она объявлена строкой выше на глазах.
 */
const FOR = /^\s*(?:async\s+)?for\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\b/
const AS = /\bas\s+([A-Za-z_]\w*)/g
const IMPORT = /^\s*import\s+(.+)$/
const FROM = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/

/** Обрезанная строка для подписи «куда прыгнули». */
const shorten = (line: string): string => {
  const text = line.trim().replace(/\s+/g, ' ')
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
}

/** `a.b.c as x, d` — имена, которые этот `import` связывает. */
function importClause(clause: string): { local: string; module: string }[] {
  const out: { local: string; module: string }[] = []
  for (const piece of clause.split(',')) {
    const named = /^\s*([\w.]+)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(piece)
    if (!named) continue
    const module = named[1]
    /*
     * Без `as` связывается ВЕРХНИЙ пакет, а не весь путь: `import os.path`
     * кладёт в область видимости имя `os`. Модулем при этом остаётся `os` —
     * «os.path» доберётся цепочкой (см. `resolveChain`), которая приклеит
     * к нему `path` сама.
     */
    const local = named[2] ?? module.split('.')[0]
    out.push({ local, module: named[2] ? module : local })
  }
  return out
}

/** `from pkg import a as b, c` — то же для второй формы. */
function fromClause(clause: string): { names: { local: string; member: string }[]; star: boolean } {
  const names: { local: string; member: string }[] = []
  let star = false
  for (const piece of clause.replace(/[()]/g, ' ').split(',')) {
    const trimmed = piece.trim()
    if (trimmed === '*') {
      star = true
      continue
    }
    const named = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(trimmed)
    if (!named) continue
    names.push({ local: named[2] ?? named[1], member: named[1] })
  }
  return { names, star }
}

/**
 * Где в исходнике стоит это имя — строка и колонка.
 *
 * Ищется по СЫРЫМ строкам инструкции, целым словом и не раньше её отступа.
 * Пока колонка бралась как `raw.indexOf(name)`, псевдоним `import case_bpm as
 * bpm` указывал внутрь `case_bpm` — шесть промахов из восьми в настоящей
 * шапке; а у импорта, перенесённого скобками, имени на первой строке нет
 * вовсе, и колонка выходила −1.
 */
function locate(
  lines: readonly string[],
  from: number,
  to: number,
  name: string,
): { line: number; column: number } {
  const word = new RegExp(`(?<![A-Za-z0-9_.])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`)
  for (let n = from; n <= to && n < lines.length; n++) {
    const at = word.exec(lines[n])
    if (at) return { line: n + 1, column: at.index }
  }
  return { line: from + 1, column: 0 }
}

/** Ячейки, у которых `%%` — обёртка вокруг обычного Python, а не другой язык. */
const PYTHON_MAGICS = /^%%(time|timeit|capture|prun|debug|snakeviz|memit)\b/

/**
 * Разобрать исходник: что он определяет и что притаскивает извне.
 *
 * Работа идёт ЛОГИЧЕСКИМИ инструкциями, а не строками, и это не аккуратность,
 * а исправление двух живых промахов. Подпись, перенесённая скобками —
 * `def loss(\n a,\n) -> X:` или `class Tables(\n Base,\n):` — даёт строку `):`
 * на нулевом отступе, и построчный разбор считал, что тело класса кончилось:
 * методы становились функциями МОДУЛЯ и находились по голому имени. А `;`
 * посреди строки прятал от разбора всё, что стоит за ним, включая импорты
 * шапки — то есть ломал не только свои определения, но и разрешение цепочек во
 * всей тетради.
 */
export function scanPython(code: string): Scan {
  const defs: Definition[] = []
  const imports: Import[] = []
  const stars: { module: string; level: number }[] = []
  const raw = code.split('\n')

  const firstCode = raw.find((line) => line.trim() !== '')
  /*
   * `%%bash` — другой язык, и разбирать его как Python значит выдумывать
   * определения. А `%%time` и `%%capture` — обёртки вокруг обычной ячейки, и
   * пропускать их целиком значило терять всё, что в них написано: в настоящей
   * тетради под `%%time` лежит обучение модели вместе со всеми её именами.
   */
  if (firstCode !== undefined && firstCode.trimStart().startsWith('%%')) {
    if (!PYTHON_MAGICS.test(firstCode.trimStart())) return { defs, imports, stars, magic: true }
  }

  /** Бесстрочные версии строк: литералы замазаны, комментарии сняты. */
  const bare: string[] = []
  let triple: string | null = null
  for (const line of raw) {
    const done = bareLine(line, triple)
    bare.push(done.code)
    triple = done.triple
  }

  /** Открытые области: класс даёт владельца, функция прячет всё внутри себя. */
  const scopes: { kind: 'class' | 'def'; name: string; indent: number }[] = []

  const depthOf = (line: string): number => {
    let depth = 0
    for (const ch of line) {
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') depth--
    }
    return depth
  }

  for (let n = 0; n < bare.length; n++) {
    if (bare[n].trim() === '') continue

    // Логическая инструкция: скобки и обратный слеш переносят её на строки ниже.
    const start = n
    let depth = depthOf(bare[n])
    let joined = bare[n]
    while ((depth > 0 || /\\$/.test(joined.trimEnd())) && n + 1 < bare.length) {
      n++
      joined = `${joined.replace(/\\\s*$/, '')} ${bare[n].trim()}`
      depth += depthOf(bare[n])
    }
    const end = n

    const indent = /^\s*/.exec(bare[start])![0].length
    while (scopes.length > 0 && indent <= scopes[scopes.length - 1].indent) scopes.pop()
    /*
     * Внутри функции определений модуля нет. `helper = 1` в чужой функции не
     * должно отвечать на клик по `helper` в другой ячейке: это локальное имя,
     * и живёт оно ровно до `return`.
     */
    const inside = scopes.some((one) => one.kind === 'def')
    const owner = scopes.length > 0 && scopes[scopes.length - 1].kind === 'class'
      ? scopes[scopes.length - 1].name
      : null

    const klass = CLASS.exec(joined)
    if (klass) {
      if (!inside) {
        const where = locate(raw, start, end, klass[1])
        defs.push({ name: klass[1], kind: 'class', ...where, owner, text: shorten(joined) })
      }
      scopes.push({ kind: 'class', name: klass[1], indent })
      continue
    }

    const fn = DEF.exec(joined)
    if (fn) {
      if (!inside) {
        const where = locate(raw, start, end, fn[1])
        defs.push({ name: fn[1], kind: 'def', ...where, owner, text: shorten(joined) })
      }
      scopes.push({ kind: 'def', name: fn[1], indent })
      continue
    }

    if (inside) continue

    /*
     * Простые инструкции, разделённые `;`. Их пишут в шапке (`import os; import
     * sys`) и в разборах на одну строку, и пока разреза здесь не было, всё,
     * что стоит за точкой с запятой, пропадало вместе с первой половиной.
     */
    for (const piece of splitSimple(joined)) {
      const from = FROM.exec(piece)
      if (from) {
        const parsed = fromClause(from[3])
        if (parsed.star) stars.push({ module: from[2], level: from[1].length })
        for (const one of parsed.names) {
          imports.push({
            local: one.local,
            module: from[2],
            member: one.member,
            level: from[1].length,
            line: start + 1,
            text: shorten(joined),
          })
          const where = locate(raw, start, end, one.local)
          defs.push({ name: one.local, kind: 'import', ...where, owner, text: shorten(joined) })
        }
        continue
      }

      const plain = IMPORT.exec(piece)
      if (plain) {
        for (const one of importClause(plain[1])) {
          imports.push({ ...one, member: null, level: 0, line: start + 1, text: shorten(joined) })
          const where = locate(raw, start, end, one.local)
          defs.push({ name: one.local, kind: 'import', ...where, owner, text: shorten(joined) })
        }
        continue
      }

      /*
       * Присваивание — на ЛЮБОЙ глубине, лишь бы не внутри функции.
       *
       * Прежнее правило «только нулевой отступ или тело класса» теряло всё, что
       * лежит в `if`, `for`, `with` и `try` на верхнем уровне, — а именно так
       * написана половина настоящего семинара: `with open(...) as f:` и
       * `for column in columns:` идут сплошь, и `column` отвечал «не нашлось»,
       * хотя определён строкой выше на глазах у человека. Тела функций сюда не
       * доходят: они отсечены выше.
       */
      /*
       * `for x in …` и `… as x` — до присваивания: в такой строке знака `=`
       * может и не быть вовсе, а имя в ней связывается.
       */
      const loop = FOR.exec(piece)
      if (loop) {
        for (const name of loop[1].split(',').map((part) => part.trim())) {
          if (!name || KEYWORDS.has(name)) continue
          const where = locate(raw, start, end, name)
          defs.push({ name, kind: 'assign', ...where, owner, text: shorten(joined) })
        }
        continue
      }
      if (/^\s*(?:async\s+)?(?:with|except)\b/.test(piece)) {
        AS.lastIndex = 0
        let bound: RegExpExecArray | null
        while ((bound = AS.exec(piece)) !== null) {
          if (KEYWORDS.has(bound[1])) continue
          const where = locate(raw, start, end, bound[1])
          defs.push({ name: bound[1], kind: 'assign', ...where, owner, text: shorten(joined) })
        }
        continue
      }

      const set = ASSIGN.exec(piece)
      if (set) {
        for (const name of set[1].split(',').map((part) => part.trim())) {
          if (!name || KEYWORDS.has(name)) continue
          const where = locate(raw, start, end, name)
          defs.push({ name, kind: 'assign', ...where, owner, text: shorten(joined) })
        }
        continue
      }

      /*
       * И поле с одной аннотацией: `train: pd.DataFrame` без значения. Так
       * объявлены поля `@dataclass`, а их в учебных модулях курса шестнадцать
       * штук — и ни одно не находилось.
       */
      const field = FIELD.exec(piece)
      if (field && !KEYWORDS.has(field[1])) {
        const where = locate(raw, start, end, field[1])
        defs.push({ name: field[1], kind: 'assign', ...where, owner, text: shorten(joined) })
      }
    }
  }

  return { defs, imports, stars, magic: false }
}

/** Разрез по `;` вне скобок: `import os; import sys` — две инструкции. */
function splitSimple(line: string): string[] {
  if (!line.includes(';')) return [line]
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ';' && depth === 0) {
      out.push(line.slice(from, i))
      from = i + 1
    }
  }
  out.push(line.slice(from))
  return out.filter((piece) => piece.trim() !== '')
}

/**
 * Сколько строк назад смотреть, чтобы узнать про открытую тройную кавычку.
 *
 * Состояние кавычек честно считается от начала исходника, и на ячейке это
 * ничего не стоит. Но тот же разбор зовётся на КАЖДОЕ движение мыши с зажатым
 * модификатором, а редактор файлов открывает до полутора мегабайт: полный
 * проход там — десятки миллисекунд на пиксель пути указателя.
 *
 * Двести строк — это заведомо больше любого docstring, который пишут руками, и
 * заведомо дёшево. Цена ошибки при промахе мелкая и односторонняя: имя внутри
 * гигантского литерала подчеркнётся и ответит «не нашлось».
 */
const LOOKBACK = 200

/**
 * Имя под кареткой — целиком, вместе с тем, чьё оно.
 *
 * Цепочка тянется ВЛЕВО и включает щёлкнутое звено: щёлкнув `head` в
 * `df.head.values`, спрашивают про `df.head`, а не про всю цепочку — так же
 * ведут себя IDE, и так же читается намерение.
 *
 * Внутри строки и комментария ответа нет: `# def helper` — это текст, и
 * подчёркивать в нём нечего. Внутри f-строки — наоборот есть: `{cian_summary}`
 * это код, и имён там живёт не меньше, чем снаружи.
 */
export function questionAt(code: string, cursor: number): Question | null {
  if (cursor < 0 || cursor > code.length) return null
  const before = code.lastIndexOf('\n', Math.max(0, cursor - 1))
  const start = before + 1
  const after = code.indexOf('\n', cursor)
  const end = after === -1 ? code.length : after
  const here = code.slice(start, end)

  /*
   * Назад отсчитывается ровно `LOOKBACK` строк — и режется тоже только они.
   *
   * Раньше здесь стояло `code.slice(0, start).split('\n')`, то есть весь текст
   * до каретки резался на строки ради последних двухсот. На ячейке это ничего
   * не стоит, а на файле стоило дорого и не там: замерено, полтора мегабайта —
   * 12 мс, и платятся они на КАЖДОЕ движение мыши с зажатым модификатором.
   */
  let window = start
  for (let n = 0; n < LOOKBACK && window > 0; n++) {
    const prev = code.lastIndexOf('\n', window - 2)
    if (prev === -1) {
      window = 0
      break
    }
    window = prev + 1
  }
  let triple: string | null = null
  const above = code.slice(window, start).split('\n')
  above.pop()
  for (const line of above) triple = bareLine(line, triple).triple
  const { code: bare } = bareLine(here, triple)

  const at = cursor - start
  if (at > bare.length) return null
  let to = at
  while (to < bare.length && WORD.test(bare[to])) to++
  let from = at
  while (from > 0 && WORD.test(bare[from - 1])) from--
  if (from === to) return null
  // Имя, начинающееся цифрой, — это число: `2x` не бывает, а `df.iloc[0]` даёт
  // `0` под указателем, и спрашивать о нём нечего.
  if (/^\d/.test(bare.slice(from, to))) return null

  const reach = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(bare.slice(0, to))
  if (!reach) return null
  const chain = reach[0].split('.').filter(Boolean)
  if (chain.length === 0) return null
  /*
   * Скобка или кавычка перед точкой — значит слева ВЫРАЖЕНИЕ, а не имя.
   *
   * Смотрим в сырую строку, а не в замазанную: `"abc".upper` иначе выглядел бы
   * голым `upper`, потому что литерал к этому моменту уже стёрт.
   */
  const viaExpression = /[)\]}'"]\s*\.\s*$/.test(here.slice(0, reach.index))
  /*
   * Ключевое слово именем не считается — ни первым звеном, ни последним.
   * `if`, `None`, `for` подчёркивались наравне с именами и отвечали «не
   * нашлось»: обещание перехода там, где переходить некуда по устройству
   * языка.
   */
  if (KEYWORDS.has(chain[chain.length - 1]) || KEYWORDS.has(chain[0])) return null
  return { chain, from: start + from, to: start + to, viaExpression }
}

export function modulePaths(module: string, level: number, dir: string): string[] {
  let base = dir
  if (level === 0) base = ''
  else for (let up = 1; up < level; up++) base = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''
  const tail = module ? module.split('.').filter(Boolean).join('/') : ''
  const joined = [base, tail].filter(Boolean).join('/')
  if (!joined) return []
  return [`${joined}.py`, `${joined}/__init__.py`]
}

/** К чему свести цепочку, чтобы знать, где искать. */
export type Target =
  | { kind: 'name'; name: string }
  | { kind: 'member'; module: string; level: number; name: string }
  /** Цепочка от данных, а не от модуля: `df.head`. Искать нечего. */
  | { kind: 'opaque'; owner: string; name: string }

/**
 * Цепочка — в то, что можно найти.
 *
 * Здесь проходит вся граница честности этой фичи, и стоит она на одном правиле:
 * у `utils.helper` и у `df.head` дерево разбора ОДИНАКОВОЕ, а смысл
 * противоположный. Различает их единственная вещь — чем связано имя слева.
 * Импорт — значит модуль, и в модуле есть что искать. Всё остальное —
 * присваивание, параметр, результат вызова — значит ДАННЫЕ, и никакого
 * `def head` у них в папке семинара нет.
 *
 * Поэтому непонятная цепочка отвечает `opaque`, а не «поищем имя `head`
 * где-нибудь». Соблазн велик: в тетради почти наверняка найдётся какой-нибудь
 * `def head`, переход сработает и уведёт читать чужой класс — тот единственный
 * промах, который человек не заметит.
 */
export function resolveChain(question: Question, imports: readonly Import[]): Target {
  const chain = question.chain
  const name = chain[chain.length - 1]
  /*
   * Слева выражение — значит это чей-то метод, и чей, отсюда не видно.
   * Пустой `owner` — «сказать нечего»: имени, о котором можно говорить, в
   * `df[["a"]].head` действительно нет.
   */
  if (question.viaExpression) return { kind: 'opaque', owner: '', name }
  if (chain.length === 1) return { kind: 'name', name }

  const root = chain[0]
  const bound = imports.find((one) => one.local === root)
  if (!bound) return { kind: 'opaque', owner: root, name }

  /*
   * Середина цепочки приклеивается к модулю: `import pkg` плюс `pkg.mod.f`
   * значит `pkg/mod.py` и в нём `f`. У формы `from pkg import mod` модуль уже
   * назван целиком, и к нему приклеивается то же самое.
   */
  const head = bound.member ? `${bound.module}.${bound.member}` : bound.module
  const middle = chain.slice(1, -1)
  const module = [head, ...middle].filter(Boolean).join('.')
  return { kind: 'member', module, level: bound.level, name }
}

/**
 * Определение имени в разобранном исходнике — то, которое стоит показать.
 *
 * Верхний уровень раньше тела класса: клик по голому `fit` спрашивает про
 * функцию модуля, а не про метод чужого класса, случайно названный так же.
 * Метод отдаётся только когда его спросили — то есть когда известен владелец.
 *
 * Среди одинаковых — ПОСЛЕДНЕЕ: тетрадь читают сверху вниз, и переопределение
 * ниже отменяет то, что было выше. Ровно так же считает и сам Python.
 */
export function pickDefinition(
  scan: Scan,
  name: string,
  owner: string | null = null,
): Definition | null {
  const all = scan.defs.filter((one) => one.name === name)
  if (all.length === 0) return null
  const wanted = owner === null ? all.filter((one) => one.owner === null) : all.filter((one) => one.owner === owner)
  const pool = wanted.length > 0 ? wanted : owner === null ? [] : all
  if (pool.length === 0) return null
  /*
   * Импорт — определение только за неимением лучшего: `from utils import f` в
   * этой же ячейке отвечает на клик по `f`, но если рядом есть настоящий
   * `def f`, показать надо его. Иначе переход уводил бы на строку импорта,
   * из которой всё равно надо прыгать дальше.
   */
  const real = pool.filter((one) => one.kind !== 'import')
  const from = real.length > 0 ? real : pool
  return from[from.length - 1]
}
