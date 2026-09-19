import { createHash } from 'node:crypto'

/**
 * Справка о том, чего в ядре ещё нет: сигнатура, прочитанная jedi ИЗ ИСХОДНИКОВ.
 *
 * `inspect_request` отвечает по ПРОСТРАНСТВУ ИМЁН: он смотрит на живой объект,
 * и пока ячейку `import seaborn as sns` не запустили, `sns.lmplot` для него —
 * несуществующее имя. Отсюда половина жалоб «справка не всегда появляется»:
 * тетрадь открыли, до ячейки с импортами ещё не дошли, а сигнатуру хочется
 * посмотреть именно сейчас — когда строку пишут, а не когда её уже написали.
 *
 * Второй путь отвечает на тот же вопрос статически. jedi стоит в каждом ядре —
 * он приезжает вместе с IPython, и это тот же jedi, которым ipykernel отвечает
 * на `complete_request`, — и умеет прочитать сигнатуру, ни разу ничего не
 * выполнив. Ему нужно только одно, чего нет в тексте одной ячейки: откуда
 * взялось имя `sns`. Поэтому сверху к разбираемому коду приклеивается ШАПКА
 * ИМПОРТОВ — строки `import …` из ячеек кода той же тетради выше текущей (см.
 * `importHeader`). В тетради область видимости — не ячейка, а ядро, и шапка
 * ровно это и повторяет.
 *
 * Почему исходник уезжает в САМО ядро, а не разбирается на сервере: jedi
 * отвечает про те библиотеки, которые стоят В ЭТОМ окружении. Сервер живёт на
 * хосте, где нет ни seaborn, ни torch, ни того, что преподаватель доставил
 * `pip install` в терминале комнаты; ядро — единственное место, где вопрос
 * «какая сигнатура у lmplot» вообще имеет ответ.
 *
 * Что здесь принято ради безопасности и тишины — и почему:
 *   · скрытый модуль в `sys.modules`, ни одного связанного имени в `globals()`
 *     студента (тот же приём, что у изоляции консилиума);
 *   · `silent: true, store_history: False` — ни вывода, ни следа в `In`/`Out`;
 *   · ответ едет `user_expressions` — при `silent` в IOPUB не приходит ничего;
 *   · будильник внутри Python: чужое ядро не имеет права стоять секундами
 *     из-за наведённой мыши, и обрывать jedi надо ТАМ, а не только переставать
 *     его ждать здесь;
 *   · потолок размера: docstring numpy бывает в сотни килобайт, а едет он
 *     через тот же сокет, что и вывод занятия.
 *
 * Чистый модуль: исходники на Python, сборка вопроса и разбор ответа — ни
 * сети, ни Yjs, ни docker (тот же приём, что в council-isolation.ts).
 */

/** Скрытый модуль, в котором живёт разбор. Не имя в `globals()`. */
export const INSPECT_MODULE = '_colloq_inspect'

/** Ключ, под которым ответ едет в `user_expressions`. */
export const INSPECT_REPORT_KEY = 'colloq'

/**
 * Выражение, которое ядро посчитает после кода и положит в `execute_reply`.
 *
 * До модуля приходится добираться через `__import__`: в `user_ns` его нет
 * нарочно — см. заголовок файла.
 */
export const INSPECT_REPORT_EXPR = `__import__('sys').modules['${INSPECT_MODULE}'].report`

/**
 * Сколько секунд jedi разрешено думать.
 *
 * Полторы, и число замерено, а не выбрано. На холодном контейнере первый
 * разбор pandas стоит ~1,5 с (jedi разбирает исходники библиотеки и кладёт
 * разбор в свой кеш), второй — 0,5 с, третий и дальше — единицы миллисекунд;
 * seaborn после прогретого pandas — 0,57 с. То есть потолок режет ровно один
 * случай на комнату: самое первое наведение на самую тяжёлую библиотеку. Оно
 * отвечает «не нашлось», а следующее — уже сигнатурой, и это лучший размен,
 * какой тут есть: ядро комнаты одно, и держать его занятым дольше ради
 * подсказки нельзя.
 */
export const INSPECT_BUDGET_SEC = 1.5

/** Потолок ответа: docstring бывает в сотни килобайт, а сокет у комнаты общий. */
export const INSPECT_LIMIT_BYTES = 20 * 1024

/** Сколько строк импорта уезжает в шапку. Учебная тетрадь укладывается вдесятеро. */
const HEADER_MAX_LINES = 60

/** И сколько знаков: кадр к ядру и так не резиновый. */
const HEADER_MAX_CHARS = 4 * 1024

/**
 * Строка, которую можно поставить в шапку: один цельный импорт верхнего уровня.
 *
 * Только верхнего: `import cv2` внутри `try:` в шапке был бы отступом посреди
 * модуля, то есть синтаксической ошибкой, из-за которой jedi не разобрал бы
 * ВСЮ шапку — а значит и ни одного имени в ней. Только цельный: продолжение
 * строки (`\` или незакрытая скобка) без своего хвоста означает то же самое.
 */
const IMPORT_LINE = /^(?:import\s+[A-Za-z_][\w.]*.*|from\s+[.\w]+\s+import\s+.+)$/

/**
 * Шапка импортов тетради: строки `import …` и `from … import …` из ячеек кода.
 *
 * Порядок — тот же, что в тетради: её читают и запускают сверху вниз, и если
 * `np` переопределили ниже, действует нижнее. Повторы выбрасываются — одна и та
 * же строка стоит в половине ячеек учебной тетради.
 *
 * Ячейки с `%%magic` пропускаются целиком: `%%bash` с `import` внутри — это не
 * Python, и приклеенная к шапке строка оттуда испортила бы разбор всему.
 */
export function importHeader(sources: readonly string[]): string {
  const lines: string[] = []
  const seen = new Set<string>()
  let chars = 0
  for (const source of sources) {
    if (typeof source !== 'string' || !source.includes('import')) continue
    if (/^\s*%%/.test(source)) continue
    for (const row of source.split('\n')) {
      const line = row.replace(/\s+$/, '')
      // Отступ — значит импорт внутри `try`, функции или `if`: см. IMPORT_LINE.
      if (line !== line.trimStart()) continue
      if (!IMPORT_LINE.test(line)) continue
      // Продолжение строки: хвоста у него в шапке не будет.
      if (line.endsWith('\\') || (line.includes('(') && !line.includes(')'))) continue
      if (seen.has(line)) continue
      if (lines.length >= HEADER_MAX_LINES || chars + line.length + 1 > HEADER_MAX_CHARS) {
        return lines.join('\n')
      }
      seen.add(line)
      lines.push(line)
      chars += line.length + 1
    }
  }
  return lines.join('\n')
}

/**
 * Имя под кареткой — цепочкой через точки, как его видит человек.
 *
 * Нужно ровно затем, чтобы написать в сигнатуре `sns.lmplot(...)`, а не
 * `lmplot(...)`: jedi знает найденное по собственному имени и про приставку не
 * догадывается, а `inspect_request` пишет именно то, что набрано. Разойдись
 * они — и один и тот же наведённый `sns.lmplot` выглядел бы по-разному в
 * зависимости от того, запускали в комнате ячейку с импортом или нет.
 */
export function nameChainAt(code: string, cursor: number): string {
  const at = Math.max(0, Math.min(cursor, code.length))
  const head = code.slice(0, at)
  const line = head.slice(head.lastIndexOf('\n') + 1)
  return /[A-Za-z_][A-Za-z0-9_.]*$/.exec(line)?.[0] ?? ''
}

/**
 * Исходник разбора — вся работа, которую делает ядро, одним куском.
 *
 * Отдельной строкой в файле, а не собирается из кусков, ровно по тому же
 * доводу, что у изоляции консилиума: это Python, и читать его надо как Python,
 * с отступами и комментариями на своих местах.
 */
const IMPL = `
"""Сигнатура и документация по исходникам — глазами jedi, без единого запуска."""
import json
import sys

version = '__VERSION__'

# Ответ последнего вопроса. Сервер забирает его через user_expressions, а не с
# возвратом: при silent=True у execute_request возврата и нет.
report = None


class _Report(object):
    """Отчёт серверу: его repr и есть готовый JSON.

    user_expressions возвращает mimebundle, а text/plain в нём — repr()
    значения. Отдать строку нельзя: её repr приехал бы в кавычках и с
    экранированием, то есть JSON внутри JSON.
    """
    __slots__ = ('text',)

    def __init__(self, text):
        self.text = text

    def __repr__(self):
        return self.text


class _Timeout(Exception):
    """Будильник: jedi думает дольше, чем комната согласна ждать."""


def _arm(budget):
    """Завести будильник на бюджет секунд; None — завести было нечем.

    Обрывать надо ИЗНУТРИ: сервер, переставший ждать, не освобождает ядро — оно
    так и будет разбирать pandas, пока кто-то ждёт своей ячейки. SIGALRM
    работает только в главном потоке; ipykernel считает код именно в нём, но
    проверка тут стоит на тот случай, когда это не так.
    """
    try:
        import signal
        import threading
        if threading.current_thread() is not threading.main_thread():
            return None

        def bang(signum, frame):
            raise _Timeout('colloq-inspect')

        old = signal.signal(signal.SIGALRM, bang)
        signal.setitimer(signal.ITIMER_REAL, budget)
        return old
    except Exception:
        return None


def _disarm(old):
    if old is None:
        return
    try:
        import signal
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)
    except Exception:
        pass


_QUOTES = ('"', "'")
_OPEN = '(['
_CLOSE = ')]'
_BACKSLASH = chr(92)


def _split(inner):
    """Параметры из текста сигнатуры — по запятым ВЕРХНЕГО уровня.

    По тексту, а не по sig.params, и это не придирка: в списке параметров jedi
    нет голой звёздочки, а она и есть та черта, после которой аргументы
    передаются только по имени. У lmplot без неё сигнатура читалась бы как
    разрешение написать lmplot(data, x, y) — то есть как неправда.

    Кавычки и вложенные скобки считаются, потому что запятая живёт и внутри
    умолчания: markers=("o", "x"), dtype=Dict[str, int].
    """
    parts = []
    depth = 0
    quote = ''
    start = 0
    i = 0
    while i < len(inner):
        ch = inner[i]
        if quote:
            if ch == _BACKSLASH:
                i += 2
                continue
            if ch == quote:
                quote = ''
        elif ch in _QUOTES:
            quote = ch
        elif ch in _OPEN:
            depth += 1
        elif ch in _CLOSE:
            depth -= 1
        elif ch == ',' and depth == 0:
            parts.append(inner[start:i].strip())
            start = i + 1
        i += 1
    tail = inner[start:].strip()
    if tail:
        parts.append(tail)
    return [p for p in parts if p]


def _wrap(display, sig):
    """Сигнатуру — столбиком, если в строку она не помещается.

    Так её печатает и сам IPython: двадцать пять параметров lmplot в одну
    строку читаются хуже, чем не читаются вовсе. Хвост («-> Self») остаётся на
    месте: он часть того же текста и переписывать его нечем.
    """
    try:
        text = sig.to_string()
    except Exception:
        return ''
    if not text:
        return ''
    own = getattr(sig, 'name', '') or ''
    if display and own and text.startswith(own + '('):
        text = display + text[len(own):]
    if len(text) <= 72:
        return text
    at = text.find('(')
    close = text.rfind(')')
    if at == -1 or close < at:
        return text
    parts = _split(text[at + 1:close])
    if not parts:
        return text
    return text[:at] + '(\\n' + ''.join('    ' + p + ',\\n' for p in parts) + ')' + text[close + 1:]


def _render(found, display, limit):
    """Первое найденное, разложенное по заголовкам IPython.

    Те же заголовки, что у inspect_request, — и это условие всей затеи: разбор
    на клиенте один (web/src/lib/signature-help.ts), и два ответа на один
    вопрос обязаны выглядеть одинаково.
    """
    for d in found:
        try:
            sigs = d.get_signatures()
        except Exception:
            sigs = []
        sig = _wrap(display, sigs[0]) if sigs else ''
        try:
            doc = d.docstring(raw=True) or ''
        except Exception:
            doc = ''
        doc = doc.strip('\\n')
        if not sig and not doc.strip():
            continue
        parts = []
        if sig:
            # У класса сигнатуры нет — есть сигнатура его __init__, и IPython
            # называет её именно так.
            head = 'Init signature' if getattr(d, 'type', '') == 'class' else 'Signature'
            parts.append(head + ':\\n' + sig)
        kind = getattr(d, 'type', '') or ''
        if kind:
            parts.append('Type: ' + kind)
        if doc.strip():
            parts.append('Docstring:\\n' + doc)
        text = '\\n'.join(parts)
        if len(text) > limit:
            # Обрыв виден: молча укороченная документация читается как
            # документация, которая так и кончается.
            text = text[:limit] + '\\n…'
        return text
    return ''


def look(code, line, column, display, budget, limit):
    """Ответить на один вопрос и положить ответ в report."""
    global report
    report = None
    try:
        import jedi
    except Exception:
        # jedi нет в этом окружении — обычное дело для ядра, собранного не нами.
        report = _Report(json.dumps({'found': False, 'why': 'no-jedi'}))
        return
    out = {'found': False, 'why': 'nothing'}
    old = _arm(budget)
    try:
        script = jedi.Script(code=code)
        try:
            found = script.infer(line, column)
        except Exception:
            found = []
        if not found:
            # infer отвечает про ЗНАЧЕНИЕ имени, goto — про то, где оно
            # объявлено. Второе знает больше там, где первое не разрешило тип.
            try:
                found = script.goto(line, column, follow_imports=True)
            except Exception:
                found = []
        text = _render(found, display, limit)
        if text:
            out = {'found': True, 'text': text}
    except _Timeout:
        out = {'found': False, 'why': 'timeout'}
    except Exception:
        out = {'found': False, 'why': 'nothing'}
    finally:
        _disarm(old)
    report = _Report(json.dumps(out))
`

let stamp: string | null = null

/** Версия исходника: другая сборка сервера — другой хеш, и ядро перечитает код. */
function implVersion(): string {
  return (stamp ??= createHash('sha256').update(IMPL).digest('hex').slice(0, 12))
}

let literal: string | null = null
function implLiteral(): string {
  return (literal ??= JSON.stringify(IMPL.replace('__VERSION__', implVersion())))
}

export interface StaticInspectQuestion {
  /** Код ячейки — тот же, что уехал бы в `inspect_request`. */
  code: string
  /** Каретка в этом коде, в знаках от начала. */
  cursor: number
  /** Шапка импортов тетради; `''` — импортов выше не было. */
  header?: string
  budgetSec?: number
  limitBytes?: number
}

/**
 * Ячейка вопроса: установка модуля (если он не тот) и один вызов.
 *
 * `exec` в `__dict__` скрытого модуля — единственный способ занести сюда
 * двести строк Python, не оставив в пространстве студента ни `sys`, ни
 * временных переменных. Сверка по версии делает установку идемпотентной и
 * бесплатной: `compile` этого исходника стоит миллисекунду, а между вопросами
 * он не меняется никогда.
 */
export function inspectStaticSource(question: StaticInspectQuestion): string {
  const header = typeof question.header === 'string' ? question.header : ''
  const cell = typeof question.code === 'string' ? question.code : ''
  const at = Math.max(0, Math.min(question.cursor ?? 0, cell.length))
  /*
   * Шапка встаёт СВЕРХУ, и каретка уезжает вниз ровно на столько строк,
   * сколько в ней есть. Считать позицию заново по склеенному тексту нельзя:
   * разъехавшись на знак, jedi разобрал бы соседнее имя и уверенно ответил
   * не о том.
   */
  const whole = header === '' ? cell : `${header}\n${cell}`
  const before = whole.slice(0, whole.length - cell.length + at)
  const line = before.split('\n').length
  const column = before.length - (before.lastIndexOf('\n') + 1)
  const display = nameChainAt(cell, at)
  const budget = Number.isFinite(question.budgetSec) ? Number(question.budgetSec) : INSPECT_BUDGET_SEC
  const limit = Number.isFinite(question.limitBytes)
    ? Math.floor(Number(question.limitBytes))
    : INSPECT_LIMIT_BYTES
  const module = JSON.stringify(INSPECT_MODULE)
  return [
    `if getattr(__import__('sys').modules.get(${module}), 'version', None) != ` +
      `${JSON.stringify(implVersion())}: ` +
      `exec(compile(${implLiteral()}, '<colloq-inspect>', 'exec'), ` +
      `__import__('sys').modules.setdefault(${module}, ` +
      `__import__('types').ModuleType(${module})).__dict__)`,
    `__import__('sys').modules[${module}].look(${JSON.stringify(whole)}, ${line}, ${column}, ` +
      `${JSON.stringify(display)}, ${budget}, ${limit})`,
  ].join('\n')
}

export interface StaticInspectAnswer {
  found: boolean
  text: string | null
  /** Почему не нашлось: `no-jedi` — его нет в окружении, `timeout` — не успел. */
  why: 'no-jedi' | 'timeout' | 'nothing' | null
}

/**
 * Разобрать ответ ядра.
 *
 * Принимает и то, что приезжает в `user_expressions` (`{status, data}` с
 * `text/plain` внутри), и голую строку JSON — второе ради теста, который гоняет
 * тот же исходник настоящим python3 и читает ответ со stdout.
 *
 * `null` — подтверждения не было вовсе: модуль не установился, запуск не
 * прошёл, ядро ответило чем-то другим. Отличать это от «не нашлось» важно:
 * первое — наша беда, второе — обычный исход.
 */
export function parseStaticInspect(raw: unknown): StaticInspectAnswer | null {
  let text: string | null = null
  if (typeof raw === 'string') text = raw
  else if (raw && typeof raw === 'object') {
    const wrapper = raw as { status?: unknown; data?: Record<string, unknown> }
    // status !== 'ok' — это `_user_obj_error()` IPython: выражение не
    // посчиталось, то есть модуля или ответа в нём нет.
    if (wrapper.status !== undefined && wrapper.status !== 'ok') return null
    const plain = wrapper.data?.['text/plain']
    if (typeof plain === 'string') text = plain
  }
  if (text === null || text === 'None') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const row = parsed as { found?: unknown; text?: unknown; why?: unknown }
  if (row.found === true && typeof row.text === 'string' && row.text !== '') {
    return { found: true, text: row.text, why: null }
  }
  const why = row.why === 'no-jedi' || row.why === 'timeout' ? row.why : 'nothing'
  return { found: false, text: null, why }
}
