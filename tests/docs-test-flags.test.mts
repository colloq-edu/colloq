/**
 * Шапка `tests/README.md` объясняет, почему прогон устроен именно так, и
 * приводит числа, которых после неё никто не пересчитывал. Сверяется и то, и
 * другое — потому что этот файл не собирает и не типизирует никто.
 *
 * Флаги. Абзацы про `--test-concurrency=1` и `--test-force-exit` — не заметка
 * на память: первый держит сюиту от молчаливого недосчёта хвоста файла, второй
 * не даёт прогону висеть на таймере серверного модуля. Уберут флаг из `npm
 * test` — и README останется единственным местом, где он ещё есть: сюита снова
 * начнёт терять тесты, а объяснение будет рассказывать, почему этого не бывает.
 *
 * Числа. «232, 232, 230, 232» и «двенадцать лишних секунд» — измерение той
 * поры, когда в сюите было 232 теста; сегодня их в разы больше, и сколько
 * именно — здесь нарочно не написано. Число в тексте растёт от чужих правок, а
 * живёт в файле, который при этом никто не открывает, — ровно так же соврала
 * строка «about 220 tests» в корневом README (см. `docs-readme-drift.test.mts`).
 * Поэтому старое число обязано быть названо прошлым, а живое — взято с конца
 * прогона, а не отсюда.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

const doc = read('tests/README.md')
const npmTest: string = JSON.parse(read('package.json')).scripts.test

/**
 * Абзац, начинающийся с этих слов: до первой пустой строки, одной строкой.
 *
 * Переносы схлопываются нарочно — абзац переносится по восьмидесяти знакам, и
 * фраза ломается там, где сегодня пришлась граница; проверка, чувствительная к
 * ней, падала бы от переформата, а не от неправды.
 */
function paragraph(from: string): string {
  const at = doc.indexOf(from)
  assert.notEqual(at, -1, `в tests/README.md нет абзаца «${from}…»`)
  return doc.slice(at, doc.indexOf('\n\n', at)).replace(/\s+/g, ' ')
}

/** Сколько тестов объявлено в дереве. Тот же счёт, что и в корневом README. */
function declared(): number {
  const dir = path.join(root, 'tests')
  let n = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.test.mts')) continue
    n += (readFileSync(path.join(dir, name), 'utf8').match(/^[ \t]*(?:test|it)\(/gm) ?? []).length
  }
  return n
}

test('флаги, которые объясняет tests/README.md, стоят в npm test', () => {
  paragraph('`--test-concurrency=1` is deliberate')
  assert.match(
    npmTest,
    /--test-concurrency=1\b/,
    'tests/README.md объясняет последовательный прогон, а npm test его больше не просит: сюита снова недосчитывает хвост файла',
  )

  paragraph('`--test-force-exit` is deliberate')
  assert.match(
    npmTest,
    /--test-force-exit\b/,
    'tests/README.md объясняет --test-force-exit, а npm test его больше не передаёт: прогон повиснет на таймере серверного модуля',
  )
})

test('старое измерение в шапке названо прошлым, а не сегодняшним', (t) => {
  const said = paragraph('`--test-concurrency=1` is deliberate')
  const then = 232
  if (!said.includes(String(then))) {
    t.skip('абзац перемерили: старого числа в нём больше нет, датировать нечего')
    return
  }
  const now = declared()
  assert.ok(now > 0, 'в tests/ не нашлось ни одного объявленного теста — сломан счёт, а не README')
  // Пока счёт держится того же порядка, число ещё описывает сюиту само по себе.
  if (now < then * 2 && now > then / 2) return

  assert.match(
    said,
    /\bthen\b|\bhistory\b/i,
    `в шапке всё ещё стоит ${then} теста, а объявлено ${now}: число обязано быть названо прошлым или перемерено`,
  )
})

test('шапка говорит, откуда берутся сегодняшние число и время', () => {
  const said = paragraph('`--test-concurrency=1` is deliberate')
  assert.match(said, /duration_ms/, 'не сказано, где смотреть настоящее время прогона')
  assert.match(said, /ℹ tests/, 'не сказано, где смотреть настоящее число тестов')
})
