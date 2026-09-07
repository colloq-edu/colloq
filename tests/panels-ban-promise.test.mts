import './_env.mts'
/**
 * Что окно бана обещает — и что комната умеет.
 *
 * Бан стирает вопросы человека из общей ленты, и это последствие, о котором
 * никто не догадается сам. Поэтому интерфейс о нём говорит — и в двух местах
 * говорил лишнее: «восстановлением версии вопросы вернутся» (окно
 * подтверждения) и «их возвращает восстановление версии в истории» (подпись
 * под списком удалённых). Ни то, ни другое неправда: история комнаты хранит
 * ЯЧЕЙКИ тетради, и возврат версии ленту не трогает вовсе. Преподаватель
 * нажимал «Удалить», уверенный, что ход обратим, а после «Вернуть целиком» на
 * отметке «до бана» получал нетронутую тетрадь и ту же пустую ленту.
 *
 * Тест держит обе стороны: что история и правда не про ленту (иначе обещание
 * можно было бы и выполнить), и что подпись в панели этого больше не обещает.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { createCell, createChatEntry, getChat, CELLS_KEY } from '../shared/notebook.js'
import { cellsOf } from '../server/src/collab/history.js'

test('снимок версии — это ячейки тетради, и ленты вопросов в нём нет', () => {
  const doc = new Y.Doc()
  doc.getArray<Y.Map<any>>(CELLS_KEY).push([createCell('code', 'print(1)')])
  getChat(doc).push([
    createChatEntry({
      participantId: 'p1',
      name: 'Нина',
      color: '#000',
      question: 'почему тут ошибка?',
    }),
  ])

  /*
   * `cellsAt(seq)` — единственный источник того, что кладёт обратно возврат, и
   * он сводится к `cellsOf`. Пока это так, «восстановлением версии вопросы
   * вернутся» — обещание за чужой счёт, сколько бы отметок ни ставил бан.
   */
  const restored = cellsOf(doc)
  assert.equal(restored.length, 1, 'ячейка в снимке одна')
  assert.equal(restored[0].source, 'print(1)')
  const said = JSON.stringify(restored)
  assert.doesNotMatch(said, /почему тут ошибка/, 'вопрос в снимок версии не попадает')
  assert.ok(
    !Object.prototype.hasOwnProperty.call(restored[0], 'chat'),
    'у исторической ячейки нет ленты',
  )
})

test('панель людей больше не обещает, что возврат версии вернёт вопросы', () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../web/src/components/panels/PeoplePanel.svelte'),
    'utf8',
  )
  // Подпись под списком удалённых, без комментариев вокруг неё.
  const markup = source.slice(source.indexOf('</script>')).replace(/<!--[\s\S]*?-->/g, '')
  assert.match(markup, /Вопросы к оракулу этим не возвращаются/, 'про стёртые вопросы сказано')
  assert.doesNotMatch(
    markup,
    /их возвращает восстановление/,
    'и не сказано, что их вернёт восстановление версии',
  )
})
