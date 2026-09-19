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
  councilSkipNotes,
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
  assert.match(lines[0], /^exec\(compile\(/)
  assert.ok(lines[0].includes(JSON.stringify(COUNCIL_MODULE)))
  // Бюджет уезжает числом в самый запрос: ядро о конфигурации сервера не знает.
  assert.match(lines[1], /\.enter\(globals\(\), 1048576\)$/)
  // Негодное число не превращается в NaN внутри Python: своё умолчание ближе.
  assert.match(councilEnterSource(Number.NaN), /\.enter\(globals\(\), 536870912\)$/)
  assert.match(councilEnterSource(-1), /\.enter\(globals\(\), 536870912\)$/)
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
  setLocaleResolver(() => 'ru')
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
function drive(what: Drive): { report: any; after: any; failure: string | null; names: string[] } {
  const enterOnce = "exec(compile(ENTER, '<enter>', 'exec'), ns)"
  const script = [
    'import json, sys',
    `ENTER = ${JSON.stringify(councilEnterSource(what.budget ?? 512 * 1024 * 1024))}`,
    `EXIT = ${JSON.stringify(COUNCIL_EXIT_SOURCE)}`,
    "ns = {'__builtins__': __builtins__, '__name__': '__main__'}",
    `exec(compile(${JSON.stringify(what.setup)}, '<setup>', 'exec'), ns)`,
    enterOnce,
    `report = json.loads(repr(sys.modules[${JSON.stringify(COUNCIL_MODULE)}].report))`,
    'failure = None',
    'try:',
    `    exec(compile(${JSON.stringify(what.attempt)}, '<attempt>', 'exec'), ns)`,
    'except BaseException as err:',
    '    failure = type(err).__name__ + ": " + str(err)',
    ...(what.twice ? [enterOnce] : []),
    "exec(compile(EXIT, '<exit>', 'exec'), ns)",
    `after = eval(compile(${JSON.stringify(what.probe)}, '<probe>', 'eval'), ns)`,
    "print('@@' + json.dumps({'report': report, 'after': after, 'failure': failure,"
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
