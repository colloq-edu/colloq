/**
 * Мелочи панелей, которые видно только глазами — и поэтому они тихо ломаются.
 *
 * Всё здесь — про разметку и стили, у которых нет ни чистой функции, ни
 * сокета: размер цели под палец, гарнитура ящика, отклик на нажатие, второй
 * щелчок по имени файла. Проверять это в браузере на каждой правке никто не
 * будет, а откатывается оно одной строкой — ровно так каждая из этих находок и
 * появилась. Читается прямо из компонентов: тест со своей копией правила
 * проходит вечно, пока файл уезжает.
 *
 * Тот же приём, что и в `terminal-palette.test.mts`, и по той же причине.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка и стили без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const TERMINAL = 'web/src/components/panels/TerminalDrawer.svelte'
const HISTORY = 'web/src/components/panels/HistoryTab.svelte'
const FILES = 'web/src/components/panels/FilesPanel.svelte'
const AI = 'web/src/components/panels/AiPanel.svelte'
const BAN = 'web/src/components/panels/BanMenu.svelte'
const STRIP = 'web/src/components/council/CouncilStrip.svelte'
const ORACLE = 'web/src/components/council/CouncilOracle.svelte'
const RULES = 'web/src/components/RoomRulesRows.svelte'

/* ------------------------------------------------------------- гарнитуры */

test('ящик набран гарнитурами продукта, а не теми, которых в нём нет', () => {
  const term = read(TERMINAL)
  // Inter никто не грузит: @font-face в index.html объявлены для 'HSE Sans' и
  // для шрифта кода, и ни одного — для Inter. Вкладки ящика падали в системный
  // шрифт рядом с той же надписью в панели.
  assert.match(term, /--tm-sans:\s*'HSE Sans'/, "--tm-sans начинается с 'HSE Sans'")

  const hist = code(read(HISTORY))
  /*
   * Моношрифт истории — общий с расшифровкой над ней, иначе время уезжает в
   * системный SF Mono рядом с JetBrains Mono. Имя переменной здесь не важно и
   * не проверяется: раньше общим был --tm-mono самого ящика, дальше им станет
   * --font-mono продукта (web/src/index.css), где к настоящему шрифту
   * дописаны подменные семейства с правками метрик. Важно одно — что
   * переменная одна на обе поверхности.
   */
  const mono = /font-family:\s*var\((--tm-mono|--font-mono)\)/.exec(hist)
  assert.ok(mono, 'моношрифт истории объявлен не переменной')
  assert.match(
    code(term),
    new RegExp(`var\\(${mono![1]}\\)`),
    'моношрифт истории — общий с ящиком',
  )
})

/* ------------------------------------------------------------- пол кегля */

test('всё, что в ящике нажимают, набрано не мельче 11px', () => {
  const term = code(read(TERMINAL))
  const hist = code(read(HISTORY))
  // 10px — для того, что читают один раз и не нажимают (tailwind.config.js).
  // Вкладки, действия и две кнопки истории — самые нажимаемые контролы ящика.
  for (const [name, source, cls] of [
    ['вкладка', term, '.term-tab'],
    ['действие', term, '.term-act'],
    ['«завести оболочку»', term, '.term-revive'],
    ['кнопки истории', hist, '.hist-go,\n  .hist-mini'],
  ] as const) {
    const block = source.slice(source.indexOf(cls))
    const size = /font-size:\s*([\d.]+)px/.exec(block)
    assert.ok(size, `${name}: не нашли кегль`)
    assert.ok(Number(size[1]) >= 11, `${name} набрано ${size[1]}px — ниже пола для нажимаемого`)
  }
})

/* --------------------------------------------------------------- цели */

test('ручка ящика и его действия — не тоньше пальца', () => {
  const term = code(read(TERMINAL))
  const grip = /\.term-grip\s*{[^}]*height:\s*(\d+)px/.exec(term)
  assert.ok(grip, 'у ручки есть высота')
  assert.ok(Number(grip[1]) >= 12, `ручка ${grip[1]}px: тянут за неё мышью и пером`)

  const act = /\.term-act\s*{[^}]*min-height:\s*(\d+)px/.exec(term)
  assert.ok(act, '«Очистить» и крестик получили минимальную высоту')
  assert.ok(Number(act[1]) >= 24, 'пол 24px — тот же, что цитирует тетрадь')
})

test('сегменты полосы групп нажимаются пальцем, а рисуются прежними', () => {
  const strip = code(read(STRIP))
  // Кнопка выросла до 24px отрицательным полем, полоса внутри осталась 12px:
  // 8×12 — вдвое меньше пола 2.5.8, и на планшете в неё не попасть.
  assert.match(strip, /-my-1\.5[^']*h-6/, 'кнопка — 24px с отрицательным полем')
  assert.match(strip, /min-w-\[16px\]/, 'и не уже шестнадцати')
  assert.match(strip, /h-3 w-full border-b-2/, 'сама полоса по-прежнему 12px')
})

test('«как на инстансе» — кнопка, а не строчка текста высотой в буквы', () => {
  const rules = code(read(RULES))
  const clear = rules.slice(rules.indexOf('.rule-clear'))
  assert.match(clear, /min-height:\s*24px/, 'у ссылки-кнопки есть цель')
})

/* ------------------------------------------------------------- движение */

test('правила комнаты берут скорость и кривую из лестницы, а не из литералов', () => {
  const rules = code(read(RULES))
  assert.doesNotMatch(rules, /100ms ease-out/, 'литеральных «100ms ease-out» не осталось')
  assert.match(rules, /var\(--speed-quick\)/, 'цвет — по --speed-quick')
  assert.match(rules, /var\(--speed-press\) var\(--ease-out\)/, 'форма — по --speed-press')
})

test('полоса ожидания консилиума бежит, а не мигает на месте', () => {
  const oracle = code(read(ORACLE))
  // animate-pulse двигает одну opacity: треть дорожки стояла слева и тускнела,
  // а остановившийся указатель читается как зависший.
  assert.doesNotMatch(oracle, /animate-pulse/, 'pulse убран')
  assert.match(oracle, /@keyframes council-run/, 'есть своя петля')
  assert.match(oracle, /translateX\(300%\)/, 'и она проходит дорожку насквозь')
  assert.doesNotMatch(
    /@keyframes council-run[\s\S]*?}\s*}/.exec(oracle)?.[0] ?? '',
    /(width|left|opacity):/,
    'только transform — иначе кадр стоит layout',
  )
})

test('история не рвёт нажатие под reduced-motion', () => {
  const hist = code(read(HISTORY))
  // Прежний блок снимал transform из списка переходов и оставлял сам
  // scale(0.97): щелчок туда и обратно без перехода — рывок вместо движения.
  assert.doesNotMatch(hist, /prefers-reduced-motion/, 'своего блока у истории нет')
})

/* ---------------------------------------------------------------- жесты */

test('второй щелчок по имени файла не открывает и не скачивает второй раз', () => {
  const files = code(read(FILES))
  // На имени висит и `pick`, и переименование по двойному щелчку: два нажатия
  // давали два билета и два a.click() — датасет на гигабайт двумя копиями.
  assert.match(files, /function pick\(entry: FileEntry, detail = 1\)/)
  assert.match(files, /if \(detail > 1\) return/)
  assert.match(files, /onclick=\{\(event\) => pick\(entry, event\.detail\)\}/)
})

test('пока бан уходит на сервер, окно не закрывается ни Escape, ни подложкой', () => {
  const ban = code(read(BAN))
  // «Отмена» была погашена, а Escape уносил окно: человек видел, что передумал,
  // и через мгновение участник оказывался удалён.
  assert.match(ban, /function close\(\): void \{\s*if \(busy\) return/)
  // Успешный бан закрывает окно мимо жестового выхода: busy снимается позже.
  assert.match(ban, /dismiss\(\)/)
})

test('повтор вопроса несёт все ячейки, о которых спрашивали', () => {
  const ai = code(read(AI))
  const retry = ai.slice(ai.indexOf('function retry('), ai.indexOf('async function stop('))
  assert.match(retry, /cellIds: \[\.\.\.entry\.cellIds\]/, 'иначе повтор теряет всё, кроме первой')
})

test('отказ сервера возвращает текст вопроса в поле, а не только слоу-мод', () => {
  const ai = code(read(AI))
  const ask = ai.slice(ai.indexOf('async function ask('), ai.indexOf('let doing ='))
  const back = ask.indexOf('composing.question = body.message')
  const slow = ask.indexOf('err.retryAfter !== null')
  assert.ok(back > 0, 'возврат текста в поле есть')
  assert.ok(back < slow, 'и стоит ДО разбора причины: причина на это не влияет')
})

test('неудачная выборка состояния оракула не выдаётся за решение админа', () => {
  const ai = code(read(AI))
  const fetchBlock = ai.slice(ai.indexOf('api\n      .aiStatus()'), ai.indexOf('// The notebook asks'))
  assert.doesNotMatch(fetchBlock, /mode: 'off'/, "'off' говорит только сервер")
  assert.match(fetchBlock, /status = null/, 'на ошибке — «ещё не знаем»')
  assert.match(fetchBlock, /statusFailed = true/)
})
