/**
 * One shell, and a room full of people who can all type into it.
 *
 * A command sent while another is running used to be pushed straight at the
 * shell, which buffers what it cannot run and echoes it back in its own time.
 * The transcript that came out was unreadable: the first person's last line of
 * output printed *underneath* the second person's command, and the second
 * command appeared twice — once as we wrote it, once as the shell echoed it.
 *
 * A fake terminado rather than a real one, because what is under test is the
 * order things are written in, and a real shell will not reliably hand you the
 * race that caused the problem.
 */
import './_env.mts'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer, type WebSocket } from 'ws'
import { getTerminal } from '../shared/notebook.js'
// Every server module reaches config on import, and config reads JUPYTER_URL at
// module scope — so nothing that touches it may be imported before before()
// points it at the fake. An earlier version imported db.js at the top and the
// suite quietly drove a real Jupyter instead.

/* ---------------------------------------------------------- fake terminado */

let http: Server
let wss: WebSocketServer
/** The shell's stdin, as the fake received it. */
let typed: string[] = []
let live: WebSocket | null = null
let minted = 0
/** Открытые сокеты по имени pty: второй к той же оболочке — дефект. */
const socketsByName = new Map<string, Set<WebSocket>>()
const socketsTo = (name: string) => socketsByName.get(name)?.size ?? 0
/** Задержка рукопожатия: ею открывается окно «переподключение в полёте». */
let upgradeDelayMs = 0

before(async () => {
  http = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/terminals') {
      minted += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: String(minted) }))
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(204).end()
      return
    }
    res.writeHead(404).end('{}')
  })
  wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    if (!/\/terminals\/websocket\//.test(req.url ?? '')) return socket.destroy()
    const name = /\/terminals\/websocket\/([^/?]+)/.exec(req.url ?? '')?.[1] ?? ''
    const accept = () =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        live = ws
        const open = socketsByName.get(name) ?? new Set<WebSocket>()
        open.add(ws)
        socketsByName.set(name, open)
        ws.on('close', () => open.delete(ws))
        ws.send(JSON.stringify(['setup', {}]))
        // A prompt, so the server's priming sees a settled shell.
        ws.send(JSON.stringify(['stdout', '$ ']))
        ws.on('message', (raw) => {
          const frame = JSON.parse(String(raw)) as [string, string]
          if (frame[0] !== 'stdin') return
          typed.push(frame[1])
        })
      })
    if (upgradeDelayMs > 0) setTimeout(accept, upgradeDelayMs)
    else accept()
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

/* ------------------------------------------------------------------ helpers */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: () => boolean, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (what()) return true
    await wait(25)
  }
  return false
}
/** What the fake shell says back when it runs something. */
function shellSays(text: string): void {
  live?.send(JSON.stringify(['stdout', text]))
}

let seq = 0
async function shell() {
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { openTerminal } = await import('../server/src/kernel/terminal.js')
  const { createSession } = await import('../server/src/db.js')
  const id = `term${seq++}`
  createSession(id, `Terminal ${id}`)
  const { doc } = getSessionDoc(id)
  typed = []
  await openTerminal(id)
  await wait(500) // priming
  typed = []
  const lines = () =>
    getTerminal(doc)
      .toArray()
      .map((line) => ({
        kind: String(line.get('kind')),
        name: (line.get('name') as string) ?? null,
        text: String((line.get('text') as { toString(): string })?.toString() ?? ''),
      }))
  return { id, doc, lines }
}

const who = (name: string) => ({ name, color: '#7e82f0', participantId: `p_${name}` })

/* -------------------------------------------------------------------- tests */

test('one person, one command, one line in the transcript', async () => {
  const { id, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'echo hello', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('echo hello'))), 'the shell was never told')
  const commands = lines().filter((l) => l.kind === 'command')
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'Maria')
})

test('a second command waits instead of being pushed at a busy shell', async () => {
  const { id, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  typed = []

  runCommand(id, 'echo mine', who('John'))
  await wait(300)
  assert.deepEqual(typed, [], "John's command was sent to a shell that was still busy")

  // The room is told, and told whose it is.
  const notice = lines().find((l) => l.kind === 'system' && /waiting for the shell/.test(l.text))
  assert.ok(notice, `no notice: ${JSON.stringify(lines())}`)
  assert.match(notice.text, /John/)

  // No command line for it yet: the transcript is the order things ran.
  assert.deepEqual(
    lines().filter((l) => l.kind === 'command').map((l) => l.name),
    ['Maria'],
  )
})

test('the waiting command runs, in order, once the shell is free', async () => {
  const { id, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  runCommand(id, 'echo second', who('John'))
  runCommand(id, 'echo third', who('Ana'))
  typed = []

  // The shell finishes and offers a prompt.
  shellSays('done\r\n$ ')
  assert.ok(
    await until(() => typed.some((t) => t.includes('echo second'))),
    'the queue never moved',
  )
  shellSays('second\r\n$ ')
  assert.ok(await until(() => typed.some((t) => t.includes('echo third'))), 'only one moved')

  assert.deepEqual(
    lines().filter((l) => l.kind === 'command').map((l) => l.text.trim()),
    ['sleep 30', 'echo second', 'echo third'],
  )
})

test('interrupting drops what was waiting, and says so', async () => {
  const { id, lines } = await shell()
  const { runCommand, interruptTerminal } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  runCommand(id, 'echo never', who('John'))
  typed = []

  interruptTerminal(id)
  await wait(200)
  shellSays('^C\r\n$ ')
  await wait(400)

  assert.ok(
    !typed.some((t) => t.includes('echo never')),
    'a command the room had cancelled ran anyway',
  )
  assert.ok(
    lines().some((l) => l.kind === 'system' && /dropped/.test(l.text)),
    'the room was not told its command had gone',
  )
})

test('заметка ядра в транскрипте не отпускает очередь терминала', async () => {
  /*
   * `kernelNote` пишет в тот же Y.Array мимо учёта терминала, поэтому ближайшая
   * запись видит рассинхрон длин и пересобирает учёт. Раньше пересборка гасила
   * `running` у живой команды и обнуляла `commandLine` — охрана «одна команда за
   * раз» переставала держать, и следующая команда уходила в занятую оболочку,
   * а её вывод печатался под чужой строкой.
   */
  const { id, doc, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  const { kernelNote } = await import('../server/src/kernel/index.js')
  runCommand(id, 'python train.py', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('python train.py'))))
  typed = []

  kernelNote(id, 'A cell failed, so the 3 cells queued behind it were not run.')
  runCommand(id, 'echo ivan', who('Ivan'))
  runCommand(id, 'echo ana', who('Ana'))
  await wait(300)

  assert.deepEqual(typed, [], 'команда ушла в оболочку, занятую чужой')
  const running = getTerminal(doc)
    .toArray()
    .filter((line) => line.get('kind') === 'command' && line.get('running') === true)
  assert.equal(running.length, 1, 'живую команду объявили законченной')
  assert.deepEqual(
    lines().filter((l) => l.kind === 'command').map((l) => l.text.trim()),
    ['python train.py'],
    'очередь всё-таки прорвало',
  )
})

test('первая команда в неоткрытый терминал держит оболочку занятой', async () => {
  /*
   * Путь «Run file» с ни разу не открытым ящиком: `dispatch` пишет строку
   * команды, а `openTerminal` тут же усыновляет транскрипт и гасит её. Фаза
   * становилась `idle` при работающем скрипте, и следующая команда уходила в
   * занятую оболочку без всякой очереди.
   */
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { createSession } = await import('../server/src/db.js')
  const { runCommand, terminalPhase } = await import('../server/src/kernel/terminal.js')
  const id = `term${seq++}`
  createSession(id, `Terminal ${id}`)
  const { doc } = getSessionDoc(id)
  typed = []

  runCommand(id, "python -u 'train.py'", who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('train.py'))), 'скрипт не запустили')
  await wait(200)

  assert.equal(terminalPhase(id), 'busy', 'оболочку объявили свободной при работающем скрипте')
  const running = getTerminal(doc)
    .toArray()
    .filter((line) => line.get('kind') === 'command' && line.get('running') === true)
  assert.equal(running.length, 1, 'строка команды перестала считаться работающей')

  typed = []
  runCommand(id, 'ls', who('Ivan'))
  await wait(300)
  assert.deepEqual(typed, [], 'вторая команда ушла в занятую оболочку')
})

test('Clear посреди чужой команды не отпускает оболочку', async () => {
  /*
   * `Clear` стирает транскрипт, но не оболочку: `pip install` внутри
   * продолжает работать. Раньше вместе с записями терялась строка команды, и
   * следующий набравший `ls` отправлял его прямо в stdin работающей.
   */
  const { id, lines } = await shell()
  const { runCommand, clearTerminal } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'python train.py', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('python train.py'))))
  clearTerminal(id)
  typed = []

  runCommand(id, 'ls', who('Ivan'))
  await wait(300)
  assert.deepEqual(typed, [], 'команда ушла в stdin работающей')
  const commands = lines().filter((l) => l.kind === 'command')
  assert.equal(commands.length, 1, `в чистом транскрипте ${commands.length} команд`)
  assert.match(commands[0].text, /train\.py/, 'комната не видит, что именно ещё работает')
})

test('команда, вставшая в очередь, отвечает тому, кто её ждёт', async () => {
  /*
   * Колбэк `done` ждёт оракул в режиме «сделать». Раньше `runCommand` клал в
   * очередь `{ text, by }` без него: оракул девяносто секунд ждал, потом
   * сообщал, что команда не доработала, а она выполнялась сама по себе минутой
   * позже, и её вывод он не видел никогда.
   */
  const { id } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  const seen: Array<{ output: string; finished: boolean }> = []
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  runCommand(id, 'echo oracle', who('Oracle'), (result) => seen.push(result))
  await wait(200)
  assert.equal(seen.length, 0, 'ответили раньше, чем команда пошла')

  shellSays('done\r\n$ ')
  assert.ok(await until(() => typed.some((t) => t.includes('echo oracle'))), 'очередь не двинулась')
  shellSays('oracle\r\n$ ')

  assert.ok(await until(() => seen.length === 1), 'ожидающий так и не дождался ответа')
  assert.equal(seen[0].finished, true)
  assert.match(seen[0].output, /oracle/)
})

test('очередь не переживает смерть оболочки и не всплывает в следующей', async () => {
  const { id, lines } = await shell()
  const { runCommand, openTerminal } = await import('../server/src/kernel/terminal.js')
  const seen: Array<{ output: string; finished: boolean }> = []
  runCommand(id, 'python server.py', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('python server.py'))))
  runCommand(id, 'pip install x', who('Ivan'), (result) => seen.push(result))
  await wait(200)

  // Оболочка умерла: `docker restart`, `exit`, Ctrl-D — снаружи это одно и то же.
  live?.send(JSON.stringify(['disconnect', 1]))
  assert.ok(await until(() => seen.length === 1), 'ожидающий остался висеть на мёртвой оболочке')
  assert.equal(seen[0].finished, false)
  assert.ok(
    lines().some((l) => l.kind === 'system' && /dropped/.test(l.text)),
    `комнате не сказали, чья команда пропала: ${JSON.stringify(lines())}`,
  )

  typed = []
  await openTerminal(id)
  await wait(500)
  runCommand(id, 'echo now', who('Ana'))
  assert.ok(await until(() => typed.some((t) => t.includes('echo now'))))
  shellSays('now\r\n$ ')
  await wait(400)
  assert.ok(
    !typed.some((t) => t.includes('pip install x')),
    'команда из прошлой оболочки выполнилась сама по себе',
  )
})

test('студент снимает из очереди только свои команды', async () => {
  /*
   * Ветка `byId` — та самая, которой закрыли находку про «студент уносит
   * очередь преподавателя». Проверять её надо отдельно: перепутать фильтры
   * `mine`/`keep` можно, и хостовый тест выше этого не заметит.
   */
  const { id, lines } = await shell()
  const { runCommand, interruptTerminal } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  runCommand(id, 'echo ivan', who('Ivan'))
  runCommand(id, 'echo ana', who('Ana'))
  typed = []

  interruptTerminal(id, 'Ivan', 'p_Ivan')
  await wait(200)
  shellSays('^C\r\n$ ')

  assert.ok(
    await until(() => typed.some((t) => t.includes('echo ana'))),
    'команда Аны исчезла вместе с чужой',
  )
  assert.ok(!typed.some((t) => t.includes('echo ivan')), 'снятая команда всё-таки побежала')
  assert.ok(
    lines().some((l) => l.kind === 'system' && /Ivan's waiting command was dropped/.test(l.text)),
    `в транскрипте не сказано, чья команда снята: ${JSON.stringify(lines())}`,
  )
})

test('поток вывода не уезжает в документ мегабайтами за одно окно', async () => {
  /*
   * `cat` большого файла отдаёт мегабайты за одно окно склейки, и каждый из них
   * уходит всем тридцати вкладкам — вместе с тетрадью, которая живёт в том же
   * документе. Оставляем хвост окна: нужное почти всегда в последних строках.
   */
  const { id, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'cat big.csv', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('cat big.csv'))))

  const flood = Array.from({ length: 3000 }, (_, i) => `строка ${i} ${'x'.repeat(900)}`)
  shellSays(flood.join('\r\n') + '\r\n')
  await wait(600)

  const text = lines().map((l) => l.text).join('\n')
  assert.ok(text.length < 300_000, `в документ уехало ${text.length} символов`)
  assert.match(text, /строка 2999/, 'хвост вывода потеряли — а он и есть результат')
  assert.doesNotMatch(text, /строка 0 /, 'начало потока оставили вместо хвоста')
  assert.ok(
    lines().some((l) => l.kind === 'system' && /faster than a shared transcript/.test(l.text)),
    'про потерянный вывод ничего не сказали',
  )
})

test('открытие терминала во время переподключения не заводит второй сокет', async () => {
  /*
   * Пока `connect` в полёте, `term.socket` уже null, таймер переподключения снят,
   * а `opening` не выставлялся — все сторожа `openTerminal` пустые. Второй вход
   * (руки оракула, команда, прилетевшая ровно в это мгновение) открывал второй
   * сокет к той же оболочке: `cd … && clear` в stdin работающего `pip`, вывод в
   * транскрипте дважды и фаза `idle` при живой команде.
   */
  const { id } = await shell()
  const { runCommand, openTerminal, terminalPhase } = await import(
    '../server/src/kernel/terminal.js'
  )
  // Имя pty этой комнаты: подделка выдаёт их по порядку, последнее — её.
  const name = String(minted)
  runCommand(id, 'pip install torch', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('pip install torch'))))
  assert.equal(socketsTo(name), 1, 'подделка начала не с одного сокета')

  try {
    // Рукопожатие тянется — это и есть окно, в котором ломалось.
    upgradeDelayMs = 600
    live?.terminate()
    // 500 мс до попытки переподключения плюс запаздывающее рукопожатие.
    await wait(700)
    await openTerminal(id)
    await wait(900)
  } finally {
    upgradeDelayMs = 0
  }

  assert.equal(socketsTo(name), 1, `к одной оболочке открыто сокетов: ${socketsTo(name)}`)
  assert.equal(terminalPhase(id), 'busy', 'работающую команду объявили законченной')
})

test('a room cannot stack commands without limit', async () => {
  const { id, lines } = await shell()
  const { runCommand } = await import('../server/src/kernel/terminal.js')
  runCommand(id, 'sleep 30', who('Maria'))
  assert.ok(await until(() => typed.some((t) => t.includes('sleep 30'))))
  for (let i = 0; i < 12; i++) runCommand(id, `echo q${i}`, who('John'))
  await wait(300)

  const waiting = lines().filter((l) => l.kind === 'system' && /waiting for the shell/.test(l.text))
  assert.ok(waiting.length <= 8, `${waiting.length} commands were allowed to stack up`)
  assert.ok(
    lines().some((l) => /too many commands/.test(l.text)),
    'the room was not told the queue was full',
  )
})
