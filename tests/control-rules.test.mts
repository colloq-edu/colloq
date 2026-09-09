/**
 * Таблица прав на управляющем сокете.
 *
 * Каждая строка здесь — отказ, который должен прозвучать РАНЬШЕ действия:
 * ядро не трогается, оболочка не открывается, очередь не растёт. Сокет
 * поддельный, ядра нет вовсе — но ловит промах именно утверждение, а не
 * отсутствие ядра: `JUPYTER_URL` смотрит в мёртвый порт, отказ соединения
 * глотается молча, и пропущенная проверка сама по себе теста не роняет.
 * (Обратное здесь было написано и звучало убедительно ровно до первой попытки
 * на это положиться.) Побочный эффект той же тишины: разрешающая половина
 * каждой строки будит переподключения ядра и оболочки, которые живут до
 * `--test-force-exit`.
 *
 * И вторая половина, без которой первая ничего не стоит: при разрешающих
 * умолчаниях всё это проходит. Правило, которое отказывает всем, — не правило.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, notesOf, setRules } from '../server/src/db.js'
import { makeFile } from '../server/src/workspace.js'
import { OPEN_ROOM, type RoomRules } from '../shared/rules.js'
import { dispatch } from '../server/src/control.js'
import { addInk, inkOf, lectureOf, startLecture, stopLecture, turnTo } from '../server/src/lecture.js'
import type { ControlClientMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

/** Ровно то, что читает `send`: состояние и приём кадра. */
function socket(): { ws: WebSocket; said: string[] } {
  const said: string[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => {
      const message = JSON.parse(frame) as { t: string; message?: string }
      if (message.t === 'error') said.push(message.message ?? '')
    },
  } as unknown as WebSocket
  return { ws, said }
}

let rooms = 0

/** Комната с этими правилами и один человек в ней. */
function room(rules: Partial<RoomRules>): string {
  const id = `ctl-${++rooms}`
  createSession(id, 'Control', null)
  setRules(id, { ...OPEN_ROOM, ...rules })
  return id
}

function who(role: 'host' | 'participant', sessionId: string): TokenPayload {
  return { sessionId, participantId: `p_${role}`, role }
}

/** Что сказал сервер в ответ на это сообщение. `null` — не сказал ничего. */
function say(
  sessionId: string,
  role: 'host' | 'participant',
  message: ControlClientMessage,
): string | null {
  const { ws, said } = socket()
  dispatch(ws, sessionId, who(role, sessionId), message)
  return said[0] ?? null
}

/* ------------------------------------------------------------ весь лист */

test('«по одной» разрешает ячейку и отказывает всему листу', () => {
  const id = room({ run: 'single' })
  // Одна ячейка — до ядра дойти и не должно: такой ячейки в тетради нет.
  assert.equal(say(id, 'participant', { t: 'run', cellId: 'c_nope' }), null)
  assert.match(say(id, 'participant', { t: 'runAll' }) ?? '', /по одной/)
  assert.match(say(id, 'participant', { t: 'runAbove', cellId: 'c_nope' }) ?? '', /по одной/)
  // Преподавателю — и то и другое.
  assert.equal(say(id, 'host', { t: 'runAll' }), null)
})

test('«запускает преподаватель» отказывает и ячейке, и листу', () => {
  const id = room({ run: 'host' })
  assert.ok(say(id, 'participant', { t: 'run', cellId: 'c_nope' }))
  assert.ok(say(id, 'participant', { t: 'runAll' }))
  assert.equal(say(id, 'host', { t: 'run', cellId: 'c_nope' }), null)
})

/* -------------------------------------------------- своё и общее — разное */

test('свою ячейку студент чистит, всю доску — нет', () => {
  /*
   * Иначе «стирать всё — преподавателю» запрещало бы студенту прибрать за
   * собой в собственной ячейке, чего никто не имел в виду.
   */
  const id = room({ wipe: 'host' })
  assert.equal(say(id, 'participant', { t: 'clearOutputs', cellId: 'c_nope' }), null)
  assert.match(say(id, 'participant', { t: 'clearOutputs' }) ?? '', /доск/i)
  assert.equal(say(id, 'host', { t: 'clearOutputs' }), null)
})

test('в лекционной комнате студент не чистит и свою ячейку', () => {
  // Вывод — часть тетради; правило про тетрадь распространяется и на него.
  const id = room({ edit: 'host' })
  assert.ok(say(id, 'participant', { t: 'clearOutputs', cellId: 'c_nope' }))
})

/* --------------------------------------------------------------- оболочка */

test('открыть и закрыть оболочку — не одно право', () => {
  /*
   * Открыть может любой: оболочка общая и в этом её смысл. Закрыть — то же, что
   * стереть расшифровку: гасит её тот, кто вправе стирать общее, иначе один
   * клик убирает у комнаты то, что она смотрела.
   */
  const id = room({})
  assert.equal(say(id, 'participant', { t: 'term:open' }), null)
  assert.equal(say(id, 'participant', { t: 'term:run', command: 'ls' }), null)
  assert.ok(say(id, 'participant', { t: 'term:close' }))
  assert.equal(say(id, 'host', { t: 'term:close' }), null)
})

/* ------------------------------------------------------------ состав и ядро */

test('«только дописывать» не даёт переставлять чужие ячейки', () => {
  // Переставить в никуда — обход запрета убирать, поэтому move идёт с remove.
  const id = room({ structure: 'add' })
  assert.match(
    say(id, 'participant', { t: 'cells:move', cellId: 'c_nope', direction: 1 }) ?? '',
    /порядок/i,
  )
  assert.equal(say(id, 'host', { t: 'cells:move', cellId: 'c_nope', direction: 1 }), null)
})

test('перезапуск ядра — правило, а не роль', () => {
  const strict = room({})
  assert.ok(say(strict, 'participant', { t: 'restart' }))
  // Комната, где работают вдвоём, вправе решить иначе.
  const open = room({ restart: 'room' })
  assert.equal(say(open, 'participant', { t: 'restart' }), null)
})

test('форматирование строже обоих соседей', () => {
  // black и переписывает каждую ячейку, и выполняется на общем ядре.
  assert.ok(say(room({ edit: 'host' }), 'participant', { t: 'format' }))
  assert.ok(say(room({ run: 'single' }), 'participant', { t: 'format' }))
  assert.equal(say(room({}), 'participant', { t: 'format' }), null)
})

/* ---------------------------------------------------- поведение, не право */

test('ответ на input() приходит от того, чья ячейка спрашивает', () => {
  /*
   * Приглашение живёт в документе, потому что его должна видеть комната. Видеть
   * и отвечать — разное, а `input()` под паролем тем более.
   */
  const id = room({})
  assert.match(say(id, 'participant', { t: 'input', value: 'пароль' }) ?? '', /участник, запустивший ячейку/i)
  assert.equal(say(id, 'host', { t: 'input', value: 'да' }), null)
})

test('замок на ячейке — роль, а не правило комнаты', () => {
  /*
   * Открывает ячейки тот, чья тетрадь, и правила об этом не спрашивают:
   * RoomRules говорят, что в комнате можно делать, а не кто раздаёт права. Само
   * поведение замка — в control-lock.test.mts; здесь только строка в таблице.
   */
  const id = room({ run: 'host', edit: 'host' })
  assert.match(
    say(id, 'participant', { t: 'cell:open', cellId: 'c_nope', open: true }) ?? '',
    /преподавател/i,
  )
  // А преподавателю отказ уже не про право: такой ячейки в комнате нет.
  assert.match(say(id, 'host', { t: 'cell:open', cellId: 'c_nope', open: true }) ?? '', /ячейки/i)
})

test('остановить может тот, чья ячейка считается, — или преподаватель', () => {
  // Правило старше правил комнаты и ими не управляется: ядро одно, и остановка
  // задевает того, чей код в нём сейчас.
  const id = room({})
  assert.match(say(id, 'participant', { t: 'interrupt' }) ?? '', /преподаватель/i)
  assert.equal(say(id, 'host', { t: 'interrupt' }), null)
})

/* ------------------------------------------------- и всё это при умолчаниях */

test('в комнате, где ничего не решали, студенту не отказывает ничто из его работы', () => {
  // Правило, которое отказывает всем, — не правило. Умолчание — это Colloq,
  // каким он был: работать в тетради и в оболочке может вся комната.
  const id = room({})
  const messages: ControlClientMessage[] = [
    { t: 'run', cellId: 'c_nope' },
    { t: 'runAll' },
    { t: 'runAbove', cellId: 'c_nope' },
    { t: 'clearOutputs', cellId: 'c_nope' },
    { t: 'format' },
    { t: 'term:open' },
    { t: 'term:run', command: 'ls' },
    { t: 'cells:move', cellId: 'c_nope', direction: 1 },
  ]
  for (const message of messages) {
    assert.equal(say(id, 'participant', message), null, `отказано на ${message.t}`)
  }
})

test('а разрушительное для всей комнаты — преподавательское с самого начала', () => {
  /*
   * Единственное место, где умолчание строже прежнего поведения, и это
   * намеренно. «Стереть все выводы» не спрашивало никого: одно нажатие
   * студента убирало с экрана всё, что комната насчитала за полтора часа, и
   * вернуть это нельзя ничем, кроме повторного запуска. Перезапуск ядра и
   * очистка расшифровки были преподавательскими и раньше.
   */
  const id = room({})
  for (const message of [
    { t: 'clearOutputs' },
    { t: 'restart' },
    { t: 'term:clear' },
  ] as ControlClientMessage[]) {
    assert.ok(say(id, 'participant', message), `${message.t} прошло у студента`)
    assert.equal(say(id, 'host', message), null, `${message.t} отказано преподавателю`)
  }
})

/* ------------------------------------------------------------ общий экран */

test('поставить документ комнате может преподаватель, смотреть — любой', () => {
  /*
   * Право здесь про общий экран, а не про чтение: файл комнаты и так
   * скачивается кем угодно из неё, и запрещать студенту открыть PDF у себя
   * значило бы запретить то, что уже разрешено кнопкой «скачать».
   */
  const id = room({})
  assert.match(say(id, 'participant', { t: 'board:open', name: 'lecture.pdf' }) ?? '', /преподавател/i)
  assert.match(say(id, 'participant', { t: 'board:close' }) ?? '', /преподавател/i)
})

test('комната, где показывать разрешено всем, пускает студента', () => {
  // Семинар, где студенты по очереди показывают своё, — не выдумка.
  const id = room({ board: 'room' })
  // Файла нет — и отказ должен быть про файл, а не про право.
  assert.match(say(id, 'participant', { t: 'board:open', name: 'lecture.pdf' }) ?? '', /файла/i)
  assert.equal(say(id, 'participant', { t: 'board:close' }), null)
})

test('на общий экран нельзя поставить то, чего в комнате нет', () => {
  /*
   * Проверяется на сервере, а не у смотрящего: иначе комната получит имя,
   * которого нет, и двадцать человек увидят пустую область без объяснения.
   */
  const id = room({})
  assert.match(say(id, 'host', { t: 'board:open', name: 'нет-такого.pdf' }) ?? '', /файла/i)
  assert.match(say(id, 'host', { t: 'board:open', name: '' }) ?? '', /файла/i)
})

/* --------------------------------------------------------- заметки спикера */

test('заметки спикера — это роль преподавателя, а не правило комнаты', () => {
  /*
   * Комната, где документ на общий экран ставит любой, — обычная. Заметки в
   * ней всё равно преподавательские: правило `board` решает, кому показывать
   * документ ЗАЛУ, а заметка залу не показывается никогда.
   */
  const id = room({ board: 'room' })
  assert.match(say(id, 'participant', { t: 'notes:open', file: 'l.pdf' }) ?? '', /преподавател/i)
  assert.match(
    say(id, 'participant', { t: 'notes:set', file: 'l.pdf', page: 1, text: 'спросить про Гаусса' }) ??
      '',
    /преподавател/i,
  )
  assert.deepEqual(notesOf(id, 'l.pdf'), {}, 'студент дописался в чужую речь')

  assert.equal(say(id, 'host', { t: 'notes:open', file: 'l.pdf' }), null)
  assert.equal(say(id, 'host', { t: 'notes:set', file: 'l.pdf', page: 1, text: 'спросить про Гаусса' }), null)
  assert.deepEqual(notesOf(id, 'l.pdf'), { 1: 'спросить про Гаусса' })
})

test('заметка длиннее потолка не пропадает молча', () => {
  /*
   * Кадр толще 8192 байт сервер выбрасывает в `parse` без единого слова, и
   * страница речи исчезает посреди пары. Потолок на знаки стоит с запасом под
   * кириллицу, и отказ на нём говорящий — иначе он ничем не лучше молчания.
   */
  const id = room({})
  assert.match(
    say(id, 'host', { t: 'notes:set', file: 'l.pdf', page: 1, text: 'я'.repeat(3001) }) ?? '',
    /3000/,
  )
  assert.deepEqual(notesOf(id, 'l.pdf'), {})
})

/* ----------------------------------------------------------------- ластик */

test('ластик слушается ведущего и молчит у всех остальных', () => {
  /*
   * Отказ здесь молчаливый намеренно: это не решение преподавателя, о котором
   * надо рассказать, а вкладка, не знающая, что лекцию ведёт кто-то другой.
   */
  const id = room({})
  startLecture(id, { file: 'l.pdf', by: 'p_host', byName: 'Пётр Ильич', color: '#0f2d69' })
  addInk(id, { id: 's1', page: 3, color: '#d4162f', width: 0.005, points: [0.1, 0.1, 0.2, 0.2] })

  assert.equal(say(id, 'participant', { t: 'ink:erase', page: 3, id: 's1' }), null)
  assert.equal(inkOf(id).length, 1, 'не ведущий стёр чужой штрих')

  assert.equal(say(id, 'host', { t: 'ink:erase', page: 3, id: 's1' }), null)
  assert.equal(inkOf(id).length, 0)
  stopLecture(id)
})

/* ------------------------------------------------------------ передача рук */

test('второй преподаватель берёт пульт, не начиная лекцию заново', () => {
  /*
   * Кнопки «взять пульт» в проводе нет: она шлёт тот же `lecture:start` по
   * тому же файлу. Если он уйдёт в `startLecture`, нажатие на сороковой минуте
   * вернёт страницу на первую, сотрёт всю разметку и обнулит часы — и сделает
   * это на проекторе, при всех. Здесь проверяется именно развилка в `dispatch`:
   * сама передача рук проверена в lecture.test.mts.
   */
  const id = room({})
  makeFile(id, 'l3.pdf', '%PDF-1.4')
  startLecture(id, { file: 'l3.pdf', by: 'p_first', byName: 'Ада', color: '#d4162f' })
  turnTo(id, 14)
  addInk(id, { id: 's1', page: 14, color: '#d4162f', width: 0.005, points: [0.1, 0.1, 0.2, 0.2] })
  const began = lectureOf(id)?.startedAt

  const { ws } = socket()
  dispatch(ws, id, { sessionId: id, participantId: 'p_second', role: 'host' }, {
    t: 'lecture:start',
    file: 'l3.pdf',
  })

  assert.equal(lectureOf(id)?.by, 'p_second', 'пульт не перешёл')
  assert.equal(lectureOf(id)?.page, 14, 'страница вернулась к началу')
  assert.equal(lectureOf(id)?.startedAt, began, 'часы лекции пошли заново')
  assert.equal(inkOf(id).length, 1, 'разметка стёрлась')
  stopLecture(id)
})

test('тот же преподаватель по тому же файлу не начинает ничего', () => {
  /*
   * Список «сменить документ» показывает все PDF комнаты, и текущий стоит в том
   * же ряду: нажатие по нему читается как «убедиться, что открыт правильный».
   * Стоило это сорока минутами разметки и часами лекции, стёртыми на проекторе
   * при всех. Начать заново — это «Закончить» и потом «Лекция»: два нажатия,
   * второе из которых делают осознанно.
   */
  const id = room({})
  makeFile(id, 'l3.pdf', '%PDF-1.4')
  startLecture(id, { file: 'l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  turnTo(id, 14)
  addInk(id, { id: 's1', page: 14, color: '#d4162f', width: 0.005, points: [0.1, 0.1, 0.2, 0.2] })
  const began = lectureOf(id)?.startedAt

  assert.equal(say(id, 'host', { t: 'lecture:start', file: 'l3.pdf' }), null)
  assert.equal(lectureOf(id)?.page, 14, 'страница вернулась к началу')
  assert.equal(lectureOf(id)?.startedAt, began, 'часы пошли заново')
  assert.equal(inkOf(id).length, 1, 'разметка стёрлась')
  stopLecture(id)
})

test('пульт у ведущего забирает преподаватель, а не всякий, кому можно доску', () => {
  /*
   * Правило `board` решает, кому ставить документ залу. Забрать управление у
   * того, кто уже ведёт, — другой поступок: в открытой комнате это значило бы,
   * что студент посреди пары молча берёт себе страницу, чернила и указку, а
   * преподаватель узнаёт об этом по пропавшему пульту.
   */
  const id = room({ board: 'room' })
  makeFile(id, 'l4.pdf', '%PDF-1.4')
  startLecture(id, { file: 'l4.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  turnTo(id, 9)

  const denied = say(id, 'participant', { t: 'lecture:start', file: 'l4.pdf' })
  assert.match(String(denied ?? ''), /преподаватель/)
  assert.equal(lectureOf(id)?.by, 'p_host', 'пульт ушёл студенту')
  assert.equal(lectureOf(id)?.page, 9)
  stopLecture(id)
})

/* ------------------------------------------------- лекция идёт, руки чужие */

test('пока идёт лекция, чужая рука не меняет документ и не убирает его', () => {
  /*
   * У семинара бывает двое ведущих. Второй на ноутбуке щёлкает `homework.pdf` в
   * панели файлов — это `board:open`, и раньше оно молча заканчивало лекцию
   * первого: проектор гас, сорок минут разметки исчезали, вернуть их нечем
   * (чернила живут только в памяти). Крестик на вкладке документа лекции — тот
   * же случай: он шлёт `board:close`.
   */
  const id = room({})
  makeFile(id, 'l3.pdf', '%PDF-1.4')
  makeFile(id, 'homework.pdf', '%PDF-1.4')
  startLecture(id, { file: 'l3.pdf', by: 'p_first', byName: 'Ада', color: '#d4162f' })
  turnTo(id, 14)
  addInk(id, { id: 's1', page: 14, color: '#d4162f', width: 0.005, points: [0.1, 0.1, 0.2, 0.2] })

  for (const message of [
    { t: 'board:open', name: 'homework.pdf' },
    { t: 'board:close' },
    { t: 'lecture:start', file: 'homework.pdf' },
  ] as ControlClientMessage[]) {
    assert.match(say(id, 'host', message) ?? '', /Идёт лекция/, `${message.t} прошло молча`)
  }
  assert.equal(lectureOf(id)?.file, 'l3.pdf', 'лекция закончилась чужой рукой')
  assert.equal(lectureOf(id)?.page, 14)
  assert.equal(inkOf(id).length, 1, 'разметка стёрлась')
  stopLecture(id)
})

test('свою лекцию ведущий переводит на другой документ сам', () => {
  // Ровно то, что делает «Ещё → сменить документ» на пульте: это его лекция, и
  // начинается она начисто.
  const id = room({})
  makeFile(id, 'l3.pdf', '%PDF-1.4')
  makeFile(id, 'l4.pdf', '%PDF-1.4')
  startLecture(id, { file: 'l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  turnTo(id, 14)

  assert.equal(say(id, 'host', { t: 'lecture:start', file: 'l4.pdf' }), null)
  assert.equal(lectureOf(id)?.file, 'l4.pdf')
  assert.equal(lectureOf(id)?.page, 1, 'другой документ — другая лекция, и она начинается сначала')
  stopLecture(id)
})

test('в комнате, где доску ставит любой, лекцию преподавателя студент не гасит', () => {
  /*
   * Правило `board` решает, кому ставить документ залу; закончить чужую лекцию
   * — другой поступок, и обходных путей к нему быть не должно: ни крестиком на
   * вкладке, ни другим PDF, ни кнопкой «Закончить».
   */
  const id = room({ board: 'room' })
  makeFile(id, 'l4.pdf', '%PDF-1.4')
  makeFile(id, 'seminar.pdf', '%PDF-1.4')
  startLecture(id, { file: 'l4.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })

  for (const message of [
    { t: 'board:close' },
    { t: 'board:open', name: 'seminar.pdf' },
    { t: 'lecture:start', file: 'seminar.pdf' },
  ] as ControlClientMessage[]) {
    assert.match(say(id, 'participant', message) ?? '', /Идёт лекция/, `${message.t} прошло молча`)
  }
  assert.match(say(id, 'participant', { t: 'lecture:stop' }) ?? '', /преподаватель/)
  assert.equal(lectureOf(id)?.file, 'l4.pdf', 'лекция кончилась не своей рукой')
  stopLecture(id)
})

/* ------------------------------------------------------- оболочка и ядро */

test('команда в оболочке — под тем же правилом, что и ячейка', () => {
  /*
   * Тот же контейнер и то же процессорное время: комната, где кнопка
   * «Запустить» над файлом погашена словами «Запускает преподаватель», не может
   * разрешать тот же скрипт строкой ниже. Открыть ящик и читать общий вывод
   * по-прежнему может любой — оболочка комнаты остаётся общей.
   */
  const id = room({ run: 'host' })
  assert.equal(say(id, 'participant', { t: 'term:open' }), null)
  assert.match(
    say(id, 'participant', { t: 'term:run', command: 'python train.py' }) ?? '',
    /преподавател/i,
  )
  assert.equal(say(id, 'host', { t: 'term:run', command: 'ls' }), null)
})

test('вкладка убранной тетради не запускает и не стирает чужой лист', () => {
  /*
   * Тетрадь убрали из комнаты, а вкладка у соседа живёт до прихода списка
   * файлов. Нажатие в ней попадало в тетрадь комнаты: Run All ставил в очередь
   * ЧУЖОЙ лист целиком, а «Clear» стирал выводы всех тетрадей сразу.
   */
  const id = room({})
  for (const message of [
    { t: 'runAll', book: 'hw.ipynb' },
    { t: 'runAbove', cellId: 'c_nope', book: 'hw.ipynb' },
    { t: 'clearOutputs', book: 'hw.ipynb' },
  ] as ControlClientMessage[]) {
    assert.match(say(id, 'host', message) ?? '', /тетради в комнате больше нет/, message.t)
  }
})

test('выключенный оракул не запирает отмену собственного хода', () => {
  /*
   * Правила меняются на живой комнате, и ход тут естественный: оракул натворил
   * → выключаю оракула → откатываю. Отказ на последнем шаге вдобавок говорил
   * «может преподаватель» тому самому преподавателю.
   */
  const id = room({ agent: 'off' })
  const host = say(id, 'host', { t: 'ai:undo', entryId: 'e_nope' })
  assert.doesNotMatch(String(host ?? ''), /может преподаватель/)
  assert.match(String(host ?? ''), /уже нельзя отменить/)
  assert.match(say(id, 'participant', { t: 'ai:undo', entryId: 'e_nope' }) ?? '', /преподавател/i)
})
