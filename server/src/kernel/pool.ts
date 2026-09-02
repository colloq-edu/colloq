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
 * Если своего контейнера комнате дать нельзя — docker не виден (сервер поднят
 * внутри контейнера без сокета) или до контейнера комнаты не будет дороги (см.
 * `roomNetwork`), — комната откатывается на общее ядро compose. Это ровно прежнее
 * поведение, включая прежнюю дыру, поэтому об этом говорится вслух: один раз в
 * журнал сервера и один раз в журнал ядра самой комнаты, где сидят люди (см.
 * `isolationLost` здесь и `noteSharedKernel` в kernel/index.ts).
 * `isolationAvailable()` — та же правда для панели.
 *
 * Путь монтирования берётся глазами docker-демона, а не наших: см. `hostMount`.
 * Адрес ядра — наоборот, нашими: под `make up` сервер сам в контейнере, и порт,
 * опубликованный на петле хоста, для него не адрес — см. `roomNetwork`.
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

/**
 * Состояние контейнера комнаты — тремя ответами, а не двумя.
 *
 * «Не running» — это ещё не «остановлен»: `dead` (docker не смог его добить,
 * обычно из-за места на диске), `paused` и `restarting` командой `docker start`
 * не поднимаются. Считая их остановленными, сервер звал `start`, не смотрел на
 * результат, не находил порт — и отвечал «could not read the published port» на
 * каждый Run до конца пары. Такой контейнер надо пересоздавать, а не будить.
 */
async function stateOf(container: string): Promise<'running' | 'stopped' | 'broken' | 'missing'> {
  const res = await run(['inspect', container, '--format', '{{.State.Status}}'])
  if (res.code !== 0) return 'missing'
  const status = res.out.trim()
  if (status === 'running') return 'running'
  return status === 'created' || status === 'exited' ? 'stopped' : 'broken'
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
 * В той ли сети контейнер, в которой мы теперь его ищем.
 *
 * Инстанс, переехавший с `make run` на `make up` (или обратно), находит по
 * имени контейнер прошлого режима: с опубликованным портом и без нашей сети —
 * или наоборот. Дороги до него в новом режиме нет, и комната ждала бы ответа
 * девяносто секунд на каждый Run; пересоздать дешевле.
 */
async function sameNetwork(container: string, network: string): Promise<boolean> {
  const res = await run(['inspect', container, '--format', '{{.HostConfig.NetworkMode}}'])
  if (res.code !== 0) return true
  // Без `--network` docker пишет сюда `default` — сравнение симметрично, эти
  // контейнеры создаём только мы.
  return res.out.trim() === (network || 'default')
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
          'каждой комнаты был свой контейнер, сервер должен видеть docker: сокет внутрь ' +
          'контейнера или запуск на хосте (make run).',
      )
    }
    return ok
  })
  return dockerReady
}

/** Сказано один раз: повторять это на каждый Run незачем. */
let networkWarned = false

function warnOnce(text: string): void {
  if (networkWarned) return
  networkWarned = true
  console.warn(text)
}

/** Есть ли названная сеть; спрашивается один раз, за пару она не появляется. */
let networkReady: Promise<boolean> | null = null

function networkExists(network: string): Promise<boolean> {
  networkReady ??= run(['network', 'inspect', network, '--format', '{{.Id}}'], 5_000).then(
    (res) => res.code === 0,
  )
  return networkReady
}

/**
 * Можно ли вообще дать комнате свой контейнер — а не только «виден ли docker».
 *
 * Сервер в контейнере без работающей `KERNEL_NETWORK` поднял бы комнате
 * контейнер, до которого сам не достучится (см. `roomNetwork`), — или не поднял
 * бы вовсе, если такой сети нет, — и в обоих случаях каждый Run кончался бы
 * ошибкой. Откат на общее ядро честнее: он хотя бы работает и сказан вслух — и
 * в журнал сервера, и в журнал ядра самой комнаты.
 */
async function canIsolate(): Promise<boolean> {
  if (!(await haveDocker())) return false
  if (!hostRoot()) return true

  const network = roomNetwork()
  if (!network) {
    warnOnce(
      '[kernel] сервер работает в контейнере (задан WORKSPACE_HOST_DIR), а KERNEL_NETWORK ' +
        'не назван: до ядра комнаты не будет дороги, поэтому семинары делят одно ядро ' +
        'compose и из любой комнаты видны файлы всех остальных. Назовите здесь сеть ' +
        'compose, в которой стоит сам сервер.',
    )
    return false
  }
  if (!(await networkExists(network))) {
    warnOnce(
      `[kernel] сети «${network}» из KERNEL_NETWORK на этой машине нет — контейнер комнаты ` +
        'в неё не встанет, поэтому семинары делят одно ядро compose и из любой комнаты ' +
        'видны файлы всех остальных. Настоящее имя сети покажет docker network ls.',
    )
    return false
  }
  return true
}

/** Правда ли у этой комнаты свой контейнер — панели, чтобы не обещать лишнего. */
export function isolationAvailable(): Promise<boolean> {
  return canIsolate()
}

/**
 * Изоляцию просили, но её нет: комнаты делят одно ядро и видят файлы друг друга.
 *
 * Отличается от `!isolationAvailable()` ровно одним, и это существенно:
 * `KERNEL_ISOLATION=off` — осознанный выбор оператора, про него говорить нечего,
 * а вот умолчание `auto`, споткнувшееся о недоступный docker, — невыполненное
 * обещание, и комната должна услышать про него словами.
 */
export async function isolationLost(): Promise<boolean> {
  if ((process.env.KERNEL_ISOLATION ?? 'auto').toLowerCase() === 'off') return false
  return !(await canIsolate())
}

/**
 * Комнаты, чьи контейнеры сейчас живут на этой машине, — по метке docker.
 *
 * Не то же самое, что `runningRoomKernels()`: та карта заполняется только
 * подъёмами ЭТОГО процесса, так что после перезапуска сервера контейнеры
 * вчерашних семинаров переставали существовать для уборки простоя и жили до
 * `make down`. Метку ставит `docker run` ниже, и она переживает нас.
 */
export async function listRoomKernels(): Promise<string[]> {
  if (!(await canIsolate())) return []
  const res = await run([
    'ps',
    '--filter',
    'label=colloq.kind=room-kernel',
    '--format',
    '{{.Label "colloq.session"}}',
  ])
  if (res.code !== 0) return []
  return res.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Путь к папке комнаты ГЛАЗАМИ docker-демона.
 *
 * `-v` разбирает демон на хосте, а не мы, и путь он понимает по-своему. Под
 * `make run` (сервер на хосте) это тот же путь, и переменная не нужна. Под
 * `make up` сервер живёт в контейнере, где папка комнаты лежит по
 * `/app/workspace/<id>`, — демон создал бы на хосте пустую папку с этим именем и
 * смонтировал её: ядро видит пустоту, а файлы комнаты остаются там, где их
 * пишет сервер и показывает панель. `WORKSPACE_HOST_DIR` называет ту же папку
 * так, как её видит хост, и только это делает изоляцию под `make up` возможной.
 */
function hostMount(sessionId: string): string {
  const inside = sessionDir(sessionId)
  const root = hostRoot()
  if (!root) return inside
  return path.join(root, path.relative(config.workspaceDir, inside))
}

/** Корень воркспейса глазами хоста; пусто — сервер на хосте, и пути совпадают. */
function hostRoot(): string {
  return (process.env.WORKSPACE_HOST_DIR ?? '').trim()
}

/**
 * Сеть, в которую ставить контейнер комнаты, — и она же признак того, как его
 * потом звать.
 *
 * Под `make run` сервер на хосте, порт публикуется на хостовой петле, и
 * `127.0.0.1:<порт>` — верный адрес. Под `make up` сервер сам в контейнере, и
 * та же строка указывает на него самого: до петли хоста ему хода нет, а
 * host-gateway не спасает — порт привязан к 127.0.0.1, а не к мосту. Дорога
 * там одна: общая сеть compose и обращение по имени контейнера. Тогда порт не
 * публикуется вовсе — и Jupyter комнаты не виден с хоста никому, что строго
 * лучше прежнего. Имя сети знает только тот, кто нас запустил: `KERNEL_NETWORK`.
 *
 * Признак «сервер в контейнере» — тот же, по которому берётся путь монтирования.
 */
function roomNetwork(): string {
  return hostRoot() ? (process.env.KERNEL_NETWORK ?? '').trim() : ''
}

async function startContainer(
  sessionId: string,
  env: string,
  retried = false,
): Promise<KernelEndpoint> {
  const container = containerFor(sessionId)
  const image = `${IMAGE_PREFIX}:${env}`
  const network = roomNetwork()
  const state = await stateOf(container)

  /*
   * Пересоздать контейнер и попробовать ещё раз — ровно один раз.
   *
   * Второй попытки нет намеренно: если и свежесозданный контейнер не отвечает,
   * дело не в нём, и бесконечный круг `rm` + `run` посреди пары хуже честной
   * ошибки на ячейке.
   */
  const recreate = async (why: string): Promise<KernelEndpoint> => {
    if (retried) throw new Error(`контейнер комнаты не удалось поднять: ${why}`)
    await run(['rm', '-f', container], 60_000)
    endpoints.delete(sessionId)
    return startContainer(sessionId, env, true)
  }

  if (state === 'broken') {
    // `dead`, `paused`, `restarting`: `docker start` такому не поможет.
    return recreate('контейнер в состоянии, из которого docker start его не поднимает')
  }
  if (state === 'stopped' || state === 'running') {
    /*
     * Контейнер, собранный из старого образа, — уже не это окружение. Он
     * переиспользовался по одному имени, так что пересборка списка пакетов
     * оставляла комнату на прежнем образе, а панель показывала новый: у
     * студента падал `import transformers`, и ничто на экране с ним не спорило.
     */
    if (!(await sameImage(container, image))) return recreate('образ окружения пересобран')
    // Контейнер прошлого режима: адреса, по которому мы теперь его зовём, у
    // него нет — ни имени в нашей сети, ни опубликованного порта.
    if (!(await sameNetwork(container, network))) return recreate('сервер сменил сеть')
    if (state === 'stopped') {
      const started = await run(['start', container], 60_000)
      // Результат читается: не поднявшийся контейнер дальше отвечал бы «could
      // not read the published port» на каждый Run, и так до ручного docker rm.
      if (started.code !== 0) return recreate(`docker start: ${started.out.slice(-200)}`)
    }
  } else if (state === 'missing') {
    if (!(await imageExists(image))) {
      throw new Error(
        `Окружение «${env}» ни разу не собиралось. Соберите его: в панели, в разделе Environments, или \`make env-build NAME=${env}\` на хосте — и откройте семинар заново.`,
      )
    }
    /*
     * Монтируется ТОЛЬКО папка этой комнаты, и по тому же пути, что и раньше:
     * рабочий каталог ядра задаётся путём сессии Jupyter `<id>/session.ipynb`,
     * так что `/workspace/<id>` обязано существовать внутри — а всё остальное
     * содержимое `/workspace` внутрь больше не попадает вовсе.
     */
    const mount = hostMount(sessionId)
    const created = await run(
      [
        'run',
        '-d',
        '--name',
        container,
        /*
         * Либо общая сеть compose и адрес по имени контейнера (сервер сам в
         * контейнере), либо порт на петле хоста. Петля тут не украшение: без
         * неё Jupyter комнаты открыт на всех интерфейсах, а Wi-Fi семинара —
         * один из них. В сетевом режиме порт не публикуется вовсе.
         */
        ...(network ? ['--network', network] : ['-p', '127.0.0.1:0:8888']),
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

  let url: string
  if (network) {
    // Внутри сети слушают тот же 8888, публиковать нечего.
    url = `http://${container}:8888`
  } else {
    const port = await publishedPort(container)
    if (port === null) throw new Error(`could not read the published port of ${container}`)
    url = `http://127.0.0.1:${port}`
  }

  const endpoint: KernelEndpoint = { url, token: roomToken(sessionId) }

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
      /*
       * 401/403 — это не «ещё не поднялся», а «токен другой».
       *
       * Токен контейнера зафиксирован при `docker run` и выведен из секрета
       * инстанса: после ротации SESSION_SECRET (README прямо её советует) все
       * старые контейнеры отвечают 403, и комната ждала девяносто секунд на
       * каждый Run, читая про таймаут. Токен детерминированный — пересозданный
       * контейнер получит правильный.
       */
      if (res.status === 401 || res.status === 403) {
        return recreate(`ядро комнаты не приняло токен (HTTP ${res.status})`)
      }
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
 * Комнаты, которые закрыли, пока их контейнер ещё поднимался.
 *
 * `docker rm -f` посреди `docker run` не догоняет: подъём доработает и оставит
 * контейнер удалённого семинара жить с его лимитом памяти — уборка простоя его
 * не найдёт (комнаты в картах уже нет), и он доживёт до `make down`. Ждать
 * подъёма в `dropRoomKernel` нельзя, это до полутора минут на запросе удаления,
 * — поэтому помечаем, а убирает за собой сам подъём.
 */
const abandoned = new Set<string>()

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
  if (!(await canIsolate())) return defaultEndpoint()

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
    .finally(() => {
      starting.delete(sessionId)
      // Комнату закрыли, пока это поднималось: контейнер (успешный или
      // недоделанный) убираем сами — за него больше некому.
      if (abandoned.delete(sessionId)) void discardRoom(sessionId)
    })
  starting.set(sessionId, attempt)
  return attempt
}

async function discardRoom(sessionId: string): Promise<void> {
  endpoints.delete(sessionId)
  try {
    await run(['rm', '-f', containerFor(sessionId)], 60_000)
  } catch (err) {
    console.error(`[kernel] не удалось убрать контейнер ${containerFor(sessionId)}:`, err)
  }
}

/**
 * Убрать контейнер комнаты насовсем.
 *
 * Зовётся при удалении семинара и при уборке простоя. Файлы лежат на хосте, в
 * папке комнаты, и переживают это — уходит только Python со всеми переменными.
 */
export async function dropRoomKernel(sessionId: string): Promise<void> {
  endpoints.delete(sessionId)
  if (!(await canIsolate())) return
  // Подъём, идущий прямо сейчас, положил бы контейнер обратно секундой позже:
  // помечаем комнату, и подъём, закончившись, снесёт его сам.
  if (starting.has(sessionId)) abandoned.add(sessionId)
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
