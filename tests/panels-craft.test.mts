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
import { roomMessages } from '../shared/locales/room.js'

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
const RULES = 'web/src/components/RoomRulesRows.svelte'
const ANSWER = 'web/src/components/panels/AnswerBody.svelte'
const TURN = 'web/src/components/panels/ChatTurn.svelte'
const CODE = 'web/src/components/ui/Code.svelte'
const CSS = 'web/src/index.css'
const RENDER = 'web/src/lib/render.svelte.ts'

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

test('«как на инстансе» — кнопка, а не строчка текста высотой в буквы', () => {
  const rules = code(read(RULES))
  const clear = rules.slice(rules.indexOf('.rule-clear'))
  assert.ok(Number(clear.match(/min-height:\s*(\d+)px/)?.[1]) >= 24, 'у ссылки-кнопки есть цель не меньше 24px')
})

/* ------------------------------------------------------------- движение */

test('правила комнаты берут скорость и кривую из лестницы, а не из литералов', () => {
  const rules = code(read(RULES))
  assert.doesNotMatch(rules, /100ms ease-out/, 'литеральных «100ms ease-out» не осталось')
  assert.match(rules, /var\(--speed-quick\)/, 'цвет — по --speed-quick')
  assert.match(rules, /var\(--speed-press\) var\(--ease-out\)/, 'форма — по --speed-press')
})

test('история не рвёт нажатие под reduced-motion', () => {
  const hist = code(read(HISTORY))
  // Прежний блок снимал transform из списка переходов и оставлял сам
  // scale(0.97): щелчок туда и обратно без перехода — рывок вместо движения.
  assert.doesNotMatch(hist, /prefers-reduced-motion/, 'своего блока у истории нет')
})

/* ------------------------------------------------- лента оракула и ширина */

/**
 * Правило одно: лента оракула вбок не ездит.
 *
 * Оракул отвечает кодом внутри предложения, и `data['GarageYrBlt'] =
 * data['GarageYrBlt'].fillna(data['GarageYrBlt'].median())` — одно слово для
 * переносчика строк. При `overflow-wrap: normal` оно вылезало за край колонки
 * на 78 px, а окно прокрутки ленты предлагало эти 78 px пролистать: панель
 * качалась влево-вправо на каждом касании трекпада. Горизонтально едут ровно
 * две вещи, и обе внутри себя, — блок кода и широкая таблица.
 */
test('проза переносит длинное слово, а не растягивает колонку', () => {
  const css = code(read(CSS))
  const prose = css.slice(css.indexOf('.prose-note {'), css.indexOf('.prose-answer {'))
  assert.match(prose, /overflow-wrap:\s*anywhere/, 'у .prose-note перенос «где угодно»')

  // `anywhere`, а не `break-word`: только он входит в расчёт минимальной
  // ширины содержимого, то есть строка не распирает ни колонку, ни flex-предка.
  const inline = css.slice(css.indexOf('.prose-note code {'))
  assert.match(
    inline.slice(0, inline.indexOf('}')),
    /box-decoration-break:\s*clone/,
    'фон инлайнового кода не разваливается на переносе',
  )

  // Вопрос человека — там же: строка пути или адреса без единого пробела.
  assert.match(code(read(TURN)), /\[overflow-wrap:anywhere\]/, 'вопрос переносится «где угодно»')
})

test('вбок едут только блок кода и таблица — каждый внутри себя', () => {
  const css = code(read(CSS))
  for (const rule of ['.prose-note pre {', '.prose-note .table-scroll {']) {
    const block = css.slice(css.indexOf(rule)).slice(0, 200)
    assert.match(block, /overflow-x-auto/, `${rule} прокручивается сам`)
    assert.match(block, /max-w-full/, `${rule} не шире колонки`)
    // Иначе жест, доехавший до конца строки, продолжается лентой и страницей.
    assert.match(block, /overscroll-x-contain/, `${rule} не раскачивает ленту`)
  }
  // Обёртку таблице markdown не даёт — её ставит рендерер, после санитайзера.
  assert.match(code(read(RENDER)), /className = 'table-scroll'/, 'таблица едет в обёртке')

  const block = code(read(CODE))
  assert.match(
    block,
    /max-w-full overflow-x-auto overscroll-x-contain whitespace-pre/,
    'блок кода в ответе прокручивается сам и не шире хода',
  )
})

test('у ленты оракула нет горизонтальной прокрутки', () => {
  const ai = code(read(AI))
  // `overflow-y: auto` в одиночку означает `overflow-x: auto` — так написано в
  // спецификации, и именно так лента получала прокрутку вбок от любого слова,
  // вылезшего за край. Страховка поверх лечения, а не вместо него.
  assert.match(
    ai,
    /bind:this=\{scroller\}[\s\S]{0,120}overflow-y-auto overflow-x-hidden/,
    'окно прокрутки ленты закрыто по горизонтали',
  )
  // И то же самое у двух коробок со своей вертикальной прокруткой внутри хода.
  const turn = code(read(TURN))
  assert.doesNotMatch(
    turn,
    /overflow-y-auto(?! overflow-x-hidden)/,
    'у каждой прокручиваемой коробки хода закрыта горизонталь',
  )

  // Обёртка ответа — flex-колонка: без min-width: 0 её минимум равен ширине
  // содержимого, и один широкий блок растянул бы весь ход вместе с лентой.
  assert.match(code(read(ANSWER)), /cn\('flex min-w-0 flex-col gap-2\.5'/, 'ответ не распирается')
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

test('цель для файлов живёт, пока папка открыта: свернул — вернулась к родителю', () => {
  const files = code(read(FILES))
  const toggle = files.slice(files.indexOf('function toggle(path: string)'), files.indexOf('function pick('))
  // Открытая папка — цель, закрытая — нет; закрыть папку над целью значит
  // поднять цель к её родителю. Иначе снять «Файлы — в папку …» было нечем,
  // кроме как открыть файл рядом.
  assert.match(toggle, /next\.add\(path\)\s*target = path/, 'раскрытие делает папку целью')
  assert.match(
    toggle,
    /target\.startsWith\(`\$\{path\}\/`\)\) target = parentOf\(path\)/,
    'сворачивание поднимает цель к родителю',
  )
  const pick = files.slice(files.indexOf('function pick(entry: FileEntry'), files.indexOf('function startDraft('))
  assert.doesNotMatch(pick, /if \(entry\.dir\) \{\s*target = entry\.path/, 'папке цель ставит только toggle')
  // Подпись внизу в обоих состояниях называет место, а не правило комнаты:
  // «доступны всей группе» рядом с «в папку data» читалось как второй режим.
  const catalog = roomMessages as Record<string, { ru: string; en: string }>
  for (const key of ['room.ui.607', 'room.ui.608']) {
    assert.ok(catalog[key].ru.startsWith('Файлы — '), key)
    assert.ok(catalog[key].en.startsWith('Files — '), key)
  }
  assert.match(files, /title=\{may\.files \? tr\('room\.extra\.461'\) : undefined\}/, 'правило — подсказкой')
})
