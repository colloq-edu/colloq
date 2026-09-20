/**
 * Заставка: одна и та же от первого кадра документа до готового экрана.
 *
 * Оболочка `#boot` живёт в web/index.html, потому что рисуется без единого
 * запроса; её двойник в приложении — `Splash.svelte`. Общего источника у них
 * быть не может (CSS приложения к этому мгновению ещё не приехал), и цена
 * копии — ровно эти проверки: разъехавшееся число даёт скачок логотипа в то
 * самое мгновение, когда оболочка уходит.
 *
 * Здесь же — то, ради чего всё затевалось: скелета «страницы» и «тетради»
 * больше нет ни на одном экране, а оболочку снимают не по факту монтирования,
 * а когда первому экрану есть что показать.
 *
 * Читается прямо из файлов, как `screens-craft` и `panels-craft`: тест со
 * своей копией правила проходит вечно, пока файл уезжает.
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

const SHELL = 'web/index.html'
const SPLASH = 'web/src/components/ui/Splash.svelte'
const BOOT = 'web/src/lib/boot.ts'
const MAIN = 'web/src/main.ts'
const APP = 'web/src/App.svelte'
const ADMIN = 'web/src/screens/AdminScreen.svelte'
const READER = 'web/src/screens/ReaderScreen.svelte'
const SESSION = 'web/src/screens/SessionScreen.svelte'
const NOTEBOOK = 'web/src/components/notebook/Notebook.svelte'
const COMPETITIONS = 'web/src/screens/CompetitionsScreen.svelte'
const ROWS = 'web/src/components/ui/RowsSkeleton.svelte'

/** Все исходники веба — по ним проверяется, что чего-то больше нет нигде. */
function webFiles(): string[] {
  const root = path.resolve(import.meta.dirname, '..', 'web', 'src')
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(svelte|ts)$/.test(entry.name)) found.push(full)
    }
  }
  walk(root)
  return found
}

/* ------------------------------------------------- скелета больше нет */

test('серых «страницы» и «тетради» не осталось ни на одном экране', () => {
  /*
   * Жалоба, с которой всё началось: «из ниоткуда появляется этот скелет, при
   * том что интерфейса нигде нет». Скелет обещал конкретный экран — шапку,
   * ячейки — до того, как о нём было известно хоть что-нибудь.
   */
  for (const file of webFiles()) {
    const source = code(fs.readFileSync(file, 'utf8'))
    const at = path.relative(path.resolve(import.meta.dirname, '..'), file)
    assert.doesNotMatch(source, /ContentSkeleton/, `${at}: скелет страницы вернулся`)
    assert.doesNotMatch(
      source,
      /variant=["'](?:page|notebook)["']/,
      `${at}: вернулся вариант скелета, который заменила заставка`,
    )
  }
  // А строки списка остались: там заглушка стоит ровно на месте будущей
  // строки, в уже нарисованной панели, и ничего не выдумывает.
  const rows = read(ROWS)
  assert.doesNotMatch(code(rows), /variant/, 'у заглушки списка нет вариантов — она одна')
  assert.match(rows, /data-skeleton="rows"/, 'заглушка списка называет себя')
  const users = webFiles().filter(
    (file) =>
      !file.endsWith('RowsSkeleton.svelte') &&
      /RowsSkeleton/.test(fs.readFileSync(file, 'utf8')),
  )
  assert.ok(users.length >= 2, 'строки списка используются панелью файлов и таблицей занятий')
})

/* ------------------------------------------- заставка и её оболочка */

test('заставка приложения повторяет оболочку число в число', () => {
  const shell = read(SHELL)
  const splash = read(SPLASH)
  // Кусок оболочки — от `#boot {` до конца её медиазапроса: числа рядом с
  // чужими (шрифты, грунт) ничего здесь не значат.
  const boot = shell.slice(shell.indexOf('#boot {'))
  assert.ok(boot.length > 400, 'в оболочке больше нет правил заставки')

  // Полоска, зазор — и то, как заставка появляется и бежит.
  for (const [what, pattern] of [
    ['полоска 88', /width:\s*88px/],
    ['полоска в 2 px', /height:\s*2px/],
    ['зазор 16', /gap:\s*16px/],
    ['появление 0.25s с задержкой 0.25s', /0\.25s ease 0\.25s forwards/],
    ['бегущий акцент 1.1s', /1\.1s ease-in-out infinite/],
    ['акцент шириной 40%', /width:\s*40%/],
    ['пробег до 250%', /translateX\(250%\)/],
    ['старт из-за левого края', /translateX\(-100%\)/],
  ] as const) {
    assert.match(boot, pattern, `оболочка потеряла: ${what}`)
    assert.match(splash, pattern, `заставка приложения потеряла: ${what}`)
  }

  /*
   * Марка — единственное число, которое в заставке приложения живёт не в CSS:
   * её рисует Icon, размер приходит пропом. 28 — то же, что в оболочке.
   * Панельная мельче, и это не забытое число: она стоит ВНУТРИ уже
   * нарисованного интерфейса и не может быть крупнее той, что стоит вместо
   * целого экрана.
   */
  const mark = boot.slice(boot.indexOf('#boot svg'))
  assert.match(mark, /width:\s*28px/, 'оболочка потеряла: марка 28')
  assert.match(mark, /height:\s*28px/, 'марка оболочки перестала быть квадратной')
  assert.match(splash, /MARK = \{ screen: 28, pane: (\d+) \}/, 'размеры марки заданы таблицей')
  const pane = Number(/MARK = \{ screen: 28, pane: (\d+) \}/.exec(splash)?.[1])
  assert.ok(pane > 0 && pane < 28, `панельная марка ${pane} не мельче экранной`)
  // И рисуют её одни и те же девять клеток — набор значков, а не третья копия.
  assert.match(splash, /Icon name="logo"/, 'марка перерисована рядом с набором значков')
})

test('обе заставки уважают «без анимации»', () => {
  const shell = read(SHELL)
  const splash = read(SPLASH)
  for (const [what, source] of [
    ['оболочка', shell.slice(shell.indexOf('#boot {'))],
    ['заставка', splash],
  ] as const) {
    const reduced = source.slice(source.indexOf('prefers-reduced-motion'))
    assert.ok(reduced.length > 40, `${what}: нет ветки без анимации`)
    assert.match(reduced, /animation-delay:\s*0s/, `${what}: задержка появления не снята`)
    assert.match(reduced, /animation:\s*none/, `${what}: бегущий акцент не остановлен`)
    assert.match(reduced, /width:\s*100%/, `${what}: вместо бегунка не осталось полосы`)
    assert.match(reduced, /opacity:\s*0\.4/, `${what}: полоса не притушена`)
  }
})

test('заставка объявляет себя тем, кто её не видит', () => {
  const splash = code(read(SPLASH))
  assert.match(splash, /role="status"/, 'заставка — состояние, а не картинка')
  assert.match(splash, /aria-busy="true"/, 'заставка не сказала, что идёт ожидание')
  assert.match(splash, /aria-label=\{label\}/, 'у заставки нет имени')
  assert.match(splash, /label = tr\('common\.loading'\)/, 'имя по умолчанию — не из словаря')
  // То же и у оболочки: она говорит на языке инстанса (main.ts правит ярлык).
  assert.match(read(SHELL), /id="boot" role="status" aria-label=/, 'оболочка молчит')
})

test('оболочка и заставка знают друг о друге', () => {
  /*
   * Копия без указателя — это копия, о которой узнают по жалобе. Оба файла
   * называют второй ПО ИМЕНИ, чтобы правка нашла соседа поиском.
   */
  assert.match(read(SHELL), /Splash\.svelte/, 'оболочка не указывает на заставку приложения')
  assert.match(read(SPLASH), /index\.html/, 'заставка приложения не указывает на оболочку')
})

/* --------------------------------------------- когда оболочка уходит */

test('оболочку снимают по первому экрану, а не по монтированию', () => {
  const main = read(MAIN)
  /*
   * Тот самый порядок: смонтировали, дождались стилей, дождались экрана — и
   * только теперь сняли оболочку. Пока `dismissShell` стоял сразу за
   * стилями, на его месте оказывался скелет: App смонтирован, но под ним
   * `{#await}` над куском маршрута и пустые данные.
   */
  const mount = main.indexOf('mount(App')
  const wait = main.indexOf('await whenFirstScreen(', mount)
  const dismiss = main.indexOf('dismissShell()', mount)
  assert.ok(mount > 0 && wait > mount, 'ожидание первого экрана исчезло из main.ts')
  assert.ok(dismiss > wait, 'оболочку снимают до того, как экрану есть что показать')
  // Событие «форма отрисована» не ждёт заставки: на нём греются куски комнаты.
  assert.ok(main.indexOf("'colloq:ready'") < wait, 'прогрев комнаты отложен до ухода заставки')
})

test('заставка не висит вечно', () => {
  const boot = read(BOOT)
  const limit = Number(/SCREEN_WAIT = (\d+)/.exec(boot)?.[1])
  assert.ok(limit > 0 && limit <= 3000, `потолок ожидания ${limit} — не потолок`)
  assert.match(code(boot), /whenFirstScreen/, 'ждать без потолка нельзя')
  // Кусок приложения не доехал — ждать больше нечего, и заставка уходит.
  const main = code(read(MAIN))
  const offer = main.slice(main.indexOf('function offerReload'))
  assert.match(offer, /firstScreenReady\(\)/, 'отказ загрузки оставляет заставку навсегда')
})

test('о готовности докладывает каждый экран, который её заслоняет', () => {
  /*
   * Забытый доклад виден только на медленной сети: экран выходит по потолку,
   * то есть на секунду позже, чем мог бы. Поэтому список — здесь.
   */
  for (const [what, file] of [
    ['панель', ADMIN],
    ['читалка', READER],
    ['комната', SESSION],
    ['тетрадь', NOTEBOOK],
    ['соревнования', COMPETITIONS],
    ['роутер', APP],
  ] as const) {
    const source = code(read(file))
    assert.match(source, /firstScreenReady\(\)/, `${what}: не докладывает о готовности`)
    assert.match(
      source,
      /from '@\/lib\/boot'/,
      `${what}: доклад взят не у общего гейта (lib/boot.ts)`,
    )
  }

  // Панель — когда знает, что рисовать: себя или вход.
  const admin = code(read(ADMIN))
  assert.match(admin, /adminAuth\.ready && !exchanging\) firstScreenReady/, 'панель торопится')
  // Тетрадь — когда перестала быть непрочитанной.
  assert.match(code(read(NOTEBOOK)), /if \(!cold\) firstScreenReady/, 'тетрадь торопится')
  // Экран отказа — это экран: ждать под заставкой больше нечего.
  assert.match(code(read(APP)), /if \(failure \|\|/, 'на отказе заставка остаётся висеть')
})

test('на месте скелета стоит заставка, и на экране — экранная', () => {
  // Роутер: все пять ожиданий куска маршрута — читалка, соревнования, панель
  // (дважды: адрес панели и корень) и комната.
  const app = code(read(APP))
  assert.equal(app.match(/<Splash \/>/g)?.length, 5, 'не все ожидания маршрута показывают заставку')
  assert.doesNotMatch(app, /<Splash size="pane"/, 'вместо экрана — панельная заставка')
  // Панель и читалка: экран целиком.
  assert.match(code(read(ADMIN)), /<Splash \/>/, 'панель потеряла заставку')
  // Внутри нарисованного интерфейса — панельная.
  assert.match(code(read(NOTEBOOK)), /<Splash size="pane"/, 'в области тетради не панельная')
  const reader = code(read(READER))
  assert.match(reader, /<Splash size="pane"/, 'в теле страницы не панельная')
  assert.match(reader, /<Splash label=/, 'на пустой странице не экранная')
})
