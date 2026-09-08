/**
 * Что человеку говорят, когда файл не приняли.
 *
 * Загрузка когда-то отвечала «unusable file name» — три слова, которые не
 * называют ни файла, ни того, чем он плох, посреди пары и при ждущем семинаре.
 * Проверка с тех пор переехала: одна на браузер и сервер, в `shared/paths.ts`,
 * — но обещание осталось прежним. `safeSegment` отвечает «да» или «нет», и
 * этого хватает серверу; здесь проверяется фраза, которой хватает человеку.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SEGMENT, safeSegment, whySegmentRefused } from '../shared/paths.js'

/** С каждым отказом человек должен уметь что-то сделать. */
function actionable(message: string): void {
  assert.ok(message.length > 20, `слишком коротко: ${message}`)
  assert.match(message, /[.!]$/, `не предложение: ${message}`)
}

test('скрытому файлу говорят, чем он скрыт', () => {
  const said = whySegmentRefused('.gitignore')
  actionable(said)
  assert.match(said, /\.gitignore/, 'файл не назван')
  assert.match(said, /точки/i)
  assert.match(said, /не поддерживаются в панели/i, 'не сказано, чем это кончится')
})

test('слишком длинное имя называет и свою длину, и предел', () => {
  const said = whySegmentRefused('n'.repeat(214) + '.txt')
  actionable(said)
  assert.match(said, /218/, 'настоящая длина не названа')
  assert.match(said, new RegExp(String(MAX_SEGMENT)), 'предел не назван')
})

test('путь с папкой отсылает к кнопке, которой папку заводят', () => {
  const said = whySegmentRefused('reports\\january\\data.csv')
  actionable(said)
  assert.match(said, /косая черта/i)
  assert.match(said, /кнопк/i, 'не показан путь вперёд')
})

test('управляющий символ назван проблемой', () => {
  const said = whySegmentRefused('bell\u0007.txt')
  actionable(said)
  assert.match(said, /символы/i)
})

test('пробел с краю виден в отказе, раз его не видно в имени', () => {
  const said = whySegmentRefused('model.py ')
  actionable(said)
  assert.match(said, /model\.py/, 'файл не назван')
  assert.match(said, /пробел/i)
})

test('имени нет вовсе — всё равно предложение', () => {
  for (const name of ['', '.', '..']) {
    actionable(whySegmentRefused(name))
  }
})

test('фраза не убегает вслед за враждебным именем', () => {
  const said = whySegmentRefused('.' + 'x'.repeat(5000))
  assert.ok(said.length < 200, `имя в 5000 символов дало сообщение в ${said.length}`)
})

test('у каждого имени, которое отвергает safeSegment, есть что сказать', () => {
  const refused = ['', '.', '..', '.env', 'a\u0007b.csv', 'x'.repeat(220), 'model.py ', 'src/m.py']
  for (const name of refused) {
    assert.equal(safeSegment(name), false, `${JSON.stringify(name)} всё-таки пропустили`)
    actionable(whySegmentRefused(name))
  }
})

test('годное имя не объясняют задним числом', () => {
  // whySegmentRefused зовут только после отказа safeSegment; на хорошем имени
  // он всё равно обязан отдать предложение, а не пустую строку или падение.
  for (const name of ['data.csv', 'семинар 7 — заметки.md', 'archive.tar.gz']) {
    assert.ok(safeSegment(name), `${name} должно быть можно`)
    actionable(whySegmentRefused(name))
  }
})
