/**
 * Переезд в дереве — то, что до сих пор просили одним переименованием на месте.
 *
 * Дерево вот-вот начнут таскать мышью: `tree:move` станут звать в десять раз
 * чаще и на папках, а не на одном имени. Ломается это молча. Файлы уезжают
 * одним `rename`, а всё, что помнит их путь наизусть — проектор, речь спикера,
 * тетрадь, открытая вкладка, — остаётся на старом, и узнают об этом через
 * полчаса, когда документ на экране не открывается.
 *
 * Ни сети, ни ядра: сокет поддельный, комната настоящая. Половина здешних
 * утверждений — про ФРАЗУ, а не про диск: отказ читают посреди пары, и
 * «„sub“ не годится в качестве имени» вместо «нельзя положить внутрь себя»
 * отправляет преподавателя переименовывать то, с чем всё в порядке.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createSession, notesOf, setNote } from '../server/src/db.js'
import { listTree, makeDir, makeFile, sessionDir, statPath } from '../server/src/workspace.js'
import { boardOf, closeControlRoom, dispatch } from '../server/src/control.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { addBook, bookAt } from '../shared/notebook.js'
import { lectureOf, startLecture, stopLecture } from '../server/src/lecture.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

/** Ровно то, что читает `send`: состояние и приём кадра. */
function socket(): { ws: WebSocket; heard: ControlServerMessage[] } {
  const heard: ControlServerMessage[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => heard.push(JSON.parse(frame) as ControlServerMessage),
    on() {
      return this
    },
    ping: () => {},
    terminate: () => {},
    close: () => {},
  } as unknown as WebSocket
  return { ws, heard }
}

let rooms = 0

function room(): string {
  const id = `move-${++rooms}`
  createSession(id, 'Переезд', null)
  return id
}

function who(sessionId: string, role: 'host' | 'participant'): TokenPayload {
  return { sessionId, participantId: `p_${role}`, role }
}

/**
 * Что сервер сказал в ответ. `null` — не сказал ничего, и это тоже ответ:
 * жест, который ничего не изменил, не должен ругаться.
 */
function say(
  sessionId: string,
  role: 'host' | 'participant',
  message: ControlClientMessage,
): string | null {
  const { ws, heard } = socket()
  dispatch(ws, sessionId, who(sessionId, role), message)
  const refusal = heard.find(
    (frame): frame is Extract<ControlServerMessage, { t: 'error' }> => frame.t === 'error',
  )
  return refusal?.message ?? null
}

/* --------------------------------------------------------------- переезд */

test('файл переезжает в другую папку, а не только меняет имя', () => {
  // До перетаскивания единственным способом позвать `tree:move` было
  // переименование на месте, и межпапочный переезд не проверял никто.
  const id = room()
  makeDir(id, 'src')
  makeFile(id, 'train.py', 'x = 1\n')

  assert.equal(say(id, 'host', { t: 'tree:move', from: 'train.py', to: 'src/train.py' }), null)

  assert.ok(statPath(id, 'src/train.py'), 'файл не доехал до папки')
  assert.equal(statPath(id, 'train.py'), null, 'файл остался и на старом месте')
  closeControlRoom(id)
})

test('папка переезжает со всем, что в ней: тетрадь, заметки, лекция и доска', () => {
  /*
   * Каскад считает новый путь как `to + был.slice(from.length)`, и проверять
   * его надо именно на ВЛОЖЕННОМ: у переименования на месте длина `from` та же,
   * что у папки, и ошибка в этой арифметике там не видна.
   */
  const id = room()
  const { doc } = getSessionDoc(id)
  makeDir(id, 'курс')
  makeDir(id, 'слайды')
  makeFile(id, 'слайды/l3.pdf', '%PDF-1.4')
  makeFile(id, 'слайды/task.ipynb', '{}')
  addBook(doc, 'слайды/task.ipynb')
  setNote(id, 'слайды/l3.pdf', 7, 'спросить про поток')
  say(id, 'host', { t: 'board:open', name: 'слайды/l3.pdf' })
  startLecture(id, { file: 'слайды/l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })

  assert.equal(say(id, 'host', { t: 'tree:move', from: 'слайды', to: 'курс/слайды' }), null)

  assert.ok(statPath(id, 'курс/слайды/l3.pdf'), 'файл не переехал')
  assert.equal(boardOf(id), 'курс/слайды/l3.pdf', 'на экране остался путь, которого нет')
  assert.equal(lectureOf(id)?.file, 'курс/слайды/l3.pdf', 'лекция осталась на мёртвом пути')
  assert.ok(bookAt(doc, 'курс/слайды/task.ipynb'), 'тетрадь не поехала за своей папкой')
  assert.equal(bookAt(doc, 'слайды/task.ipynb'), null, 'тетрадь осталась и по старому адресу')
  assert.deepEqual(notesOf(id, 'курс/слайды/l3.pdf'), { 7: 'спросить про поток' })

  stopLecture(id)
  closeControlRoom(id)
})

test('обрезанное дерево не оставляет проектор на мёртвом пути', () => {
  /*
   * Список файлов упирается в потолок в две тысячи строк, и `pip install -t .`
   * съедает его целиком. Каскад переезда считался ПО ЭТОМУ списку — значит
   * документ, до которого обход не дошёл, не переезжал вместе со своей папкой:
   * проектор оставался на пути, которого на диске уже нет, а речь к нему — под
   * ключом, которого не существует. Именно тот файл, который сейчас на экране,
   * и есть тот, чью пропажу заметят все двадцать человек разом.
   */
  const id = room()
  makeDir(id, 'слайды')
  makeFile(id, 'слайды/l3.pdf', '%PDF-1.4')
  setNote(id, 'слайды/l3.pdf', 3, 'здесь про дивергенцию')
  const dir = sessionDir(id)
  for (let i = 0; i < 2005; i++) fs.writeFileSync(path.join(dir, `f${i}.csv`), '')

  const tree = listTree(id)
  assert.equal(tree.truncated, true, 'потолок не сработал — тест ничего не проверяет')
  assert.ok(
    !tree.files.some((file) => file.path === 'слайды/l3.pdf'),
    'документ всё ещё в списке — тест ничего не проверяет',
  )

  say(id, 'host', { t: 'board:open', name: 'слайды/l3.pdf' })
  startLecture(id, { file: 'слайды/l3.pdf', by: 'p_host', byName: 'Ада', color: '#d4162f' })
  assert.equal(say(id, 'host', { t: 'tree:move', from: 'слайды', to: 'лекции' }), null)

  assert.equal(boardOf(id), 'лекции/l3.pdf', 'доска считала переезд по обрезанному списку')
  assert.equal(lectureOf(id)?.file, 'лекции/l3.pdf', 'лекция считала переезд по нему же')
  assert.deepEqual(notesOf(id, 'лекции/l3.pdf'), { 3: 'здесь про дивергенцию' })

  stopLecture(id)
  closeControlRoom(id)
})

/* ---------------------------------------------------------------- отказы */

test('папку не кладут внутрь себя, и сказано это про место, а не про имя', () => {
  /*
   * Промах на одну строку: папку роняют на то, что лежит в ней самой. Сервер
   * отвечал `bad-name`, а фраза выходила из `whySegmentRefused` — «„src“ не
   * годится в качестве имени», — и преподаватель шёл придумывать другое имя
   * тому, с чем всё в порядке. Не годится не имя, а место.
   */
  const id = room()
  makeFile(id, 'src/model.py', 'x = 1\n')
  makeDir(id, 'src/deep')

  const said = say(id, 'host', { t: 'tree:move', from: 'src', to: 'src/deep/src' })

  assert.match(said ?? '', /внутрь себя/, `отказ объяснил не то: ${said}`)
  assert.doesNotMatch(said ?? '', /качестве имени/, 'жалоба на имя, а виновато место')
  assert.ok(statPath(id, 'src/model.py'), 'поддерево уехало из дерева')
  closeControlRoom(id)
})

test('переезд в никуда — тихое ничего, а не столкновение файла с самим собой', () => {
  /*
   * Мышь отпускают там же, где взяли, чаще, чем попадают в соседнюю папку.
   * `existsSync(цели)` стоял раньше проверки «это тот же путь», и жест
   * возвращался фразой «„data.csv“ в этой папке уже есть»: человек читал, что
   * файл не поместился рядом с самим собой, и шёл искать двойника.
   */
  const id = room()
  makeFile(id, 'data.csv', 'a,b\n')

  assert.equal(
    say(id, 'host', { t: 'tree:move', from: 'data.csv', to: 'data.csv' }),
    null,
    'несостоявшийся жест отругали',
  )
  assert.ok(statPath(id, 'data.csv'), 'файл пропал на пустом месте')
  closeControlRoom(id)
})

test('занятое имя в чужой папке называет папку, а не только файл', () => {
  /*
   * «„data.csv“ в этой папке уже есть» верно ровно для переименования на месте:
   * там «эта папка» — та, что открыта. У перетаскивания «эта» указывает на
   * папку, ИЗ которой тащили, а одноимённых data.csv в комнате бывает
   * несколько — и человек не понимает, куда именно не влезло.
   */
  const id = room()
  makeDir(id, 'src')
  makeFile(id, 'data.csv', 'a,b\n')
  makeFile(id, 'src/data.csv', 'c,d\n')

  const said = say(id, 'host', { t: 'tree:move', from: 'data.csv', to: 'src/data.csv' })

  assert.match(said ?? '', /«data\.csv»/, `отказ не назвал файл: ${said}`)
  assert.match(said ?? '', /«src»/, `отказ не назвал папку: ${said}`)
  assert.equal(statPath(id, 'data.csv')?.size, 4, 'файл переехал поверх занятого имени')

  // А переименование на месте говорит ровно то, что говорило всегда: там
  // называть папку незачем, она перед глазами.
  makeFile(id, 'src/model.py', 'x = 1\n')
  const renamed = say(id, 'host', { t: 'tree:move', from: 'src/model.py', to: 'src/data.csv' })
  assert.match(
    renamed ?? '',
    /в этой папке уже есть/,
    `фраза переименования разъехалась: ${renamed}`,
  )
  closeControlRoom(id)
})

test('содержимое, уходящее за восьмой уровень, не переезжает молча', () => {
  /*
   * Глубину проверяли только у самого переезжающего пути. Папка с седьмого
   * уровня ложилась на шестой — и всё, что оказывалось глубже восьмого,
   * пропадало из панели: обход `listTree` туда не доходит и `truncated` при
   * этом не ставит, то есть список объявляет себя полным. Файл нельзя ни
   * открыть, ни скачать, ни убрать поштучно, а место он занимает.
   */
  const id = room()
  makeDir(id, 'куда')
  assert.equal(makeFile(id, 'deep/a/b/c/d/e/f/g.py', 'x = 1\n'), 'ok')

  const said = say(id, 'host', { t: 'tree:move', from: 'deep', to: 'куда/deep' })

  assert.match(said ?? '', /Слишком глубоко/, `переезд за потолок прошёл молча: ${said}`)
  assert.ok(statPath(id, 'deep/a/b/c/d/e/f/g.py'), 'файл всё-таки уехал за адресуемую глубину')
  closeControlRoom(id)
})

test('содержимое, уходящее за длину адресуемого пути, не переезжает молча', () => {
  /*
   * Та же дыра, что и с глубиной, только по символам: `normalizePath` меряет
   * тот путь, который прислали, а он короткий. Содержимое уезжало за четыреста
   * символов — и после этого `resolveInSession` его не пропускает: файл в
   * списке есть, а открыть, скачать и убрать его поштучно нечем, место он при
   * этом занимает. На «Убрать» приходила фраза не про то — «„data.csv“ не
   * годится в качестве имени».
   */
  const id = room()
  const long = 'a'.repeat(120)
  const far = 'b'.repeat(40)
  const buried = `${long}/${long}/${long}/data.csv`
  assert.equal(makeFile(id, buried, 'a,b\n'), 'ok')
  makeDir(id, far)

  const said = say(id, 'host', { t: 'tree:move', from: long, to: `${far}/${long}` })

  assert.match(said ?? '', /длиннее 400 символов/, `переезд за длину прошёл молча: ${said}`)
  assert.match(said ?? '', /не переложить/, `отказ пожаловался не на то: ${said}`)
  assert.ok(statPath(id, buried), 'файл уехал по пути, которого уже не назвать')
  closeControlRoom(id)
})

test('папку на самом дне список показывает, а её содержимое — никогда', () => {
  /*
   * На это опирается панель: под такой папкой она пишет «глубже не видно», а не
   * «пусто». `truncated` здесь не выставляется — он считает только строки, — и
   * строки «показано не целиком» внизу не будет тоже. Правило живёт в обходе,
   * поэтому проверяется здесь; словами его повторяет `readsInside` в
   * web/src/lib/tree-move.ts.
   */
  const id = room()
  // Ячейкой, а не `makeFile`: девять сегментов — путь, которого комната назвать
  // не может, и завести его она сама не даст. `os.makedirs` даёт.
  const deep = 'a/b/c/d/e/f/g/h'
  fs.mkdirSync(path.join(sessionDir(id), deep), { recursive: true })
  fs.writeFileSync(path.join(sessionDir(id), `${deep}/x.py`), 'x = 1\n')

  const tree = listTree(id)

  assert.equal(tree.truncated, false, 'потолок глубины выдал себя за потолок строк')
  assert.ok(
    tree.files.some((file) => file.path === deep),
    'папка дна пропала из списка — панели не о чем говорить',
  )
  assert.ok(
    !tree.files.some((file) => file.path === `${deep}/x.py`),
    'содержимое дна вдруг попало в список — тест ничего не проверяет',
  )
  closeControlRoom(id)
})

test('имя, отличающееся только регистром, — переименование, а не столкновение', () => {
  /*
   * На macOS «Data» и «data» — одна и та же папка, и `existsSync(цели)`
   * отвечал «занято» самим источником: сменить регистр имени было нельзя
   * вовсе. На Linux то же переименование проходило всегда — одна операция вела
   * себя по-разному на машине разработчика и на сервере.
   */
  const id = room()
  makeDir(id, 'Data')
  makeFile(id, 'Data/train.csv', 'a,b\n')

  assert.equal(say(id, 'host', { t: 'tree:move', from: 'Data', to: 'data' }), null)

  const names = listTree(id).files.map((file) => file.name)
  assert.ok(names.includes('data'), `папка не сменила написание: ${names.join(', ')}`)
  assert.ok(!names.includes('Data'), 'старое написание осталось в дереве')
  assert.ok(statPath(id, 'data/train.csv'), 'содержимое не поехало за именем')
  closeControlRoom(id)
})

/* ------------------------------------------------------------------ права */

test('переставить файл в комнате может преподаватель, а не участник', () => {
  /*
   * Правка дерева разведена намеренно: ЗАВЕСТИ можно по правилу комнаты
   * (`files`), а УБРАТЬ и ПЕРЕИМЕНОВАТЬ — только преподавателю, потому что оба
   * убирают: старого пути после переезда нет ровно так же, как нет удалённого
   * файла. Перетаскивание — тот же переезд, и планка у него та же; строка у
   * участника в панели просто не берётся в руку.
   */
  const id = room()
  makeDir(id, 'src')
  makeFile(id, 'train.py', 'x = 1\n')

  const said = say(id, 'participant', { t: 'tree:move', from: 'train.py', to: 'src/train.py' })

  assert.match(said ?? '', /преподаватель/, `участнику дали переставить файл: ${said}`)
  assert.ok(statPath(id, 'train.py'), 'файл всё-таки переехал')
  assert.equal(say(id, 'host', { t: 'tree:move', from: 'train.py', to: 'src/train.py' }), null)
  assert.ok(statPath(id, 'src/train.py'), 'преподавателю переезд тоже не дался')
  closeControlRoom(id)
})

/* ------------------------------------------------- отказ на одном из путей */

test('отказ на одном пути не оставляет комнату наполовину переехавшей', () => {
  /*
   * Заметки — единственное в каскаде, что ходит в базу, и там у переезда был
   * свой отказ: ключ (комната, файл, страница) занят, а заметки не удаляются
   * НИГДЕ, кроме удаления семинара. Разметили «черновик.pdf», убрали его,
   * завели файл с прежним именем — и голый `UPDATE lecture_notes SET file`
   * падал посреди цикла. Исключение обрывало каскад целиком: файлы на диске
   * уже переехали, а тетрадь, доска и вкладки оставались на старых путях, и
   * человек получал английскую строку SQLite вместо объяснения. Теперь не
   * падает и не теряет — но каскад обязан держаться и без этого.
   */
  const id = room()
  const { doc } = getSessionDoc(id)
  makeFile(id, 'папка/a.pdf', '%PDF-1.4')
  makeFile(id, 'папка/task.ipynb', '{}')
  addBook(doc, 'папка/task.ipynb')
  // Заметки к пути, на который сейчас переедет размеченный файл: та самая
  // занятая пара ключей.
  setNote(id, 'курс/a.pdf', 7, 'речь к прошлому черновику')
  setNote(id, 'папка/a.pdf', 7, 'речь к этому файлу')
  say(id, 'host', { t: 'board:open', name: 'папка/a.pdf' })

  assert.equal(say(id, 'host', { t: 'tree:move', from: 'папка', to: 'курс' }), null)

  assert.ok(statPath(id, 'курс/a.pdf'), 'файл не переехал')
  assert.equal(boardOf(id), 'курс/a.pdf', 'доска осталась на старом пути из-за чужого отказа')
  assert.ok(bookAt(doc, 'курс/task.ipynb'), 'тетрадь не доехала — каскад оборвался на середине')
  /*
   * И заметки доезжают: `moveNotesTo` переносит через `UPDATE OR REPLACE`, так
   * что хвост под целевым путём — речь к документу, которого там давно нет, —
   * уступает речи к файлу, который туда только что приехал.
   */
  assert.deepEqual(
    notesOf(id, 'курс/a.pdf'),
    { 7: 'речь к этому файлу' },
    'заметки размеченного файла остались под путём, которого на диске больше нет',
  )
  assert.deepEqual(notesOf(id, 'папка/a.pdf'), {}, 'заметки остались и на старом пути')
  closeControlRoom(id)
})
