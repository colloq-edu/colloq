import { translate, tr } from '../shared/i18n.js'
/**
 * Мелочи тетради, которые видно только глазами, — и одно слово, без которого
 * консилиум врёт.
 *
 * Правила, каждое откатывается одной строкой и каждое об этом молчит: кнопка
 * «Запустить» над файлом переводит переход шорткатом `transition` (все
 * свойства, включая кольцо фокуса) вместо позиционного списка; «кто запускал»
 * ищется перебором по всем вкладкам комнаты в КАЖДОЙ ячейке с выводом; про
 * общее ядро попыток не сказано там, где ручку включают; состояние ядра
 * уезжает в прокрутку полосы, а счётчик ячеек снова прячется медиазапросом
 * про окно, которое не знает ни про панели, ни про зум.
 *
 * Читается прямо из компонентов — тот же приём, что в panels-craft: тест со
 * своей копией правила проходит вечно, пока файл уезжает.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { COUNCIL_SHARED_KERNEL_NOTE } from '../shared/notebook.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка и стили без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const CELL = read('web/src/components/notebook/CellView.svelte')
const FILEBAR = read('web/src/components/editor/FileBar.svelte')
const NOTEBOOK = read('web/src/components/notebook/Notebook.svelte')

/* ------------------------------------------------------------- переходы */

test('«Запустить» над файлом переводит два свойства, а не все подряд', () => {
  const bar = code(FILEBAR)
  // `transition` без списка переводит и border-color, и box-shadow: кольцо
  // фокуса приезжало вслед за клавишей вместо того, чтобы появиться сразу.
  assert.doesNotMatch(bar, /class="[^"]*\btransition\s/, 'шорткат `transition` вернулся')
  assert.match(bar, /transition-\[filter,transform\]/, 'список свойств — позиционный')
  // Лестница скоростей и кривых (index.css) существует ровно чтобы литералов
  // вроде «100ms ease-out» тут не было.
  assert.match(bar, /duration-press ease-out/, 'скорость и кривая — из лестницы')
  // Нажимаемое отвечает пальцу: тот же press, что у близнеца этой кнопки —
  // «На общий экран» в SessionScreen.
  assert.match(bar, /enabled:active:scale-\[0\.97\]/, 'кнопка не прессуется')
})

/* --------------------------------------------------------- присутствие */

test('«кто запускал» спрашивается по карте, а не перебором по всей комнате', () => {
  const at = CELL.indexOf('const runner = $derived.by')
  assert.ok(at > 0, 'лица запускавшего в ячейке больше нет')
  const runner = CELL.slice(at, at + 300)
  assert.match(runner, /session\.peersById\.get\(who\)/)
  // Двести ячеек на пятьсот вкладок — сто тысяч сравнений на кадр присутствия.
  assert.doesNotMatch(code(CELL), /session\.peers\.find\(/, 'перебор по вкладкам вернулся')
})

/* ------------------------------------------------------------ общее ядро */

test('про общее ядро сказано у кнопки попытки — и там, где ручку включают', () => {
  // Одна копия на весь продукт: строка живёт в shared, а не переписана здесь
  // своими словами — иначе подсказка кнопки и ручка разъедутся.
  assert.match(CELL, /COUNCIL_SHARED_KERNEL_NOTE/)
  assert.doesNotMatch(CELL, /Попытки считаются в общем ядре/, 'строка переписана копией')

  // Ручка «кто может запускать» уехала из меню замка в полосу очереди пульта,
  // и строка уехала вместе с ней: council-strip-note.test.mts.
  assert.doesNotMatch(CELL, /tr\('room\.ui\.335'\)/, 'ручка studentRun вернулась в тетрадь')

  const run = CELL.indexOf("tr('room.extra.138'")
  assert.ok(run > 0, 'кнопки запуска попытки больше нет')
  assert.match(
    CELL.slice(run - 200, run + 300),
    /p0: tr\(COUNCIL_SHARED_KERNEL_NOTE\)/,
    'подсказка кнопки — про очередь, а не про состояние',
  )
})

test('строка про общее ядро говорит и про снятые имена, и про общие данные', () => {
  // Сервер снимает имена, заведённые попыткой (kernel/index.ts ·
  // COUNCIL_SNAPSHOT_NAMES), но изменённые данные остаются общими — фраза
  // описывает ровно это, иначе она обещала бы изоляцию, которой нет.
  assert.match(tr(COUNCIL_SHARED_KERNEL_NOTE), /по очереди/)
  assert.match(tr(COUNCIL_SHARED_KERNEL_NOTE), /удаляются после запуска/)
  assert.match(tr(COUNCIL_SHARED_KERNEL_NOTE), /общих объектов и файлов сохраняются/)
})

/* ------------------------------------------------------- полоса тетради */

test('состояние ядра в полосе стоит вне прокрутки и не режется', () => {
  const bar = code(NOTEBOOK)
  // Правый угол — отдельный слот, а не хвост прокручиваемого ряда: пока он
  // лежал внутри `overflow-x-auto`, «ядро остановлено» уезжало за край вместе
  // с «Форматировать», а затухание, намекающее на прокрутку, гасило ровно его.
  const scroller = bar.indexOf('overflow-x-auto')
  const corner = bar.indexOf('max-w-[70%]')
  assert.ok(scroller > 0 && corner > scroller, 'правый угол полосы пропал или вернулся в прокрутку')
  const cornerClass = bar.slice(bar.lastIndexOf('class=', corner), bar.indexOf('>', corner))
  assert.doesNotMatch(cornerClass, /mask-image/, 'угол с состоянием снова под градиентом')
  assert.doesNotMatch(cornerClass, /overflow-x/, 'угол с состоянием снова прокручивается')

  // Плашка гнётся, слово в ней уходит в многоточие, а целиком живёт в title:
  // `shrink-0` возвращал негнущуюся коробку, которую срезал `contain: paint`.
  assert.match(bar, /const PILL = '[^']*min-w-0/, 'плашка снова негнущаяся')
  assert.doesNotMatch(bar, /const PILL = '[^']*shrink-0/, 'плашка снова негнущаяся')
})

test('счётчик ячеек уступает ступенями, а не по медиазапросу', () => {
  const bar = code(NOTEBOOK)
  // `xl:` — про ширину окна, а полосу сужают панели и зум браузера, про
  // которые окно ничего не знает: счётчик пропадал на широком экране с
  // открытым терминалом и держался на узком с закрытыми панелями.
  assert.doesNotMatch(bar, /xl:inline/, 'счётчик снова прячется медиазапросом')
  assert.match(bar, /bind:clientWidth=\{barWidth\}/, 'полоса больше не меряет себя')
  // Три ступени: полная строка → одно число с подсказкой → ничего.
  assert.match(
    bar,
    /countMode === 'short'\s*\?\s*tr\('room\.notebook\.cellCount'/,
    'у числа пропала подсказка',
  )
  for (const step of ["return 'full'", "return 'short'", "return 'none'"]) {
    assert.ok(bar.includes(step), `ступень ${step} пропала`)
  }
})

test('якорь не меряет спрятанную вкладку, и ход после запуска идёт через один расчёт', () => {
  const settle = NOTEBOOK.slice(NOTEBOOK.indexOf('function settle(): void'))
  const body = settle.slice(0, settle.indexOf('\n  }'))
  /*
   * Проверка обязана стоять ДО первого измерения: отравляет не поправка, а
   * память высот — один записанный ноль уводит экран на следующем кадре, когда
   * тетрадь уже видна. Поэтому ищем `measurable` раньше, чем `slotHeights.set`.
   */
  const guard = body.indexOf('measurable(')
  assert.ok(guard > 0, 'якорь снова меряет всё подряд, включая спрятанную вкладку')
  assert.ok(guard < body.indexOf('slotHeights.set'), 'ноль успевает попасть в память высот')

  // Арифметика хода живёт в cell-scroll (там тесты и там обе жалобы), а не
  // вторым списком чисел в компоненте.
  const show = code(NOTEBOOK).slice(code(NOTEBOOK).indexOf('function show(id: string)'))
  assert.match(show.slice(0, 500), /afterRun\(frameOf\(box\), boxOf\(cell\)\)/)
  assert.doesNotMatch(
    show.slice(0, 500),
    /scrollTo\(/,
    'плавный ход мимо steerTo не обрывается чужой прокруткой',
  )
})

test('за «Запустить всё» лист не ходит вовсе, а увёзший его сам остаётся хозяином', () => {
  const body = code(NOTEBOOK)

  /*
   * Прогон отличается от одиночного запуска ПИКОМ очереди, а не текущей её
   * длиной: к концу «Запустить всё» очередь пуста, и последняя ячейка по ней
   * неотличима от одиночной — лист дёргался бы ровно один раз, напоследок.
   * И решение принимается синхронно с переходом: ход отложен на tick и кадр,
   * к тому времени пик уже сброшен.
   */
  const run = body.slice(body.indexOf('let peak = 0'))
  const head = run.slice(0, run.indexOf('\n  })'))
  assert.match(head, /if \(queued > peak\) peak = queued/, 'пик очереди больше не считается')
  assert.match(head, /const batch = peak >= 2/, 'прогон снова путают с одиночным запуском')
  assert.ok(
    head.indexOf('const batch = peak >= 2') < head.indexOf('if (now === null) peak = 0'),
    'пик сбрасывается раньше решения — последняя ячейка прогона потянет лист',
  )
  assert.match(head, /if \(batch\) return/)

  // Ход остался ровно один и плавный: мгновенная езда по очереди была нужна,
  // пока за очередью вообще ходили.
  const show = body.slice(body.indexOf('function show(id: string)'))
  const inside = show.slice(0, show.indexOf('\n  }'))
  assert.doesNotMatch(inside, /box\.scrollTop = target/, 'мгновенная езда вернулась без очереди')
  assert.match(inside, /steerTo\(box, id, target\)/)
  assert.match(
    inside,
    /steering && Math\.abs\(steering\.top - target\) < 2/,
    'разгон сбивается заново',
  )

  // Просьбы за кадр всё равно складываются: Shift+Enter подряд — тоже частый ход.
  const follow = body.slice(body.indexOf('function follow(id: string)'))
  assert.match(
    follow.slice(0, 500),
    /requestAnimationFrame/,
    'просьбы за кадр больше не складываются',
  )

  // Увёл сам — не ведём. Увозом считается прокрутка, а не нажатие: выделить
  // ячейку по ходу работы можно, не отказываясь от того, чтобы показывали.
  assert.match(body, /onwheelcapture=\{\(\) => \{[\s\S]{0,120}handedOver = true/)
  assert.match(body, /ontouchmovecapture=\{\(\) => \{[\s\S]{0,120}handedOver = true/)
  const down = body.slice(body.indexOf('onpointerdowncapture'))
  assert.doesNotMatch(down.slice(0, 80), /handedOver/, 'нажатие на ячейку отключает показ')
})
