/**
 * Панель на телефоне: плашка идущего занятия, списки и переключатели.
 *
 * 19.09.2026 после семинара: «общий список занятий — там вот эта плашка лайва
 * на телефоне ломается». Ломалась она не случайно, а по устройству разметки, и
 * поэтому проверяется здесь, а не глазами на следующем семинаре.
 *
 * Заодно проверены четыре соседних экрана, на которых нашлось то же самое:
 * окружения (имя ужато в ноль, значок GPU поверх состояния, действие на 293px),
 * преподаватели (реестр в 600px минимума и абзац шириной в слово рядом с
 * неужимаемой кнопкой), переключатель правил (три сегмента `nowrap` = 311px) и
 * двери «откуда тетрадь» (потолок 182px от ряда, которого на телефоне нет).
 *
 * Плашка — ряд из трёх частей, и группа кнопок справа стоит `shrink-0`: ряд
 * умеет переноситься, но не умеет ужиматься. Измерено на стенде при экране
 * 390px — группа занимала 84…430px, то есть «Открыть» наполовину за краем, и
 * нажать его было нечем.
 *
 * Список — таблица с шестью колонками и минимумом в 600px: на 390 за краем
 * оставались дата, «входили», состояние и кнопка действий, а с нею «Правила»,
 * «Архивировать» и «Удалить». Коробка со своей боковой прокруткой ничем не
 * показывает, что она скроллится.
 *
 * Обе починки — один и тот же приём: `max-[640px]:` поверх прежних классов.
 * Прежние классы не тронуты ни одним правилом, поэтому стол остаётся ровно
 * таким, каким был, а телефон получает столбик и карточки. Вторая разметка для
 * телефона была бы вторым списком действий — и однажды один из них отстал бы
 * от другого, а в этом меню лежит «Удалить».
 *
 * Читается прямо из компонентов, как в `panels-craft.test.mts`: тест со своей
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
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** Переносы строк — дело форматирования, а не смысла. */
const flat = (source: string): string => source.replace(/\s+/g, ' ')

const SEMINARS = 'web/src/admin/screens/Seminars.svelte'
const PAGE = 'web/src/admin/ui/AdminPage.svelte'
const ENVIRONMENTS = 'web/src/admin/screens/Environments.svelte'
const TEACHERS = 'web/src/admin/screens/Teachers.svelte'
const RULES = 'web/src/components/RoomRulesRows.svelte'
const NEW_SEMINAR = 'web/src/admin/screens/NewSeminar.svelte'

const seminars = flat(code(read(SEMINARS)))
const page = flat(code(read(PAGE)))
const environments = flat(code(read(ENVIRONMENTS)))
const teachers = flat(code(read(TEACHERS)))
const rules = flat(code(read(RULES)))
const newSeminar = flat(code(read(NEW_SEMINAR)))

/**
 * Пиксели, которыми отмерена первая строка карточки.
 *
 * Одна мерка на три экрана: место под кнопку меню вычитается из ширины
 * названия, и вычтенное обязано сойтись с тем, что кнопка занимает. Числа
 * пишутся шагом Tailwind (`w-11` — это 44px), поэтому считаются, а не
 * переписываются в тест.
 */
const step = (n: string): number => Number(n) * 4

/** Плашка «идёт сейчас» целиком — от её `{#each}` до конца `</section>`. */
function plate(): string {
  const start = seminars.indexOf('{#each live as seminar')
  assert.notEqual(start, -1, 'плашка идущих занятий на месте')
  const end = seminars.indexOf('</section>', start)
  assert.notEqual(end, -1, 'у плашки есть конец')
  return seminars.slice(start, end)
}

/** Строка таблицы занятий — от её `{#each}` до закрывающего `</tr>`. */
function row(): string {
  const start = seminars.indexOf('{#each shown as seminar')
  assert.notEqual(start, -1, 'строки списка на месте')
  const end = seminars.indexOf('</tr>', start)
  assert.notEqual(end, -1, 'у строки есть конец')
  return seminars.slice(start, end)
}

/* ------------------------------------------------------------- плашка */

test('ниже 640 плашка идущего занятия складывается в столбик', () => {
  const live = plate()
  assert.match(live, /max-\[640px\]:flex-col/, 'ряд становится столбиком')
  // Иначе части остаются шириной по содержимому и жмутся к левому краю.
  assert.match(live, /max-\[640px\]:items-stretch/, 'каждая часть — во всю ширину')
  // 74px были не полом, а потолком ровно до тех пор, пока ряд помещался.
  assert.match(live, /max-\[640px\]:min-h-0/, 'высота плашки перестаёт быть заданной')
})

test('ряд действий плашки занимает строку целиком и не уезжает за край', () => {
  const live = plate()
  // `margin-left: auto` на элементе колоночного flex'а отменяет растяжение и
  // прижимает ряд к правому краю — ровно та поломка, от которой чинимся.
  assert.match(live, /max-\[640px\]:ml-0/, 'прижатие вправо снято')
  // Адрес занимает всё, что осталось от «Открыть», и ужимается многоточием.
  assert.match(live, /max-\[640px\]:flex-1/, 'кнопка адреса тянется')
  assert.match(live, /max-\[640px\]:min-w-0/, 'и умеет стать уже своего содержимого')
  assert.match(live, /max-\[640px\]:truncate/, 'адрес обрезается, а не распирает строку')
  // Хост на телефоне лишний: панель открыта на нём же, а в 278px строки он
  // съедает ровно то место, где стоит идентификатор комнаты.
  assert.match(live, /max-\[640px\]:hidden[^"]*">\{hostPathOf\(seminar\)\}/, 'хост уходит')
  assert.match(live, /\{pathOf\(seminar\)\}/, 'остаётся /s/…')
})

test('в плашке нажимают пальцем: обе цели — 44px', () => {
  const live = plate()
  const tall = [...live.matchAll(/max-\[640px\]:h-11/g)]
  assert.equal(tall.length, 2, 'и кнопка адреса, и «Открыть» ростом 44px')
})

test('длинное название в плашке читается двумя строками, а не третью одной', () => {
  const live = plate()
  assert.match(live, /max-\[640px\]:line-clamp-2/, 'две строки с обрезкой')
  // `truncate` держит `white-space: nowrap`, и без этого класса зажим в две
  // строки остаётся одной строкой — правило тихо ничего не делает.
  assert.match(live, /max-\[640px\]:whitespace-normal/, 'и перенос слов разрешён')
})

test('поля плашки и поля страницы — одно число', () => {
  // Плашка вылезает за колонку текста НАРОЧНО, во всю ширину экрана, и делает
  // это отрицательным полем. Разъехавшись с полем страницы, эти два числа дают
  // плашку, вылезающую за край на телефоне и не достающую до него на столе.
  assert.match(plate(), /-mx-7/, 'плашка растягивается на поля страницы')
  assert.match(page, /flex-1 overflow-auto px-7/, 'а поля страницы — 28px')
  assert.doesNotMatch(
    page,
    /max-\[\d+px\]:px-\d/,
    'и они одни на все ширины: своё поле на телефоне рассогласует плашку',
  )
})

/* -------------------------------------------------------------- список */

test('ниже 640 список занятий — карточки, а не таблица с обрезанными колонками', () => {
  assert.match(seminars, /table-fixed max-\[640px\]:block max-\[640px\]:min-w-0/, 'таблица разблокирована')
  assert.match(seminars, /<tbody class="max-\[640px\]:block">/, 'тело — тоже')
  assert.match(seminars, /<thead class=\{cn\('max-\[640px\]:hidden'/, 'шапка колонок уходит')
  const line = row()
  assert.match(line, /max-\[640px\]:flex max-\[640px\]:flex-wrap/, 'строка раскладывается флексом')
})

test('карточка собрана порядком ячеек: название и меню сверху, остальное под ними', () => {
  const line = row()
  // Шесть ячеек и шесть номеров: меню поднимается к названию, а не остаётся
  // шестым по счёту где-то под датой.
  const orders = [...line.matchAll(/max-\[640px\]:order-(\d)/g)].map((m) => Number(m[1]))
  assert.deepEqual([...orders].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6], 'каждая ячейка знает своё место')
})

test('первая строка карточки отмерена под кнопку меню, и оба числа — одно', () => {
  const line = row()
  // Подчёркивания — это пробелы: `calc(100%-44px)` без них не считается вовсе,
  // правило молча выпадает, и кнопка меню уезжает на вторую строку карточки.
  // Проверено на стенде: ровно так эта починка и сломалась в первый раз.
  const name = line.match(/max-\[640px\]:basis-\[calc\(100%_-_(\d+)px\)\]/)
  const menu = line.match(/max-\[640px\]:basis-(\d+)\b/)
  assert.ok(name, 'название занимает всё, кроме места под меню')
  assert.ok(menu, 'а меню — это место')
  // Разъехавшись, эти два числа переносят кнопку меню на вторую строку — под
  // окружение и дату, где её никто не ищет.
  assert.equal(Number(name[1]), Number(menu[1]) * 4, 'вычтенные пиксели и ширина меню сходятся')
})

test('на карточке нажимают пальцем: меню и адрес комнаты — 44px', () => {
  const line = row()
  assert.match(line, /max-\[640px\]:h-11 max-\[640px\]:w-11/, 'кнопка действий — 44×44')
  // 24px хватает мыши. Отрицательное поле рядом возвращает карточке рост, так
  // что цель растёт, а строка — нет.
  assert.match(line, /max-\[640px\]:min-h-\[44px\]/, 'адрес комнаты — цель, а не подпись')
})

test('на карточке видно, сколько человек в комнате прямо сейчас', () => {
  const line = row()
  // На столе это число стоит в своей колонке; на телефоне колонок нет, и
  // «идёт» без числа не отличает комнату с одним заглянувшим от потока.
  const chip = line.slice(line.indexOf("seminar.status === 'live'"))
  assert.match(chip, /·\s*\{seminar\.liveCount\}/, 'значок несёт число')
  assert.match(chip, /max-\[640px\]:inline/, 'и только на телефоне: на столе оно в своей колонке')
})

test('ни одно действие строки на телефоне не потеряно: разметка одна', () => {
  // Вторая разметка для телефона означала бы второй список действий. Здесь его
  // нет по построению — меню в файле ровно одно, и карточка открывает его же.
  const menus = [...seminars.matchAll(/role="menu"/g)]
  assert.equal(menus.length, 1, 'меню строки одно на оба вида')
  const copies = [...seminars.matchAll(/data-copy=\{seminar\.id\}/g)]
  assert.equal(copies.length, 1, 'и адрес комнаты в строке один')
  // И оно по-прежнему полно: открыть, переименовать, настройки, звонок,
  // публикация, архив, удалить.
  const items = [...seminars.matchAll(/role="menuitem"/g)]
  assert.ok(items.length >= 9, `пунктов меню ${items.length}, ожидалось не меньше девяти`)
})

/* --------------------------------------------------------------- шапка */

test('шапка экрана на телефоне — столбик во всю ширину', () => {
  const start = seminars.indexOf('{#snippet actions()}')
  const head = seminars.slice(start, seminars.indexOf('{/snippet}', start))
  const wide = [...head.matchAll(/max-\[640px\]:w-full/g)]
  assert.ok(wide.length >= 2, 'и поиск, и «Новое занятие» — во всю ширину')
  const tall = [...head.matchAll(/max-\[640px\]:h-11/g)]
  assert.ok(tall.length >= 2, 'и оба ростом с палец, а не с курсор')
  // Процент считается от родителя, а родитель ужимался по содержимому: без
  // ширины на нём `w-full` внутри — это процент от неизвестного числа.
  assert.match(page, /flex-wrap items-center gap-2 max-\[640px\]:w-full/, 'ряд действий знает свою ширину')
})

/* -------------------------------------------------------- окружения */

/** Строка окружения — от её `{#each}` до конца шапки карточки. */
function envRow(): string {
  const start = environments.indexOf('{#each envs.environments as env')
  assert.notEqual(start, -1, 'список окружений на месте')
  const end = environments.indexOf('{#if env.packages.length > 0', start)
  assert.notEqual(end, -1, 'у шапки карточки есть конец')
  return environments.slice(start, end)
}

test('ниже 640 строка окружения переносится, а не давит имя в ноль', () => {
  const row = envRow()
  assert.match(row, /max-\[640px\]:flex-wrap/, 'ряд умеет перенестись')
  assert.match(row, /max-\[640px\]:items-start/, 'и части выравниваются по верху')
  // Имя стояло `flex-1` среди `shrink-0`: ужималось только оно, и на 390px его
  // не было видно вовсе.
  assert.match(row, /max-\[640px\]:line-clamp-2/, 'имя читается двумя строками')
  assert.match(row, /min-\[641px\]:truncate/, 'а на столе — одной, как было')
  assert.match(row, /max-\[640px\]:whitespace-normal/, 'строка фактов переносится, а не обрезается')
})

test('значок GPU не налезает на состояние: строке имени разрешено перенестись', () => {
  const row = envRow()
  // Значок `shrink-0` внутри ужатой до нуля строки печатался поверх соседа.
  const nameLine = row.slice(row.indexOf('{env.name}') - 400, row.indexOf('GPU') + 10)
  assert.match(nameLine, /max-\[640px\]:flex-wrap/, 'значок уходит на свою строку, а не поверх чужой')
  assert.match(nameLine, /max-\[640px\]:min-w-0/, 'и имя рядом с ним умеет стать уже')
})

test('первая строка карточки окружения отмерена под кнопку меню', () => {
  const row = envRow()
  const name = row.match(/max-\[640px\]:basis-\[calc\(100%_-_(\d+)px\)\]/)
  assert.ok(name, 'имя занимает всё, кроме места под квадрат, зазоры и меню')
  const swatch = row.match(/class="h-2\.5 w-(2\.5) shrink-0/)
  const gap = row.match(/max-\[640px\]:gap-x-(\d+)/)
  const menu = row.match(/max-\[640px\]:h-11 max-\[640px\]:w-(11)\b/)
  assert.ok(swatch && gap && menu, 'квадрат, зазор и меню названы числами')
  // Квадрат + зазор + зазор + меню. Разъехавшись, эти числа переносят кнопку
  // меню под имя — то самое место, где её никто не ищет.
  const vacated = step(swatch[1]) + step(gap[1]) * 2 + step(menu[1])
  assert.equal(Number(name[1]), vacated, `вычтено ${name[1]}px, занято ${vacated}px`)
})

test('состояния и действие окружения уходят под имя, а не за край экрана', () => {
  // Одним номером у общей константы, а не у каждой плашки по месту: плашек
  // шесть на пять ветвей, и разъехаться они могут только все сразу.
  assert.match(environments, /const PILL =[^;]*max-\[640px\]:order-1/, 'плашки — во вторую строку')
  const action = environments.match(/const ROW_ACTION =[\s\S]*?'\s*(?=\/\*|const|let|\n\s*\/\*\*)/)
  assert.ok(action, 'у действия строки одна константа на обе ветви')
  for (const rule of [
    'max-\\[640px\\]:order-1',
    'max-\\[640px\\]:w-full',
    'max-\\[640px\\]:h-auto',
    'max-\\[640px\\]:min-h-\\[44px\\]',
  ]) {
    assert.match(action[0], new RegExp(rule), `${rule} у кнопки действия`)
  }
  // «Использовать по умолчанию» — 293px в одну строку, и держала их жёсткая
  // высота 32px. Два правила, и оба обязаны стоять вместе.
  assert.match(environments, /const ROW_ACTION =[\s\S]*?max-\[640px\]:py-2/, 'текст в две строки дышит')
  // И ровно один раз: длинная строка классов, скопированная во вторую ветвь,
  // — это две кнопки, расходящиеся на первой же правке.
  assert.equal([...environments.matchAll(/class=\{ROW_ACTION\}/g)].length, 2, 'обе ветви берут её')
})

/* ----------------------------------------------------- преподаватели */

test('ниже 640 реестр преподавателей — карточки, а не полосы за краем', () => {
  assert.match(teachers, /min-w-\[600px\] max-\[640px\]:min-w-0/, '600px минимума сняты')
  assert.match(
    teachers,
    /sticky top-0 z-10 flex h-9 items-center border-b border-line bg-canvas max-\[640px\]:hidden/,
    'шапка полос уходит вместе с полосами',
  )
  assert.match(teachers, /min-h-\[66px\] items-center border-b border-line-soft max-\[640px\]:flex-wrap/, 'строка переносится')
  // Одной константой на три полосы: роль, ссылка и последний вход ведут себя
  // одинаково, и разойтись они могут только вместе.
  assert.match(teachers, /const PHONE_LANE = '[^']*max-\[640px\]:order-1[^']*max-\[640px\]:w-full/, 'полосы — каждая своей строкой')
  for (const col of ['COL_ROLE', 'COL_LINK', 'COL_SEEN']) {
    assert.match(teachers, new RegExp(`const ${col} = \`[^\`]*\\$\\{PHONE_LANE\\}\``), `${col} берёт её`)
  }
})

test('первая строка карточки преподавателя отмерена под кнопку меню', () => {
  const person = teachers.match(/const COL_PERSON =[\s\S]*?max-\[640px\]:basis-\[calc\(100%_-_(\d+)px\)\]/)
  const menu = teachers.match(/const COL_MENU = 'w-10 shrink-0 max-\[640px\]:w-(\d+)'/)
  assert.ok(person && menu, 'человек и меню названы числами')
  assert.equal(Number(person[1]), step(menu[1]), 'вычтенные пиксели и ширина меню сходятся')
})

test('подписи полос переезжают в карточку теми же словами, что в шапке', () => {
  // Замаскированная строка точек и «никогда» без подписи не говорят, чего они
  // «никогда» и что это за точки: шапка полос на телефоне спрятана.
  const lanes = [...teachers.matchAll(/@render lane\(tr\("([^"]+)"\)\)/g)].map((m) => m[1])
  assert.equal(lanes.length, 3, 'подписаны роль, ссылка и последний вход')
  const head = teachers.slice(teachers.indexOf('sticky top-0'), teachers.indexOf('{#if listError}'))
  const heading = [...head.matchAll(/@render eyebrow\(tr\("([^"]+)"\)\)/g)].map((m) => m[1])
  for (const key of lanes) {
    assert.ok(heading.includes(key), `${key} — то же слово, что у полосы в шапке`)
  }
  // И только на телефоне: на столе подпись стоит в шапке, и вторая её копия
  // в каждой строке — это шум на всю таблицу.
  assert.match(teachers, /\{#snippet lane\(text: string\)\}\s*<span class="mb-1 hidden max-\[640px\]:block">/, 'подпись видна только ниже 640')
})

test('на карточке преподавателя нажимают пальцем: обе кнопки — 44×44', () => {
  const targets = [...teachers.matchAll(/max-\[640px\]:h-11 max-\[640px\]:w-11/g)]
  assert.equal(targets.length, 2, 'копирование ссылки и меню строки')
})

test('секция «Токен настройки» складывается в столбик, а не в колонку по слову', () => {
  const start = teachers.indexOf('admin.setup.token')
  const section = teachers.slice(start - 400, start + 200)
  // `flex-1` — это `flex-basis: 0`: текст просил НОЛЬ ширины, переноса не
  // случалось, и на 390px ему доставалось восемь пикселей рядом с неужимаемой
  // кнопкой, а заглавная подпись печаталась поверх неё.
  assert.match(section, /flex-1 max-\[640px\]:basis-full/, 'текст просит всю ширину')
  assert.match(teachers, /btn-outline shrink-0 max-\[640px\]:h-11 max-\[640px\]:w-full/, 'кнопка встаёт под ним, во всю ширину')
})

/* --------------------------------------------- переключатель правил */

test('ниже 640 сегменты правила встают столбиком и не срезаются краем', () => {
  // Три сегмента с `white-space: nowrap` — это 311px, а строке на 390px-экране
  // остаётся 278: группа стоит `shrink-0`, и правый сегмент срезало.
  assert.match(rules, /flex shrink-0 border border-line max-\[640px\]:w-full max-\[640px\]:flex-col/, 'группа становится столбиком')
  const phone = rules.slice(rules.indexOf('@media (max-width: 640px)'))
  assert.ok(phone, 'у сегментов есть телефонное правило')
  assert.match(phone, /border-right: 0/, 'правая рамка снята')
  assert.match(phone, /border-bottom: 1px solid rgb\(var\(--line\)\)/, 'и заменена нижней')
  assert.match(phone, /\.rule-seg:last-child \{ border-bottom: 0/, 'кроме последнего — иначе двойная черта снизу')
  assert.match(phone, /height: 44px/, 'и рост — под палец, а не под курсор')
})

test('порог переключателя один: класс раскладки и media-правило рамок', () => {
  // Колонка с правыми рамками рисует черту вдоль правого края, строка с
  // нижними — полоску под каждой кнопкой. Разойдясь, эти два порога дают
  // ширину, на которой видно и то, и другое.
  const layout = rules.match(/max-\[(\d+)px\]:flex-col/)
  const borders = rules.match(/@media \(max-width: (\d+)px\)/)
  assert.ok(layout && borders, 'оба порога названы числом')
  assert.equal(layout[1], borders[1], 'и это одно число')
})

/* ------------------------------------------------ новое занятие */

test('двери «откуда тетрадь» на телефоне — во всю ширину, а не в свои 182px', () => {
  // Потолок в 182px — мерка ряда из трёх дверей, а ряда на телефоне нет:
  // двери вставали в столбик, но каждая с мёртвым полем справа.
  assert.match(newSeminar, /const DOOR =[\s\S]*?max-\[640px\]:max-w-none/, 'потолок снят')
  assert.match(newSeminar, /const DOOR =[\s\S]*?max-\[640px\]:basis-full/, 'и дверь просит всю ширину')
})
