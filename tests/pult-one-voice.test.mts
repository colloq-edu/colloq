/**
 * Про одну беду — один раз, и голосом того, кто на экране.
 *
 * Терминальные состояния комнаты — «этот семинар удалён» и «эта вкладка
 * разошлась с сервером» — комната рисует поверх всего (z-[100]): под проекцией
 * (z-90) и обёрткой пульта (z-95) они были нарисованы и невидимы, а обе
 * поверхности продолжали выглядеть живыми. Плашки подняли — и на планшете
 * стало по два сообщения об одном: лист пульта внутри обёртки и полоса комнаты
 * поверх него. Ломаться от этого ничего не ломается, но говорится дважды, и
 * вторым голосом — собранным для окна с мышью: строка в text-ui и кнопка в
 * 30 px у нижней кромки планшета.
 *
 * Поэтому уговор: на пульте про удалённую комнату и про расхождение говорит
 * ConsoleView — своими словами, своим размером под палец и с обещанием, что
 * лекция не прервалась, — а комната на пульте молчит. На проекции всё
 * наоборот: LectureView собственных слов не имеет, и полоса комнаты там
 * единственное, что объясняет залу застывшую страницу.
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

const SESSION = code(read('web/src/screens/SessionScreen.svelte'))
const CONSOLE = code(read('web/src/components/lecture/ConsoleView.svelte'))

test('комната молчит про удалённый семинар там, где говорит пульт', () => {
  assert.match(SESSION, /\{#if session\.gone && !pult\}/, 'плашка комнаты снова рисуется на пульте')
  assert.match(CONSOLE, /\{#if session\.gone\}/, 'а пульт про удалённую комнату не говорит вовсе')
})

test('комната молчит про расхождение с сервером там, где говорит пульт', () => {
  assert.match(
    SESSION,
    /\{#if session\.stuck && !session\.gone && !pult\}/,
    'полоса комнаты снова ложится поверх листа пульта — два сообщения об одном',
  )
  assert.match(CONSOLE, /\{:else if session\.stuck\}/, 'а пульт про расхождение молчит')
  assert.match(CONSOLE, /reloadByHand\(\)/, 'на пульте нет кнопки перезагрузки')
})

test('на проекции обе плашки остаются: своих слов у неё нет', () => {
  // Балка — ровно тот случай, ради которого плашки поднимали над z-90: зал
  // видит застывшую страницу, а причины на экране нет. Своих слов у проекции
  // не появилось, значит гасить на ней нечего.
  const lecture = code(read('web/src/components/lecture/LectureView.svelte'))
  assert.doesNotMatch(lecture, /session\.stuck/, 'проекция завела свои слова — уговор поменялся')
  const gone = SESSION.match(/\{#if session\.gone[^}]*\}/)?.[0] ?? ''
  const stuck = SESSION.match(/\{#if session\.stuck && !session\.gone[^}]*\}/)?.[0] ?? ''
  for (const [what, plate] of [
    ['«удалён»', gone],
    ['«разошлись»', stuck],
  ] as const) {
    assert.doesNotMatch(plate, /projection/, `${what}: плашку погасили и на балке`)
  }
})

test('подъём стека уведомлений над полосой остался при полосе', () => {
  // Стек и так рисуется только в комнате (`!pult && !projection`), но высота
  // его нижнего отступа считается от `session.stuck` — то есть от того, есть
  // ли под ним полоса. Разъехаться этим двум нельзя: тосты сядут на неё.
  assert.match(
    SESSION,
    /\{#if !session\.gone && !pult && !projection\}/,
    'стек уведомлений рисуется не только в комнате',
  )
  assert.match(
    SESSION,
    /session\.stuck \? 'bottom-\[4\.75rem\]' : 'bottom-4'/,
    'подъём стека уехал',
  )
})
