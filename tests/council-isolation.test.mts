/**
 * Личные копии данных на попытку консилиума — снизу, со стороны Python.
 *
 * Беда, ради которой всё это заведено, случилась на живом семинаре 19.09: в
 * задании стояла закомментированная строка `# data = data.dropna()`, один
 * человек её раскомментировал и запустил — и `data` стал другим у ВСЕХ,
 * включая тех, кто уже сдал. Прежняя уборка (снимок имён до попытки, снятие
 * новых после) не могла это поймать по устройству: перепривязка меняет имя,
 * которое БЫЛО, а `df.drop(..., inplace=True)` не меняет имён вовсе.
 *
 * Поэтому здесь проверяется не форма исходника, а поведение: тот же кусок
 * Python, что уезжает в ядро комнаты, исполняется настоящим `python3` — вход,
 * попытка, выход, — и после выхода исходники обязаны быть целы до последнего
 * байта. Половина случаев не требует pandas и numpy вовсе (список, словарь,
 * множество), и она идёт всегда; таблицы и массивы — только если в этом
 * `python3` они есть.
 *
 * `python3` может не оказаться (CI без Python, чужая машина) — тогда вся
 * нижняя половина пропускается, а верхняя, про сборку исходника и разбор
 * отчёта, остаётся: она чистая.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { setLocaleResolver } from '../shared/i18n.js'
import {
  councilEnterRefusal,
  councilEnterSource,
  councilLeftoverNotes,
  councilMemoryNote,
  councilSkipNotes,
  parseCouncilLeftovers,
  parseCouncilReport,
  sizeWords,
  COUNCIL_EXIT_SOURCE,
  COUNCIL_MODULE,
  COUNCIL_REPORT_EXPR,
  MAX_SKIP_NOTES,
  SIZE_UNKNOWN,
  type CouncilIsolationReport,
} from '../server/src/kernel/council-isolation.js'

/* ------------------------------------------------------------- исходники */

test('вход — два выражения, которые не связывают в ядре ни одного имени', () => {
  const source = councilEnterSource(1024 * 1024)
  const lines = source.split('\n')
  assert.equal(lines.length, 2, 'вход перестал быть двумя выражениями')
  /*
   * Ни одного присваивания на верхнем уровне — в этом весь смысл `exec` в
   * `__dict__` скрытого модуля. Появись здесь `import sys` или `m = ...`, вход
   * сам бы нарушил обещание «пространство имён возвращается в точности к
   * тому, что было»: его собственные имена остались бы у студента.
   */
  for (const line of lines) {
    assert.doesNotMatch(line, /^[A-Za-z_][A-Za-z0-9_]*\s*=[^=]/, `вход связал имя: ${line.slice(0, 40)}`)
    assert.doesNotMatch(line, /^(import|from|def|class)\s/, `вход связал имя: ${line.slice(0, 40)}`)
  }
  /*
   * Установка идёт через сверку версии, а не безусловно: исходник перевалил за
   * двадцать килобайт, и `compile` на каждую попытку стоил бы полмиллисекунды
   * ни за что. Версия — хеш самого исходника, поэтому новая сборка сервера
   * переустановит модуль в уже живом ядре сама, без перезапуска комнаты.
   */
  assert.match(lines[0], /^if getattr\(__import__\('sys'\)\.modules\.get\(/)
  assert.match(lines[0], /'version', None\) != "[0-9a-f]{12}": exec\(compile\(/)
  assert.ok(lines[0].includes(JSON.stringify(COUNCIL_MODULE)))
  // Версия внутри исходника и версия в сверке — одна и та же строка, иначе
  // модуль переустанавливался бы на каждой попытке и молча.
  const stamp = /!= "([0-9a-f]{12})"/.exec(lines[0])![1]
  assert.ok(lines[0].includes(`version = '${stamp}'`), 'версия в исходнике другая')
  // Бюджет уезжает числом в самый запрос: ядро о конфигурации сервера не знает.
  assert.match(lines[1], /\.enter\(globals\(\), 1048576, \{/)
  // Негодное число не превращается в NaN внутри Python: своё умолчание ближе.
  assert.match(councilEnterSource(Number.NaN), /\.enter\(globals\(\), 536870912, \{/)
  assert.match(councilEnterSource(-1), /\.enter\(globals\(\), 536870912, \{/)

  /*
   * Настройки — литералом в вызове, а не внутри исходника: текст отказа зависит
   * от языка комнаты, а его меняют в панели посреди пары. Булево при этом —
   * словом Python: `false` в ядре не значение, а NameError (наступали).
   */
  assert.match(lines[1], /'memory': False\}?/)
  assert.match(councilEnterSource(1024, { memoryGuard: true }), /'memory': True/)
  assert.doesNotMatch(lines[1], /\b(false|true|null)\b/)
  setLocaleResolver(() => 'en')
  assert.match(councilEnterSource(1024), /may not shut the kernel down/)
  setLocaleResolver(() => 'ru')
  assert.match(councilEnterSource(1024), /нельзя завершать ядро/)
})

test('выход переживает отсутствие модуля — возвращать тогда нечего', () => {
  // Ядро могли перезапустить между входом и выходом: модуля нет, KeyError —
  // нормальный исход, и глушить его должен сам исходник, а не сервер.
  assert.match(COUNCIL_EXIT_SOURCE, /^try:/)
  assert.match(COUNCIL_EXIT_SOURCE, /except Exception:\n {4}pass$/)
  assert.ok(COUNCIL_EXIT_SOURCE.includes('.leave(globals())'))
  assert.ok(COUNCIL_REPORT_EXPR.includes(COUNCIL_MODULE))
})

/* ----------------------------------------------------------------- отчёт */

test('отчёт читается из mimebundle, а всё непонятное — это «не подтверждено»', () => {
  const body = { ok: true, copied: 3, skipped: [{ name: 'big', bytes: 42 }], failed: [], bytes: 7, ms: 4 }
  const bundle = { status: 'ok', data: { 'text/plain': JSON.stringify(body) }, metadata: {} }
  const parsed = parseCouncilReport(bundle)
  assert.equal(parsed?.ok, true)
  assert.equal(parsed?.copied, 3)
  assert.equal(parsed?.bytes, 7)
  assert.deepEqual(parsed?.skipped, [{ name: 'big', bytes: 42 }])

  // Та же строка без обёртки — так его читает тест, гоняющий python3 напрямую.
  assert.equal(parseCouncilReport(JSON.stringify(body))?.copied, 3)

  /*
   * Всё остальное — `null`, и это главное свойство разбора: сервер по нему
   * решает НЕ запускать попытку. Пустой объект — ровно то, что приезжает от
   * ядра, когда вход упал: user_expressions на упавшем запуске не считаются.
   */
  assert.equal(parseCouncilReport({}), null, 'пустой ответ сошёл за подтверждение')
  assert.equal(parseCouncilReport(undefined), null)
  assert.equal(parseCouncilReport({ status: 'error', ename: 'KeyError' }), null)
  assert.equal(parseCouncilReport({ status: 'ok', data: { 'text/plain': 'не json' } }), null)
  assert.equal(parseCouncilReport({ status: 'ok', data: { 'text/plain': '{"copied":1}' } }), null,
    'отчёт без ok сошёл за подтверждение')

  // Отказ входа — это отчёт, а не молчание: у него есть причина.
  const bad = parseCouncilReport('{"ok":false,"error":"MemoryError: ","copied":0,"ms":3}')
  assert.equal(bad?.ok, false)
  assert.equal(bad?.error, 'MemoryError: ')
})

/* ----------------------------------------------------------------- слова */

test('про оставшееся общим сказано по-человечески, не больше трёх строк и на двух языках', () => {
  const report = (skipped: { name: string; bytes: number }[]): CouncilIsolationReport => ({
    ok: true, copied: 0, skipped, failed: [], bytes: 0, ms: 1, error: null,
  })
  setLocaleResolver(() => 'ru')
  assert.deepEqual(councilSkipNotes(report([])), [])

  const one = councilSkipNotes(report([{ name: 'big', bytes: 1.2 * 1024 ** 3 }]))
  assert.equal(one.length, 1)
  assert.match(one[0], /Переменная `big`/)
  assert.match(one[0], /1,2 ГБ/)
  // Совет обязан быть исполнимым: имя подставлено с обеих сторон.
  assert.match(one[0], /big = big\.copy\(\)/)
  // Строка идёт в stderr попытки — своим переводом строки, а не склейкой.
  assert.ok(one[0].endsWith('\n'))

  const many = councilSkipNotes(report(
    ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, bytes: 5 * 1024 ** 2 })),
  ))
  assert.equal(many.length, MAX_SKIP_NOTES + 1, 'предупреждения вытеснили бы сам ответ')
  assert.match(many.at(-1)!, /и ещё 2 такие переменные/)

  // Не влезло в бюджет и не скопировалось — для студента одно и то же: данные
  // общие. Но размера у второго нет, и выдумывать его нельзя.
  const failed = councilSkipNotes({
    ok: true, copied: 0, skipped: [], bytes: 0, ms: 1, error: null,
    failed: [{ name: 'conn', error: 'TypeError: cannot pickle' }],
  })
  assert.equal(failed.length, 1)
  assert.match(failed[0], /`conn`/)
  // Размера у неудачной копии нет, и выдумывать его нельзя.
  assert.doesNotMatch(failed[0], /\(\d/, 'выдуманный размер')
  // Обход, упёршийся в потолок узлов, — та же строка без числа.
  const deep = councilSkipNotes(report([{ name: 'tree', bytes: SIZE_UNKNOWN }]))
  assert.equal(deep.length, 1)
  assert.doesNotMatch(deep[0], /\(\d/)

  assert.match(councilEnterRefusal(null), /Не удалось подготовить личные копии/)
  assert.match(councilEnterRefusal(null), /ядро не подтвердило/)
  assert.match(councilEnterRefusal('MemoryError'), /MemoryError/)
  assert.doesNotMatch(councilEnterRefusal('MemoryError'), /\n/, 'отказ перестал быть одной строкой')

  setLocaleResolver(() => 'en')
  assert.match(councilSkipNotes(report([{ name: 'big', bytes: 3 * 1024 ** 2 }]))[0], /too large to copy/)
  assert.match(councilEnterRefusal(null), /Could not prepare personal copies/)
  assert.equal(sizeWords(2 * 1024 ** 3), '2 GB')
  assert.equal(sizeWords(512 * 1024), '512 kB')
  assert.match(councilMemoryNote(2 * 1024 ** 3), /ran out of memory/)
  setLocaleResolver(() => 'ru')

  /*
   * MemoryError под нашим потолком — это спасённое занятие, и говорить о нём
   * надо так, чтобы студент понял: упал он, а не комната. Число обязательно:
   * без него совет «уменьшите объём» не на что опереть.
   */
  assert.match(councilMemoryNote(2 * 1024 ** 3), /не хватило памяти/)
  assert.match(councilMemoryNote(2 * 1024 ** 3), /2 ГБ/)
  assert.match(councilMemoryNote(2 * 1024 ** 3), /Ядро и данные остальных целы/)
  // Потолка не было (не Linux, рядом CUDA) — та же мысль, но без выдуманного числа.
  assert.doesNotMatch(councilMemoryNote(null), /\d/)
  assert.match(councilMemoryNote(null), /Ядро и данные остальных целы/)
})

/* ------------------------------------------------- настоящий python3 */

const python = (() => {
  const probe = spawnSync('python3', ['-c', 'import sys; print(sys.version_info[0])'], {
    encoding: 'utf8',
  })
  return probe.status === 0 ? 'python3' : null
})()

interface Drive {
  /** Что вошло в `setup`, ушло в `enter`, пережило попытку и вернулось выходом. */
  setup: string
  attempt: string
  /** Выражение Python, которое считают в `ns` ПОСЛЕ выхода и кладут в JSON. */
  probe: string
  budget?: number
  /** Второй вход подряд, без выхода между ними: прошлый выход не дошёл. */
  twice?: boolean
}

/**
 * Один прогон настоящим python3: setup → вход → попытка → выход → проба.
 *
 * `ns` — обычный словарь, и это честная замена user_ns: IPython исполняет
 * ячейку ровно так же, с `globals()`, равным ему. Исключение попытки ловится
 * и называется, но выход отрабатывает в любом случае — как и на сервере.
 */
interface Drove {
  report: any
  /** Отчёт выхода: что вернуть было нечем. `null` — хвостов не осталось. */
  left: any
  after: any
  failure: string | null
  names: string[]
}

function drive(what: Drive): Drove {
  const enterOnce = "exec(compile(ENTER, '<enter>', 'exec'), ns)"
  const module = JSON.stringify(COUNCIL_MODULE)
  const script = [
    'import json, sys',
    `ENTER = ${JSON.stringify(councilEnterSource(what.budget ?? 512 * 1024 * 1024))}`,
    `EXIT = ${JSON.stringify(COUNCIL_EXIT_SOURCE)}`,
    "ns = {'__builtins__': __builtins__, '__name__': '__main__'}",
    `exec(compile(${JSON.stringify(what.setup)}, '<setup>', 'exec'), ns)`,
    enterOnce,
    `report = json.loads(repr(sys.modules[${module}].report))`,
    'failure = None',
    'try:',
    `    exec(compile(${JSON.stringify(what.attempt)}, '<attempt>', 'exec'), ns)`,
    'except BaseException as err:',
    '    failure = type(err).__name__ + ": " + str(err)',
    ...(what.twice ? [enterOnce] : []),
    "exec(compile(EXIT, '<exit>', 'exec'), ns)",
    `raw = sys.modules[${module}].leftovers`,
    'left = json.loads(repr(raw)) if raw is not None else None',
    `after = eval(compile(${JSON.stringify(what.probe)}, '<probe>', 'eval'), ns)`,
    "print('@@' + json.dumps({'report': report, 'after': after, 'failure': failure, 'left': left,"
      + " 'names': sorted(k for k in ns if k not in ('__builtins__', '__name__'))}))",
  ].join('\n')
  const run = spawnSync(python!, ['-'], { input: script, encoding: 'utf8' })
  assert.equal(run.status, 0, `python3 упал: ${run.stderr}`)
  const line = run.stdout.split('\n').find((l) => l.startsWith('@@'))
  assert.ok(line, `нет ответа: ${run.stdout} ${run.stderr}`)
  return JSON.parse(line.slice(2))
}

const noPython = python ? false : 'нет python3'

test('перепривязка, мутация и новое имя не переживают попытку — настоящим python3', { skip: noPython }, () => {
  const out = drive({
    setup: [
      'lst = [1, 2, 3]',
      "d = {'k': 1}",
      'st = {1, 2}',
      'ba = bytearray(b"abc")',
      "nested = {'inner': [1, 2], 'deep': {'q': 3}}",
      'shared = [7]',
      'a = shared',
      'b = shared',
      // Кортеж неизменяем сам, а список внутри него — нет.
      'pair = ([1], "x")',
    ].join('\n'),
    attempt: [
      // Перепривязка: та самая строка семинара, только на списке.
      'lst = lst + [9]',
      "d['k'] = 2",
      "d['new'] = 3",
      'st.add(3)',
      'ba.extend(b"xyz")',
      "nested['inner'].append(4)",
      "nested['deep']['q'] = 9",
      // Два имени на один объект — и внутри попытки они обязаны остаться одним.
      "assert a is b, 'копии разъехались'",
      'a.append(8)',
      "assert b == [7, 8], 'изменение через a не видно через b'",
      'pair[0].append(2)',
      'secret = 42',
    ].join('\n'),
    probe: "{'lst': lst, 'd': d, 'st': sorted(st), 'ba': ba.decode(), 'nested': nested,"
      + " 'a': a, 'b': b, 'same': a is b and a is shared, 'pair': list(pair[0])}",
  })
  assert.equal(out.report.ok, true)
  assert.equal(out.failure, null, `попытка упала: ${out.failure}`)
  assert.deepEqual(out.after.lst, [1, 2, 3], 'перепривязка не откатилась')
  assert.deepEqual(out.after.d, { k: 1 }, 'словарь испорчен')
  assert.deepEqual(out.after.st, [1, 2], 'множество испорчено')
  assert.equal(out.after.ba, 'abc', 'bytearray испорчен')
  assert.deepEqual(out.after.nested, { inner: [1, 2], deep: { q: 3 } }, 'вложенное испорчено')
  assert.deepEqual(out.after.a, [7], 'общий объект испорчен')
  assert.deepEqual(out.after.pair, [1], 'список внутри кортежа испорчен')
  assert.equal(out.after.same, true, 'после выхода имена разъехались по разным объектам')
  assert.ok(!out.names.includes('secret'), 'новое имя пережило попытку')
  // И ни одного собственного имени вход с выходом после себя не оставили.
  assert.ok(!out.names.some((n) => n.startsWith('_colloq')), out.names.join(','))
  assert.deepEqual(out.names, ['a', 'b', 'ba', 'd', 'lst', 'nested', 'pair', 'shared', 'st'])
})

test('исключение и KeyboardInterrupt посреди попытки не мешают выходу', { skip: noPython }, () => {
  for (const boom of ['raise ValueError("бум")', 'raise KeyboardInterrupt()']) {
    const out = drive({
      setup: 'lst = [1, 2, 3]',
      attempt: `lst.append(9)\n${boom}`,
      probe: 'lst',
    })
    assert.equal(out.report.ok, true)
    assert.deepEqual(out.after, [1, 2, 3], `выход не отработал после ${boom}`)
  }
})

test('объект сверх бюджета назван в отчёте и остаётся общим', { skip: noPython }, () => {
  // Бюджет в сотню байт: под него не подходит ни один настоящий список.
  const out = drive({
    setup: 'big = list(range(5000))\nsmall = [1]',
    attempt: 'big.append(-1)\nsmall.append(2)',
    probe: "{'big': big[-1], 'small': small}",
    budget: 100,
  })
  assert.equal(out.report.ok, true)
  assert.deepEqual(out.report.skipped.map((r: { name: string }) => r.name), ['big'])
  assert.ok(out.report.skipped[0].bytes > 100, 'размер в отчёте не назван')
  assert.equal(out.after.big, -1, 'сверхбюджетный объект оказался копией')
  assert.deepEqual(out.after.small, [1], 'мелкий объект не получил копии')
})

test('повторный вход без выхода не теряет исходники', { skip: noPython }, () => {
  const out = drive({
    setup: 'lst = [1, 2, 3]',
    attempt: 'lst.append(9)',
    probe: 'lst',
    twice: true,
  })
  assert.deepEqual(out.after, [1, 2, 3], 'повторный вход запомнил копию как исходник')
})

test('каталог возвращается вместе с именами', { skip: noPython }, () => {
  const out = drive({
    setup: 'import os as _os\nwas = _os.getcwd()',
    attempt: "import os\nos.chdir('/')",
    probe: '_os.getcwd() == was',
  })
  assert.equal(out.after, true, 'каталог не вернулся')
})

/* ----------------------------------------------- pandas и numpy, если есть */

const hasPandas = python !== null &&
  spawnSync(python, ['-c', 'import pandas, numpy'], { encoding: 'utf8' }).status === 0

test('таблица и массив: dropna, inplace и запись по индексу не доходят до следующего',
  { skip: hasPandas ? false : 'нет pandas/numpy' }, () => {
    const out = drive({
      setup: [
        'import pandas as pd',
        'import numpy as np',
        "data = pd.DataFrame({'a': [1.0, None, 3.0]})",
        "df = pd.DataFrame({'a': [1, 2, 3], 'b': [4, 5, 6]})",
        's = pd.Series([1, 2, 3])',
        'arr = np.arange(5)',
        "box = {'inner': pd.DataFrame({'z': [1, 2]})}",
      ].join('\n'),
      attempt: [
        // Ровно то, что случилось на семинаре 19.09.
        'data = data.dropna()',
        "assert len(data) == 2, 'попытка не увидела свою копию'",
        "df.drop(columns=['b'], inplace=True)",
        "df['x'] = 1",
        'df.iloc[0, 0] = 999',
        's[0] = 777',
        'arr[0] = 555',
        "box['inner']['z2'] = 5",
      ].join('\n'),
      probe: "{'data': int(len(data)), 'cols': list(df.columns), 's0': int(s[0]),"
        + " 'arr0': int(arr[0]), 'box': list(box['inner'].columns)}",
    })
    assert.equal(out.report.ok, true)
    assert.equal(out.failure, null, `попытка упала: ${out.failure}`)
    assert.ok(out.report.copied >= 5, `скопировано слишком мало: ${out.report.copied}`)
    assert.equal(out.after.data, 3, 'перепривязка таблицы не откатилась')
    assert.deepEqual(out.after.cols, ['a', 'b'], 'inplace-удаление колонки доехало до исходника')
    assert.equal(out.after.s0, 1, 'запись в Series доехала до исходника')
    assert.equal(out.after.arr0, 0, 'запись в ndarray доехала до исходника')
    assert.deepEqual(out.after.box, ['z'], 'вложенная таблица испорчена')
    // Модули не копируются: копия numpy стоила бы дорого и не значила бы ничего.
    assert.ok(out.names.includes('np') && out.names.includes('pd'))
  })

/* --------------------------------------- разрушительные приёмы и процесс */

/**
 * «Кто-то сделает X, и всем конец» — список, собранный по живому семинару.
 *
 * Каждая строка здесь закрыта одним и тем же движением: снимок до попытки,
 * возврат после. Ценность теста в том, что он гоняет НАСТОЯЩИЙ python3 —
 * половина этих случаев ломает сам возврат, если написать его неаккуратно
 * (подменённый `builtins.list` в своё время ронял выход целиком).
 */
test('del, globals().clear() и затенение встроенных не переживают попытку', { skip: noPython }, () => {
  const out = drive({
    setup: 'df = [1, 2, 3]\nkeep = {"a": 1}',
    attempt: 'del df\nlist = "сломал"\nlen = None\nsecret = 1',
    probe: "{'df': df, 'keep': keep}",
  })
  assert.deepEqual(out.after.df, [1, 2, 3], 'del df не вернулся')
  assert.deepEqual(out.names, ['df', 'keep'], 'затенение встроенных или новое имя пережили попытку')

  const wiped = drive({
    setup: 'df = [1, 2, 3]\nkeep = {"a": 1}',
    attempt: 'globals().clear()',
    probe: "{'df': df, 'keep': keep}",
  })
  assert.deepEqual(wiped.after, { df: [1, 2, 3], keep: { a: 1 } }, 'globals().clear() унёс комнату')
})

test('подменённые builtins возвращаются — и не ломают сам возврат', { skip: noPython }, () => {
  /*
   * Здесь возврат чинит то, чем сам пользуется. Пока он звал `list(ns)` из
   * builtins, попытка с `builtins.list = "сломал"` роняла выход на первой
   * строке, состояние оставалось подменённым, а следующий вход запоминал
   * чужие копии как исходники. Проверено — падало именно так.
   */
  const out = drive({
    setup: 'df = [1, 2, 3]',
    attempt: 'import builtins\nbuiltins.list = "сломал"\nbuiltins.len = None\nbuiltins.ПОДКИНУТО = 1',
    probe: "{'list_ok': __import__('builtins').list is list, 'len_ok': __import__('builtins').len is len,"
      + " 'no_new': not hasattr(__import__('builtins'), 'ПОДКИНУТО'), 'df': df}",
  })
  assert.equal(out.after.list_ok, true, 'builtins.list остался подменённым')
  assert.equal(out.after.len_ok, true, 'builtins.len остался подменённым')
  assert.equal(out.after.no_new, true, 'подкинутое имя осталось в builtins')
  assert.deepEqual(out.after.df, [1, 2, 3], 'возврат имён не доработал после битых builtins')
})

test('exit() и quit() в попытке отказывают, а не гасят ядро комнате', { skip: noPython }, () => {
  // В ipykernel это `shell.ask_exit()` — конец процесса и потеря переменных у
  // ВСЕХ; воспроизведено на живом ядре. В голом python оболочки нет, поэтому
  // здесь проверяются сами имена, а автовызов IPython — приёмкой на ядре.
  const out = drive({
    setup: 'df = [1]',
    attempt: 'try:\n    exit()\nexcept BaseException as e:\n    caught = type(e).__name__\n'
      + 'try:\n    quit()\nexcept BaseException as e:\n    caught2 = type(e).__name__\n'
      + 'both = [caught, caught2]',
    probe: "{'names': sorted(k for k in globals() if k in ('exit', 'quit')), 'df': df}",
  })
  assert.equal(out.failure, null, out.failure ?? '')
  assert.deepEqual(out.after.names, [], 'exit/quit остались в пространстве после выхода')
})

/**
 * Тот самый `os._exit(0)`, который 20.09 девять раз унёс ядро у тридцати человек.
 *
 * Тест устроен так, что мимо него эта беда не проходит физически: если
 * `os._exit` сработает, python кончится молча, до `print('@@'...)` дело не
 * дойдёт, и `drive` упадёт на «нет ответа». То есть проверяется не форма
 * отказа, а ровно то, что процесс ЖИВ — единственное, что в тот день имело
 * значение. `os.abort()` рядом: он гасит так же, только через SIGABRT.
 *
 * И вторая половина, не менее важная: после выхода `os._exit` обязан быть
 * НАСТОЯЩИМ. Оставить в общем модуле `os` наш отказ значило бы сломать
 * `multiprocessing` всей комнате — и не на попытке, а навсегда.
 */
test('os._exit() в попытке отказывает, а не гасит ядро комнате', { skip: noPython }, () => {
  const out = drive({
    setup: 'df = [1]',
    // Ровно та попытка, что стояла в комнате d8uf9ewe 20.09 — две строки.
    attempt: 'import os\nos._exit(0)',
    probe: "{'alive': True, 'df': df}",
  })
  // Дошли сюда — значит, python досчитал до печати ответа, то есть выжил.
  assert.equal(out.after.alive, true, 'попытка унесла процесс с собой')
  assert.deepEqual(out.after.df, [1], 'данные комнаты не пережили попытку')
  // Имя отказа — то, по которому сервер печатает одну строку вместо трейсбека.
  assert.match(out.failure ?? '', /^ColloqRefused: /, `вместо отказа: ${out.failure}`)
  assert.match(out.failure ?? '', /os\._exit/)
})

test('os.abort() в попытке отказывает так же', { skip: noPython }, () => {
  const out = drive({
    setup: 'df = [1]',
    attempt: 'import os\nos.abort()',
    probe: "{'alive': True}",
  })
  assert.equal(out.after.alive, true, 'os.abort() унёс процесс с собой')
  assert.match(out.failure ?? '', /^ColloqRefused: /, `вместо отказа: ${out.failure}`)
})

/**
 * После выхода `os._exit` обязан быть НАСТОЯЩИМ, а `os.kill` — нетронутым.
 *
 * Первое: оставить в общем модуле `os` наш отказ значило бы сломать
 * `multiprocessing` всей комнате — и не на попытке, а навсегда.
 *
 * Второе: `os.kill` не закрыт намеренно, а не по недосмотру. Им управляют
 * дочерними процессами (`subprocess`, пулы), и отказ там сломал бы работающие
 * тетради ради дыры, которую всё равно обходят через `ctypes`. Строка стоит
 * здесь, чтобы следующий, кто решит «закроем заодно и kill», знал, что об
 * этом уже думали.
 */
test('после выхода os._exit настоящий, а os.kill не трогали вовсе', { skip: noPython }, () => {
  const out = drive({
    setup: 'import os\nreal = (os._exit, os.abort, os.kill)',
    attempt: 'import os\nseen_kill = os.kill is real[2]',
    probe: "{'restored': os._exit is real[0] and os.abort is real[1], 'kill': os.kill is real[2]}",
  })
  assert.equal(out.failure, null, out.failure ?? '')
  assert.equal(out.after.restored, true, 'os._exit остался подменённым — это сломает multiprocessing')
  assert.equal(out.after.kill, true, 'os.kill подменили — это сломает управление дочерними процессами')
})

test('состояние процесса возвращается: ГСЧ, потоки вывода, путь, окружение', { skip: noPython }, () => {
  const out = drive({
    setup: 'import random, sys, os, warnings, decimal\n'
      + 'random.seed(1234)\n'
      + 'was = [random.random() for _ in range(3)]\n'
      + 'random.seed(1234)\n'
      + 'path_was = list(sys.path)\n'
      + 'os.environ["COLLOQ_KEEP"] = "да"\n'
      + 'warnings.resetwarnings()\n'
      + 'filters_was = len(warnings.filters)\n'
      + 'limit_was = sys.getrecursionlimit()\n'
      + 'prec_was = decimal.getcontext().prec',
    attempt: 'import random, sys, os, io, warnings, decimal\n'
      + 'random.seed(99)\n[random.random() for _ in range(5)]\n'
      + 'sys.stdout = io.StringIO()\n'
      + 'sys.path.insert(0, "/подкинуто")\n'
      + 'os.environ["COLLOQ_NEW"] = "подкинуто"\n'
      + 'os.environ["COLLOQ_KEEP"] = "испорчено"\n'
      + 'warnings.filterwarnings("ignore")\n'
      + 'sys.setrecursionlimit(100)\n'
      + 'sys.settrace(lambda *a: None)\n'
      + 'decimal.getcontext().prec = 3',
    probe: "{'rng': [random.random() for _ in range(3)] == was,"
      + " 'stdout': sys.stdout is sys.__stdout__,"
      + " 'path': sys.path == path_was,"
      + " 'env_keep': os.environ.get('COLLOQ_KEEP'),"
      + " 'env_new': 'COLLOQ_NEW' in os.environ,"
      + " 'filters': len(warnings.filters) == filters_was,"
      + " 'reclimit': sys.getrecursionlimit() == limit_was,"
      + " 'trace': sys.gettrace() is None,"
      + " 'prec': decimal.getcontext().prec == prec_was}",
  })
  assert.equal(out.after.rng, true, 'поток случайных чисел сдвинут попыткой')
  assert.equal(out.after.stdout, true, 'sys.stdout остался подменённым — вывод сломан у всех')
  assert.equal(out.after.path, true, 'sys.path остался с чужой записью')
  assert.equal(out.after.env_keep, 'да', 'os.environ испорчено')
  assert.equal(out.after.env_new, false, 'подкинутая переменная окружения осталась')
  assert.equal(out.after.filters, true, 'фильтры предупреждений остались чужими')
  assert.equal(out.after.reclimit, true, 'предел рекурсии остался чужим')
  assert.equal(out.after.trace, true, 'трассировщик попытки остался включённым')
  assert.equal(out.after.prec, true, 'контекст decimal остался чужим')
})

test('поток, оставленный попыткой, посчитан выходом — остановить его нечем', { skip: noPython }, () => {
  const out = drive({
    setup: 'x = 1',
    attempt: 'import threading\nev = threading.Event()\n'
      + 'threading.Thread(target=lambda: ev.wait(20), daemon=True).start()',
    probe: 'x',
  })
  assert.equal(out.left?.threads, 1, `отчёт выхода: ${JSON.stringify(out.left)}`)
  // И ровно то же в словах, которые увидит преподаватель.
  setLocaleResolver(() => 'ru')
  const notes = councilLeftoverNotes(parseCouncilLeftovers(JSON.stringify(out.left)))
  assert.equal(notes.length, 1)
  assert.match(notes[0], /остался работать 1 поток/)

  // А без хвостов приписки нет вовсе: пустой отчёт — это не новость.
  const quiet = drive({ setup: 'x = 1', attempt: 'y = 2', probe: 'x' })
  assert.equal(parseCouncilLeftovers(JSON.stringify(quiet.left)), null)
})

test('numpy, pandas и их генераторы возвращаются вместе с остальным',
  { skip: hasPandas ? false : 'нет pandas/numpy' }, () => {
    const out = drive({
      setup: 'import numpy as np, pandas as pd\n'
        + 'np.random.seed(7)\nwas = list(np.random.rand(3))\nnp.random.seed(7)\n'
        + 'print_was = np.get_printoptions()["precision"]\n'
        + 'width_was = pd.get_option("display.width")\n'
        + 'rng = np.random.default_rng(5)\nfirst = list(rng.random(3))\n'
        + 'rng = np.random.default_rng(5)',
      attempt: 'import numpy as np, pandas as pd\n'
        + 'np.random.seed(1)\nnp.random.rand(5)\n'
        + 'np.set_printoptions(precision=1)\n'
        + 'pd.set_option("display.width", 17)\n'
        + 'mine = list(rng.random(3))',
      probe: "{'rng': list(np.random.rand(3)) == was,"
        + " 'print': np.get_printoptions()['precision'] == print_was,"
        + " 'pandas': pd.get_option('display.width') == width_was,"
        + " 'generator': list(rng.random(3)) == first}",
    })
    assert.equal(out.after.rng, true, 'numpy: поток случайных чисел сдвинут попыткой')
    assert.equal(out.after.print, true, 'numpy printoptions остались чужими')
    assert.equal(out.after.pandas, true, 'опции pandas остались чужими')
    // Generator в переменной — тоже состояние: без личной копии одинаковые
    // попытки давали бы разные числа в зависимости от очереди.
    assert.equal(out.after.generator, true, 'np.random.Generator оказался общим')
  })

/* ------------------------------------------------ torch, если он есть */

const hasTorch = python !== null &&
  spawnSync(python, ['-c', 'import torch'], { encoding: 'utf8' }).status === 0

test('тензоры, модель и оптимизатор — личные, и оптимизатор смотрит на свою модель',
  { skip: hasTorch ? false : 'нет torch' }, () => {
    for (const order of ['model', 'opt'] as const) {
      const out = drive({
        setup: 'import torch, torch.nn as nn\n'
          + 't = torch.arange(5, dtype=torch.float32)\n'
          + 'bag = [torch.zeros(4)]\n'
          + 'shared = torch.ones(3)\na = shared\nb = shared\n'
          + 'leaf = torch.zeros(2, requires_grad=True)\nnonleaf = leaf * 2\n'
          + (order === 'model'
            ? 'model = nn.Linear(4, 2)\nopt = torch.optim.SGD(model.parameters(), lr=1.0)\n'
            : 'model0 = nn.Linear(4, 2)\nopt = torch.optim.SGD(model0.parameters(), lr=1.0)\nmodel = model0\ndel model0\n')
          + 'was = float(model.weight[0][0])',
        attempt: 'import torch\nt[0] = 7\nt.add_(1)\nbag[0][0] = 5\n'
          + "assert a is b, 'тензоры разъехались'\na[0] = 9\n"
          + 'out = model(torch.ones(1, 4)).sum()\nopt.zero_grad()\nout.backward()\nopt.step()\n'
          + "assert opt.param_groups[0]['params'][0] is model.weight, 'оптимизатор смотрит не на свою модель'\n"
          + 'moved = float(model.weight[0][0])',
        probe: "{'t': float(t[0]), 'bag': float(bag[0][0]), 'shared': float(a[0]),"
          + " 'same': a is b, 'weight': float(model.weight[0][0]), 'was': was}",
      })
      assert.equal(out.failure, null, `${order}: ${out.failure}`)
      assert.equal(out.after.t, 0, `${order}: запись в тензор доехала до исходника`)
      assert.equal(out.after.bag, 0, `${order}: тензор в списке испорчен`)
      assert.equal(out.after.shared, 1, `${order}: общий тензор испорчен`)
      assert.equal(out.after.same, true, `${order}: после выхода имена разъехались`)
      assert.equal(out.after.weight, out.after.was, `${order}: шаг оптимизатора изменил общую модель`)
      // Не-листовой тензор с историей градиента deepcopy не берёт — он
      // остаётся общим и назван в отчёте, а не роняет вход.
      assert.ok(out.report.failed.some((row: { name: string }) => row.name === 'nonleaf'),
        JSON.stringify(out.report.failed))
      assert.equal(out.report.ok, true)
    }
  })

/* ------------------------------------- классы тетради и scipy.sparse */

test('объект класса, объявленного в тетради, получает личную копию', { skip: noPython }, () => {
  const out = drive({
    setup: 'class Dataset:\n'
      + '    def __init__(self):\n'
      + '        self.rows = [1, 2, 3]\n'
      + '        self.name = "исходник"\n'
      + 'class Slotted:\n'
      + "    __slots__ = ('items',)\n"
      + '    def __init__(self):\n'
      + '        self.items = [1, 2]\n'
      + 'class WithGen:\n'
      + '    def __init__(self):\n'
      + '        self.gen = (i for i in range(3))\n'
      + '        self.rows = [1, 2]\n'
      + 'ds = Dataset()\nsl = Slotted()\nwg = WithGen()\n'
      + 'import io\nbuf = io.StringIO("x")',
    attempt: 'ds.rows.append(9)\nds.name = "испорчено"\nsl.items.append(3)\nwg.rows.append(9)',
    probe: "{'rows': ds.rows, 'name': ds.name, 'slots': sl.items, 'gen': wg.rows}",
  })
  assert.deepEqual(out.after.rows, [1, 2, 3], 'список внутри объекта тетради испорчен')
  assert.equal(out.after.name, 'исходник', 'поле объекта тетради испорчено')
  assert.deepEqual(out.after.slots, [1, 2], '__slots__-объект не скопирован')
  // Генератор внутри копировать нечем — объект остаётся общим и назван.
  assert.deepEqual(out.after.gen, [1, 2, 9], 'объект с генератором вдруг скопировался')
  const shared = out.report.failed.map((row: { name: string }) => row.name)
  assert.ok(shared.includes('wg'), JSON.stringify(out.report.failed))
  // Чужой (библиотечный) объект не копируется вовсе: там сокеты и окна.
  assert.ok(!out.report.failed.some((row: { name: string }) => row.name === 'buf'))
})

const hasScipy = python !== null &&
  spawnSync(python, ['-c', 'import scipy.sparse'], { encoding: 'utf8' }).status === 0

test('разреженная матрица копируется и весит своими массивами', { skip: hasScipy ? false : 'нет scipy' }, () => {
  const out = drive({
    setup: 'import scipy.sparse as sp, numpy as np\n'
      + 'm = sp.csr_matrix(np.array([[1.0, 0.0], [0.0, 2.0]]))\n'
      + 'big = sp.random(300, 300, density=0.5, format="csr")',
    attempt: 'm.data[:] = 0\nbig.data[:] = 0',
    probe: "{'m': float(m.toarray()[0][0]), 'big': float(abs(big).sum())}",
    budget: 1024,
  })
  assert.equal(out.after.m, 1, 'запись в data разреженной доехала до исходника')
  // Большая не влезла в бюджет — и посчитана по настоящим массивам, а не по
  // весу обёртки, иначе она прошла бы мимо бюджета молча.
  const skipped = out.report.skipped.find((row: { name: string }) => row.name === 'big')
  assert.ok(skipped, JSON.stringify(out.report.skipped))
  assert.ok(skipped.bytes > 300 * 300 * 0.5 * 4, `вес разреженной: ${skipped.bytes}`)
})
