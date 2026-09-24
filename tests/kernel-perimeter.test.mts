/**
 * The hardened room profile on the docker backend (kernel/perimeter.ts).
 *
 * This proves what could otherwise be seen only during a live class: exactly
 * which `docker run` line a room gets, exactly which rules the helper installs,
 * and that the server REFUSES to start a room when the rules did not go in —
 * rather than silently starting it with an open network. There is no real
 * docker in the suite (see `_env.mts`), so docker is replaced with a function,
 * and the lines are compared whole. The live check on colima — packages,
 * refusals, a fork bomb — is described in the rollout report; it cannot be
 * repeated here.
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

/* ------------------------------------------------------ the docker run line */

test('a room on the host: its own network, a loopback port and the whole hardened profile — the full line', () => {
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
    // How plotly hands over a figure: without this variable it decides itself,
    // and differently in different versions — 5.x adds `text/html` to the
    // figure and sends the whole plotly.js bundle as the first frame, five
    // megabytes of script nobody needs in the shared document
    // (kernel/pool.ts · runArgs). A default, not a ban:
    // `pio.renderers.default` in a cell overrides it.
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
  // Not a single concession: no --privileged, no --cap-add, no host network.
  assert.ok(!args.some((arg) => /^--(privileged|cap-add|pid=)|^--network=host$|^host$/.test(arg)), JSON.stringify(args))
})

test('the container form: a shared network by name, the port is not published, the same profile', () => {
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

test('the process ceiling is KERNEL_PIDS, and a silly number does not lift it', () => {
  withEnv({ KERNEL_PIDS: undefined }, () => assert.equal(pidsLimit(), 512))
  withEnv({ KERNEL_PIDS: '2048' }, () => {
    assert.equal(pidsLimit(), 2048)
    assert.ok(runArgs({ sessionId: 'p', env: 'base', mount: '/m', network: 'colloq-rooms', publish: true, gpu: null }).includes('--pids-limit=2048'))
  })
  // Zero, a negative, a word, a fraction and too few for Jupyter — the
  // default, not "no ceiling" and not a room that cannot even start a kernel.
  for (const bad of ['0', '-1', 'много', '1.5', '10', '']) {
    withEnv({ KERNEL_PIDS: bad }, () => assert.equal(pidsLimit(), 512, bad))
  }
})

test('the personal notebooks container: the same profile, but without a GPU, with its own label and its own ceiling', () => {
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

  // The name and the label — so that cleanup, `colloq status` and slice
  // allocation can tell them apart.
  assert.equal(own[own.indexOf('--name') + 1], 'colloq-room-r3-own')
  assert.ok(own.includes('colloq.role=own'), JSON.stringify(own))
  assert.ok(room.includes('colloq.role=room'), JSON.stringify(room))

  /*
   * No card, no slice label, no shared memory for it — and this is not a
   * setting but the design: a GPU is given to a container whole, and a
   * student removes `CUDA_VISIBLE_DEVICES` with one line. The slice is passed
   * on purpose: a caller's mistake must not be able to hand the card to the
   * drafts.
   */
  assert.ok(room.includes('--gpus'), 'the room was left without a card')
  assert.ok(!own.includes('--gpus'), JSON.stringify(own))
  assert.ok(!own.some((arg) => /^--label$/.test(arg) && false))
  assert.ok(!own.some((arg) => arg.startsWith('colloq.gpu=')), JSON.stringify(own))
  assert.ok(!own.some((arg) => arg.startsWith('--shm-size')), JSON.stringify(own))

  // Its own process ceiling: it holds dozens of kernels, and the room's 512
  // would not be enough.
  assert.ok(own.includes('--pids-limit=2048'), JSON.stringify(own))
  assert.ok(room.includes('--pids-limit=512'), JSON.stringify(room))

  // Everything else is the same: image, network, class folder, profile, numbers.
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

  // It has ITS OWN token: otherwise a line from a draft would open the
  // lecture's Jupyter.
  const tokenOf = (args: string[]) => args.find((arg) => arg.startsWith('JUPYTER_TOKEN='))
  assert.match(tokenOf(own) ?? '', /^JUPYTER_TOKEN=[0-9a-f]{40}$/)
  assert.notEqual(tokenOf(own), tokenOf(room))
})

test('the process ceiling of the personal notebooks container is KERNEL_OWN_PIDS, and junk does not lift it', () => {
  withEnv({ KERNEL_OWN_PIDS: undefined }, () => assert.equal(ownPidsLimit(), 2048))
  withEnv({ KERNEL_OWN_PIDS: '4096' }, () => {
    assert.equal(ownPidsLimit(), 4096)
    const args = runArgs({ sessionId: 'p', env: 'base', mount: '/m', network: 'colloq-rooms', publish: true, gpu: null, role: 'own' })
    assert.ok(args.includes('--pids-limit=4096'), JSON.stringify(args))
  })
  for (const bad of ['0', '-1', 'много', '1.5', '10', '']) {
    withEnv({ KERNEL_OWN_PIDS: bad }, () => assert.equal(ownPidsLimit(), 2048, bad))
  }
  // And the ceiling on LIVE kernels in it is a separate number, read by the
  // same rule.
  withEnv({ KERNEL_OWN_MAX: undefined }, () => assert.equal(ownKernelMax(), 40))
  withEnv({ KERNEL_OWN_MAX: '4' }, () => assert.equal(ownKernelMax(), 4))
  for (const bad of ['0', '-1', 'сорок', '1.5', '']) {
    withEnv({ KERNEL_OWN_MAX: bad }, () => assert.equal(ownKernelMax(), 40, bad))
  }

  /*
   * The idle time of a personal kernel is a third number, and for it `0` IS
   * MEANINGFUL.
   *
   * For the ceilings zero is meaningless and reads as junk; here it is a switch
   * for someone whose class is organised differently, and mixing them up
   * would quietly turn the sweep on where it was turned off.
   */
  withEnv({ KERNEL_OWN_IDLE_MIN: undefined }, () => assert.equal(ownIdleMinutes(), 30))
  withEnv({ KERNEL_OWN_IDLE_MIN: '5' }, () => assert.equal(ownIdleMinutes(), 5))
  withEnv({ KERNEL_OWN_IDLE_MIN: ' 0 ' }, () => assert.equal(ownIdleMinutes(), 0))
  for (const bad of ['-1', 'полчаса', '1.5', '']) {
    withEnv({ KERNEL_OWN_IDLE_MIN: bad }, () => assert.equal(ownIdleMinutes(), 30, bad))
  }
})

test('COLLOQ_ROOM_NETWORK: only the word open opens it, a typo does not open the network', () => {
  assert.equal(roomNetworkMode({}), 'blocked')
  assert.equal(roomNetworkMode({ COLLOQ_ROOM_NETWORK: 'blocked' }), 'blocked')
  assert.equal(roomNetworkMode({ COLLOQ_ROOM_NETWORK: ' Open ' }), 'open')
  assert.equal(roomNetworkMode({ COLLOQ_ROOM_NETWORK: 'opne' }), 'blocked')
  assert.equal(roomNetworkMode({ COLLOQ_ROOM_NETWORK: '1' }), 'blocked')
})

test('the rooms network: its own subnet, no ICC and no IPv6', () => {
  assert.deepEqual(networkCreateArgs(DEFAULT_ROOM_SUBNET), [
    'network', 'create', '--driver=bridge', '--subnet=10.213.0.0/22', '--ipv6=false',
    '-o', 'com.docker.network.bridge.enable_icc=false',
    '--label', 'colloq.kind=room-network',
    'colloq-rooms',
  ])
  // The subnet is taken — docker picks one itself, everything else is the same.
  assert.ok(!networkCreateArgs(null).some((arg) => arg.startsWith('--subnet')))
})

/* ---------------------------------------------------------------- addresses */

test('addresses and subnets are computed honestly', () => {
  assert.equal(ipv4InCidr('10.213.3.255', '10.213.0.0/22'), true)
  assert.equal(ipv4InCidr('10.213.4.0', '10.213.0.0/22'), false)
  assert.equal(ipv4InCidr('192.168.1.64', '192.168.0.0/16'), true)
  assert.equal(ipv4InCidr('172.32.0.1', '172.16.0.0/12'), false)
  assert.equal(ipv4InCidr('1.2.3.4', '0.0.0.0/0'), true)
  assert.equal(ipv4InCidr('300.1.1.1', '0.0.0.0/0'), false)
  assert.equal(ipv4InCidr('fe80::1', '0.0.0.0/0'), false)
  // docker prints subnets separated by spaces, with v6 alongside — we drop it.
  assert.deepEqual(ipv4Subnets('172.19.0.0/16 fd00:dead::/64 '), ['172.19.0.0/16'])
  assert.deepEqual(ipv4Subnets(''), [])
})

test("the only exemption is the server's own addresses inside the rooms subnet", () => {
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

/* ------------------------------------------------------------- rules */

test('rules: replies, exemptions and DNS pass, private ranges and the host itself are refused; full lines', () => {
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
  // The list of what is closed is exactly what was promised to the owner and
  // in the documentation.
  assert.deepEqual([...BLOCKED_V4], [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
    '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4',
  ])
})

test('the fallback set without REJECT differs only in the refusal action', () => {
  const plan = { subnets: ['10.213.0.0/22'], exempt: [] }
  const reject = perimeterRules(plan, 'reject').split('\n')
  const drop = perimeterRules(plan, 'drop').split('\n')
  assert.deepEqual(drop.filter((line) => line.startsWith('-A COLLOQ-ROOMS-DENY')), ['-A COLLOQ-ROOMS-DENY -j DROP'])
  assert.deepEqual(
    drop.filter((line) => !line.startsWith('-A COLLOQ-ROOMS-DENY')),
    reject.filter((line) => !line.startsWith('-A COLLOQ-ROOMS-DENY')),
  )
})

test('the helper script touches only its own and names the reason for a refusal', () => {
  const script = perimeterScript({ subnets: ['10.213.0.0/22'], exempt: [] })
  // iptables of the same dockerd, in its mount namespace.
  assert.match(script, /nsenter -t "\$pid" -m -- "\$@"/)
  assert.match(script, /readlink "\$p\/ns\/net"/)
  // Atomically and without flushing anyone else's rules.
  assert.match(script, /iptables-restore -w --noflush/)
  assert.ok(!/iptables(-restore)? [^\n]*(-F|--flush)( |$)/m.test(script), 'the install script flushes something')
  // Jumps — once, after a check, with our comment.
  assert.match(script, /-C DOCKER-USER -m comment --comment colloq-rooms -j COLLOQ-ROOMS-FWD/)
  assert.match(script, /-I DOCKER-USER 1 -m comment --comment colloq-rooms -j COLLOQ-ROOMS-FWD/)
  assert.match(script, /-I INPUT 1 -m comment --comment colloq-rooms -j COLLOQ-ROOMS-IN/)
  for (const code of [20, 21, 22, 23]) assert.match(script, new RegExp(`exit ${code}`))
  assert.match(script, /say ok\n$/)

  const removal = perimeterRemovalScript()
  // Exactly what was inserted is removed — by the same line — and only our chains.
  assert.match(removal, /-D DOCKER-USER -m comment --comment colloq-rooms -j COLLOQ-ROOMS-FWD/)
  assert.match(removal, /-D INPUT -m comment --comment colloq-rooms -j COLLOQ-ROOMS-IN/)
  for (const line of removal.split('\n').filter((l) => / -[FX] /.test(l))) {
    assert.match(line, /for chain in COLLOQ-ROOMS-FWD COLLOQ-ROOMS-IN COLLOQ-ROOMS-DENY; do fw iptables -w -[FX] "\$chain"/)
  }
})

test('the helper is privileged, but lives for a second and does not pull an image', () => {
  assert.deepEqual(helperArgs('colloq-kernel:base', 'echo hi'), [
    'run', '--rm', '--privileged', '--pid=host', '--network=host', '--user=0:0',
    '--pull=never', '--no-healthcheck', '--label', 'colloq.kind=room-perimeter',
    '--entrypoint=sh', 'colloq-kernel:base', '-c', 'echo hi',
  ])
})

/* ------------------------------------------------------------ installation */

interface Call { args: string[] }

/** A docker that remembers calls and answers by the test's rules. */
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

test('the rules went in — the room proceeds, and for a minute the helper is not called again', async () => {
  await withEnv({ COLLOQ_ROOM_NETWORK: undefined }, async () => {
    const { docker, calls } = fakeDocker(standardAnswers(() => ({ code: 0, out: 'colloq-perimeter: ok' })))
    const target = { network: 'colloq-rooms', create: true }
    await ensureRoomPerimeter(docker, target, 'colloq-kernel:base')
    await ensureRoomPerimeter(docker, target, 'colloq-kernel:base')
    const helpers = calls.filter((call) => isHelper(call.args))
    assert.equal(helpers.length, 1, 'the helper is called on every start')
    assert.match(helperScript(helpers[0].args), /-A COLLOQ-ROOMS-IN -s 10\.213\.0\.0\/22 -j COLLOQ-ROOMS-DENY/)
    assert.equal(perimeterProblem(), null)
  })
})

test('the rules did not go in — a refusal with translated text and a way out, not an open network', async () => {
  await withEnv({ COLLOQ_ROOM_NETWORK: undefined }, async () => {
    const said = 'colloq-perimeter: no DOCKER-USER chain: Docker does not manage iptables on this host'
    const { docker } = fakeDocker(standardAnswers(() => ({ code: 21, out: said })))
    const target = { network: 'colloq-rooms', create: true }

    setLocaleResolver(() => 'ru')
    const ru = await ensureRoomPerimeter(docker, target, 'colloq-kernel:base').then(
      () => assert.fail('the room started without the block'),
      (err: unknown) => err,
    )
    assert.ok(ru instanceof RoomPerimeterError)
    assert.match(ru.message, /Комнату не запустить/)
    assert.match(ru.message, /no DOCKER-USER chain/)
    assert.match(ru.message, /COLLOQ_ROOM_NETWORK=open/)
    assert.equal(perimeterProblem(), ru.message)

    // A refusal is not remembered as a success: the next start tries again —
    // and says the same thing in English.
    setLocaleResolver(() => 'en')
    const en = await ensureRoomPerimeter(docker, target, 'colloq-kernel:base').then(
      () => assert.fail('the second start went through without the block'),
      (err: unknown) => err,
    )
    assert.ok(en instanceof RoomPerimeterError)
    assert.match(en.message, /The room cannot start/)
    assert.match(en.message, /COLLOQ_ROOM_NETWORK=open/)
  })
})

test('the helper cannot be started (no rights for --privileged) — a refusal too', async () => {
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

test('an answer without "ok" is not a success, even with a zero code', async () => {
  await withEnv({ COLLOQ_ROOM_NETWORK: undefined }, async () => {
    const { docker } = fakeDocker(standardAnswers(() => ({ code: 0, out: '' })))
    await assert.rejects(ensureRoomPerimeter(docker, { network: 'colloq-rooms', create: true }, 'colloq-kernel:base'), RoomPerimeterError)
  })
})

test('COLLOQ_ROOM_NETWORK=open: rules are not installed, old ones are removed, no refusal', async () => {
  await withEnv({ COLLOQ_ROOM_NETWORK: 'open' }, async () => {
    const { docker, calls } = fakeDocker(standardAnswers(() => ({ code: 0, out: 'colloq-perimeter: removed' })))
    await ensureRoomPerimeter(docker, { network: 'colloq-rooms', create: true }, 'colloq-kernel:base')
    await ensureRoomPerimeter(docker, { network: 'colloq-rooms', create: true }, 'colloq-kernel:base')
    const helpers = calls.filter((call) => isHelper(call.args)).map((call) => helperScript(call.args))
    assert.equal(helpers.length, 1, 'the old rules must be removed once per launch')
    assert.ok(!/iptables-restore/.test(helpers[0]), 'the block was installed in open mode')
    assert.match(helpers[0], /-D DOCKER-USER/)
    assert.equal(perimeterProblem(), null)
  })
})

test('no rooms network — one is created; the subnet is taken — docker picks one itself', async () => {
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
    // The rules follow the subnet the network actually got.
    const script = helperScript(calls.find((call) => isHelper(call.args))!.args)
    assert.match(script, /-s 172\.30\.0\.0\/16 -d 192\.168\.0\.0\/16/)
  })
})

test('an explicitly named subnet is not silently replaced', async () => {
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

test('the server does not create the shared compose network: if it is missing — a refusal', async () => {
  await withEnv({ COLLOQ_ROOM_NETWORK: undefined }, async () => {
    const { docker, calls } = fakeDocker(() => ({ code: 1, out: 'Error: No such network: colloq' }))
    await assert.rejects(ensureRoomPerimeter(docker, { network: 'colloq', create: false }, 'colloq-kernel:base'), RoomPerimeterError)
    assert.ok(!calls.some((call) => call.args[1] === 'create'))
  })
})

test('there is no kernel image at all — a refusal, the helper is not called', async () => {
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

test('the personal notebooks container takes ITS OWN numbers if the class named them', () => {
  /*
   * The teacher sets the class "Memory" field for their own work — for the
   * dataset they load during the lecture. They did not sign up to hand the
   * same amount to thirty drafts, and on the machine that is exactly twice
   * the memory.
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
  // numpy and torch threads are counted by the ALLOCATED cores, not by the
  // machine's cores: otherwise one core would get thirty threads on it.
  assert.ok(mine.includes('OMP_NUM_THREADS=1'), JSON.stringify(mine))

  // Not named — the old behaviour: the same as the room.
  const same = withEnv({ KERNEL_MEM: undefined, KERNEL_CPUS: undefined }, () => args(null, null))
  assert.ok(same.includes('--memory=4g'), JSON.stringify(same))
  assert.ok(same.includes('--cpus=2'), JSON.stringify(same))
})
