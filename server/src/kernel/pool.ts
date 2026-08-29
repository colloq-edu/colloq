/**
 * Контейнер на семинар, поднимаемый по требованию.
 *
 * Был контейнер на ОКРУЖЕНИЕ, общий для всех семинаров на нём, и в него
 * монтировался весь `WORKSPACE_DIR`. Это значило, что право запускать ячейки в
 * ЛЮБОЙ комнате открывало файлы всех остальных: `os.listdir("/workspace")`
 * перечислял чужие семинары, `open("/workspace/чужая/зачёт.csv")` читал их, а
 * `os.remove` удалял. Плюс общий `JUPYTER_TOKEN` в переменных окружения —
 * то есть и API Jupyter соседних комнат. Никакое правило комнаты этого не
 * закрывает: это не права, а изоляция, и чинится она только здесь.
 *
 * Теперь у комнаты свой контейнер, в него смонтирована только её папка, и
 * токен у него свой — выведенный из секрета инстанса, так что переживает
 * перезапуск сервера и не совпадает с чужим.
 *
 * Образ берётся по имени окружения, `colloq-kernel:<env>`, — так же, как его
 * называет docker-compose для окружения по умолчанию, поэтому отдельной ветки
 * для «обычных» семинаров нет.
 *
 * Контейнеры запускаются `docker run`, а не compose: службы compose объявлены в
 * файле, а эти решаются в момент, когда преподаватель открывает комнату. Имя —
 * `colloq-room-<id>`, чтобы человек, глядящий в `docker ps` посреди пары, понял,
 * что он видит.
 *
 * Если docker недоступен — сервер поднят внутри контейнера без сокета, как при
 * `make up`, — комната откатывается на общее ядро compose. Это ровно прежнее
 * поведение, включая прежнюю дыру, поэтому об этом говорится вслух: один раз в
 * журнал и постоянно в панели.
 */
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import path from 'node:path'
import { config } from '../config.js'
import { activeName } from '../environments.js'
import { sessionDir } from '../workspace.js'
import { defaultEndpoint, type KernelEndpoint } from './jupyter.js'

const IMAGE_PREFIX = 'colloq-kernel'
const ROOM_PREFIX = 'colloq-room'

interface RunResult {
  code: number
  out: string
}

function run(args: string[], timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('docker', args)
    let out = ''
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', (err) => {
      clearTimeout(kill)
      resolve({ code: -1, out: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(kill)
      resolve({ code: code ?? -1, out: out.trim() })
    })
  })
}

/**
 * Токен Jupyter для одной комнаты.
 *
 * Выводится из секрета инстанса, а не выдаётся случайно: контейнер переживает
 * перезапуск сервера, и случайный токен пришлось бы где-то хранить — либо
 * терять вместе с доступом к живому ядру посреди пары. Разный у разных комнат,
 * так что ячейка, прочитавшая свой `JUPYTER_TOKEN`, не открывает соседние.
 */
function roomToken(sessionId: string): string {
  return createHmac('sha256', config.sessionSecret)
    .update(`jupyter:${sessionId}`)
    .digest('hex')
    .slice(0, 40)
}

const containerFor = (sessionId: string) => `${ROOM_PREFIX}-${sessionId}`

/** The host port Docker gave a container, read back after it started. */
async function publishedPort(container: string): Promise<number | null> {
  const res = await run(['port', container, '8888/tcp'])
  if (res.code !== 0) return null
  // "0.0.0.0:54321" or "[::]:54321\n0.0.0.0:54321"
  const match = res.out.match(/:(\d+)\s*$/m)
  const port = match ? Number(match[1]) : NaN
  return Number.isFinite(port) ? port : null
}

async function stateOf(container: string): Promise<'running' | 'stopped' | 'missing'> {
  const res = await run(['inspect', container, '--format', '{{.State.Status}}'])
  if (res.code !== 0) return 'missing'
  return res.out.trim() === 'running' ? 'running' : 'stopped'
}

async function imageExists(image: string): Promise<boolean> {
  const res = await run(['image', 'inspect', image, '--format', '{{.Id}}'])
  return res.code === 0
}

/** Whether a container was created from the image this environment now has. */
async function sameImage(container: string, image: string): Promise<boolean> {
  const [running, current] = await Promise.all([
    run(['inspect', container, '--format', '{{.Image}}']),
    run(['image', 'inspect', image, '--format', '{{.Id}}']),
  ])
  if (running.code !== 0 || current.code !== 0) return true
  return running.out.trim() === current.out.trim()
}

/**
 * Есть ли вообще docker у этого процесса.
 *
 * Считается один раз: под `make up` сервер сам живёт в контейнере без сокета, и
 * шелл-аут на каждую комнату был бы двадцатью бесполезными процессами за пару.
 */
let dockerReady: Promise<boolean> | null = null

function haveDocker(): Promise<boolean> {
  /*
   * Явный выключатель, и он же — предохранитель тестов.
   *
   * Сюита поднимает десятки комнат с поддельным Jupyter; без этой строки она
   * запускала для каждой настоящий контейнер — тридцать шесть за один прогон,
   * и они оставались висеть. Оператору он тоже нужен: контейнер на семинар
   * стоит памяти, и машина, которой это дорого, вправе вернуться к общему ядру,
   * сказав об этом вслух, а не обнаружив однажды тридцать контейнеров.
   */
  if ((process.env.KERNEL_ISOLATION ?? 'auto').toLowerCase() === 'off') {
    dockerReady ??= Promise.resolve(false)
    return dockerReady
  }
  dockerReady ??= run(['version', '--format', '{{.Server.Version}}'], 5_000).then((res) => {
    const ok = res.code === 0
    if (!ok) {
      console.warn(
        '[kernel] docker недоступен — семинары делят одно ядро compose, и из любой комнаты ' +
          'видны файлы всех остальных на этой машине. Так работал Colloq раньше; чтобы у ' +
          'каждой комнаты был свой контейнер, сервер должен видеть docker (make run).',
      )
    }
    return ok
  })
  return dockerReady
}

/** Правда ли у этой комнаты свой контейнер — панели, чтобы не обещать лишнего. */
export function isolationAvailable(): Promise<boolean> {
  return haveDocker()
}

async function startContainer(sessionId: string, env: string): Promise<KernelEndpoint> {
  const container = containerFor(sessionId)
  const image = `${IMAGE_PREFIX}:${env}`
  const state = await stateOf(container)

  if (state === 'stopped' || state === 'running') {
    /*
     * Контейнер, собранный из старого образа, — уже не это окружение. Он
     * переиспользовался по одному имени, так что пересборка списка пакетов
     * оставляла комнату на прежнем образе, а панель показывала новый: у
     * студента падал `import transformers`, и ничто на экране с ним не спорило.
     */
    if (!(await sameImage(container, image))) {
      await run(['rm', '-f', container], 60_000)
      endpoints.delete(sessionId)
      return startContainer(sessionId, env)
    }
    if (state === 'stopped') await run(['start', container], 60_000)
  } else if (state === 'missing') {
    if (!(await imageExists(image))) {
      throw new Error(
        `Окружение «${env}» ни разу не собиралось. Соберите его в панели, в разделе Environments, и откройте семинар заново.`,
      )
    }
    /*
     * Монтируется ТОЛЬКО папка этой комнаты, и по тому же пути, что и раньше:
     * рабочий каталог ядра задаётся путём сессии Jupyter `<id>/session.ipynb`,
     * так что `/workspace/<id>` обязано существовать внутри — а всё остальное
     * содержимое `/workspace` внутрь больше не попадает вовсе.
     */
    const mount = sessionDir(sessionId)
    const created = await run(
      [
        'run',
        '-d',
        '--name',
        container,
        // Docker picks the host port, and the loopback address is not
        // optional: without it the room's Jupyter is on every interface, and
        // the seminar's Wi-Fi is one of them.
        '-p',
        '127.0.0.1:0:8888',
        '-e',
        `JUPYTER_TOKEN=${roomToken(sessionId)}`,
        '-v',
        `${mount}:/workspace/${sessionId}`,
        // Student code is arbitrary, exactly as in compose. A runaway cell in
        // one room must not be able to take the host down either.
        `--memory=${process.env.KERNEL_MEM ?? '2g'}`,
        `--cpus=${process.env.KERNEL_CPUS ?? '2'}`,
        '--pids-limit=512',
        /*
         * `no`, а не `unless-stopped`: контейнеров теперь по одному на семинар,
         * и перезагрузка машины поднимала бы разом весь прошлый семестр. Пока
         * сервер жив, упавший контейнер он поднимет сам при следующем открытии
         * комнаты.
         */
        '--restart=no',
        '--label',
        'colloq.kind=room-kernel',
        '--label',
        `colloq.session=${sessionId}`,
        '--label',
        `colloq.environment=${env}`,
        image,
      ],
      120_000,
    )
    if (created.code !== 0) throw new Error(`docker run failed: ${created.out.slice(-300)}`)
  }

  const port = await publishedPort(container)
  if (port === null) throw new Error(`could not read the published port of ${container}`)

  const endpoint: KernelEndpoint = {
    url: `http://127.0.0.1:${port}`,
    token: roomToken(sessionId),
  }

  // Wait for Jupyter inside it to answer. `docker run` returns as soon as the
  // process is spawned, and connecting a second later fails with a bare
  // "fetch failed" that says nothing about why.
  const deadline = Date.now() + 90_000
  let lastError = 'no response'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint.url}/api/status?token=${endpoint.token}`, {
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) return endpoint
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`ядро комнаты не ответило за 90 с (${lastError})`)
}

/** Адреса, которые уже разрешили, чтобы занятая комната не звала docker на ячейку. */
const endpoints = new Map<string, KernelEndpoint>()
/** Один запуск за раз на комнату, общий для одновременных вызовов. */
const starting = new Map<string, Promise<KernelEndpoint>>()

/**
 * Адрес Python, с которым должна разговаривать эта комната.
 *
 * Без docker — общее ядро compose: ровно то, что было раньше, вместе с прежней
 * дырой, о которой сказано в шапке файла.
 */
export async function endpointForSession(
  sessionId: string,
  env: string | null,
): Promise<KernelEndpoint> {
  if (!(await haveDocker())) return defaultEndpoint()

  const cached = endpoints.get(sessionId)
  if (cached) return cached

  const inFlight = starting.get(sessionId)
  if (inFlight) return inFlight

  const name = (env ?? '').trim() || activeName()
  const attempt = startContainer(sessionId, name)
    .then((endpoint) => {
      endpoints.set(sessionId, endpoint)
      return endpoint
    })
    .finally(() => starting.delete(sessionId))
  starting.set(sessionId, attempt)
  return attempt
}

/**
 * Убрать контейнер комнаты насовсем.
 *
 * Зовётся при удалении семинара и при уборке простоя. Файлы лежат на хосте, в
 * папке комнаты, и переживают это — уходит только Python со всеми переменными.
 */
export async function dropRoomKernel(sessionId: string): Promise<void> {
  endpoints.delete(sessionId)
  if (!(await haveDocker())) return
  await run(['rm', '-f', containerFor(sessionId)], 60_000)
}

/** Забыть разрешённый адрес, чтобы следующее открытие перепроверило контейнер. */
export function forgetSessionKernel(sessionId: string): void {
  endpoints.delete(sessionId)
}

/** Комнаты, для которых этот процесс поднял контейнер. Нужно панели. */
export function runningRoomKernels(): string[] {
  return [...endpoints.keys()]
}
