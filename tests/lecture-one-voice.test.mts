/**
 * Один отказ — один голос, один такт указки — одно число.
 *
 * Пульт и сервер лекции говорят об одном и том же двумя кусками кода, и оба
 * раза правило написано словом, а не выведено: «страница исписана» пульт
 * показывает до штриха, сервер — после переподключения, и это ОДНА фраза;
 * кадры указки режет таким-то окном пульт, и тем же окном придерживает точку
 * сервер, и это ОДНО число. Пока копий было по две, обе успели разъехаться
 * ровно так, как расходятся копии: слова совпадали, а комментарий у серверного
 * такта ссылался на такт ЧЕРНИЛ — на другую константу с похожим именем.
 *
 * Тесты ниже сверяют не строки друг с другом (это тавтология, когда функция
 * одна), а два конца на одних и тех же чернилах: там, где сервер отказывает,
 * пульт уже не открыл штрих, и наоборот. Плюс два взгляда в исходники — чтобы
 * вторая копия не завелась заново молча.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LASER_EVERY_MS,
  MAX_INKED_PAGES,
  MAX_STROKES_PER_PAGE,
  inkFullSays,
} from '../shared/lecture.js'
import { addInk, inkOf, startLecture } from '../server/src/lecture.js'
import { inkRefusal } from '../web/src/components/lecture/pult.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Код без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const lecture = (id: string) =>
  startLecture(id, { file: 'slides.pdf', by: 'teacher', byName: 'Ада', color: '#d4162f' })

const dab = (page: number, name: string) => ({
  id: name,
  page,
  color: '#111',
  width: 0.004,
  points: [0, 0],
})

/* ------------------------------------------------- потолки: два конца */

test('полная страница: пульт не открывает штрих ровно там, где сервер его не примет', () => {
  const id = 'полная-страница'
  lecture(id)
  for (let i = 0; i < MAX_STROKES_PER_PAGE - 1; i += 1) addInk(id, dab(1, `s${i}`))

  // Страницу не добрали одного штриха: оба конца ещё пускают.
  assert.equal(inkRefusal(inkOf(id), [], 1), null)
  const last = addInk(id, dab(1, 'последний'))
  assert.equal(last?.full, undefined)

  // И оба отказывают на следующем — не раньше и не позже.
  const known = inkOf(id)
  const refusal = inkRefusal(known, [], 1)
  const server = addInk(id, dab(1, 'лишний'))
  assert.equal(server?.full, 'page-full')
  assert.equal(refusal, server?.full)
  /*
   * Фраза одна не потому, что совпала, а потому, что функция одна: пульт зовёт
   * `inkFullSays` из shared (InkLayer · `down`), сервер — её же (control.ts ·
   * `case 'ink'`). Своя копия на пульте стояла и совпадала слово в слово — до
   * первой правки формулировки.
   */
  assert.equal(inkFullSays(refusal!), inkFullSays(server!.full!))
  // Соседняя страница к этому потолку отношения не имеет: там пишут дальше.
  assert.equal(inkRefusal(known, [], 2), null)
})

test('страницы кончились: пульт называет тот же потолок, что сервер', () => {
  const id = 'много-страниц'
  lecture(id)
  for (let page = 1; page <= MAX_INKED_PAGES; page += 1) addInk(id, dab(page, `p${page}`))

  const known = inkOf(id)
  const fresh = MAX_INKED_PAGES + 1
  const refusal = inkRefusal(known, [], fresh)
  const server = addInk(id, dab(fresh, 'на новой'))
  assert.equal(server?.full, 'too-many-pages')
  assert.equal(refusal, server?.full)
  assert.equal(inkFullSays(refusal!), inkFullSays(server!.full!))

  // Уже исписанная страница пускает обоих: потолок про число страниц.
  assert.equal(inkRefusal(known, [], 1), null)
  assert.equal(addInk(id, dab(1, 'ещё на первой'))?.full, undefined)
})

/* ----------------------------------------------- вторая копия в коде */

test('слова отказа набраны в одном файле, и это shared', () => {
  const says = (['page-full', 'too-many-pages', 'stroke-full'] as const).map(inkFullSays)
  const shared = read('shared/lecture.ts')
  for (const phrase of says) {
    assert.ok(shared.includes(phrase), `фраза «${phrase}» пропала из shared/lecture.ts`)
  }

  /*
   * Ищем по всему клиенту и серверу: копия заводится не там, где о ней помнят,
   * а там, где отказ понадобился второй раз. Тесты не в счёт — они и должны
   * знать фразу, чтобы её сторожить.
   */
  const sources: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.resolve(import.meta.dirname, '..', dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (/\.(ts|svelte)$/.test(entry.name)) sources.push(rel)
    }
  }
  walk('web/src')
  walk('server/src')

  for (const rel of sources) {
    const source = read(rel)
    for (const phrase of says) {
      assert.ok(!source.includes(phrase), `фраза «${phrase}» набрана второй раз в ${rel}`)
    }
  }
})

test('пульт сужает отказ от общего типа, а не набирает литералы заново', () => {
  const pult = code(read('web/src/components/lecture/pult.ts'))
  assert.match(
    pult,
    /export type InkRefusal = Extract<InkFull,/,
    'у пульта снова свой список отказов: переименованный в shared не уронит сборку',
  )
})

/* ------------------------------------------------------- такт указки */

test('такт указки — одно число на оба конца', () => {
  const ink = code(read('web/src/components/lecture/InkLayer.svelte'))
  assert.doesNotMatch(ink, /const\s+LASER_EVERY_MS\s*=/, 'у пульта снова своя копия такта')
  assert.match(
    ink,
    /import \{[^}]*\bLASER_EVERY_MS\b[^}]*\} from '@shared\/lecture'/,
    'слой чернил берёт такт указки не из shared',
  )

  const control = code(read('server/src/control.ts'))
  const own = /const\s+LASER_EVERY_MS\s*=\s*(\d+)/.exec(control)
  if (own) {
    /*
     * Серверная копия ещё стоит — control.ts правит его владелец. Пока она
     * здесь, числа держит этот тест: сервер, придерживающий точку дольше
     * пульта, добавляет к каждому кадру задержку, которой ведущий не
     * заказывал, а короче — платит полным кругом рассылки за каждый сэмпл.
     */
    assert.equal(Number(own[1]), LASER_EVERY_MS, 'сервер придерживает указку не тем окном')
  } else {
    assert.match(
      control,
      /import \{[^}]*\bLASER_EVERY_MS\b[^}]*\} from '@shared\/lecture'/,
      'серверный такт указки не из shared и не объявлен рядом',
    )
  }
})

test('жёсткость пружины выведена из того такта, который стоит в shared', () => {
  const source = read('web/src/components/lecture/InkLayer.svelte')
  const spring = /Жёсткость — ПО ИСТОЧНИКУ СЭМПЛОВ[\s\S]*?const SPRING_WIRE = (\d+)/.exec(source)
  assert.ok(spring, 'вывод SPRING_WIRE пропал из слоя чернил')
  /*
   * Остаток 4 % набегает примерно за 3.2/k секунды, значит k ≈ 3.2 / такт:
   * голова доходит ровно к приходу следующего сэмпла и не стоит между ними.
   * Число выписано руками — тем важнее, чтобы оно осталось от ЭТОГО такта.
   */
  const wanted = Math.round(3.2 / (LASER_EVERY_MS / 1000))
  assert.ok(
    Math.abs(Number(spring[1]) - wanted) <= 1,
    `SPRING_WIRE = ${spring[1]} при такте ${LASER_EVERY_MS} мс: ждали около ${wanted}`,
  )
  // И объяснение считает от него же, а не от числа, которое давно сдвинули.
  assert.ok(
    spring[0].includes(`${LASER_EVERY_MS} мс`),
    'вывод жёсткости объясняет себя другим тактом',
  )
})
