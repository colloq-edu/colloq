/**
 * Провод «попроси вывод этой попытки» — от карточки до сокета.
 *
 * Полный кадр `council:board` режется сервером по бюджету вывода: у попыток
 * сверх него `run.outputs` пуст и стоит `run.outputsOmitted`. Карточка это
 * честно пишет («вывод не поехал со стопкой») и даёт повод — зовёт
 * `onneedoutputs`. Дальше повод должен куда-то приходить: без пропса в
 * CellView обещание «просим его отдельно…» не сбылось бы никогда — сервер
 * отвечает дельтой на `council:attempt`, а звать его было бы некому.
 *
 * Здесь проверяется именно стык, которого не хватало: монтаж стопки в
 * CellView. Обе его стороны — карточка и `CouncilState.wantOutputs` — закрыты
 * в `council-stack-craft.test.mts`.
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

const CELL = code(read('web/src/components/notebook/CellView.svelte'))

test('монтаж стопки передаёт просьбу о выводе в CouncilState', () => {
  const mount = CELL.slice(
    CELL.indexOf('<CouncilStack'),
    CELL.indexOf('{:else}', CELL.indexOf('<CouncilStack')),
  )
  assert.notEqual(mount, '', 'стопка монтируется в CellView')
  assert.match(
    mount,
    /onneedoutputs=\{\(participantId\) => session\.council\.wantOutputs\(id, participantId\)\}/,
    'повод карточки уходит в стопку — той же ячейкой, что и остальные провода',
  )
  // Дедупликация живёт в CouncilState (ключ с `startedAt`, память чистится на
  // полный кадр стопки). Вторая копия здесь разошлась бы с первой на первом же
  // переподключении, поэтому в монтаже её быть не должно.
  assert.doesNotMatch(mount, /new Set|asked/, 'своей памяти о просьбах монтаж не заводит')
})

test('на просьбу есть кому ответить: кадр и обработчик на месте', () => {
  assert.match(
    read('web/src/lib/council.svelte.ts'),
    /wantOutputs\(cellId: string, participantId: string\)/,
    'CouncilState принимает просьбу',
  )
  assert.match(
    read('shared/protocol.ts'),
    /t: 'council:attempt'; cellId: string; participantId: string/,
    'кадр объявлен в общем контракте',
  )
  assert.match(read('server/src/control.ts'), /case 'council:attempt': \{/, 'сервер его разбирает')
})
