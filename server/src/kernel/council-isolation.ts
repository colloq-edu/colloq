import { tr, formatNumber } from '@shared/i18n'

/**
 * Личные копии данных на одну попытку консилиума — и точный возврат после неё.
 *
 * Ядро в комнате одно, и это устройство продукта: попытка обязана видеть `df`,
 * `np` и всё, что преподаватель подготовил в общей ячейке. Но пока «личный лист»
 * означал только личный ТЕКСТ, общим оставалось всё остальное, и на семинаре
 * 19.09 это стоило пары: в задании стояла закомментированная строка
 * `# data = data.dropna()`, один человек её раскомментировал и запустил — и
 * `data` стал другим у ВСЕХ, включая тех, кто уже сдал.
 *
 * Ломалось это двумя разными способами, и прежняя уборка (снимок имён до
 * попытки, снятие новых после) не закрывала ни одного:
 *   1. перепривязка — `data = data.dropna()` меняет ИМЯ, которое было, а
 *      снимались только имена, которых не было;
 *   2. мутация на месте — `df.drop(..., inplace=True)`, `df['x'] = 1`,
 *      `lst.append(...)` портят сам объект, и снимать тут нечего вовсе.
 *
 * Отдельное ядро на студента отвергнуто по цене (≈2 ГБ на ядро и хрупкость
 * zmq/matplotlib), `fork` — по тем же причинам плюс общий сокет Jupyter.
 * Осталось единственное дешёвое: перед попыткой подменить привязки личными
 * копиями, после — вернуть пространство имён в точности к тому, что было.
 *
 * Цена копии здесь не теоретическая. В образе `colloq-kernel:base` стоит
 * pandas 3, где Copy-on-Write включён всегда: `obj.copy(deep=False)` стоит
 * O(1) и при этом любая запись в копию исходника не трогает — то есть самый
 * частый и самый тяжёлый случай семинара (таблица на сотни мегабайт) закрыт
 * бесплатно. Глубокие копии остаются для numpy, контейнеров и pandas без CoW,
 * и на них стоит бюджет: то, что в него не влезло, остаётся общим, а попытке об
 * этом говорят вслух — молчаливое «у одних копия, у других нет» было бы хуже
 * прежней дыры.
 *
 * Чистый модуль: исходники на Python, сборка и разбор отчёта, ни сети, ни Yjs
 * — ради теста (тот же приём, что в council.ts).
 */

/** Скрытый модуль, в котором живёт состояние изоляции. Не имя в `globals()`. */
export const COUNCIL_MODULE = '_colloq_council'

/** Ключ, под которым отчёт едет в `user_expressions` ответа ядра. */
export const COUNCIL_REPORT_KEY = 'colloq'

/**
 * Выражение, которое ядро посчитает и положит в `execute_reply`.
 *
 * `user_expressions` отвечает ДАЖЕ при `silent: true` (ipykernel ·
 * IPythonKernel.do_execute: они считаются после запуска, если статус `ok`), а
 * при `silent: true` ядро не шлёт в IOPUB ничего — значит другого способа
 * услышать вход и не было бы. Модуль спрятан в `sys.modules`, поэтому до него
 * приходится добираться через `__import__`: в `user_ns` его нет нарочно.
 */
export const COUNCIL_REPORT_EXPR = `__import__('sys').modules['${COUNCIL_MODULE}'].report`

/** Сколько байт личных копий разрешено одной попытке, если не сказано иначе. */
export const COUNCIL_DEFAULT_COPY_BYTES = 512 * 1024 * 1024

/** Столько строк про «осталась общей» помещается в шапку вывода; дальше — счёт. */
export const MAX_SKIP_NOTES = 3

/** Размер, которого не сосчитать: обход упёрся в потолок узлов. */
export const SIZE_UNKNOWN = -1

export interface CouncilCopySkip {
  name: string
  /** Байты; `SIZE_UNKNOWN` — объект оказался слишком ветвистым, чтобы мерить. */
  bytes: number
}

export interface CouncilCopyFailure {
  name: string
  error: string
}

export interface CouncilIsolationReport {
  ok: boolean
  /** Сколько имён получили личную копию. */
  copied: number
  /** Что не влезло в бюджет и осталось общим. */
  skipped: CouncilCopySkip[]
  /** Что не скопировалось по своей причине (и тоже осталось общим). */
  failed: CouncilCopyFailure[]
  /** Сколько байт копий насчитал вход. */
  bytes: number
  ms: number
  /** Заполнено, только когда `ok` ложно. */
  error: string | null
}

/**
 * Реализация входа и выхода — одним куском Python, который исполняется НЕ в
 * пространстве студента.
 *
 * Всё, что объявлено ниже, ложится в `__dict__` скрытого модуля: ячейка входа
 * (`councilEnterSource`) делает ровно два действия, и ни одно из них не
 * связывает имён в `globals()` попытки. Иначе вход сам себе противоречил бы —
 * обещая точный возврат пространства имён и одновременно оставляя в нём
 * `sys`, `copy` и собственные переменные.
 *
 * `state` и `report` заводятся через `setdefault` в конце: исходник
 * исполняется перед КАЖДОЙ попыткой (так дешевле, чем сверять версии), и
 * обычное присваивание стирало бы состояние прошлого, ещё не закрытого входа —
 * то есть ровно то, ради чего состояние и держат.
 */
const IMPL = `
import collections
import copy
import json
import os
import sys
import time
import types

# Служебные имена IPython: они принадлежат ядру, а не студенту, и копия
# журнала ввода никому не нужна. \`_1\`, \`_i7\` — эхо ячеек, туда же.
_SERVICE = frozenset((
    'In', 'Out', '_', '__', '___', '_i', '_ii', '_iii',
    '_ih', '_oh', '_dh', 'exit', 'quit', 'get_ipython',
))

# Модуль, функция, класс, метод: у попытки нет способа их испортить так, чтобы
# это пережило выход, а копировать модуль numpy было бы и дорого, и бессмысленно.
_NOCOPY = (
    types.ModuleType, types.FunctionType, types.BuiltinFunctionType,
    types.MethodType, types.MethodWrapperType, type,
)

# Потолок обхода при ОЦЕНКЕ размера контейнера. Дерево из миллиона узлов
# дороже мерить, чем копировать: такое объявляем слишком большим и не трогаем.
_WALK_NODES = 200000
_MISS = object()


class _Report(object):
    """Отчёт серверу: его repr и есть готовый JSON.

    user_expressions возвращает mimebundle, а text/plain в нём — repr()
    значения. Отдавать строку нельзя: её repr приехал бы в кавычках и с
    экранированием, то есть JSON внутри JSON. Объект с нужным repr снимает
    вопрос целиком.
    """
    __slots__ = ('text',)

    def __init__(self, text):
        self.text = text

    def __repr__(self):
        return self.text


def _short(err, limit=200):
    try:
        text = type(err).__name__ + ': ' + str(err)
    except Exception:
        text = type(err).__name__
    return text[:limit]


def _service(name):
    if name.startswith('__') and name.endswith('__'):
        return True
    if name.startswith('_colloq'):
        return True
    if name in _SERVICE:
        return True
    if len(name) > 1 and name[0] == '_':
        rest = name[1:]
        if rest.isdigit():
            return True
        if rest[0] == 'i' and rest[1:].isdigit():
            return True
    return False


def _pandas():
    return sys.modules.get('pandas')


def _numpy():
    return sys.modules.get('numpy')


def _cow(pd):
    """Ленивая копия pandas безопасна только при Copy-on-Write.

    В pandas 3 он включён всегда и отключить его нечем; до того — ручка
    options.mode.copy_on_write. Без CoW copy(deep=False) отдаёт вид на те же
    данные: запись в копию доехала бы до исходника, то есть ровно та беда,
    ради которой всё это и заведено.
    """
    try:
        if int(str(pd.__version__).split('.')[0]) >= 3:
            return True
    except Exception:
        pass
    try:
        return bool(pd.options.mode.copy_on_write)
    except Exception:
        return False


def _frame_bytes(obj):
    try:
        used = obj.memory_usage(index=True, deep=False)
    except TypeError:
        # Index.memory_usage не знает index=True — у него нет своего индекса.
        try:
            used = obj.memory_usage(deep=False)
        except Exception:
            return 0
    except Exception:
        return 0
    try:
        return int(used.sum())
    except AttributeError:
        try:
            return int(used)
        except Exception:
            return 0
    except Exception:
        return 0


def _leaf_bytes(obj):
    """Вес тяжёлого листа: массив и таблица весят не тем, что скажет getsizeof."""
    np = _numpy()
    if np is not None and isinstance(obj, np.ndarray):
        try:
            return int(obj.nbytes)
        except Exception:
            return 0
    pd = _pandas()
    if pd is not None and isinstance(obj, (pd.DataFrame, pd.Series, pd.Index)):
        return _frame_bytes(obj)
    return 0


def _deep_bytes(root):
    """Вес дерева обходом; None — узлов больше потолка, мерить нечем."""
    seen = set()
    stack = [root]
    total = 0
    nodes = 0
    while stack:
        cur = stack.pop()
        key = id(cur)
        if key in seen:
            continue
        seen.add(key)
        nodes += 1
        if nodes > _WALK_NODES:
            return None
        leaf = _leaf_bytes(cur)
        if leaf:
            # DataFrame внутри словаря считается своим весом, а не весом
            # обёртки: deepcopy скопирует его целиком, даже под CoW.
            total += leaf
            continue
        try:
            total += sys.getsizeof(cur)
        except Exception:
            total += 64
        if isinstance(cur, dict):
            stack.extend(cur.keys())
            stack.extend(cur.values())
        elif isinstance(cur, (list, tuple, set, frozenset, collections.deque)):
            stack.extend(cur)
    return total


def _estimator_bytes(obj):
    """Оценщик sklearn весит своими массивами: один-два уровня по __dict__."""
    total = 0
    try:
        fields = vars(obj)
    except TypeError:
        return 0
    for value in fields.values():
        total += _leaf_bytes(value)
        if isinstance(value, (list, tuple)):
            for item in value:
                total += _leaf_bytes(item)
        elif isinstance(value, dict):
            for item in value.values():
                total += _leaf_bytes(item)
    return total


def _plan(obj):
    """Чем копировать и во сколько это встанет; None — не копируем вовсе.

    Список типов закрытый, и это нарочно. Тензор torch, открытый файл,
    генератор, соединение с базой копируются либо неправильно, либо
    катастрофически дорого, а попытка, которой такое подменили, падает не
    своей ошибкой. Что не скопировано — названо в отчёте.
    """
    np = _numpy()
    if np is not None and isinstance(obj, np.ndarray):
        try:
            return ('ndarray', int(obj.nbytes))
        except Exception:
            return ('ndarray', 0)
    pd = _pandas()
    if pd is not None and isinstance(obj, (pd.DataFrame, pd.Series, pd.Index)):
        if _cow(pd):
            return ('pandas-lazy', 0)
        return ('pandas-deep', _frame_bytes(obj))
    # Кортеж — тоже контейнер: сам он неизменяем, а список или таблица внутри
    # него — нет. deepcopy кортежа, в котором менять нечего, возвращает его же.
    if isinstance(obj, (list, dict, set, tuple, bytearray, collections.deque)):
        return ('deep', _deep_bytes(obj))
    base = sys.modules.get('sklearn.base')
    if base is not None:
        try:
            if isinstance(obj, base.BaseEstimator):
                return ('deep', _estimator_bytes(obj))
        except Exception:
            return None
    return None


def _make(kind, obj, memo):
    if kind == 'ndarray':
        return obj.copy()
    if kind == 'pandas-lazy':
        return obj.copy(deep=False)
    if kind == 'pandas-deep':
        return obj.copy(deep=True)
    return copy.deepcopy(obj, memo)


def leave(ns):
    """Вернуть пространство имён к тому, что было до попытки.

    Каждая неудача глотается отдельно: возврат cwd не должен отменяться тем,
    что кто-то удалил из ns имя прямо сейчас, а rcParams — тем, что не стало
    каталога. Половина возврата лучше, чем ничего.
    """
    global state
    current = state
    if not current:
        return
    saved = current.get('saved')
    if saved is not None:
        for key in saved:
            try:
                if key not in ns or ns[key] is not saved[key]:
                    ns[key] = saved[key]
            except Exception:
                pass
        for key in [k for k in list(ns) if k not in saved]:
            try:
                del ns[key]
            except Exception:
                pass
    cwd = current.get('cwd')
    if cwd:
        try:
            os.chdir(cwd)
        except Exception:
            pass
    rc = current.get('rc')
    if rc:
        try:
            mpl = sys.modules.get('matplotlib')
            if mpl is not None:
                mpl.rcParams.update(rc)
        except Exception:
            pass
    state = None


def enter(ns, budget):
    """Подменить привязки личными копиями и отчитаться серверу.

    Отчёт ставится ВСЕГДА, в том числе на своей ошибке: сервер читает его как
    единственное подтверждение, и молчание он обязан считать отказом —
    запускать попытку на общих объектах нельзя ни при какой неудаче.
    """
    global state, report
    started = time.time()
    report = None
    try:
        if state:
            # Прошлый выход не дошёл (ядро умерло, сервер перезапустился) —
            # сначала он, иначе saved этого входа запомнит чужие копии как
            # исходники, и настоящие данные пропадут навсегда.
            leave(ns)
        saved = dict(ns)
        rc = None
        mpl = sys.modules.get('matplotlib')
        if mpl is not None:
            try:
                # backend не возвращаем: он ленивый, и update() по нему
                # означал бы переключение бэкенда на ровном месте.
                rc = dict((k, v) for k, v in mpl.rcParams.items() if k != 'backend')
            except Exception:
                rc = None
        try:
            cwd = os.getcwd()
        except Exception:
            cwd = None
        # Состояние ставится ДО копирования: прерывание пределом посреди входа
        # не должно оставить попытке половину подмены без пути назад.
        state = {'saved': saved, 'cwd': cwd, 'rc': rc}

        copies = {}
        skipped = []
        failed = []
        # Один memo на весь вход: он и хранит решения по id объекта, и служит
        # памятью deepcopy. Два имени на один объект получают ОДНУ копию, и
        # a is b внутри попытки остаётся правдой; объект, оставленный общим,
        # записан сам в себя и потому не копируется внутри чужой копии.
        memo = {}
        used = 0
        for key in list(saved):
            obj = saved[key]
            if _service(key) or isinstance(obj, _NOCOPY):
                continue
            seen = memo.get(id(obj), _MISS)
            if seen is not _MISS:
                if seen is not obj:
                    copies[key] = seen
                continue
            try:
                plan = _plan(obj)
            except Exception as err:
                failed.append({'name': key[:80], 'error': _short(err)})
                memo[id(obj)] = obj
                continue
            if plan is None:
                memo[id(obj)] = obj
                continue
            kind, size = plan
            if size is None or used + size > budget:
                skipped.append({
                    'name': key[:80],
                    'bytes': ${SIZE_UNKNOWN} if size is None else int(size),
                })
                memo[id(obj)] = obj
                continue
            try:
                made = _make(kind, obj, memo)
            except Exception as err:
                # Одна неудачная копия — не отказ входа: объект остаётся общим
                # и назван в отчёте, остальные попытка получает своими.
                failed.append({'name': key[:80], 'error': _short(err)})
                memo[id(obj)] = obj
                continue
            used += int(size)
            memo[id(obj)] = made
            copies[key] = made

        # Подмена — одним проходом и только теперь, когда готовы ВСЕ копии:
        # попытка не должна увидеть половину своих данных и половину общих.
        for key in copies:
            ns[key] = copies[key]

        report = _Report(json.dumps({
            'ok': True,
            'copied': len(copies),
            'skipped': skipped,
            'failed': failed,
            'bytes': used,
            'ms': int((time.time() - started) * 1000),
        }, separators=(',', ':')))
    except Exception as err:
        report = _Report(json.dumps({
            'ok': False,
            'copied': 0,
            'skipped': [],
            'failed': [],
            'bytes': 0,
            'error': _short(err),
            'ms': int((time.time() - started) * 1000),
        }, separators=(',', ':')))


globals().setdefault('state', None)
globals().setdefault('report', None)
`

/**
 * Ячейка входа: два выражения, ни одного связанного имени.
 *
 * `exec` в `__dict__` скрытого модуля — единственный способ занести сюда сотню
 * строк Python, не оставив в пространстве студента ни `sys`, ни временных
 * переменных. `setdefault` делает установку идемпотентной, а повторный `exec`
 * переопределяет функции, не трогая `state` (см. хвост IMPL).
 */
export function councilEnterSource(budgetBytes: number = COUNCIL_DEFAULT_COPY_BYTES): string {
  const budget = Number.isFinite(budgetBytes) && budgetBytes >= 0
    ? Math.floor(budgetBytes)
    : COUNCIL_DEFAULT_COPY_BYTES
  const literal = JSON.stringify(IMPL)
  const module = JSON.stringify(COUNCIL_MODULE)
  return [
    `exec(compile(${literal}, '<colloq-council>', 'exec'), ` +
      `__import__('sys').modules.setdefault(${module}, ` +
      `__import__('types').ModuleType(${module})).__dict__)`,
    `__import__('sys').modules[${module}].enter(globals(), ${budget})`,
  ].join('\n')
}

/**
 * Ячейка выхода — и она обязана отработать даже там, где входа не было.
 *
 * Модуля может не быть вовсе (вход не доехал, ядро успели перезапустить), и
 * KeyError тогда — нормальный исход, а не беда попытки: возвращать нечего.
 */
export const COUNCIL_EXIT_SOURCE = [
  'try:',
  `    __import__('sys').modules[${JSON.stringify(COUNCIL_MODULE)}].leave(globals())`,
  'except Exception:',
  '    pass',
].join('\n')

function skipList(value: unknown): CouncilCopySkip[] {
  if (!Array.isArray(value)) return []
  const out: CouncilCopySkip[] = []
  for (const item of value) {
    const row = item as { name?: unknown; bytes?: unknown }
    if (typeof row?.name !== 'string') continue
    out.push({ name: row.name, bytes: typeof row.bytes === 'number' ? row.bytes : SIZE_UNKNOWN })
  }
  return out
}

function failList(value: unknown): CouncilCopyFailure[] {
  if (!Array.isArray(value)) return []
  const out: CouncilCopyFailure[] = []
  for (const item of value) {
    const row = item as { name?: unknown; error?: unknown }
    if (typeof row?.name !== 'string') continue
    out.push({ name: row.name, error: typeof row.error === 'string' ? row.error : '' })
  }
  return out
}

/**
 * Разобрать ответ ядра в отчёт входа; `null` — подтверждения не было.
 *
 * Принимает и то, что приезжает в `user_expressions` (`{status, data}` с
 * `text/plain` внутри), и голую строку JSON — второе ради теста, который
 * гоняет те же исходники настоящим python3 и читает отчёт со stdout.
 */
export function parseCouncilReport(raw: unknown): CouncilIsolationReport | null {
  let text: string | null = null
  if (typeof raw === 'string') text = raw
  else if (raw && typeof raw === 'object') {
    const wrapper = raw as { status?: unknown; data?: Record<string, unknown> }
    // status !== 'ok' — это `_user_obj_error()` IPython: выражение не
    // посчиталось, то есть модуля или отчёта в нём нет.
    if (wrapper.status !== undefined && wrapper.status !== 'ok') return null
    const plain = wrapper.data?.['text/plain']
    if (typeof plain === 'string') text = plain
  }
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const row = parsed as Record<string, unknown>
  if (typeof row.ok !== 'boolean') return null
  return {
    ok: row.ok,
    copied: typeof row.copied === 'number' ? row.copied : 0,
    skipped: skipList(row.skipped),
    failed: failList(row.failed),
    bytes: typeof row.bytes === 'number' ? row.bytes : 0,
    ms: typeof row.ms === 'number' ? row.ms : 0,
    error: typeof row.error === 'string' ? row.error : null,
  }
}

/** Байты словами: «1,2 ГБ». Число — по языку инстанса, как и всё остальное. */
export function sizeWords(bytes: number): string {
  const round = (value: number) =>
    formatNumber(value, { maximumFractionDigits: value < 10 ? 1 : 0 })
  if (bytes >= 1024 * 1024 * 1024) return tr('server.council.sizeGb', { p0: round(bytes / 1024 ** 3) })
  if (bytes >= 1024 * 1024) return tr('server.council.sizeMb', { p0: round(bytes / 1024 ** 2) })
  return tr('server.council.sizeKb', { p0: round(Math.max(1, bytes) / 1024) })
}

/**
 * Что сказать попытке про то, что осталось общим.
 *
 * Строки едут в начало её вывода, по одной на переменную и не больше трёх:
 * карточка попытки рисуется в стопке из сотен, и десять строк предупреждений
 * вытеснили бы оттуда сам ответ. Остальные — числом.
 *
 * Неудачные копии (`failed`) говорят ровно то же самое: для студента разницы
 * между «не влезло» и «не скопировалось» нет — данные общие, и правило одно.
 */
export function councilSkipNotes(report: CouncilIsolationReport): string[] {
  const shared: CouncilCopySkip[] = [
    ...report.skipped,
    ...report.failed.map((row) => ({ name: row.name, bytes: SIZE_UNKNOWN })),
  ]
  if (shared.length === 0) return []
  const lines = shared.slice(0, MAX_SKIP_NOTES).map(({ name, bytes }) =>
    bytes >= 0
      ? tr('server.council.copyTooBig', { p0: name, p1: sizeWords(bytes) })
      : tr('server.council.copyShared', { p0: name }),
  )
  if (shared.length > MAX_SKIP_NOTES) {
    lines.push(tr('server.council.copyMore', { count: shared.length - MAX_SKIP_NOTES }))
  }
  return lines.map((line) => `${line}\n`)
}

/** Почему вход не состоялся — одной строкой, без трейсбека, на языке комнаты. */
export function councilEnterRefusal(reason: string | null): string {
  return tr('server.council.copyFailed', {
    p0: reason && reason.trim().length > 0 ? reason.trim() : tr('server.council.copyNoAnswer'),
  })
}
