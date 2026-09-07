/**
 * Format, которому сейчас не время: отказ словами — и нажавшему, и комнате.
 *
 * Форматирование идёт в ядро мимо очереди, и под работающей ячейкой его
 * запускать нельзя: за ячейкой в `input()` запрос черноты стоял бы до конца
 * пары. Отказ поэтому мгновенный — но он был мгновенным и НЕМЫМ для всех, кроме
 * нажавшего: строку «Formatting failed: …» писал только путь после ядра, а
 * ранние отказы возвращались раньше неё. Тетрадь у комнаты не изменилась, и
 * почему — не было сказано нигде.
 *
 * Ядро тут не нужно вовсе: причина видна раньше, чем оно понадобилось, — на
 * этом весь смысл отказа и держится.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import type * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { getCells, getTerminal } from '../shared/notebook.js'
import { formatSession, requestRun, shutdownKernels } from '../server/src/kernel/index.js'

after(async () => {
  await shutdownKernels()
  shutdownCollab()
})

/** Журнал ядра комнаты — то, что читает вся комната, а не один нажавший. */
function notes(doc: Y.Doc): string[] {
  return getTerminal(doc)
    .toArray()
    .filter((line) => line.get('kind') === 'system')
    .map((line) => String(line.get('text')))
}

test('Format поверх очереди отказывает словами, и те же слова уходят в журнал', async () => {
  const id = 'fmt-refused'
  createSession(id, 'Formatting')
  const { doc } = getSessionDoc(id)
  // Вторая ячейка новой тетради — кодовая; первая markdown, её Run не берёт.
  const cellId = getCells(doc).get(1).get('id') as string

  // Ядра нет и не будет (JUPYTER_URL в тестах — заведомо мёртвый порт), но
  // очередь становится непустой прямо здесь, синхронно: насос уходит ждать
  // ядро раньше, чем успевает что-то из неё взять.
  requestRun(id, [cellId], 'Ада', 'p_ada')
  const outcome = await formatSession(id)

  assert.match(
    outcome.error ?? '',
    /cells are queued to run/,
    'отказ должен называть причину, а не молчать',
  )
  assert.equal(outcome.changed, 0, 'отказ ничего не переписывает')
  assert.ok(
    notes(doc).includes(`Formatting failed: ${outcome.error}`),
    `комната не получила причину: ${JSON.stringify(notes(doc))}`,
  )
})
