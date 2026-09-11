/**
 * Комната на телефоне: ничто не уезжает за кромку экрана.
 *
 * Корень комнаты прячет переполнение, поэтому «не влезло» здесь выглядит не
 * полосой прокрутки, а ОТРЕЗАННЫМ: от кнопки «Скопировать» на 360 px
 * оставались две буквы, а обрыв связи («ВОССТАНАВЛИВАЕМ СВЯЗЬ» — 185 px
 * разрядки) уносил за правый край и её, и переключатель темы. Проверяется
 * поэтому не «красиво», а три правила, из которых красота следует:
 *
 *   1. полоса, которой не хватило ширины, ПЕРЕНОСИТСЯ, а не выталкивает;
 *   2. усыхает и обрезается то, что ЧИТАЮТ; то, что НАЖИМАЮТ, остаётся целым;
 *   3. кнопка, потерявшая подпись ради места, сохраняет имя для читалки.
 *
 * Читается прямо из компонентов, как в `panels-touch.test.mts`: тест со своей
 * копией правила проходит вечно, пока файл уезжает.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const SESSION = 'web/src/screens/SessionScreen.svelte'
const FILE_BAR = 'web/src/components/editor/FileBar.svelte'
const LECTURE = 'web/src/components/lecture/LectureView.svelte'

/** Полоса состояния комнаты — от `border-t border-brand-2` до конца шапки. */
function band(source: string): string {
  const at = source.indexOf('border-t border-brand-2')
  assert.notEqual(at, -1, 'полоса состояния на месте')
  // От самого тега, а не от найденного слова: класс полосы занимает две
  // строки, и `border-t` стоит в конце первой.
  return source.slice(source.lastIndexOf('<div', at), source.indexOf('</header>'))
}

/* ------------------------------------------------------------- переполнение */

test('корень комнаты режет, но не прокручивается вбок', () => {
  const session = code(read(SESSION))
  // `overflow-hidden` — это НЕВИДИМАЯ прокручиваемая коробка: браузер сам
  // уводит её вбок, показывая фокус на кнопке за краем, и комната остаётся
  // сдвинутой навсегда — вернуть её нечем. `clip` режет так же и коробки не
  // заводит.
  assert.match(session, /flex h-full min-h-0 flex-col overflow-clip bg-canvas/)
  assert.doesNotMatch(session, /flex h-full min-h-0 flex-col overflow-hidden/)
})

test('полоса состояния переносится, а не выталкивает содержимое', () => {
  const strip = band(code(read(SESSION)))
  // Восемь органов в одной строке — около 520 px при окне в 360.
  assert.match(strip, /flex-wrap/, 'полосе разрешено переноситься')
  assert.match(strip, /min-h-\[45px\]/, 'рост — нижняя граница, а не потолок')
  assert.doesNotMatch(strip, /\bflex-nowrap\b/, 'запрета на перенос нет ни на одной ширине')
  assert.doesNotMatch(
    strip.slice(0, strip.indexOf('{#if room.length')),
    /\sh-\[45px\]/,
    'жёсткого роста у полосы нет: вторая строка должна помещаться',
  )
})

test('кнопки комнаты переносятся одной группой и жмутся вправо', () => {
  const strip = band(code(read(SESSION)))
  const group = strip.slice(strip.indexOf('ml-auto flex shrink-0 items-center'))
  assert.notEqual(group, '', 'группа кнопок существует')
  // Порознь перенос рвал полосу по живому: переключатели в первой строке,
  // тема и «Скопировать» — во второй.
  for (const inside of ['aria-pressed={leftShown}', '<ThemeSwitch', 'onclick={copyLink}']) {
    assert.ok(group.includes(inside), `${inside} — внутри группы`)
  }
})

/* ------------------------------------------------- усыхает читаемое, не жмомое */

test('состояние связи усыхает многоточием, а не двигает соседей', () => {
  const strip = band(code(read(SESSION)))
  for (const key of ['room.ui.898', 'room.ui.899']) {
    const at = strip.indexOf(`title={tr('${key}')}`)
    assert.notEqual(at, -1, `${key}: фраза целиком осталась в title`)
    const block = strip.slice(strip.lastIndexOf('<div', at), strip.indexOf('</div>', at))
    assert.match(block, /min-w-0 shrink /, 'блок состояния усыхает')
    assert.doesNotMatch(block, /class="flex shrink-0 items-center gap-2 text-white"/)
    assert.match(block, /truncate text-2xs font-bold uppercase tracking-label/, 'слово с многоточием')
    assert.match(block, /size=\{12\} class="shrink-0/, 'значок не усыхает никогда')
  }
})

test('«Скопировать» на узкой полосе — значок с именем, а не две буквы', () => {
  const strip = band(code(read(SESSION)))
  const button = strip.slice(strip.indexOf('onclick={copyLink}'))
  // `sr-only`, а не `hidden`: кнопка с одним значком обязана остаться названной.
  assert.match(button, /class="sr-only text-2xs font-bold uppercase tracking-label sm:not-sr-only"/)
  assert.ok(!/class="hidden[^"]*"[^>]*>\s*\{copied/.test(button), 'подпись не выключена насовсем')
  assert.match(strip, /onclick=\{copyLink\}[\s\S]{0,200}title=\{tr\('room\.ui\.904'\)\}/, 'и title на месте')
})

test('полоса файла: усыхает причина отказа, а не кнопка «Запустить»', () => {
  const bar = code(read(FILE_BAR))
  assert.match(bar, /flex min-w-0 shrink items-center gap-2\.5/, 'правая половина усыхает')
  assert.doesNotMatch(bar, /flex shrink-0 items-center gap-2\.5 px-5/, 'прежнего shrink-0 нет')
  const why = bar.slice(bar.indexOf('title={mayEdit ? '))
  assert.match(why, /<span class="truncate">\{mayEdit \? /, 'фраза обрезается многоточием')
  assert.match(bar, /class="truncate text-2xs text-muted">\{user\.name\}/, 'имена соседей тоже')
})

test('полоса лекции: имя ведущего не выталкивает счётчик страниц', () => {
  const view = code(read(LECTURE))
  const at = view.indexOf("{tr('room.ui.297')}")
  assert.notEqual(at, -1, 'строка «идёт лекция» на месте')
  // От начала полосы, а не от найденной фразы: группа открывается выше неё.
  const row = view.slice(view.lastIndexOf('<div', at))
  assert.match(row, /<span class="flex min-w-0 flex-1 items-center gap-2">/, 'кто ведёт и что идёт — усыхают')
  assert.match(row, /<span class="shrink-0 font-mono tabular-nums">/, 'счётчик страниц цел')
})

/* ---------------------------------------------------------- высота и переносы */

test('пульт правил не выше окна, а прокручивается список внутри него', () => {
  const session = code(read(SESSION))
  const pult = session.slice(session.indexOf('fixed right-3 top-[104px]'))
  // В альбомной ориентации телефона (390 px высоты) «Закончить занятие»
  // оказывалось ниже кромки экрана, и домотать до него было нечем.
  assert.match(pult, /max-h-\[calc\(100dvh-7\.5rem\)\]/, 'лист не выше окна')
  assert.match(pult, /flex max-h-\[calc\(100dvh-7\.5rem\)\] flex-col/, 'колонка: шапка, список, подвал')
  assert.match(pult, /min-h-0 flex-1 overflow-y-auto px-4/, 'прокручивается список')
  assert.doesNotMatch(pult.slice(0, pult.indexOf('RoomRulesRows')), /max-h-\[min\(60vh,32rem\)\] overflow-y-auto/)
})

test('полоса «занятие закончено»: объяснение переносится целой строкой', () => {
  const session = code(read(SESSION))
  const banner = session.slice(session.indexOf('bg-warning/[0.08]'))
  // `flex-1` с нулевой основой брал остаток строки в 30 px и ставил фразу
  // в столбик по слову на строку.
  assert.match(banner, /class="min-w-0 flex-1 basis-56 text-2xs leading-snug text-muted"/)
})
