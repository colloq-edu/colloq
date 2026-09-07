/**
 * Чего стоит возврат зала: step2 каждого вернувшегося и ответ сервера ему.
 *
 * После перезапуска сервера или моргания ретранслятора пятьсот вкладок
 * переподключаются за одну-две секунды, по два сокета каждая, и на общем
 * документе это не «дельта на пару десятков байт»: step2 несёт ВЕСЬ набор
 * удалений комнаты, а ответ сервера — `encodeStateAsUpdate(doc, sv)` — тот же
 * набор обратно. Обе цифры росли всю пару и в жалобах не участвуют: их никто
 * никогда не мерил, а в находке аудита они стояли догадкой.
 *
 * Замер (эта машина, комната в 400 ячеек, 160 тысяч набранных символов и 22.8
 * тысячи удалений — семестр одного курса):
 *
 *   весь документ ................................. 750 КБ
 *   step2 вернувшегося клиента .................... 87 КБ
 *   encodeStateAsUpdate(doc, sv) синхронному ...... 87 КБ, 1.3 мс
 *   classify(step2) — разбор кадра гейтом ......... 5.6 мс
 *
 * То есть возврат зала — это ≈2.8 с занятого цикла событий на одном только
 * разборе (5.6 мс × 500) и ≈44 МБ исходящего сверх всего остального. Ни одно из
 * этого не чинится здесь; здесь это ЗАПИСАНО числом и закреплено потолками,
 * которые ловят настоящую беду: квадратичный разбор и кадр, упирающийся в
 * `MAX_SYNC_STEP2_BYTES` (после него вернувшегося не пускают вовсе).
 *
 * Потолки — с запасом на порядок: под нагруженной машиной время плавает, и
 * тест, падающий от соседнего процесса, хуже отсутствующего.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { classify, MAX_SYNC_STEP2_BYTES } from '../server/src/collab/gate.js'
import { createCell, getCells } from '../shared/notebook.js'

/** Ячеек в комнате за семестр: шесть тетрадей курса, разобранных на паре. */
const CELLS = 400
/** Символов в ячейке — и каждый седьмой стёрт: правки и есть набор удалений. */
const CHARS = 400

function semester(): Y.Doc {
  const doc = new Y.Doc()
  const cells = getCells(doc)
  doc.transact(() => {
    for (let i = 0; i < CELLS; i++) cells.push([createCell('code', '')])
  })
  for (let i = 0; i < CELLS; i++) {
    const text = (cells.get(i) as Y.Map<unknown>).get('source') as Y.Text
    doc.transact(() => {
      for (let k = 0; k < CHARS; k++) {
        text.insert(text.length, String.fromCharCode(97 + (k % 26)))
        if (k % 7 === 6) text.delete(text.length - 1, 1)
      }
    })
  }
  return doc
}

/** Сколько миллисекунд заняло — по лучшему из прогонов, а не по первому. */
function fastest(times: number, run: () => void): number {
  let best = Infinity
  for (let i = 0; i < times; i++) {
    const at = process.hrtime.bigint()
    run()
    best = Math.min(best, Number(process.hrtime.bigint() - at) / 1e6)
  }
  return best
}

test('step2 семестровой комнаты не упирается в потолок кадра', () => {
  const doc = semester()
  const server = Y.encodeStateVector(doc)

  // Вернувшийся клиент: у него всё, кроме последней минуты чужого набора.
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(doc))
  client.transact(() => {
    const text = (getCells(client).get(0) as Y.Map<unknown>).get('source') as Y.Text
    text.insert(0, 'вернулся и дописал')
  })
  const step2 = Y.encodeStateAsUpdate(client, server)

  /*
   * Кадр толще потолка — это отказ на входе: вернувшийся не синхронизируется
   * вовсе и остаётся с «нет связи» до конца пары. Семестровая комната от этой
   * границы всё ещё далеко (87 КБ против 8 МБ), и знать, насколько далеко, надо
   * до того, как в комнату лягут тетради вдвое больше.
   */
  assert.ok(
    step2.byteLength < MAX_SYNC_STEP2_BYTES / 8,
    `step2 семестра — ${(step2.byteLength / 1024).toFixed(0)} КБ, потолок ${(
      MAX_SYNC_STEP2_BYTES / 1024
    ).toFixed(0)} КБ: запас кончается`,
  )

  const judged = classify(doc, step2, MAX_SYNC_STEP2_BYTES)
  assert.equal(judged.ok, true, 'гейт не разобрал обычный кадр возврата')
  const took = fastest(5, () => classify(doc, step2, MAX_SYNC_STEP2_BYTES))
  assert.ok(took < 60, `разбор step2 занял ${took.toFixed(1)} мс — это уже не линейно`)
})

test('ответ синхронному клиенту — не пустой кадр, а весь набор удалений', () => {
  const doc = semester()
  const sv = Y.encodeStateVector(doc)
  const answer = Y.encodeStateAsUpdate(doc, sv)

  /*
   * «Клиенту, у которого всё есть, сервер отвечает почти ничем» — так это
   * читается и так это НЕ работает: структур в ответе нет, а набор удалений
   * едет целиком, и на возврате зала он уходит пятистам вкладкам.
   */
  assert.ok(
    answer.byteLength > 1024,
    'ответ синхронному клиенту стал пустым — проверьте, тот ли это Yjs',
  )
  const took = fastest(5, () => Y.encodeStateAsUpdate(doc, sv))
  assert.ok(took < 20, `сборка ответа заняла ${took.toFixed(1)} мс на комнату в ${CELLS} ячеек`)
})
