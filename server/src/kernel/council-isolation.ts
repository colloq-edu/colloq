import { createHash } from 'node:crypto'
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
 * Копиями дело не кончается. Тем же входом закрыто то, чем ОДНА попытка гасила
 * занятие целиком, — всё найдено вопросом «а если кто-то сделает так?»:
 *   · `exit()` и `quit()`: в ipykernel это `shell.ask_exit()`, то есть конец
 *     процесса. Воспроизведено на живом ядре — после такой попытки переменных
 *     нет ни у кого. Теперь отвечают отказом; `sys.exit()` ядро переживает и
 *     без нас, его не трогаем;
 *   · жадность: `np.ones((40000, 40000))` или неудачное декартово соединение
 *     звали OOM-killer, и он убивал ядро комнаты. Проверено контрольным
 *     опытом. Теперь попытке ставится потолок адресного пространства от
 *     предела контейнера, и то же самое кончается `MemoryError` у автора;
 *   · состояние процесса, которое молча меняет результаты следующим: поток
 *     случайных чисел, `sys.stdout`, `sys.path`, `os.environ`, `builtins`,
 *     фильтры предупреждений, опции печати numpy и pandas, `%pdb`, хуки
 *     IPython, фигуры matplotlib, дочерние процессы. Снимок до, возврат после.
 *
 * Чего здесь НЕТ и не будет, пока не решат иначе: файлы на диске (chmod на
 * время попытки ломает редактор файлов и терминал, перехват `open` ломает
 * обычное «каждый пишет out.csv»), защита от умысла (`os._exit`, снос этого
 * модуля из `sys.modules`) и модули, которые попытка импортировала.
 * Консилиум — приём преподавания, а не экзаменационная песочница.
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

/**
 * Отчёт ВЫХОДА — и он, в отличие от входного, необязателен.
 *
 * Выход не решает, запускать ли попытку; он только рассказывает про хвосты,
 * которые вернуть было нечем (оставленные потоки, убитые процессы). Молчание
 * здесь — не беда попытки, а всего лишь отсутствие приписки в её выводе.
 */
export const COUNCIL_LEFTOVERS_EXPR = `__import__('sys').modules['${COUNCIL_MODULE}'].leftovers`

/** Имя исключения, которым изоляция отказывает попытке её же словами. */
export const COUNCIL_REFUSED = 'ColloqRefused'

/** Сколько байт личных копий разрешено одной попытке, если не сказано иначе. */
export const COUNCIL_DEFAULT_COPY_BYTES = 512 * 1024 * 1024

/** Меньше этого потолок памяти не опускается: под ним не работает и импорт. */
export const COUNCIL_MEMORY_FLOOR_BYTES = 512 * 1024 * 1024

/** Запас, который остаётся ядру комнаты сверх того, что отдано попытке. */
export const COUNCIL_MEMORY_HEADROOM_BYTES = 256 * 1024 * 1024

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
  /** Потолок памяти на попытку, байтами; `null` — потолка нет. */
  memory: number | null
  ms: number
  /** Заполнено, только когда `ok` ложно. */
  error: string | null
}

/** Что после попытки вернуть было нечем. */
export interface CouncilLeftovers {
  /** Потоки, которые попытка оставила работать: остановить их нечем. */
  threads: number
  /** Дочерние процессы, которые пришлось убить за неё. */
  processes: number
}

/** Тексты и ручки, которые вход получает от сервера, а не носит в себе. */
export interface CouncilIsolationSettings {
  budgetBytes?: number
  /** Ставить ли потолок адресного пространства на время попытки. */
  memoryGuard?: boolean
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
import builtins
import collections
import copy
import json
import os
import sys
import time
import types


# Снимок самих встроенных, снятый ПРИ УСТАНОВКЕ, когда они ещё целы.
#
# Попытка вправе написать \`builtins.list = "сломал"\` — и возврат, который как
# раз это и чинит, падал бы на первой своей строке: \`list(ns)\` больше не
# вызывается. Проверено, именно так и падало. Поэтому всё, чем пользуется
# ВОЗВРАТ, берётся отсюда, а не из builtins, которые к тому моменту чужие.
_list = list
_vars = vars
_getattr = getattr
_setattr = setattr
_delattr = delattr
_id = id


class ColloqRefused(Exception):
    """Попытка попросила то, что у комнаты одно на всех.

    Имя видно студенту на карточке, поэтому оно короткое и своё: сервер узнаёт
    по нему свой же отказ и печатает одну человеческую строку без трейсбека
    (kernel/index.ts · runCouncilOne), как и с остановкой по пределу.
    """

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


def _torch():
    # Только уже импортированный: свой import здесь стоил бы секунды на первой
    # же попытке в комнате, где torch никому не нужен.
    return sys.modules.get('torch')


def _sparse():
    return sys.modules.get('scipy.sparse')


def _shell():
    """Оболочка IPython, если мы в ядре; в голом python её нет, и это нормально."""
    mod = sys.modules.get('IPython')
    if mod is None:
        return None
    try:
        return mod.get_ipython()
    except Exception:
        return None


def _threading():
    return sys.modules.get('threading')


def _main_thread():
    thr = _threading()
    # threading не импортирован — значит поток ровно один, и он главный.
    # Раньше здесь стояло False, и обработчик SIGINT не возвращался никогда в
    # самом обычном случае: в комнате, где никто не звал threading.
    if thr is None:
        return True
    try:
        return thr.current_thread() is thr.main_thread()
    except Exception:
        return False


def _own(obj):
    """Экземпляр класса, объявленного в самой тетради.

    \`class Dataset: ...\` в общей ячейке — это код преподавателя, и объект
    такого класса ведёт себя как данные: попытка его меняет, а следующая
    получает испорченный. Чужие классы (библиотечные) сюда не попадают
    нарочно: соединение с базой, окно matplotlib, сессия requests копируются
    либо неправильно, либо катастрофически дорого.
    """
    try:
        return getattr(type(obj), '__module__', None) == '__main__'
    except Exception:
        return False


def _fields(obj):
    """Поля экземпляра: __dict__ и __slots__ по всей цепочке классов."""
    out = []
    try:
        own = getattr(obj, '__dict__', None)
        if isinstance(own, dict):
            out.extend(own.values())
    except Exception:
        pass
    try:
        chain = type(obj).__mro__
    except Exception:
        return out
    for cls in chain:
        slots = getattr(cls, '__slots__', None)
        if not slots or cls is object:
            continue
        if isinstance(slots, str):
            slots = (slots,)
        for name in slots:
            try:
                out.append(getattr(obj, name))
            except Exception:
                pass
    return out


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


def _tensor_bytes(obj):
    """Вес тензора — элементы, а не обёртка; у разреженного считаем по nnz."""
    try:
        item = int(obj.element_size())
    except Exception:
        return 0
    try:
        if getattr(obj, 'is_sparse', False):
            # nelement() у разреженного — это ПЛОТНЫЙ размер (бывает 1e12), и
            # по нему любая матрица смежности ушла бы в «слишком большая».
            return int(obj._nnz()) * item * (1 + int(obj.dim()))
    except Exception:
        return 0
    try:
        return int(obj.nelement()) * item
    except Exception:
        return 0


def _module_bytes(obj):
    """Модель весит своими параметрами и буферами — остальное в ней мелочь."""
    total = 0
    try:
        for part in obj.parameters(recurse=True):
            total += _tensor_bytes(part)
        for part in obj.buffers(recurse=True):
            total += _tensor_bytes(part)
    except Exception:
        return 0
    return total


def _optimizer_bytes(obj, memo):
    """Оптимизатор весит своим состоянием: моменты Adam — это вторые веса.

    Сами параметры сюда не идут: они лежат ключами \`state\` и принадлежат
    модели, которую посчитали (или посчитают) отдельно. Всё, что уже решено в
    этом входе, узнаётся по memo и не считается дважды.
    """
    total = 0
    try:
        slots = obj.state.values()
    except Exception:
        return 0
    try:
        for slot in slots:
            if not isinstance(slot, dict):
                continue
            for value in slot.values():
                if id(value) in memo:
                    continue
                total += _tensor_bytes(value)
    except Exception:
        return 0
    return total


def _sparse_bytes(obj):
    """Разреженная матрица весит своими массивами — какие из них у неё есть."""
    total = 0
    for name in ('data', 'indices', 'indptr', 'row', 'col', 'offsets', 'coords'):
        part = getattr(obj, name, None)
        if part is None:
            continue
        items = part if isinstance(part, (tuple, list)) else (part,)
        for item in items:
            try:
                total += int(item.nbytes)
            except Exception:
                pass
    return total


def _leaf_bytes(obj):
    """Вес тяжёлого листа: массив, таблица и тензор весят не тем, что getsizeof.

    Без этого список из десяти CUDA-тензоров по гигабайту стоил бы по
    \`getsizeof\` восемьдесят байт и проходил мимо бюджета целиком.
    """
    np = _numpy()
    if np is not None and isinstance(obj, np.ndarray):
        try:
            return int(obj.nbytes)
        except Exception:
            return 0
    pd = _pandas()
    if pd is not None and isinstance(obj, (pd.DataFrame, pd.Series, pd.Index)):
        return _frame_bytes(obj)
    torch = _torch()
    if torch is not None:
        try:
            if isinstance(obj, torch.Tensor):
                return _tensor_bytes(obj)
            if isinstance(obj, torch.nn.Module):
                return _module_bytes(obj)
        except Exception:
            return 0
    sparse = _sparse()
    if sparse is not None:
        try:
            if sparse.issparse(obj):
                return _sparse_bytes(obj)
        except Exception:
            return 0
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
        elif _own(cur):
            # Объект класса из тетради — такой же контейнер: deepcopy заберёт
            # его поля целиком, значит и мерить надо их. В чужие объекты не
            # спускаемся: там окна, сокеты и половина библиотеки.
            stack.extend(_fields(cur))
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


def _plan(obj, memo):
    """Чем копировать и во сколько это встанет; None — не копируем вовсе.

    Список типов закрытый, и это нарочно: открытый файл, генератор, сокет,
    соединение с базой копируются либо неправильно, либо катастрофически
    дорого, а попытка, которой такое подменили, падает не своей ошибкой. Что
    не скопировано — названо в отчёте и в выводе попытки.

    Порядок проверок — от дешёвого к дорогому, и это не вкусовщина: \`_plan\`
    зовётся на каждое имя каждой попытки. Сначала два isinstance по уже
    импортированным numpy и pandas, потом встроенные контейнеры (чистый
    isinstance без единого обращения к sys.modules), и только потом торчащие
    наружу библиотеки — каждая за одним словарным поиском в sys.modules,
    который на комнате без torch стоит ноль.
    """
    np = _numpy()
    if np is not None:
        if isinstance(obj, np.ndarray):
            try:
                return ('ndarray', int(obj.nbytes))
            except Exception:
                return ('ndarray', 0)
        try:
            # Генератор случайных чисел в переменной — это состояние, и общее
            # оно тоже: \`rng.random()\` у одного сдвигает поток у следующего,
            # и одинаковые попытки дают разные числа. Весит он байты.
            if isinstance(obj, (np.random.Generator, np.random.RandomState)):
                return ('deep', 0)
        except Exception:
            pass
    rnd = sys.modules.get('random')
    if rnd is not None:
        try:
            if isinstance(obj, rnd.Random):
                return ('deep', 0)
        except Exception:
            pass
    pd = _pandas()
    if pd is not None and isinstance(obj, (pd.DataFrame, pd.Series, pd.Index)):
        if _cow(pd):
            return ('pandas-lazy', 0)
        return ('pandas-deep', _frame_bytes(obj))
    # Кортеж — тоже контейнер: сам он неизменяем, а список или таблица внутри
    # него — нет. deepcopy кортежа, в котором менять нечего, возвращает его же.
    if isinstance(obj, (list, dict, set, tuple, bytearray, collections.deque)):
        return ('deep', _deep_bytes(obj))
    torch = _torch()
    if torch is not None:
        try:
            # Раньше \`_own\`: \`class Net(nn.Module)\` в тетради — это и то и
            # другое, а вес модели честнее считать по параметрам, чем обходом
            # её полей.
            if isinstance(obj, torch.nn.Module):
                return ('deep', _module_bytes(obj))
            if isinstance(obj, torch.Tensor):
                # Параметр модели — тот же тензор, той же дорогой. deepcopy
                # бережёт requires_grad, устройство и то, лист ли это; на
                # не-листовом тензоре с историей градиента он бросит, и объект
                # уйдёт в failed — общим, но названным.
                return ('deep', _tensor_bytes(obj))
            if isinstance(obj, torch.optim.Optimizer):
                # Общий memo — единственное, что связывает оптимизатор с его
                # моделью: параметры в обоих одни и те же объекты, и копия
                # должна быть одна на двоих, в каком бы порядке имена ни шли.
                return ('deep', _optimizer_bytes(obj, memo))
        except Exception:
            return None
    sparse = _sparse()
    if sparse is not None:
        try:
            if sparse.issparse(obj):
                return ('sparse', _sparse_bytes(obj))
        except Exception:
            return None
    base = sys.modules.get('sklearn.base')
    if base is not None:
        try:
            if isinstance(obj, base.BaseEstimator):
                return ('deep', _estimator_bytes(obj))
        except Exception:
            return None
    if _own(obj):
        return ('deep', _deep_bytes(obj))
    return None


def _make(kind, obj, memo):
    if kind == 'ndarray':
        return obj.copy()
    if kind == 'pandas-lazy':
        return obj.copy(deep=False)
    if kind == 'pandas-deep':
        return obj.copy(deep=True)
    if kind == 'sparse':
        # Свой copy() у scipy дешевле deepcopy и знает про формат.
        return obj.copy()
    return copy.deepcopy(obj, memo)


def _guard_exit(ns, text):
    """\`exit()\` в попытке гасит ядро ВСЕЙ комнате — и это не выдумка.

    В ipykernel \`exit\` и \`quit\` — один объект ZMQExitAutocall, его вызов
    (и даже голое имя \`exit\` на строке: IPython сам дописывает скобки) идёт
    в \`shell.ask_exit()\`, а тот ставит \`exit_now\`, и процесс заканчивается.
    Проверено на настоящем ядре: \`data\` после этого нет ни у кого.
    \`sys.exit()\` ведёт себя иначе и ядро переживает — его не трогаем.

    Подменяется именно \`ask_exit\`, а не имена \`exit\`/\`quit\` в
    пространстве попытки, и это существенно: голое \`exit\` на строке IPython
    превращает в вызов только потому, что там лежит ЕГО объект-автовызов
    (IPyAutocall). Подменив имя обычной функцией, мы бы закрыли \`exit()\` со
    скобками и открыли \`exit\` без них — проверено на живом ядре, именно так
    и вышло. Оригинал остаётся на месте, а его \`__call__\` упирается в наш
    отказ. Имена подменяются только там, где оболочки нет вовсе.
    """
    def refuse(*args, **kwargs):
        raise ColloqRefused(text)

    saved = {'refuse': refuse}
    shell = _shell()
    if shell is not None:
        try:
            saved['shell'] = shell
            saved['own'] = 'ask_exit' in vars(shell)
            saved['ask'] = shell.ask_exit
            shell.ask_exit = refuse
        except Exception:
            saved.pop('shell', None)
    if 'shell' not in saved:
        for name in ('exit', 'quit'):
            try:
                saved.setdefault('names', {})[name] = (name in ns, ns.get(name))
                ns[name] = refuse
            except Exception:
                pass
    return saved


def _unguard_exit(current, ns):
    saved = current.get('exit') if current else None
    if not saved:
        return
    shell = saved.get('shell')
    if shell is not None:
        try:
            if saved.get('own'):
                shell.ask_exit = saved['ask']
            else:
                # Метод класса вернётся сам, как только уйдёт наша подмена.
                del shell.ask_exit
        except Exception:
            try:
                shell.ask_exit = saved['ask']
            except Exception:
                pass
    # Сами имена вернёт общий возврат привязок; здесь только на случай, когда
    # их в saved не было вовсе (голый python без IPython).
    for name, was in (saved.get('names') or {}).items():
        try:
            if ns.get(name) is not saved['refuse']:
                continue
            if was[0]:
                ns[name] = was[1]
            else:
                del ns[name]
        except Exception:
            pass


def _read_int(path):
    try:
        with open(path) as handle:
            raw = handle.read().strip()
    except Exception:
        return None
    if raw == 'max':
        return None
    try:
        value = int(raw)
    except Exception:
        return None
    # cgroup v1 пишет «нет предела» как 2**63-1 — это не предел, а его отсутствие.
    if value <= 0 or value > (1 << 60):
        return None
    return value


def _cgroup(*names):
    for name in names:
        value = _read_int('/sys/fs/cgroup/' + name)
        if value is not None:
            return value
    return None


def _reclaimable():
    """Файловый кэш, который cgroup считает занятым, а отдаст по первому требованию.

    memory.current включает страницы прочитанных файлов: после read_csv на
    гигабайт «занято» на гигабайт больше, хотя OOM-killer за этими страницами
    не придёт — ядро Linux просто выбросит их. Считать их занятыми значило бы
    отказывать попытке в памяти, которая на самом деле свободна. Так же считает
    docker stats: usage минус inactive_file.
    """
    for path, key in (
        ('/sys/fs/cgroup/memory.stat', 'inactive_file '),
        ('/sys/fs/cgroup/memory/memory.stat', 'total_inactive_file '),
    ):
        try:
            with open(path) as handle:
                for line in handle:
                    if line.startswith(key):
                        return int(line.split()[1])
        except Exception:
            continue
    return 0


def _vmsize():
    """Адресное пространство процесса прямо сейчас, байтами."""
    try:
        with open('/proc/self/status') as handle:
            for line in handle:
                if line.startswith('VmSize:'):
                    return int(line.split()[1]) * 1024
    except Exception:
        return None
    return None


def _gpu_near():
    """Есть ли рядом CUDA — при ней потолок адресного пространства ставить нельзя.

    Драйвер резервирует десятки терабайт ВИРТУАЛЬНОГО адресного пространства
    (это не занятая память), и RLIMIT_AS ломает инициализацию наглухо. Лучше
    без потолка, чем комната, где не работает torch.
    """
    torch = _torch()
    if torch is not None:
        try:
            if torch.cuda.is_initialized() or torch.cuda.is_available():
                return True
        except Exception:
            return True
    if os.environ.get('NVIDIA_VISIBLE_DEVICES', '').strip() not in ('', 'void', 'none'):
        return True
    for node in ('/dev/nvidiactl', '/dev/nvidia0'):
        try:
            if os.path.exists(node):
                return True
        except Exception:
            pass
    return False


def _memory_cap(floor, headroom):
    """Сколько адресного пространства отдать попытке; None — потолка не будет.

    Считаем от предела контейнера, а не от машины: ядро комнаты живёт в cgroup,
    и убивает его именно её OOM-killer. Из предела вычитается то, что уже
    занято (данными преподавателя в том числе) и запас на само ядро; меньше
    пола не опускаемся — потолок, под которым не работает даже импорт, хуже,
    чем никакого.
    """
    if not sys.platform.startswith('linux'):
        return None
    if _gpu_near():
        return None
    limit = _cgroup('memory.max', 'memory/memory.limit_in_bytes')
    if limit is None:
        return None
    used = _cgroup('memory.current', 'memory/memory.usage_in_bytes')
    if used is None:
        return None
    room = limit - max(used - _reclaimable(), 0) - headroom
    if room < floor:
        room = floor
    return room


def _arm_memory(floor, headroom):
    """Поставить потолок и вернуть, что было (для выхода) и сколько дали."""
    res = sys.modules.get('resource')
    if res is None:
        try:
            import resource as res
        except Exception:
            return None
    room = _memory_cap(floor, headroom)
    if room is None:
        return None
    base = _vmsize()
    if base is None:
        return None
    try:
        soft, hard = res.getrlimit(res.RLIMIT_AS)
    except Exception:
        return None
    wanted = base + room
    if hard != res.RLIM_INFINITY and wanted > hard:
        wanted = hard
    if soft != res.RLIM_INFINITY and wanted >= soft:
        # Кто-то уже поставил потолок ниже нашего — он главнее, не трогаем.
        return None
    try:
        res.setrlimit(res.RLIMIT_AS, (wanted, hard))
    except Exception:
        return None
    return {'soft': soft, 'hard': hard, 'room': room}


def _disarm_memory(saved):
    if not saved:
        return
    res = sys.modules.get('resource')
    if res is None:
        return
    try:
        res.setrlimit(res.RLIMIT_AS, (saved['soft'], saved['hard']))
    except Exception:
        pass


def _snapshot():
    """Состояние ПРОЦЕССА, которое попытка может сдвинуть на всю комнату.

    Не имена — их держит saved, — а всё вокруг: поток случайных чисел, потоки
    вывода, sys.path, окружение, настройки печати numpy и pandas, обработчик
    прерывания, открытые фигуры matplotlib. Каждая строка здесь — «кто-то
    сделает так, и следующие двадцать попыток посчитаются иначе».

    Ничего не импортируем: то, чего в ядре нет, попытка сдвинуть и не может.
    """
    snap = {}
    rnd = sys.modules.get('random')
    if rnd is not None:
        try:
            snap['random'] = rnd.getstate()
        except Exception:
            pass
    np = _numpy()
    if np is not None:
        try:
            snap['np_random'] = np.random.get_state()
        except Exception:
            pass
        try:
            snap['np_print'] = np.get_printoptions()
        except Exception:
            pass
        try:
            snap['np_err'] = np.geterr()
        except Exception:
            pass
    torch = _torch()
    if torch is not None:
        try:
            snap['torch_rng'] = torch.get_rng_state()
        except Exception:
            pass
        try:
            if torch.cuda.is_initialized():
                snap['torch_cuda_rng'] = torch.cuda.get_rng_state_all()
        except Exception:
            pass
        try:
            snap['torch_grad'] = torch.is_grad_enabled()
        except Exception:
            pass
        try:
            snap['torch_dtype'] = torch.get_default_dtype()
        except Exception:
            pass
    try:
        snap['streams'] = (sys.stdout, sys.stderr, sys.stdin,
                           sys.displayhook, sys.excepthook)
    except Exception:
        pass
    try:
        snap['path'] = list(sys.path)
    except Exception:
        pass
    try:
        snap['reclimit'] = sys.getrecursionlimit()
    except Exception:
        pass
    try:
        snap['trace'] = (sys.gettrace(), sys.getprofile())
    except Exception:
        pass
    thr_hooks = _threading()
    if thr_hooks is not None:
        try:
            # Те же крючки, но для потоков, которые заведут ПОСЛЕ попытки:
            # оставленный профилировщик замедлял бы всю комнату молча.
            snap['thread_trace'] = (thr_hooks.gettrace(), thr_hooks.getprofile())
        except Exception:
            pass
    try:
        snap['environ'] = dict(os.environ)
    except Exception:
        pass
    warn = sys.modules.get('warnings')
    if warn is not None:
        try:
            snap['warnfilters'] = warn.filters[:]
        except Exception:
            pass
    try:
        snap['builtins'] = dict(vars(builtins))
    except Exception:
        pass
    sig = sys.modules.get('signal')
    if sig is not None and _main_thread():
        try:
            snap['sigint'] = sig.getsignal(sig.SIGINT)
        except Exception:
            pass
    dec = sys.modules.get('decimal')
    if dec is not None:
        try:
            snap['decimal'] = dec.getcontext().copy()
        except Exception:
            pass
    pd = _pandas()
    if pd is not None:
        try:
            # Приватный API pandas, и потому строго в try: сломается — просто
            # не вернём опции, а не уроним вход.
            snap['pd_options'] = copy.deepcopy(pd._config.config._global_config)
        except Exception:
            pass
    sk = sys.modules.get('sklearn')
    if sk is not None:
        try:
            snap['sklearn'] = sk.get_config()
        except Exception:
            pass
    shell = _shell()
    if shell is not None:
        try:
            # %pdb on — и ядро садится в отладчик на ЧУЖОМ исключении,
            # занимая очередь всей комнаты до перезапуска.
            snap['call_pdb'] = shell.call_pdb
        except Exception:
            pass
        try:
            snap['events'] = dict(
                (key, list(value)) for key, value in shell.events.callbacks.items())
        except Exception:
            pass
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is not None:
        try:
            snap['fignums'] = set(plt.get_fignums())
        except Exception:
            pass
    # Пустое множество, а не отсутствие ключа: попытка может САМА первой
    # позвать threading или multiprocessing, и тогда её же потоки оказались бы
    # незаметны — ровно тот случай, ради которого этот счёт и заведён.
    snap['children'] = set()
    snap['threads'] = set()
    mp = sys.modules.get('multiprocessing')
    if mp is not None:
        try:
            snap['children'] = set(id(child) for child in mp.active_children())
        except Exception:
            pass
    thr = _threading()
    if thr is not None:
        try:
            snap['threads'] = set(id(item) for item in thr.enumerate())
        except Exception:
            pass
    return snap


def _restore(snap):
    """Вернуть состояние процесса. Каждая строка глотает свою беду отдельно.

    Возвращает счёт того, что вернуть НЕЛЬЗЯ: потоки, которые попытка оставила
    работать. Их сервер называет преподавателю в выводе попытки — остановить
    чужой поток нечем, а молчать о нём хуже.
    """
    left = {'threads': 0, 'processes': 0}
    if not snap:
        return left
    rnd = sys.modules.get('random')
    if rnd is not None and 'random' in snap:
        try:
            rnd.setstate(snap['random'])
        except Exception:
            pass
    np = _numpy()
    if np is not None:
        if 'np_random' in snap:
            try:
                np.random.set_state(snap['np_random'])
            except Exception:
                pass
        if 'np_print' in snap:
            try:
                np.set_printoptions(**snap['np_print'])
            except Exception:
                pass
        if 'np_err' in snap:
            try:
                np.seterr(**snap['np_err'])
            except Exception:
                pass
    torch = _torch()
    if torch is not None:
        if 'torch_rng' in snap:
            try:
                torch.set_rng_state(snap['torch_rng'])
            except Exception:
                pass
        if 'torch_cuda_rng' in snap:
            try:
                torch.cuda.set_rng_state_all(snap['torch_cuda_rng'])
            except Exception:
                pass
        if 'torch_grad' in snap:
            try:
                torch.set_grad_enabled(snap['torch_grad'])
            except Exception:
                pass
        if 'torch_dtype' in snap:
            try:
                torch.set_default_dtype(snap['torch_dtype'])
            except Exception:
                pass
    if 'streams' in snap:
        try:
            out, err, inp, display, excepthook = snap['streams']
            sys.stdout, sys.stderr, sys.stdin = out, err, inp
            sys.displayhook, sys.excepthook = display, excepthook
        except Exception:
            pass
    if 'path' in snap:
        try:
            sys.path[:] = snap['path']
        except Exception:
            pass
    if 'reclimit' in snap:
        try:
            sys.setrecursionlimit(snap['reclimit'])
        except Exception:
            pass
    if 'trace' in snap:
        try:
            sys.settrace(snap['trace'][0])
            sys.setprofile(snap['trace'][1])
        except Exception:
            pass
    if 'thread_trace' in snap:
        try:
            hooks = _threading()
            hooks.settrace(snap['thread_trace'][0])
            hooks.setprofile(snap['thread_trace'][1])
        except Exception:
            pass
    if 'environ' in snap:
        try:
            was = snap['environ']
            for key in [k for k in _list(os.environ) if k not in was]:
                try:
                    del os.environ[key]
                except Exception:
                    pass
            for key in was:
                try:
                    if os.environ.get(key) != was[key]:
                        os.environ[key] = was[key]
                except Exception:
                    pass
        except Exception:
            pass
    warn = sys.modules.get('warnings')
    if warn is not None and 'warnfilters' in snap:
        try:
            warn.filters[:] = snap['warnfilters']
        except Exception:
            pass
    if 'builtins' in snap:
        try:
            was = snap['builtins']
            for key in [k for k in _list(_vars(builtins)) if k not in was]:
                try:
                    _delattr(builtins, key)
                except Exception:
                    pass
            for key in was:
                try:
                    if _getattr(builtins, key, _MISS) is not was[key]:
                        _setattr(builtins, key, was[key])
                except Exception:
                    pass
        except Exception:
            pass
    sig = sys.modules.get('signal')
    if sig is not None and 'sigint' in snap and _main_thread():
        try:
            sig.signal(sig.SIGINT, snap['sigint'])
        except Exception:
            pass
    dec = sys.modules.get('decimal')
    if dec is not None and 'decimal' in snap:
        try:
            dec.setcontext(snap['decimal'])
        except Exception:
            pass
    pd = _pandas()
    if pd is not None and 'pd_options' in snap:
        try:
            live = pd._config.config._global_config
            live.clear()
            live.update(snap['pd_options'])
        except Exception:
            pass
    sk = sys.modules.get('sklearn')
    if sk is not None and 'sklearn' in snap:
        try:
            sk.set_config(**snap['sklearn'])
        except Exception:
            pass
    shell = _shell()
    if shell is not None:
        if 'call_pdb' in snap:
            try:
                shell.call_pdb = snap['call_pdb']
            except Exception:
                pass
        if 'events' in snap:
            try:
                live = shell.events.callbacks
                for key in live:
                    # На месте, а не подменой списка: на эти же списки смотрят
                    # и сам IPython, и всё, что подписалось до попытки.
                    live[key][:] = snap['events'].get(key, [])
            except Exception:
                pass
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is not None and 'fignums' in snap:
        try:
            for num in _list(plt.get_fignums()):
                if num not in snap['fignums']:
                    try:
                        plt.close(num)
                    except Exception:
                        pass
        except Exception:
            pass
    mp = sys.modules.get('multiprocessing')
    if mp is not None and 'children' in snap:
        try:
            for child in mp.active_children():
                if _id(child) in snap['children']:
                    continue
                left['processes'] += 1
                try:
                    child.terminate()
                except Exception:
                    pass
        except Exception:
            pass
    thr = _threading()
    if thr is not None and 'threads' in snap:
        try:
            # Свой поток и главный — не хвост попытки, даже если снимок пуст
            # (его снимали до того, как в ядре вообще появился threading).
            skip = set()
            try:
                skip.add(_id(thr.current_thread()))
                skip.add(_id(thr.main_thread()))
            except Exception:
                pass
            for item in thr.enumerate():
                if _id(item) in snap['threads'] or _id(item) in skip:
                    continue
                if item.is_alive():
                    left['threads'] += 1
        except Exception:
            pass
    return left


def leave(ns):
    """Вернуть пространство имён к тому, что было до попытки.

    Каждая неудача глотается отдельно: возврат cwd не должен отменяться тем,
    что кто-то удалил из ns имя прямо сейчас, а rcParams — тем, что не стало
    каталога. Половина возврата лучше, чем ничего.
    """
    global state, leftovers
    current = state
    if not current:
        return
    # Потолок памяти снимается ПЕРВЫМ: под ним не должен идти ни один возврат,
    # иначе чужой np.set_printoptions отменится из-за нехватки адресов.
    _disarm_memory(current.get('memory'))
    _unguard_exit(current, ns)
    saved = current.get('saved')
    if saved is not None:
        for key in saved:
            try:
                if key not in ns or ns[key] is not saved[key]:
                    ns[key] = saved[key]
            except Exception:
                pass
        for key in [k for k in _list(ns) if k not in saved]:
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
    try:
        left = _restore(current.get('process'))
    except Exception:
        left = {'threads': 0, 'processes': 0}
    state = None
    # Отчёт выхода необязателен: сервер читает его, если он доехал, и молчание
    # здесь не беда попытки — в отличие от молчания входа.
    try:
        leftovers = _Report(json.dumps(left, separators=(',', ':')))
    except Exception:
        leftovers = None


def enter(ns, budget, settings=None):
    """Подменить привязки личными копиями и отчитаться серверу.

    Отчёт ставится ВСЕГДА, в том числе на своей ошибке: сервер читает его как
    единственное подтверждение, и молчание он обязан считать отказом —
    запускать попытку на общих объектах нельзя ни при какой неудаче.

    \`settings\` приезжает от сервера, а не зашито сюда: там и тексты на языке
    комнаты, и выключатель потолка памяти. Язык меняют в панели посреди пары —
    собирать исходник с ним внутри значило бы держать в ядре вчерашний.
    """
    global state, report, leftovers
    started = time.time()
    report = None
    leftovers = None
    settings = settings or {}
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
        state = {'saved': saved, 'cwd': cwd, 'rc': rc, 'process': _snapshot(),
                 'exit': _guard_exit(ns, settings.get('exit') or 'exit() is not allowed here'),
                 'memory': None}

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
                plan = _plan(obj, memo)
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

        cap = None
        if settings.get('memory'):
            # Потолок ставится ПОСЛЕ копий и по свежему замеру: жадная попытка
            # (np.ones((40000, 40000)), декартово соединение) иначе зовёт
            # OOM-killer, а тот убивает ядро комнаты — вместе с разбором
            # преподавателя и работой всех, кто уже сдал. Под потолком то же
            # самое кончается MemoryError в одной попытке.
            armed = _arm_memory(int(settings.get('floor') or 0),
                                int(settings.get('headroom') or 0))
            if armed:
                state['memory'] = armed
                cap = armed['room']

        report = _Report(json.dumps({
            'ok': True,
            'copied': len(copies),
            'skipped': skipped,
            'failed': failed,
            'bytes': used,
            'memory': cap,
            'ms': int((time.time() - started) * 1000),
        }, separators=(',', ':')))
    except Exception as err:
        report = _Report(json.dumps({
            'ok': False,
            'copied': 0,
            'skipped': [],
            'failed': [],
            'bytes': 0,
            'memory': None,
            'error': _short(err),
            'ms': int((time.time() - started) * 1000),
        }, separators=(',', ':')))


globals().setdefault('state', None)
globals().setdefault('report', None)
globals().setdefault('leftovers', None)
# Последней строкой, и это важно: по ней вход узнаёт, что установка ДОШЛА до
# конца. Прерванный на середине exec оставил бы модуль без version, и
# следующая попытка переустановила бы его целиком, а не понадеялась на половину.
version = '__VERSION__'
`

/** Версия установки — короткий хеш самого исходника, считается один раз. */
let version: string | null = null
function implVersion(): string {
  return (version ??= createHash('sha1').update(IMPL).digest('hex').slice(0, 12))
}
/**
 * Исходник с проставленной версией, уже экранированный в литерал Python.
 *
 * Считается один раз на процесс: вход собирается на каждую попытку (в нём
 * тексты на языке комнаты), а экранировать двадцать килобайт по десять раз в
 * секунду на потоке в пятьсот человек незачем.
 */
let literal: string | null = null
function implLiteral(): string {
  return (literal ??= JSON.stringify(IMPL.replace('__VERSION__', implVersion())))
}

/**
 * Ячейка входа: два выражения, ни одного связанного имени.
 *
 * `exec` в `__dict__` скрытого модуля — единственный способ занести сюда сотню
 * строк Python, не оставив в пространстве студента ни `sys`, ни временных
 * переменных. `setdefault` делает установку идемпотентной, а повторный `exec`
 * переопределяет функции, не трогая `state` (см. хвост IMPL).
 */
export function councilEnterSource(
  budgetBytes: number = COUNCIL_DEFAULT_COPY_BYTES,
  options: CouncilIsolationSettings = {},
): string {
  const budget = Number.isFinite(budgetBytes) && budgetBytes >= 0
    ? Math.floor(budgetBytes)
    : COUNCIL_DEFAULT_COPY_BYTES
  const source = implLiteral()
  const module = JSON.stringify(COUNCIL_MODULE)
  /*
   * Настройки — литералом в самом вызове, а не внутри исходника.
   *
   * Текст отказа зависит от языка комнаты, а его меняют в панели посреди пары:
   * запёкши его в исходник, мы бы держали в живом ядре вчерашний перевод (или
   * переустанавливали модуль на каждой смене языка). Строки через
   * `JSON.stringify` (их экранирование в Python то же), булево — словом
   * Python: `false` в ядре — это NameError, а не значение.
   */
  const settings = [
    `{'exit': ${JSON.stringify(tr('server.council.noExit'))}`,
    `'memory': ${options.memoryGuard === true ? 'True' : 'False'}`,
    `'floor': ${COUNCIL_MEMORY_FLOOR_BYTES}`,
    `'headroom': ${COUNCIL_MEMORY_HEADROOM_BYTES}}`,
  ].join(', ')
  return [
    /*
     * Установка — только когда её ещё нет или она другая.
     *
     * Исходник растёт с каждым новым типом (двадцать с лишним килобайт), а
     * `compile` его стоил около полумиллисекунды КАЖДОЙ попытке, при том что
     * между попытками он не меняется никогда. Сверка по версии снимает это
     * целиком и остаётся честной: другая сборка сервера — другой хеш, и
     * живое ядро получит новый код без перезапуска.
     */
    `if getattr(__import__('sys').modules.get(${module}), 'version', None) != ` +
      `${JSON.stringify(implVersion())}: ` +
      `exec(compile(${source}, '<colloq-council>', 'exec'), ` +
      `__import__('sys').modules.setdefault(${module}, ` +
      `__import__('types').ModuleType(${module})).__dict__)`,
    `__import__('sys').modules[${module}].enter(globals(), ${budget}, ${settings})`,
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
  const row = readBundle(raw)
  if (!row || typeof row.ok !== 'boolean') return null
  return {
    ok: row.ok,
    copied: typeof row.copied === 'number' ? row.copied : 0,
    skipped: skipList(row.skipped),
    failed: failList(row.failed),
    bytes: typeof row.bytes === 'number' ? row.bytes : 0,
    memory: typeof row.memory === 'number' ? row.memory : null,
    ms: typeof row.ms === 'number' ? row.ms : 0,
    error: typeof row.error === 'string' ? row.error : null,
  }
}

/** Отчёт выхода; `null` — его не было, и это не повод ни для чего. */
export function parseCouncilLeftovers(raw: unknown): CouncilLeftovers | null {
  const row = readBundle(raw)
  if (!row) return null
  const threads = typeof row.threads === 'number' ? row.threads : 0
  const processes = typeof row.processes === 'number' ? row.processes : 0
  if (threads <= 0 && processes <= 0) return null
  return { threads, processes }
}

/** Общее для обоих отчётов: достать JSON из mimebundle или из голой строки. */
function readBundle(raw: unknown): Record<string, unknown> | null {
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
  if (text === null || text === 'None') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  return parsed as Record<string, unknown>
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

/**
 * Попытка упёрлась в потолок памяти — и это хорошая новость, которую надо
 * рассказать хорошо.
 *
 * Без потолка тот же `np.ones((40000, 40000))` звал бы OOM-killer, а тот
 * убивает ядро комнаты: разбор преподавателя, данные всех, кто уже сдал, и
 * очередь. Студент должен понять, что упал ОН, а не занятие.
 */
export function councilMemoryNote(bytes: number | null): string {
  return `${bytes && bytes > 0
    ? tr('server.council.outOfMemory', { p0: sizeWords(bytes) })
    : tr('server.council.outOfMemoryPlain')}\n`
}

/**
 * Что попытка оставила после себя работать.
 *
 * Поток, запущенный попыткой, переживает её и продолжает писать в общее ядро;
 * остановить его нечем — `Thread.stop()` в Python нет. Поэтому не чиним, а
 * называем: преподаватель, читающий вывод, должен знать, почему в комнате
 * что-то шевелится само.
 */
export function councilLeftoverNotes(left: CouncilLeftovers | null): string[] {
  if (!left) return []
  const lines: string[] = []
  if (left.threads > 0) lines.push(tr('server.council.threadsLeft', { count: left.threads }))
  if (left.processes > 0) lines.push(tr('server.council.processesKilled', { count: left.processes }))
  return lines.map((line) => `${line}\n`)
}
