/**
 * Заметки спикера: речь преподавателя самому себе.
 *
 * Единственное в этом продукте, чего комнате видеть не полагается. Заметка
 * «здесь спросить, кто помнит формулу Байеса; если молчат — вывести на доске»,
 * приехавшая всем, приезжает вместе с ответом на ещё не заданный вопрос — и
 * ломается это МОЛЧА: у преподавателя на экране всё как надо, а у двадцати
 * человек в зале лишняя строка, которую никто не заметит до конца пары.
 *
 * Поэтому здесь проверяется не право (оно в control-rules), а адресат: кому
 * кадр уехал на самом деле. И три способа потерять уже написанное — пустая
 * строка вместо удаления, переименование документа и удаление семинара.
 *
 * Сокет поддельный, но комната настоящая: `toHosts` перебирает
 * зарегистрированные сокеты комнаты и спрашивает у них роль, а роль
 * запоминается только при подключении. Проверять такое мимо подключения
 * бессмысленно — рассылке просто некуда идти, и тест был бы зелёным всегда.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, discardNotes, notesOf, setNote } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { makeFile } from '../server/src/workspace.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

/** Поддельный сокет, который умеет ровно то, что от него хочет `control.ts`. */
function socket(): { ws: WebSocket; heard: ControlServerMessage[] } {
  const heard: ControlServerMessage[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => heard.push(JSON.parse(frame) as ControlServerMessage),
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping: () => {},
    terminate: () => {},
    // Закрытие обязано дойти до обработчика: в нём гасится сердцебиение, а без
    // него интервал переживёт тест и потащит за собой всю сюиту.
    close: () => {
      for (const fn of handlers.get('close') ?? []) fn()
    },
  } as unknown as WebSocket
  return { ws, heard }
}

function who(sessionId: string, role: 'host' | 'participant', tag: string = role): TokenPayload {
  return { sessionId, participantId: `p_${tag}`, role }
}

let rooms = 0

/**
 * Комната с тремя подключёнными: два преподавателя и студент.
 *
 * Двое ведущих — не выдумка ради полноты: у семинара их бывает двое, и правка,
 * сделанная на ноутбуке первого, обязана дойти до планшета второго. Ровно из-за
 * этого рассылка не может быть `tell`.
 */
function room() {
  const id = `notes-${++rooms}`
  createSession(id, 'Заметки', null)
  const first = socket()
  const second = socket()
  const guest = socket()
  handleControlSocket(first.ws, id, who(id, 'host', 'host'))
  handleControlSocket(second.ws, id, who(id, 'host', 'host2'))
  handleControlSocket(guest.ws, id, who(id, 'participant'))
  /*
   * Оба преподавателя открывают заметки к документу — ровно это делает пульт,
   * когда показывает лекцию. Эхо правки приходит только тем, кто спрашивал про
   * ЭТОТ файл: у одного человека вкладок бывает две, и вторая из них — проекция
   * на кафедральном ноутбуке, раскрытом перед аудиторией.
   */
  dispatch(first.ws, id, who(id, 'host', 'host'), { t: 'notes:open', file: 'l3.pdf' })
  dispatch(second.ws, id, who(id, 'host', 'host2'), { t: 'notes:open', file: 'l3.pdf' })
  dispatch(guest.ws, id, who(id, 'participant'), { t: 'notes:open', file: 'l3.pdf' })
  // Приветственная пачка и ответы на открытие — не наше дело: смотрим только на
  // то, что придёт после.
  for (const one of [first, second, guest]) one.heard.length = 0
  return { id, first, second, guest }
}

/** Сказать от чьего-то имени по его же сокету. */
function say(
  id: string,
  from: { ws: WebSocket },
  payload: TokenPayload,
  message: ControlClientMessage,
): void {
  dispatch(from.ws, id, payload, message)
}

function notesFrames(heard: ControlServerMessage[]): ControlServerMessage[] {
  return heard.filter((frame) => frame.t === 'notes' || frame.t === 'notes:one')
}

/* ------------------------------------------------------------- адресат */

test('карта заметок уезжает одному спросившему, и он обязан быть преподавателем', () => {
  const { id, first, second, guest } = room()
  setNote(id, 'l3.pdf', 7, 'спросить про поток')

  say(id, guest, who(id, 'participant'), { t: 'notes:open', file: 'l3.pdf' })
  assert.deepEqual(notesFrames(guest.heard), [], 'речь преподавателя уехала в зал')
  assert.match(guest.heard.find((frame) => frame.t === 'error')?.message ?? '', /преподавател/i)

  say(id, first, who(id, 'host', 'host'), { t: 'notes:open', file: 'l3.pdf' })
  assert.deepEqual(notesFrames(first.heard), [
    { t: 'notes', file: 'l3.pdf', notes: { 7: 'спросить про поток' } },
  ])
  /*
   * Второму преподавателю — ничего: он ничего не спрашивал. Карта к документу,
   * которого у него не открыто, подменила бы на его пульте свою.
   */
  assert.deepEqual(notesFrames(second.heard), [])
  closeControlRoom(id)
})

test('правка доходит до второго преподавателя и не доходит до зала', () => {
  const { id, first, second, guest } = room()

  say(id, first, who(id, 'host', 'host'), {
    t: 'notes:set',
    file: 'l3.pdf',
    page: 7,
    text: 'спросить, кто помнит формулу Байеса',
  })

  const echo = {
    t: 'notes:one',
    file: 'l3.pdf',
    page: 7,
    text: 'спросить, кто помнит формулу Байеса',
  }
  // Себе — тоже: ноутбук и планшет одного человека это два разных сокета, и
  // второй узнаёт о правке только так.
  assert.deepEqual(notesFrames(first.heard), [echo])
  assert.deepEqual(notesFrames(second.heard), [echo])
  assert.deepEqual(notesFrames(guest.heard), [], 'заметка уехала студенту')
  closeControlRoom(id)
})

test('вкладка, не спрашивавшая заметок, их и не получает', () => {
  /*
   * Проекция на кафедральном ноутбуке входит по тому же ключу тем же
   * участником — то есть тоже «преподаватель». Речь преподавателя самому себе
   * не должна лежать в памяти машины, раскрытой перед аудиторией, даже если на
   * экран она этого не выводит: файл, которого там нет, невозможно случайно
   * показать.
   */
  const { id, first, second } = room()
  // Второй «уходит с документа»: пульт спросил заметки к другому файлу.
  say(id, second, who(id, 'host', 'host2'), { t: 'notes:open', file: 'other.pdf' })
  second.heard.length = 0

  say(id, first, who(id, 'host', 'host'), {
    t: 'notes:set',
    file: 'l3.pdf',
    page: 7,
    text: 'здесь пауза',
  })
  assert.equal(notesFrames(first.heard).length, 1)
  assert.deepEqual(notesFrames(second.heard), [], 'заметка уехала на чужой документ')
  closeControlRoom(id)
})

/* -------------------------------------------------------- пустая заметка */

test('пустая заметка — это её отсутствие, а не пустая строка в карте', () => {
  /*
   * Иначе лента показывает точку «здесь есть что сказать» над страницей, где
   * не сказано ничего, — и преподаватель на паре ищет глазами текст, которого
   * нет. Строка из пробелов — тот же случай: её оставляет тот, кто стёр
   * заметку не до конца.
   */
  const { id, first } = room()
  const host = who(id, 'host', 'host')

  say(id, first, host, { t: 'notes:set', file: 'l3.pdf', page: 7, text: 'сказать про Стокса' })
  assert.deepEqual(notesOf(id, 'l3.pdf'), { 7: 'сказать про Стокса' })

  say(id, first, host, { t: 'notes:set', file: 'l3.pdf', page: 7, text: '   \n  ' })
  assert.deepEqual(notesOf(id, 'l3.pdf'), {}, 'страница осталась в карте пустой строкой')

  // И эхо говорит то же самое, что легло в базу: иначе у второго устройства
  // останутся пробелы там, где заметки уже нет.
  const last = notesFrames(first.heard).at(-1)
  assert.deepEqual(last, { t: 'notes:one', file: 'l3.pdf', page: 7, text: '' })
  closeControlRoom(id)
})

test('страница заметки — целая и не меньше первой', () => {
  const { id, first } = room()
  const host = who(id, 'host', 'host')

  say(id, first, host, { t: 'notes:set', file: 'l3.pdf', page: 7.8, text: 'дробная' })
  assert.deepEqual(notesOf(id, 'l3.pdf'), { 7: 'дробная' }, 'дробная страница округляется вниз')

  // Нулевой и отрицательной страницы не бывает: это мусор из вкладки, и
  // молчать о нём нельзя — всё, что теряет написанный текст, говорит вслух.
  say(id, first, host, { t: 'notes:set', file: 'l3.pdf', page: 0, text: 'ниоткуда' })
  assert.match(first.heard.find((frame) => frame.t === 'error')?.message ?? '', /страниц/i)
  assert.deepEqual(notesOf(id, 'l3.pdf'), { 7: 'дробная' })
  closeControlRoom(id)
})

/* ------------------------------------------------ переименование и удаление */

test('переименование документа уводит заметки за собой', () => {
  /*
   * Вечер, потраченный на речь к двадцати четырём страницам, привязан к ПУТИ
   * документа. Преподаватель правит «l3.pdf» на «Лекция 3. Поток и
   * дивергенция.pdf» — обычное дело, — и без переезда заметки остаются
   * строками, к которым больше нет ключа: старого пути на диске уже нет, а
   * восстановить их из интерфейса нечем.
   *
   * Проверяется через `tree:move`, а не через `moveNotesTo`: сама функция была
   * написана давно и правильно, а сломано было то, что её никто не звал.
   */
  const { id, first } = room()
  makeFile(id, 'l3.pdf', '%PDF-1.4')
  setNote(id, 'l3.pdf', 7, 'спросить про поток')
  setNote(id, 'l3.pdf', 12, 'вывести на доске')

  say(id, first, who(id, 'host', 'host'), { t: 'tree:move', from: 'l3.pdf', to: 'лекция-3.pdf' })

  assert.deepEqual(notesOf(id, 'l3.pdf'), {}, 'заметки остались под именем, которого больше нет')
  assert.deepEqual(notesOf(id, 'лекция-3.pdf'), { 7: 'спросить про поток', 12: 'вывести на доске' })
  closeControlRoom(id)
})

test('удалённый семинар уносит заметки с собой', () => {
  /*
   * Заметки — единственное, что преподаватель писал себе сам, и они переживают
   * и конец лекции, и перезапуск сервера. Пережить удаление комнаты они не
   * должны: за ними не остаётся ни комнаты, ни документа, а лежат они в общей
   * базе, где их некому будет ни показать, ни убрать.
   */
  const id = `notes-gone-${++rooms}`
  createSession(id, 'Заметки', null)
  setNote(id, 'l3.pdf', 1, 'начать с задачи про шар')
  const other = `notes-stays-${++rooms}`
  createSession(other, 'Соседний', null)
  setNote(other, 'l3.pdf', 1, 'чужая речь')

  discardNotes(id)

  assert.deepEqual(notesOf(id, 'l3.pdf'), {})
  // Тот же путь в соседней комнате — не тот же документ: ключ тройной.
  assert.deepEqual(notesOf(other, 'l3.pdf'), { 1: 'чужая речь' })
})

test('заметки к одному документу не видны с другого', () => {
  // Ключ — семинар, файл и страница. Ошибка в любой части ключа выглядит как
  // «заметки пропали», а на деле они лежат под соседним именем.
  const id = `notes-key-${++rooms}`
  createSession(id, 'Заметки', null)
  setNote(id, 'l3.pdf', 7, 'про поток')
  setNote(id, 'seminar-3.pdf', 7, 'про задачи')

  assert.deepEqual(notesOf(id, 'l3.pdf'), { 7: 'про поток' })
  assert.deepEqual(notesOf(id, 'seminar-3.pdf'), { 7: 'про задачи' })
  assert.deepEqual(notesOf(id, 'l4.pdf'), {})
})
