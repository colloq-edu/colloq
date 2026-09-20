/**
 * Укреплённый профиль комнаты на docker-бэкенде (kernel/perimeter.ts).
 *
 * Здесь доказывается то, что иначе видно только на живой паре: какую ровно
 * строку `docker run` получает комната, какие ровно правила ставит помощник, и
 * что сервер ОТКАЗЫВАЕТ поднять комнату, когда правила не встали, — а не
 * поднимает её молча с открытой сетью. Настоящего docker в сюите нет (см.
 * `_env.mts`), поэтому docker подменяется функцией, а строки сверяются целиком.
 * Живую проверку на colima — пакеты, отказы, fork-бомбу — описывает отчёт о
 * внедрении; здесь её не повторить.
 */
import './_env.mts'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ownIdleMinutes, ownKernelMax, runArgs } from '../server/src/kernel/pool.js'
import {
  BLOCKED_V4,
  DEFAULT_ROOM_SUBNET,
  RoomPerimeterError,
  ensureRoomPerimeter,
  forgetPerimeter,
  helperArgs,
  ipv4InCidr,
  ipv4Subnets,
  networkCreateArgs,
  ownAddresses,
  ownPidsLimit,
  perimeterProblem,
  perimeterRemovalScript,
  perimeterRules,
  perimeterScript,
  pidsLimit,
  roomHardeningArgs,
  roomNetworkMode,
  type DockerRun,
} from '../server/src/kernel/perimeter.js'
import { setLocaleResolver } from '../shared/i18n.js'

function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const before = new Map(Object.keys(vars).map((key) => [key, process.env[key]]))
  const restore = () => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const out = body()
    if (out instanceof Promise) return out.finally(restore) as T
    restore()
    return out
  } catch (err) {
    restore()
    throw err
  }
}

afterEach(() => {
  forgetPerimeter()
  setLocaleResolver(() => 'ru')
})

/* ------------------------------------------------------ строка docker run */

test('комната на хосте: своя сеть, порт на петле и весь укреплённый профиль — строка целиком', () => {
  const args = withEnv({ KERNEL_MEM: undefined, KERNEL_CPUS: undefined, KERNEL_PIDS: undefined }, () =>
    runArgs({
      sessionId: 'r1',
      env: 'base',
      mount: '/srv/workspace/r1',
      network: 'colloq-rooms',
      publish: true,
      gpu: null,
    }),
  )
  const token = args[args.indexOf('-e') + 1]
  assert.match(token, /^JUPYTER_TOKEN=[0-9a-f]{40}$/)
  assert.deepEqual(args, [
    'run', '-d', '--name', 'colloq-room-r1',
    '--network', 'colloq-rooms',
    '-p', '127.0.0.1:0:8888',
    '--user=1000:1000',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=512',
    '--sysctl=net.ipv6.conf.all.disable_ipv6=1',
    '--sysctl=net.ipv6.conf.default.disable_ipv6=1',
    '--label', 'colloq.profile=1',
    '-e', token,
    '-e', 'OMP_NUM_THREADS=2',
    '-e', 'MKL_NUM_THREADS=2',
    '-e', 'OPENBLAS_NUM_THREADS=2',
    '-e', 'NUMEXPR_NUM_THREADS=2',
    // Чем plotly отдаёт фигуру: без этой переменной он решает сам и решает
    // по-разному в разных версиях — 5.x добавляет к фигуре `text/html`, а
    // первым кадром высылает весь бандл plotly.js, пять мегабайт скрипта,
    // который в общем документе не нужен никому (kernel/pool.ts · runArgs).
    // Умолчание, а не запрет: `pio.renderers.default` в ячейке его перебивает.
    '-e', 'PLOTLY_RENDERER=plotly_mimetype',
    '-v', '/srv/workspace/r1:/workspace/r1',
    '--memory=4g',
    '--memory-swap=4g',
    '--cpus=2',
    '--restart=no',
    '--label', 'colloq.kind=room-kernel',
    '--label', 'colloq.session=r1',
    '--label', 'colloq.environment=base',
    '--label', 'colloq.role=room',
    'colloq-kernel:base',
  ])
  // Ни одной поблажки: ни --privileged, ни --cap-add, ни хостовой сети.
  assert.ok(!args.some((arg) => /^--(privileged|cap-add|pid=)|^--network=host$|^host$/.test(arg)), JSON.stringify(args))
})

test('контейнерная форма: общая сеть по имени, порт не публикуется, профиль тот же', () => {
  const args = runArgs({
    sessionId: 'r2',
    env: 'base',
    mount: '/host/workspace/r2',
    network: 'colloq',
    publish: false,
    gpu: null,
  })
  assert.equal(args[args.indexOf('--network') + 1], 'colloq')
  assert.ok(!args.includes('-p'))
  for (const flag of roomHardeningArgs()) assert.ok(args.includes(flag), flag)
})

test('потолок процессов — KERNEL_PIDS, и глупое число его не снимает', () => {
  withEnv({ KERNEL_PIDS: undefined }, () => assert.equal(pidsLimit(), 512))
  withEnv({ KERNEL_PIDS: '2048' }, () => {
    assert.equal(pidsLimit(), 2048)
    assert.ok(runArgs({ sessionId: 'p', env: 'base', mount: '/m', network: 'colloq-rooms', publish: true, gpu: null }).includes('--pids-limit=2048'))
  })
  // Ноль, отрицательное, слово, дробь и слишком мало для Jupyter — умолчание,
  // а не «без потолка» и не комната, которая не поднимет даже ядро.
  for (const bad of ['0', '-1', 'много', '1.5', '10', '']) {
    withEnv({ KERNEL_PIDS: bad }, () => assert.equal(pidsLimit(), 512, bad))
  }
})

test('контейнер личных тетрадей: тот же профиль, но без GPU, со своей меткой и своим потолком', () => {
  const room = runArgs({
    sessionId: 'r3', env: 'base-gpu', mount: '/srv/workspace/r3',
    network: 'colloq-rooms', publish: true, gpu: '0',
  })
  const own = withEnv({ KERNEL_OWN_PIDS: undefined }, () =>
    runArgs({
      sessionId: 'r3', env: 'base-gpu', mount: '/srv/workspace/r3',
      network: 'colloq-rooms', publish: true, gpu: '0', role: 'own',
    }),
  )

  // Имя и метка — чтобы уборка, `colloq status` и раздача срезов отличали их.
  assert.equal(own[own.indexOf('--name') + 1], 'colloq-room-r3-own')
  assert.ok(own.includes('colloq.role=own'), JSON.stringify(own))
  assert.ok(room.includes('colloq.role=room'), JSON.stringify(room))

  /*
   * Ни карты, ни метки среза, ни разделяемой памяти под неё — и это не
   * настройка, а устройство: GPU выдаётся контейнеру целиком, а
   * `CUDA_VISIBLE_DEVICES` студент снимает одной строкой. Срез передан
   * намеренно: ошибка вызывающего не должна уметь отдать карту черновикам.
   */
  assert.ok(room.includes('--gpus'), 'комната осталась без карты')
  assert.ok(!own.includes('--gpus'), JSON.stringify(own))
  assert.ok(!own.some((arg) => /^--label$/.test(arg) && false))
  assert.ok(!own.some((arg) => arg.startsWith('colloq.gpu=')), JSON.stringify(own))
  assert.ok(!own.some((arg) => arg.startsWith('--shm-size')), JSON.stringify(own))

  // Свой потолок процессов: ядер в нём десятки, комнатных 512 не хватит.
  assert.ok(own.includes('--pids-limit=2048'), JSON.stringify(own))
  assert.ok(room.includes('--pids-limit=512'), JSON.stringify(room))

  // Всё остальное — то же самое: образ, сеть, папка занятия, профиль, числа.
  assert.equal(own.at(-1), room.at(-1))
  assert.equal(own[own.indexOf('--network') + 1], 'colloq-rooms')
  assert.equal(own[own.indexOf('-v') + 1], '/srv/workspace/r3:/workspace/r3')
  for (const flag of ['--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges']) {
    assert.ok(own.includes(flag), flag)
  }
  assert.equal(
    own.find((arg) => arg.startsWith('--memory=')),
    room.find((arg) => arg.startsWith('--memory=')),
  )

  // Токен у него СВОЙ: иначе строка из черновика открывала бы Jupyter лекции.
  const tokenOf = (args: string[]) => args.find((arg) => arg.startsWith('JUPYTER_TOKEN='))
  assert.match(tokenOf(own) ?? '', /^JUPYTER_TOKEN=[0-9a-f]{40}$/)
  assert.notEqual(tokenOf(own), tokenOf(room))
})

test('потолок процессов контейнера личных тетрадей — KERNEL_OWN_PIDS, и мусор его не снимает', () => {
  withEnv({ KERNEL_OWN_PIDS: undefined }, () => assert.equal(ownPidsLimit(), 2048))
  withEnv({ KERNEL_OWN_PIDS: '4096' }, () => {
    assert.equal(ownPidsLimit(), 4096)
    const args = runArgs({ sessionId: 'p', env: 'base', mount: '/m', network: 'colloq-rooms', publish: true, gpu: null, role: 'own' })
    assert.ok(args.includes('--pids-limit=4096'), JSON.stringify(args))
  })
  for (const bad of ['0', '-1', 'много', '1.5', '10', '']) {
    withEnv({ KERNEL_OWN_PIDS: bad }, () => assert.equal(ownPidsLimit(), 2048, bad))
  }
  // И потолок ЖИВЫХ ядер в нём — отдельное число, тем же правилом чтения.
  withEnv({ KERNEL_OWN_MAX: undefined }, () => assert.equal(ownKernelMax(), 40))
  withEnv({ KERNEL_OWN_MAX: '4' }, () => assert.equal(ownKernelMax(), 4))
  for (const bad of ['0', '-1', 'сорок', '1.5', '']) {
    withEnv({ KERNEL_OWN_MAX: bad }, () => assert.equal(ownKernelMax(), 40, bad))
  }

  /*
   * Простой личного ядра — третье число, и у него `0` ЗНАЧАЩИЙ.
   *
   * У потолков ноль бессмыслен и читается как мусор; здесь это выключатель для
   * того, у кого пара устроена иначе, и спутать их значило бы тихо включить
   * уборку там, где её выключили.
   */
  withEnv({ KERNEL_OWN_IDLE_MIN: undefined }, () => assert.equal(ownIdleMinutes(), 30))
  withEnv({ KERNEL_OWN_IDLE_MIN: '5' }, () => assert.equal(ownIdleMinutes(), 5))
  withEnv({ KERNEL_OWN_IDLE_MIN: ' 0 ' }, () => assert.equal(ownIdleMinutes(), 0))
  for (const bad of ['-1', 'полчаса', '1.5', '']) {
    withEnv({ KERNEL_OWN_IDLE_MIN: bad }, () => assert.equal(ownIdleMinutes(), 30, bad))
  }
})

test('COLLOQ_ROOM_NETWORK: открыть можно только словом open, опечатка сеть не открывает', () => {
  assert.equal(roomNetworkMode({}), 'blocked')
  assert.equal(roomNetworkMode({ COLLOQ_ROOM_NETWORK: 'blocked' }), 'blocked')
  assert.equal(roomNetworkMode({ COLLOQ_ROOM_NETWORK: ' Open ' }), 'open')
  assert.equal(roomNetworkMode({ COLLOQ_ROOM_NETWORK: 'opne' }), 'blocked')
  assert.equal(roomNetworkMode({ COLLOQ_ROOM_NETWORK: '1' }), 'blocked')
})

test('сеть комнат: своя подсеть, без ICC и без IPv6', () => {
  assert.deepEqual(networkCreateArgs(DEFAULT_ROOM_SUBNET), [
    'network', 'create', '--driver=bridge', '--subnet=10.213.0.0/22', '--ipv6=false',
    '-o', 'com.docker.network.bridge.enable_icc=false',
    '--label', 'colloq.kind=room-network',
    'colloq-rooms',
  ])
  // Подсеть занята — docker выбирает сам, всё остальное то же.
  assert.ok(!networkCreateArgs(null).some((arg) => arg.startsWith('--subnet')))
})

/* ---------------------------------------------------------------- адреса */

test('адреса и подсети считаются честно', () => {
  assert.equal(ipv4InCidr('10.213.3.255', '10.213.0.0/22'), true)
  assert.equal(ipv4InCidr('10.213.4.0', '10.213.0.0/22'), false)
  assert.equal(ipv4InCidr('192.168.1.64', '192.168.0.0/16'), true)
  assert.equal(ipv4InCidr('172.32.0.1', '172.16.0.0/12'), false)
  assert.equal(ipv4InCidr('1.2.3.4', '0.0.0.0/0'), true)
  assert.equal(ipv4InCidr('300.1.1.1', '0.0.0.0/0'), false)
  assert.equal(ipv4InCidr('fe80::1', '0.0.0.0/0'), false)
  // docker печатает подсети через пробел, v6 рядом — его отбрасываем.
  assert.deepEqual(ipv4Subnets('172.19.0.0/16 fd00:dead::/64 '), ['172.19.0.0/16'])
  assert.deepEqual(ipv4Subnets(''), [])
})

test('исключение — только свои адреса сервера внутри подсети комнат', () => {
  const nic = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false) => ({
    address, family, internal, netmask: '', mac: '', cidr: null,
  }) as never
  const found = ownAddresses(['172.19.0.0/16'], {
    lo: [nic('127.0.0.1', 'IPv4', true)],
    eth0: [nic('172.18.0.5'), nic('fe80::1', 'IPv6')],
    eth1: [nic('172.19.0.2')],
  })
  assert.deepEqual(found, ['172.19.0.2'])
})

/* ------------------------------------------------------------- правила */

test('правила: ответы, исключения и DNS проходят, частное и сам хост — отказ; строки целиком', () => {
  const rules = perimeterRules({ subnets: ['172.19.0.0/16'], exempt: ['172.19.0.2'] })
  const deny = BLOCKED_V4.map((range) => `-A COLLOQ-ROOMS-FWD -s 172.19.0.0/16 -d ${range} -j COLLOQ-ROOMS-DENY`)
  assert.equal(
    rules,
    [
      '*filter',
      ':COLLOQ-ROOMS-FWD - [0:0]',
      ':COLLOQ-ROOMS-IN - [0:0]',
      ':COLLOQ-ROOMS-DENY - [0:0]',
      '-A COLLOQ-ROOMS-DENY -p tcp -j REJECT --reject-with tcp-reset',
      '-A COLLOQ-ROOMS-DENY -j REJECT --reject-with icmp-admin-prohibited',
      '-A COLLOQ-ROOMS-FWD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
      '-A COLLOQ-ROOMS-FWD -s 172.19.0.2/32 -j RETURN',
      '-A COLLOQ-ROOMS-FWD -p udp -m udp --dport 53 -j RETURN',
      '-A COLLOQ-ROOMS-FWD -p tcp -m tcp --dport 53 -j RETURN',
      '-A COLLOQ-ROOMS-IN -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
      '-A COLLOQ-ROOMS-IN -s 172.19.0.2/32 -j RETURN',
      '-A COLLOQ-ROOMS-IN -p udp -m udp --dport 53 -j RETURN',
      '-A COLLOQ-ROOMS-IN -p tcp -m tcp --dport 53 -j RETURN',
      ...deny,
      '-A COLLOQ-ROOMS-IN -s 172.19.0.0/16 -j COLLOQ-ROOMS-DENY',
      'COMMIT',
      '',
    ].join('\n'),
  )
  // Список закрытого — ровно то, что обещано владельцу и документации.
  assert.deepEqual([...BLOCKED_V4], [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
    '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4',
  ])
})

test('запасной набор без REJECT отличается только действием отказа', () => {
  const plan = { subnets: ['10.213.0.0/22'], exempt: [] }
  const reject = perimeterRules(plan, 'reject').split('\n')
  const drop = perimeterRules(plan, 'drop').split('\n')
  assert.deepEqual(drop.filter((line) => line.startsWith('-A COLLOQ-ROOMS-DENY')), ['-A COLLOQ-ROOMS-DENY -j DROP'])
  assert.deepEqual(
    drop.filter((line) => !line.startsWith('-A COLLOQ-ROOMS-DENY')),
    reject.filter((line) => !line.startsWith('-A COLLOQ-ROOMS-DENY')),
  )
})

test('скрипт помощника трогает только своё и называет причину отказа', () => {
  const script = perimeterScript({ subnets: ['10.213.0.0/22'], exempt: [] })
  // iptables — того же dockerd, в его пространстве имён файлов.
  assert.match(script, /nsenter -t "\$pid" -m -- "\$@"/)
  assert.match(script, /readlink "\$p\/ns\/net"/)
  // Атомарно и без сброса чужого.
  assert.match(script, /iptables-restore -w --noflush/)
  assert.ok(!/iptables(-restore)? [^\n]*(-F|--flush)( |$)/m.test(script), 'скрипт установки что-то сбрасывает')
  // Переходы — один раз, по проверке, с нашим комментарием.
  assert.match(script, /-C DOCKER-USER -m comment --comment colloq-rooms -j COLLOQ-ROOMS-FWD/)
  assert.match(script, /-I DOCKER-USER 1 -m comment --comment colloq-rooms -j COLLOQ-ROOMS-FWD/)
  assert.match(script, /-I INPUT 1 -m comment --comment colloq-rooms -j COLLOQ-ROOMS-IN/)
  for (const code of [20, 21, 22, 23]) assert.match(script, new RegExp(`exit ${code}`))
  assert.match(script, /say ok\n$/)

  const removal = perimeterRemovalScript()
  // Снимается ровно вставленное — по той же строке, — и только наши цепочки.
  assert.match(removal, /-D DOCKER-USER -m comment --comment colloq-rooms -j COLLOQ-ROOMS-FWD/)
  assert.match(removal, /-D INPUT -m comment --comment colloq-rooms -j COLLOQ-ROOMS-IN/)
  for (const line of removal.split('\n').filter((l) => / -[FX] /.test(l))) {
    assert.match(line, /for chain in COLLOQ-ROOMS-FWD COLLOQ-ROOMS-IN COLLOQ-ROOMS-DENY; do fw iptables -w -[FX] "\$chain"/)
  }
})

test('помощник привилегирован, но живёт секунду и не тянет образ', () => {
  assert.deepEqual(helperArgs('colloq-kernel:base', 'echo hi'), [
    'run', '--rm', '--privileged', '--pid=host', '--network=host', '--user=0:0',
    '--pull=never', '--no-healthcheck', '--label', 'colloq.kind=room-perimeter',
    '--entrypoint=sh', 'colloq-kernel:base', '-c', 'echo hi',
  ])
})

/* ------------------------------------------------------------ установка */

interface Call { args: string[] }

/** docker, который помнит вызовы и отвечает по правилам теста. */
function fakeDocker(answer: (args: string[]) => { code: number; out: string }): { docker: DockerRun; calls: Call[] } {
  const calls: Call[] = []
  const docker: DockerRun = async (args) => {
    calls.push({ args })
    return answer(args)
  }
  return { docker, calls }
}

const isHelper = (args: string[]) => args[0] === 'run' && args.includes('--privileged')
const helperScript = (args: string[]) => args[args.length - 1]

function standardAnswers(helper: (script: string) => { code: number; out: string }) {
  return (args: string[]) => {
    if (args[0] === 'network' && args[1] === 'inspect') return { code: 0, out: '10.213.0.0/22 ' }
    if (args[0] === 'image' && args[1] === 'inspect') return { code: 0, out: 'sha256:abc' }
    if (isHelper(args)) return helper(helperScript(args))
    return { code: 1, out: `unexpected: docker ${args.join(' ')}` }
  }
}

test('правила встали — комната идёт, и минуту помощник не зовётся заново', async () => {
  await withEnv({ COLLOQ_ROOM_NETWORK: undefined }, async () => {
    const { docker, calls } = fakeDocker(standardAnswers(() => ({ code: 0, out: 'colloq-perimeter: ok' })))
    const target = { network: 'colloq-rooms', create: true }
    await ensureRoomPerimeter(docker, target, 'colloq-kernel:base')
    await ensureRoomPerimeter(docker, target, 'colloq-kernel:base')
    const helpers = calls.filter((call) => isHelper(call.args))
    assert.equal(helpers.length, 1, 'помощник позван на каждый подъём')
    assert.match(helperScript(helpers[0].args), /-A COLLOQ-ROOMS-IN -s 10\.213\.0\.0\/22 -j COLLOQ-ROOMS-DENY/)
    assert.equal(perimeterProblem(), null)
  })
})

test('правила не встали — отказ с переведённым текстом и выходом, а не открытая сеть', async () => {
  await withEnv({ COLLOQ_ROOM_NETWORK: undefined }, async () => {
    const said = 'colloq-perimeter: no DOCKER-USER chain: Docker does not manage iptables on this host'
    const { docker } = fakeDocker(standardAnswers(() => ({ code: 21, out: said })))
    const target = { network: 'colloq-rooms', create: true }

    setLocaleResolver(() => 'ru')
    const ru = await ensureRoomPerimeter(docker, target, 'colloq-kernel:base').then(
      () => assert.fail('комната поднялась без запрета'),
      (err: unknown) => err,
    )
    assert.ok(ru instanceof RoomPerimeterError)
    assert.match(ru.message, /Комнату не запустить/)
    assert.match(ru.message, /no DOCKER-USER chain/)
    assert.match(ru.message, /COLLOQ_ROOM_NETWORK=open/)
    assert.equal(perimeterProblem(), ru.message)

    // Отказ не запоминается как успех: следующий подъём пробует снова — и на
    // английском говорит то же самое.
    setLocaleResolver(() => 'en')
    const en = await ensureRoomPerimeter(docker, target, 'colloq-kernel:base').then(
      () => assert.fail('второй подъём прошёл без запрета'),
      (err: unknown) => err,
    )
    assert.ok(en instanceof RoomPerimeterError)
    assert.match(en.message, /The room cannot start/)
    assert.match(en.message, /COLLOQ_ROOM_NETWORK=open/)
  })
})

test('помощника не запустить (нет прав на --privileged) — тоже отказ', async () => {
  await withEnv({ COLLOQ_ROOM_NETWORK: undefined }, async () => {
    const { docker } = fakeDocker(
      standardAnswers(() => ({ code: 125, out: 'docker: Error response from daemon: privileged mode is not allowed.' })),
    )
    await assert.rejects(ensureRoomPerimeter(docker, { network: 'colloq-rooms', create: true }, 'colloq-kernel:base'), (err: unknown) => {
      assert.ok(err instanceof RoomPerimeterError)
      assert.match(err.reason, /privileged mode is not allowed/)
      return true
    })
  })
})

test('ответ без «ok» — не успех, даже с нулевым кодом', async () => {
  await withEnv({ COLLOQ_ROOM_NETWORK: undefined }, async () => {
    const { docker } = fakeDocker(standardAnswers(() => ({ code: 0, out: '' })))
    await assert.rejects(ensureRoomPerimeter(docker, { network: 'colloq-rooms', create: true }, 'colloq-kernel:base'), RoomPerimeterError)
  })
})

test('COLLOQ_ROOM_NETWORK=open: правила не ставятся, прежние снимаются, отказа нет', async () => {
  await withEnv({ COLLOQ_ROOM_NETWORK: 'open' }, async () => {
    const { docker, calls } = fakeDocker(standardAnswers(() => ({ code: 0, out: 'colloq-perimeter: removed' })))
    await ensureRoomPerimeter(docker, { network: 'colloq-rooms', create: true }, 'colloq-kernel:base')
    await ensureRoomPerimeter(docker, { network: 'colloq-rooms', create: true }, 'colloq-kernel:base')
    const helpers = calls.filter((call) => isHelper(call.args)).map((call) => helperScript(call.args))
    assert.equal(helpers.length, 1, 'снимать прежнее надо один раз за запуск')
    assert.ok(!/iptables-restore/.test(helpers[0]), 'в открытом режиме поставили запрет')
    assert.match(helpers[0], /-D DOCKER-USER/)
    assert.equal(perimeterProblem(), null)
  })
})

test('сети комнат нет — заводится своя; подсеть занята — docker выбирает сам', async () => {
  await withEnv({ COLLOQ_ROOM_NETWORK: undefined, KERNEL_ROOM_SUBNET: undefined }, async () => {
    let created = false
    const { docker, calls } = fakeDocker((args) => {
      if (args[0] === 'network' && args[1] === 'inspect') {
        return created ? { code: 0, out: '172.30.0.0/16' } : { code: 1, out: 'Error: No such network: colloq-rooms' }
      }
      if (args[0] === 'network' && args[1] === 'create') {
        if (args.includes('--subnet=10.213.0.0/22')) return { code: 1, out: 'Error response from daemon: Pool overlaps with other one on this address space' }
        created = true
        return { code: 0, out: 'abc' }
      }
      if (args[0] === 'image') return { code: 0, out: 'sha256:abc' }
      if (isHelper(args)) return { code: 0, out: 'colloq-perimeter: ok' }
      return { code: 1, out: 'unexpected' }
    })
    await ensureRoomPerimeter(docker, { network: 'colloq-rooms', create: true }, 'colloq-kernel:base')
    const creates = calls.filter((call) => call.args[1] === 'create')
    assert.equal(creates.length, 2)
    assert.ok(!creates[1].args.some((arg) => arg.startsWith('--subnet')))
    // Правила — по подсети, которую сеть получила на деле.
    const script = helperScript(calls.find((call) => isHelper(call.args))!.args)
    assert.match(script, /-s 172\.30\.0\.0\/16 -d 192\.168\.0\.0\/16/)
  })
})

test('названную явно подсеть молча не подменяем', async () => {
  await withEnv({ COLLOQ_ROOM_NETWORK: undefined, KERNEL_ROOM_SUBNET: '10.99.0.0/24' }, async () => {
    const { docker, calls } = fakeDocker((args) => {
      if (args[1] === 'inspect' && args[0] === 'network') return { code: 1, out: 'No such network' }
      if (args[1] === 'create') return { code: 1, out: 'Pool overlaps with other one on this address space' }
      return { code: 1, out: 'unexpected' }
    })
    await assert.rejects(ensureRoomPerimeter(docker, { network: 'colloq-rooms', create: true }, null), RoomPerimeterError)
    assert.equal(calls.filter((call) => call.args[1] === 'create').length, 1)
    assert.ok(calls.some((call) => call.args.includes('--subnet=10.99.0.0/24')))
  })
})

test('общую сеть compose сервер не заводит: её нет — отказ', async () => {
  await withEnv({ COLLOQ_ROOM_NETWORK: undefined }, async () => {
    const { docker, calls } = fakeDocker(() => ({ code: 1, out: 'Error: No such network: colloq' }))
    await assert.rejects(ensureRoomPerimeter(docker, { network: 'colloq', create: false }, 'colloq-kernel:base'), RoomPerimeterError)
    assert.ok(!calls.some((call) => call.args[1] === 'create'))
  })
})

test('образа ядра нет ни одного — отказ, помощник не зовётся', async () => {
  await withEnv({ COLLOQ_ROOM_NETWORK: undefined }, async () => {
    const { docker, calls } = fakeDocker((args) => {
      if (args[0] === 'network') return { code: 0, out: '10.213.0.0/22' }
      if (args[0] === 'image') return { code: 1, out: 'No such image' }
      if (args[0] === 'images') return { code: 0, out: '' }
      return { code: 1, out: 'unexpected' }
    })
    await assert.rejects(ensureRoomPerimeter(docker, { network: 'colloq-rooms', create: true }, 'colloq-kernel:base'), /colloq-kernel image/)
    assert.ok(!calls.some((call) => isHelper(call.args)))
  })
})

test('контейнер личных тетрадей берёт СВОИ числа, если занятие их назвало', () => {
  /*
   * Поле «Память» занятия преподаватель ставит под свою работу — под датасет,
   * который грузит на лекции. Отсыпать столько же тридцати черновикам он не
   * подписывался, а на машине это ровно вдвое больше памяти.
   */
  const args = (memoryMb: number | null, cpus: number | null) =>
    runArgs({
      sessionId: 'r4', env: 'base', mount: '/m', network: 'colloq-rooms',
      publish: true, gpu: null, role: 'own', memoryMb, cpus,
    })
  const mine = args(2048, 1)
  assert.ok(mine.includes('--memory=2048m'), JSON.stringify(mine))
  assert.ok(mine.includes('--memory-swap=2048m'), JSON.stringify(mine))
  assert.ok(mine.includes('--cpus=1'), JSON.stringify(mine))
  // Потоки numpy и torch считаются по ВЫДАННЫМ ядрам, а не по ядрам машины:
  // иначе одно ядро поднимало бы тридцать потоков на нём.
  assert.ok(mine.includes('OMP_NUM_THREADS=1'), JSON.stringify(mine))

  // Не назвали — прежнее поведение: столько же, сколько у комнаты.
  const same = withEnv({ KERNEL_MEM: undefined, KERNEL_CPUS: undefined }, () => args(null, null))
  assert.ok(same.includes('--memory=4g'), JSON.stringify(same))
  assert.ok(same.includes('--cpus=2'), JSON.stringify(same))
})
