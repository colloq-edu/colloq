/**
 * Транскрипт — это хвост, и он обрезается с головы. Одна запись обрезке не
 * подлежит: строка команды, которая прямо сейчас производит вывод.
 *
 * По ней — и только по ней — `runCommand` решает, занята ли оболочка. Вывод
 * перекатывается в новую запись каждые 32 КБ, так что строка команды быстро
 * становится самой старой и вылетала первой: `forgetEntry` обнулял вместе с ней
 * `commandLine`, охрана «одна команда за раз» переставала держать, и следующий
 * набравший `ls` отправлял его прямо в stdin занятой оболочки. Его байты
 * доставались чужому `train.py`, остаток чужого вывода печатался под его
 * строкой, а «X — команда ждёт свободной оболочки» не появлялось. Хватало
 * восьмисот строк вывода — то есть одной `find /`.
 *
 * Здесь же — вторая половина того же обещания: «Ctrl+C — команду останавливает X» не пишется,
 * пока ETX действительно не ушёл. Раньше строка появлялась при оборванном
 * канале, а команда в pty продолжала работать, и человек жал «стоп» в пустоту.
 *
 * Подделка терминадо, а не настоящая оболочка: под проверкой порядок записей и
 * охрана, а настоящий шелл не отдаст нужную гонку по требованию.
 */
import './_env.mts'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer, type WebSocket } from 'ws'
import { getTerminal } from '../shared/notebook.js'

let http: Server
let wss: WebSocketServer
/** Что подделка получила в stdin оболочки. */
let typed: string[] = []
let live: WebSocket | null = null
let minted = 0
/** Какие pty подделку просили удалить: перезапуск сервера не должен просить ни одного. */
let deleted: string[] = []

before(async () => {
  http = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/terminals') {
      minted += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: String(minted) }))
      return
    }
    if (req.method === 'DELETE') {
      deleted.push(req.url ?? '')
      res.writeHead(204).end()
      return
    }
    res.writeHead(404).end('{}')
  })
  wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    if (!/\/terminals\/websocket\//.test(req.url ?? '')) return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      live = ws
      ws.send(JSON.stringify(['setup', {}]))
      // Приглашение, чтобы прайм на той стороне увидел успокоившуюся оболочку.
      ws.send(JSON.stringify(['stdout', '$ ']))
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as [string, string]
        if (frame[0] !== 'stdin') return
        typed.push(frame[1])
      })
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as { port: number }
  process.env.JUPYTER_URL = `http://127.0.0.1:${port}`
  process.env.JUPYTER_TOKEN = 'fake'
})

after(async () => {
  const { shutdownTerminals } = await import('../server/src/kernel/terminal.js')
  const { shutdownCollab } = await import('../server/src/collab/index.js')
  await shutdownTerminals()
  shutdownCollab()
  live?.terminate()
  wss?.close()
  await new Promise<void>((resolve) => http.close(() => resolve()))
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (what()) return true
    await wait(25)
  }
  return false
}
function shellSays(text: string): void {
  live?.send(JSON.stringify(['stdout', text]))
}

let seq = 0
async function shell() {
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { openTerminal } = await import('../server/src/kernel/terminal.js')
  const { createSession } = await import('../server/src/db.js')
  const id = `trim${seq++}`
  createSession(id, `Terminal ${id}`)
  const { doc } = getSessionDoc(id)
  typed = []
  await openTerminal(id)
  await wait(500) // прайм
  typed = []
  const lines = () =>
    getTerminal(doc)
      .toArray()
      .map((line) => ({
        kind: String(line.get('kind')),
        name: (line.get('name') as string) ?? null,
        running: line.get('running') === true,
        text: String((line.get('text') as { toString(): string })?.toString() ?? ''),
      }))
  return { id, doc, lines }
}

const who = (name: string) => ({ name, color: '#7e82f0', participantId: `p_${name}` })

test('обрезка транскрипта не выносит строку идущей команды', async () => {
  const { id, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')

  runCommand(id, 'find / -name "*.py"', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('find /'))), 'команду не отправили')
  typed = []

  /*
   * Шесть окон склейки по ~39 КБ: каждое влезает в MAX_FLUSH_CHARS, вместе они
   * переваливают и за 200 КБ, и за 800 строк, и раскатываются на записи по
   * 32 КБ — то есть ровно тот случай, где обрезка и начинала есть голову.
   */
  const burst = Array.from({ length: 300 }, (_, i) => `/usr/lib/python3/${'x'.repeat(110)}/${i}`).join('\n') + '\n'
  for (let i = 0; i < 6; i++) {
    shellSays(burst)
    await wait(120)
  }
  await wait(200)

  const kept = lines()
  assert.ok(kept.length < 40, `транскрипт не обрезался вовсе: ${kept.length} записей`)
  const command = kept.find((l) => l.kind === 'command')
  assert.ok(command, `строку идущей команды выбросило обрезкой:\n${JSON.stringify(kept.slice(0, 3))}`)
  assert.equal(command.name, 'Maria')
  assert.equal(command.running, true, 'идущая команда перестала считаться идущей')

  // И, главное, следствие: чужая команда встаёт в очередь, а не уходит в
  // занятую оболочку.
  runCommand(id, 'ls', who('John'))
  await wait(300)
  assert.deepEqual(typed, [], 'команду John отправили в оболочку, которая ещё занята')
  const notice = lines().find((l) => l.kind === 'system' && /ждёт свободной оболочки/.test(l.text))
  assert.ok(notice, 'комната не узнала, что команда ждёт')
  assert.match(notice.text, /John/)
})

test('Ctrl+C при оборванном канале не объявляется отправленным', async () => {
  const { id, lines } = await shell()
  const { runCommand, interruptTerminal } = await import('../server/src/kernel/terminal.js')

  runCommand(id, 'sleep 300', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 300'))))
  typed = []

  // Канал к Jupyter обрывается — pty внутри контейнера продолжает работать.
  live?.terminate()
  await wait(150)

  interruptTerminal(id, 'Maria', 'p_Maria')
  const said = lines().filter((l) => l.kind === 'system')
  assert.ok(
    said.some((l) => /Ctrl\+C до неё ещё не дошёл/.test(l.text)),
    `комнате не сказали, что Ctrl+C не ушёл:\n${JSON.stringify(said)}`,
  )

  // И обещание выполняется: ETX уходит, как только канал вернулся.
  assert.ok(
    await until(() => typed.some((t) => t.includes('\u0003'))),
    'ETX так и не доехал до оболочки после переподключения',
  )
})

test('перезапуск сервера не убивает оболочку — и возвращается в неё', async () => {
  const { id, lines } = await shell()
  const { runCommand, openTerminal, shutdownTerminals } = await import(
    '../server/src/kernel/terminal.js'
  )

  runCommand(id, 'python train.py', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('train.py'))), 'команду не отправили')

  /*
   * `make run` после правки — то, что Makefile советует делать всё время.
   * Ядро его переживает намеренно (shutdownKernels), а терминал раньше слал
   * DELETE и убивал pty вместе с трёхчасовым обучением внутри.
   */
  const pty = minted
  deleted = []
  typed = []
  await shutdownTerminals()
  assert.deepEqual(deleted, [], 'оболочку удалили вместе с сервером — обучение внутри погибло')

  await openTerminal(id)
  await wait(900) // прайм + опрос оболочки
  assert.equal(minted, pty, 'после перезапуска завели новую оболочку вместо прежней')

  const command = lines().find((l) => l.kind === 'command' && /train\.py/.test(l.text))
  assert.ok(command, 'строка команды пропала из транскрипта')
  assert.equal(
    command.running,
    true,
    'команда, идущая в переживший перезапуск pty, объявлена законченной — ' +
      'охрана «одна команда за раз» после перезапуска не держит',
  )

  // И следующая команда честно ждёт, а не уходит в занятую оболочку.
  typed = []
  runCommand(id, 'ls', who('John'))
  await wait(300)
  assert.deepEqual(typed, [], 'команду John отправили в оболочку, где идёт чужое обучение')
})
