/**
 * Пульт правил в комнате зовёт русскую причину — и зовёт её ОДНУ.
 *
 * Слова отказа проверяет соседний `weblib-rule-refusal.test.mts` (там же
 * разобрано, почему причина называется своими словами, а не пересказом
 * `ApiError`). Здесь — то, чего тот файл проверить не мог, пока правка не
 * легла: место вызова. `session.showError(err.message)` возвращается одной
 * строкой, а увидеть это можно только на живой паре и только при отказе —
 * разметка молчит, типы молчат, экран выглядит целым.
 *
 * Вторая проверка — про вторую копию. Правило это маленькое, и завести его
 * рядом с экраном соблазнительно ровно до первой правки: сообщений станет два
 * набора, разойдутся они молча (сквозная причина 6 аудита). Экран обязан
 * брать `ruleRefusal` из `lib/`, где живёт и `api.ts`, порождающий эти отказы.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = path.resolve(import.meta.dirname, '..')
const SESSION = 'web/src/screens/SessionScreen.svelte'

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** Разметка без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

test('отказ пульта правил приезжает в комнату через ruleRefusal', () => {
  const session = code(read(SESSION))
  const from = session.indexOf('async function setRule(')
  assert.ok(from > 0, 'пульт правил на месте')
  const body = session.slice(from, session.indexOf('\n  }\n', from))

  assert.match(body, /showError\(/, 'отказ по-прежнему виден человеку, а не молчит')
  assert.match(body, /showError\(ruleRefusal\(/, 'причину называет lib/rule-refusal.ts')
  assert.doesNotMatch(body, /err\.message/, 'английская фраза ApiError в русской комнате')
  assert.match(session, /import \{ ruleRefusal \} from '@\/lib\/rule-refusal'/)
})

test('второй копии правила рядом с экранами нет', () => {
  const dir = path.join(ROOT, 'web/src/screens')
  for (const name of fs.readdirSync(dir)) {
    const source = code(read(`web/src/screens/${name}`))
    assert.doesNotMatch(
      source,
      /(export )?function ruleRefusal\b/,
      `${name}: свой свод слов отказа рядом с общим`,
    )
  }
})
