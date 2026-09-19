/**
 * Справка по наведению: разбор ответа ядра и то, во что он превращается в окне.
 *
 * Ломалось это на живом занятии 19.09 и ломалось молча: подсказка показывала
 * первые ШЕСТЬ строк ответа, и для `df.head(n=5)` этого хватало, а для
 * `sns.lmplot(...)` — нет. Человек наводился, чтобы посмотреть параметры
 * графика, и видел четыре из сорока двух: ровно те, которые уже набрал.
 *
 * Отсюда и то, что здесь проверяется. Не «красиво ли», а три вещи, каждая из
 * которых ломается без единого слова:
 *   · разбор разметки IPython на настоящих ответах ядра (образцы ниже сняты с
 *     `colloq-kernel:base`, а не придуманы);
 *   · память: второе наведение не ходит в ядро, но и не помнит вчерашних
 *     отказов;
 *   · обещания самого окна — одна прокрутка, полная сигнатура, слой ниже
 *     тулбара, — которые живут в разметке и в теме и проверяются чтением, как
 *     в panels-craft.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  forgetHelp,
  helpIsEmpty,
  helpKey,
  parseSignatureHelp,
  rememberHelp,
  rememberedHelp,
  HELP_TTL_MS,
} from '../web/src/lib/signature-help.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/* ------------------------------------------------ настоящие ответы ядра */

/** Функция seaborn: сигнатура на сорок с лишним строк — тот самый случай. */
const LMPLOT = [
  'Signature:',
  'sns.lmplot(',
  '    data,',
  '    *,',
  '    x=None,',
  '    y=None,',
  '    hue=None,',
  '    height=5,',
  '    aspect=1,',
  "    markers='o',",
  '    facet_kws=None,',
  ')',
  'Docstring:',
  'Plot data and regression model fits across a FacetGrid.',
  '',
  'This function combines :func:`regplot` and :class:`FacetGrid`. It is',
  'intended as a convenient interface to fit regression models across',
  'conditional subsets of a dataset.',
  '',
  'Parameters',
  '----------',
  'data : DataFrame',
  '    Tidy ("long-form") dataframe where each column is a variable.',
  'File:      /usr/local/lib/python3.11/site-packages/seaborn/regression.py',
  'Type:      function',
].join('\n')

/** Метод DataFrame: сигнатура в одну строку, документация с примерами. */
const HEAD = [
  "Signature: df.head(n: 'int' = 5) -> 'Self'",
  'Docstring:',
  'Return the first `n` rows.',
  '',
  'Examples',
  '--------',
  '>>> df.head()',
  '      animal',
  '0  alligator',
  '1        bee',
  'File:      /usr/local/lib/python3.11/site-packages/pandas/core/generic.py',
  'Type:      method',
].join('\n')

/** Класс: сигнатуры нет, есть сигнатура его `__init__` — и две документации. */
const DATAFRAME = [
  'Init signature:',
  'pd.DataFrame(',
  '    data=None,',
  "    index: 'Axes | None' = None,",
  ") -> 'None'",
  'Docstring:     ',
  'Two-dimensional, size-mutable, potentially heterogeneous tabular data.',
  'Init docstring:',
  'Construct a DataFrame from the given data.',
  'File:      /usr/local/lib/python3.11/site-packages/pandas/core/frame.py',
  'Type:      type',
].join('\n')

/** Модуль: ни сигнатуры, ни документации — только чем он является. */
const MODULE = [
  'Type:        module',
  "String form: <module 'seaborn' from '/usr/local/lib/python3.11/site-packages/seaborn/__init__.py'>",
  'File:        /usr/local/lib/python3.11/site-packages/seaborn/__init__.py',
  'Docstring:   <no docstring>',
].join('\n')

/** Значение, которое не вызывают: тут важнее всего то, чем оно выглядит. */
const NUMBER = [
  'Type:        int',
  'String form: 42',
  'Docstring:  ',
  'int([x]) -> integer',
  '',
  'Convert a number or string to an integer.',
].join('\n')

/* ----------------------------------------------------------------- разбор */

test('длинная сигнатура приезжает ЦЕЛИКОМ, а не первыми шестью строками', () => {
  const help = parseSignatureHelp(LMPLOT)
  assert.match(help.signature, /^sns\.lmplot\(/)
  // Ровно тот параметр, до которого прежняя подсказка не доживала.
  assert.match(help.signature, /facet_kws=None,/)
  assert.match(help.signature, /\)$/)
  assert.equal(help.signature.split('\n').length, 11)
  assert.equal(help.type, 'function')
  assert.match(help.doc, /^Plot data and regression model fits/)
  // Путь внутри контейнера человеку в комнате не значит ничего — это шум.
  assert.doesNotMatch(help.doc, /site-packages/)
  assert.doesNotMatch(help.signature, /site-packages/)
  assert.equal(help.raw, '')
})

test('метод: сигнатура в строку, примеры в документации сохраняют выравнивание', () => {
  const help = parseSignatureHelp(HEAD)
  assert.equal(help.signature, "df.head(n: 'int' = 5) -> 'Self'")
  assert.equal(help.type, 'method')
  // Таблица pandas выровнена пробелами: съеденный отступ превратил бы её в кашу.
  assert.match(help.doc, /\n0 {2}alligator\n/)
  assert.doesNotMatch(help.doc, /generic\.py/)
})

test('у класса показывается сигнатура __init__ и обе его документации', () => {
  const help = parseSignatureHelp(DATAFRAME)
  assert.match(help.signature, /^pd\.DataFrame\(/)
  assert.match(help.signature, /-> 'None'$/)
  assert.match(help.doc, /Two-dimensional, size-mutable/)
  assert.match(help.doc, /Construct a DataFrame from the given data\./)
  assert.equal(help.type, 'type')
})

test('модуль: «нет документации» — это НЕ документация', () => {
  const help = parseSignatureHelp(MODULE)
  assert.equal(help.signature, '')
  assert.equal(help.doc, '')
  assert.equal(help.type, 'module')
  // Строковый вид у модуля показываем: у него это единственный ответ по делу.
  assert.match(help.form, /^<module 'seaborn'/)
  assert.equal(helpIsEmpty(help), false)
})

test('у значения показывается то, чем оно выглядит, — а у функции никогда', () => {
  const value = parseSignatureHelp(NUMBER)
  assert.equal(value.form, '42')
  assert.equal(value.type, 'int')
  assert.match(value.doc, /^int\(\[x\]\) -> integer/)
  // У вызываемого `String form` — это `<function lmplot at 0x7f…>`: адрес в
  // чужом процессе, то есть строка шума поперёк окна.
  const callable = parseSignatureHelp(
    ['Signature: f(x)', 'String form: <function f at 0x7f2c1a>', 'Type: function'].join('\n'),
  )
  assert.equal(callable.form, '')
})

test('мусор и чужое ядро показываются как есть, а не теряются', () => {
  const help = parseSignatureHelp('## help for `qplot`\nno idea what this is')
  assert.equal(help.signature, '')
  assert.equal(help.doc, '')
  assert.match(help.raw, /^## help for/)
  assert.equal(helpIsEmpty(help), false)
  // Пустота остаётся пустотой: окно ради неё открывать незачем.
  assert.equal(helpIsEmpty(parseSignatureHelp('')), true)
  assert.equal(helpIsEmpty(parseSignatureHelp('   \n  ')), true)
})

test('заголовок ВНУТРИ документации её не разрезает', () => {
  /*
   * Второй `File:` — это строка примера, а не раздел ответа. Пока побеждало
   * последнее вхождение, документация обрывалась на середине примера, и
   * половина справки просто исчезала.
   */
  const help = parseSignatureHelp(
    [
      'Signature: open(name)',
      'Docstring:',
      'Open a file.',
      'File:      example',
      'and the sentence that goes after it',
      'File:      /usr/lib/python3.11/io.py',
      'Type:      function',
    ].join('\n'),
  )
  assert.match(help.doc, /Open a file\./)
  assert.match(help.doc, /File: {6}example/)
  assert.match(help.doc, /and the sentence that goes after it/)
  assert.equal(help.type, 'function')
  // А настоящий хвост — слипшиеся приписки в самом конце — разделом остался.
  assert.doesNotMatch(help.doc, /usr\/lib/)
})

/* ----------------------------------------------------------------- память */

test('второе наведение на то же имя берётся из памяти, а не из ядра', () => {
  forgetHelp()
  const key = helpKey('c_1', 'sns.lmplot')
  assert.equal(rememberedHelp(key), null)
  rememberHelp(key, LMPLOT)
  assert.equal(rememberedHelp(key), LMPLOT)
  // Имя помнится В ПРЕДЕЛАХ ячейки: `df` в соседней — другой объект.
  assert.equal(rememberedHelp(helpKey('c_2', 'sns.lmplot')), null)
})

test('память живёт минуту и умирает от запуска ячейки', () => {
  forgetHelp()
  const key = helpKey('c_1', 'df')
  const now = 1_000_000
  rememberHelp(key, HEAD, now)
  assert.equal(rememberedHelp(key, now + HELP_TTL_MS - 1), HEAD)
  // Минута прошла — в ядре за это время могли переопределить что угодно.
  assert.equal(rememberedHelp(key, now + HELP_TTL_MS + 1), null)

  rememberHelp(key, HEAD, now)
  forgetHelp()
  assert.equal(rememberedHelp(key, now), null, 'запуск ячейки не стёр память')
})

/* ------------------------------------------------------- окно и его слой */

const EDITOR = read('web/src/components/notebook/CodeEditor.svelte')
const THEME = read('web/src/components/notebook/cm-theme.ts')
const SESSION = read('web/src/lib/session.svelte.ts')

test('редактор больше не режет ответ ядра по строкам', () => {
  assert.doesNotMatch(EDITOR, /SIGNATURE_LINES/, 'потолок в шесть строк вернулся')
  assert.doesNotMatch(EDITOR, /function signatureHead/, 'обрезка шапки вернулась')
  assert.match(EDITOR, /parseSignatureHelp\(/, 'разбор справки потерялся')
})

test('прокрутка в окне справки одна, и она не утаскивает за собой тетрадь', () => {
  assert.match(THEME, /'\.cm-signature-body': \{[\s\S]*?overflow: 'auto'/)
  assert.match(THEME, /'\.cm-signature-body': \{[\s\S]*?overscrollBehavior: 'contain'/)
  assert.match(THEME, /maxHeight: 'min\(45vh, 420px\)'/)
  // Второй прокрутки быть не должно: своя у сигнатуры сделала бы документацию
  // недосягаемой — см. довод у signatureDom.
  assert.equal((THEME.match(/overflow: 'auto'/g) ?? []).length, 1)
  assert.match(THEME, /width: 'min\(640px, 92vw\)'/)
})

test('справка по-прежнему под строкой и ниже тулбара ячейки', () => {
  assert.match(EDITOR, /above: false/)
  assert.match(THEME, /'\.cm-tooltip\.cm-tooltip-hover': \{\s*zIndex: '5'/)
  // У закреплённой Shift+Tab хозяина нет — `cm-tooltip` висит на нашем узле,
  // и слой ему нужен свой.
  assert.match(THEME, /'\.cm-tooltip\.cm-signature': \{\s*zIndex: '5'/)
})

test('Shift+Tab открывает справку только там, где не о чем снимать отступ', () => {
  assert.match(EDITOR, /key: 'Shift-Tab'/)
  // Выделение и readOnly отдают нажатие дальше — отступу.
  assert.match(EDITOR, /if \(!range\.empty\) return false/)
  assert.match(EDITOR, /const spot = signatureSpot\(/)
  assert.match(EDITOR, /if \(!spot\) return false/)
  // Снятие отступа осталось на месте и осталось ниже по старшинству.
  assert.match(EDITOR, /indentLess: cm\.commands\.indentLess/)
  assert.ok(
    EDITOR.indexOf("key: 'Shift-Tab'") < EDITOR.indexOf('tabKey({'),
    'справка оказалась ниже отступа и не сработает никогда',
  )
})

test('на экране одна справка, а не две', () => {
  /*
   * Нажав Shift+Tab, руку с мыши не убирают: указатель остаётся на том же
   * имени, и через треть секунды под закреплённым окном выезжало второе — с
   * тем же текстом. Снято со стенда. Закрывается это с двух сторон: наведение
   * молчит, пока висит закреплённая, а закрепление убирает то, что уже выехало.
   */
  assert.match(EDITOR, /if \(view\.state\.field\(pinnedField, false\)\) return null/)
  assert.match(EDITOR, /effects: \[cm\.view\.closeHoverTooltips, pinned\.of\(signatureTooltip\(/)
  // И закреплённая обязана быть объявлена раньше наведения — иначе о ней
  // некому спросить.
  assert.ok(EDITOR.indexOf('const pinnedField') < EDITOR.indexOf('const signatureHover'))
})

test('Escape закрывает оба вида справки — и тогда, когда фокус ушёл из ячейки', () => {
  // Одна дверь на оба вида: по наведению и закреплённая Shift+Tab.
  assert.match(EDITOR, /effects: \[cm\.view\.closeHoverTooltips, pinned\.of\(null\)\]/)
  assert.match(EDITOR, /closeSignature\(view\)/)
  /*
   * Выделив мышью строку внутри окна, человек уводит фокус из ячейки — и
   * Escape перестаёт доходить до набора клавиш редактора. Замерено на стенде:
   * окно висело, пока не увести указатель. Слушатель на документе закрывает
   * эту щель и только её: пока фокус в редакторе, порядок разбирает сам
   * редактор.
   */
  assert.match(EDITOR, /document\.addEventListener\('keydown', onKey, true\)/)
  assert.match(EDITOR, /if \(event\.key !== 'Escape' \|\| view\.hasFocus\) return/)
  assert.match(EDITOR, /destroy: \(\) => document\.removeEventListener\('keydown', onKey, true\)/)
})

test('запуск ячейки стирает память справки — одним местом на все кнопки', () => {
  assert.match(SESSION, /message\.t === 'run' \|\| message\.t === 'restart'/)
  assert.match(SESSION, /forgetHelp\(\)/)
})
