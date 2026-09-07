/**
 * Расписание на выложенной странице курса.
 *
 * `colloq.ru/c/<курс>` — единственный адрес, который классу дают на весь год:
 * его диктуют вслух, сохраняют и открывают, чтобы понять, что будет на неделе.
 * Страница нумерует строки подряд, и эта нумерация читается как расписание —
 * значит недели обязаны идти подряд тоже. Пока в плане «ML · сильная» после
 * «25–31 янв» шло «1–7 мар», февраль просто исчезал: строка 22 была на месте,
 * а недели за ней не было, и сверить страницу с расписанием было нельзя.
 *
 * Проверяется выгруженный файл, а не база: до студента доезжает именно он, а
 * между планом в панели и страницей на Pages стоит `make site`, который эту
 * дыру переносит слово в слово. Незаполненную неделю называют строкой («буфер»,
 * «каникулы»), а не пропускают.
 *
 * Цепочка рвётся сама, как только вместо темы в строке появляется проведённый
 * семинар: у него в подписи дата публикации, а не неделя, и сколько недель он
 * занял — из страницы не видно. Тогда счёт начинается заново со следующей
 * названной недели: тест обязан молчать там, где не знает, а не выдумывать.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const DAY = 24 * 60 * 60 * 1000

interface Row {
  n: string
  name: string
  when: string
}

/** Строки плана со страницы курса: номер, тема, подпись справа. */
function rowsOf(html: string): Row[] {
  const out: Row[] = []
  const row = /<span class="n">([^<]*)<\/span><span class="t">([^<]*)<\/span><span class="s">([^<]*)<\/span>/g
  for (const found of html.matchAll(row)) {
    out.push({ n: found[1], name: found[2], when: found[3] })
  }
  return out
}

/**
 * Неделя словами расписания в пару «первый день, последний день».
 *
 * Года в расписании нет и не будет: его так и составляют («7–13 сен»). Года
 * здесь и не надо — важно только, что дни идут подряд, — так что он считается
 * от условного и переводится вперёд, как только месяц пошёл назад.
 */
function week(label: string, year: { at: number; month: number }): [number, number] | null {
  const text = label.replace(/[–—−]/g, '-').replace(/\s+/g, ' ').trim()
  const full = /^(\d{1,2}) ([а-я]{3})[а-я]* ?- ?(\d{1,2}) ([а-я]{3})[а-я]*$/.exec(text)
  const short = /^(\d{1,2}) ?- ?(\d{1,2}) ([а-я]{3})[а-я]*$/.exec(text)
  const parts = full
    ? [full[1], full[2], full[3], full[4]]
    : short
      ? [short[1], short[3], short[2], short[3]]
      : null
  if (!parts) return null
  const day = (d: string, m: string): number | null => {
    const month = MONTHS.indexOf(m)
    if (month === -1) return null
    if (month < year.month) year.at += 1
    year.month = month
    return Date.UTC(year.at, month, Number(d))
  }
  const from = day(parts[0], parts[1])
  const to = from === null ? null : day(parts[2], parts[3])
  return from === null || to === null ? null : [from, to]
}

/** Февраль кончается 28-м или 29-м — год расписание не называет. */
const nextDay = (end: number, start: number): boolean => {
  if (start === end + DAY) return true
  const last = new Date(end)
  const first = new Date(start)
  return (
    last.getUTCMonth() === 1 &&
    last.getUTCDate() >= 28 &&
    first.getUTCMonth() === 2 &&
    first.getUTCDate() === 1
  )
}

const pages = readdirSync(resolve(ROOT, 'site/c'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `site/c/${entry.name}/index.html`)

test('на выложенных страницах курсов есть что читать', () => {
  // Иначе всё, что ниже, зелено просто потому, что проверять нечего.
  assert.ok(pages.length > 0, 'в site/c нет ни одной страницы курса')
})

for (const page of pages) {
  const course = page.split('/')[2]
  const html = readFileSync(resolve(ROOT, page), 'utf8')
  const rows = rowsOf(html)

  test(`курс «${course}»: недели плана идут подряд`, () => {
    assert.ok(rows.length > 0, 'на странице курса нет ни одной строки')
    const year = { at: 2025, month: -1 }
    let prev: { row: Row; to: number } | null = null
    for (const row of rows) {
      const span = week(row.when, year)
      if (!span) {
        // Проведённый семинар или удалённая комната: недели в подписи нет.
        prev = null
        continue
      }
      if (prev !== null) {
        assert.ok(
          nextDay(prev.to, span[0]),
          `между «${prev.row.n} · ${prev.row.when}» и «${row.n} · ${row.when}» ` +
            'в расписании дыра: страница нумерует строки подряд, а недели пропускает',
        )
      }
      prev = { row, to: span[1] }
    }
  })

  test(`курс «${course}»: в темах нет черновых пометок`, () => {
    for (const row of rows) {
      assert.ok(
        !/\?{2,}|TODO|XXX/i.test(row.name),
        `строка ${row.n}: «${row.name}» — черновая пометка уехала классу`,
      )
    }
  })
}
