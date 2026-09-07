/**
 * Ход оракула: команда, не дождавшаяся оболочки, СНЯТА — и так и сказано.
 *
 * Слово здесь дороже обычного: этот абзац читает не человек, а модель, и она
 * пересказывает его комнате своими словами. Дело сделано (`stopRun` в ветке
 * ожидания зовёт `dropPendingOf`, и что тот действительно вырезает запись из
 * очереди, отвечает ждущему и не трогает чужую команду, закреплено в
 * tests/terminal.test.mts · «ход оракула кончился — его ждущая команда не
 * начнётся потом сама»), а слово успело разойтись с ним: в ответе стояло
 * «команда осталась в очереди и может начаться позже — второй раз её ставить не
 * надо». Модель, поверив, объявляла классу запуск, которого уже не будет, и не
 * запускала заново.
 *
 * Поэтому проверяется пара: снятие в коде хода и фраза, которая про него
 * говорит. Ни сети, ни ядра здесь нет — сверяются два места одного файла.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const agent = readFileSync(
  fileURLToPath(new URL('../server/src/ai/agent.ts', import.meta.url)),
  'utf8',
)

/** Кусок файла от строки-приметы до конца ветки — грубо, но по делу. */
function from(mark: string, chars: number): string {
  const at = agent.indexOf(mark)
  assert.notEqual(at, -1, `в agent.ts нет ${mark}`)
  return agent.slice(at, at + chars)
}

test('срок ожидания снимает свою команду из очереди, а не оставляет её там', () => {
  const branch = from("if (!typedRunningCommand(hands.sessionId, hands.by.participantId)) {", 400)
  assert.match(branch, /cut = 'waiting'/)
  assert.match(branch, /dropPendingOf\(hands\.sessionId, hands\.by\.participantId\)/)
  // Ctrl+C — только в свою команду: в этой ветке его нет вовсе.
  assert.doesNotMatch(branch, /interruptTerminal/)
})

test('и модели про это сказано теми же словами: команда снята', () => {
  const said = from("if (result.cut === 'waiting') {", 500)
  assert.match(said, /сн(ял|ята) из очереди/)
  /*
   * Три обещания, которых код не выполняет. Каждое проверяется отдельно:
   * вернуться может любое, а стоят они одинаково — модель говорит комнате, что
   * запуск ещё впереди, и ждёт его вместо того, чтобы запустить.
   */
  assert.doesNotMatch(said, /осталась в очереди/)
  assert.doesNotMatch(said, /может начаться/)
  assert.doesNotMatch(said, /второй раз её ставить не надо/)
})

test('строка шага в ленте преподавателя говорит то же самое', () => {
  const step = from("result.cut === 'waiting'", 200)
  assert.match(step, /не начался/)
  assert.match(step, /снята/)
})
