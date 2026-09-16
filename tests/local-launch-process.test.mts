import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import { fingerprint } from '../cli/src/launch-config.js'

const repo = path.resolve(import.meta.dirname, '..')
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean | Promise<boolean>, timeout = 15000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await pause(40)
  }
  throw new Error('Timed out waiting for local session')
}
async function port(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const p = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return p
}
function fixture(p: number): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'colloq-local-process-'))
  fs.mkdirSync(path.join(root, 'cli/src'), { recursive: true })
  for (const file of fs
    .readdirSync(path.join(repo, 'cli/src'))
    .filter((f) => f.startsWith('launch') && f.endsWith('.ts')))
    fs.copyFileSync(path.join(repo, 'cli/src', file), path.join(root, 'cli/src', file))
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  for (const dir of [
    'bin',
    'shared',
    'web/dist',
    'server/dist',
    'server/src/ops',
    'kernel/environments',
    '.colloq',
  ])
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  fs.copyFileSync(
    path.join(repo, 'shared/local-public-url-lease.ts'),
    path.join(root, 'shared/local-public-url-lease.ts'),
  )
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(root, '.env'), `PORT=${p}\nCOLLOQ_UNSAFE_DEV_FILES=1\n`)
  fs.writeFileSync(path.join(root, 'kernel/Dockerfile'), 'FROM fake')
  fs.writeFileSync(path.join(root, 'kernel/requirements.txt'), '')
  fs.writeFileSync(path.join(root, 'kernel/environments/base.txt'), '')
  fs.writeFileSync(path.join(root, 'web/dist/index.html'), 'hello')
  const server = `import http from 'node:http';import fs from 'node:fs';
const s=http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({ok:true,localRunId:process.env.COLLOQ_LOCAL_RUN_ID,publicUrl:process.env.COLLOQ_LOCAL_URL}))});
s.listen(Number(process.env.PORT),'127.0.0.1',()=>fs.appendFileSync('events','start\\n'));
process.on('SIGTERM',()=>{fs.appendFileSync('events','stop:'+process.env.COLLOQ_STOP_KERNELS_ON_EXIT+'\\n');s.close(()=>process.exit(0))});`
  fs.writeFileSync(path.join(root, 'server/dist/server.js'), server)
  fs.writeFileSync(path.join(root, 'server/src/index.ts'), server)
  fs.writeFileSync(
    path.join(root, 'server/src/ops/local-cleanup.ts'),
    "import fs from 'node:fs';fs.appendFileSync('events','cleanup\\n')",
  )
  fs.writeFileSync(
    path.join(root, 'bin/docker'),
    '#!/bin/sh\ncase "$1" in\n info) exit 0;;\n image) printf \'[{"Id":"sha256:fixture","Created":"2100-01-01T00:00:00Z"}]\\n\';;\n *) exit 1;;\nesac\n',
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(root, 'bin/npm'),
    '#!/bin/sh\nprintf "unexpected-build\\n" >> events\nexit 1\n',
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(root, '.colloq/build.json'),
    JSON.stringify({ fingerprint: fingerprint(root), fast: false }),
  )
  return root
}
function invoke(root: string, args: string[]) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(root, 'cli/src/launch.ts'), ...args],
    {
      cwd: root,
      env: {
        ...process.env,
        // The caller may already run a local server; fixtures own their ports and files.
        PORT: fs.readFileSync(path.join(root, '.env'), 'utf8').match(/^PORT=(\d+)/m)![1],
        DATA_DIR: path.join(root, 'data'),
        WORKSPACE_DIR: path.join(root, 'workspace'),
        PATH: path.join(root, 'bin') + ':' + process.env.PATH,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  child.stdout.on('data', (b) => (output += b))
  child.stderr.on('data', (b) => (output += b))
  const done = new Promise<number>((r) =>
    child.on('close', (code, signal) => r(code ?? (signal ? 128 : 1))),
  )
  return { child, done, output: () => output }
}

test(
  'foreground owns its process, reuses the build, refuses duplicate takeover and stops cleanly',
  { timeout: 25000 },
  async () => {
    const p = await port(),
      root = fixture(p),
      first = invoke(root, ['run', '--no-open'])
    try {
      await until(
        () =>
          fs.existsSync(path.join(root, '.colloq/local-session.json')) &&
          JSON.parse(fs.readFileSync(path.join(root, '.colloq/local-session.json'), 'utf8'))
            .phase === 'ready',
      )
      await until(() => first.output().includes('localhost:' + p))
      assert.match(first.output(), new RegExp('localhost:' + p))
      const second = invoke(root, ['run', '--no-open'])
      assert.equal(await second.done, 0, second.output())
      assert.match(second.output(), /уже/)
      assert.equal(fs.readFileSync(path.join(root, 'events'), 'utf8').split('start').length - 1, 1)
      first.child.kill('SIGINT')
      assert.equal(await first.done, 130, first.output())
      assert.match(fs.readFileSync(path.join(root, 'events'), 'utf8'), /stop:1/)
      assert.equal(fs.existsSync(path.join(root, '.colloq/local-session.json')), false)
      assert.equal(fs.existsSync(path.join(root, '.colloq.pid')), false)
    } finally {
      first.child.kill('SIGTERM')
      await first.done
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'detached launch returns only after readiness and stop terminates its supervisor',
  { timeout: 25000 },
  async () => {
    const root = fixture(await port()),
      run = invoke(root, ['run', '--detach', '--no-open'])
    try {
      assert.equal(await run.done, 0, run.output())
      const receipt = JSON.parse(
        fs.readFileSync(path.join(root, '.colloq/local-session.json'), 'utf8'),
      )
      assert.equal(receipt.phase, 'ready')
      const restart = invoke(root, ['restart'])
      assert.equal(await restart.done, 0, restart.output())
      const restarted = JSON.parse(
        fs.readFileSync(path.join(root, '.colloq/local-session.json'), 'utf8'),
      )
      assert.equal(restarted.options.detach, true)
      assert.notEqual(restarted.runId, receipt.runId)
      const stop = invoke(root, ['stop'])
      assert.equal(await stop.done, 0, stop.output())
      assert.equal(fs.existsSync(path.join(root, '.colloq/local-session.json')), false)
      assert.match(fs.readFileSync(path.join(root, 'events'), 'utf8'), /stop:1/)
    } finally {
      if (fs.existsSync(path.join(root, '.colloq/local-session.json')))
        await invoke(root, ['stop']).done
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'tunnel failure leaves foreground application running and Ctrl+C still stops it',
  { timeout: 20000 },
  async () => {
    const p = await port(),
      root = fixture(p)
    fs.mkdirSync(path.join(root, 'scripts'))
    fs.writeFileSync(
      path.join(root, 'scripts/host.sh'),
      '#!/bin/bash\nprintf "tunnel-start\\n" >> events\nexit 3\n',
    )
    const run = invoke(root, ['run', '--host', 'seminar.example.test', '--no-open'])
    try {
      await until(() => run.output().includes('Локальная работа продолжается'))
      assert.equal((await fetch(`http://127.0.0.1:${p}/api/health`)).status, 200)
      run.child.kill('SIGINT')
      assert.equal(await run.done, 130, run.output())
      assert.match(fs.readFileSync(path.join(root, 'events'), 'utf8'), /cleanup/)
    } finally {
      run.child.kill('SIGTERM')
      await run.done
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'failed application startup retires leftovers and releases both receipts',
  { timeout: 15000 },
  async () => {
    const root = fixture(await port())
    fs.writeFileSync(path.join(root, 'server/dist/server.js'), 'process.exit(7)')
    const run = invoke(root, ['run', '--no-open'])
    try {
      assert.equal(await run.done, 1, run.output())
      assert.match(fs.readFileSync(path.join(root, 'events'), 'utf8'), /cleanup/)
      assert.equal(fs.existsSync(path.join(root, '.colloq/local-session.json')), false)
      assert.equal(fs.existsSync(path.join(root, 'data/.local-session.lock')), false)
    } finally {
      run.child.kill('SIGTERM')
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'development watcher reload preserves kernels and final stop invokes cleanup',
  { timeout: 30000 },
  async () => {
    const p = await port(),
      ui = await port(),
      root = fixture(p)
    // Exercise the actual project's Tailwind/PostCSS pipeline, not an HTML-only fixture.
    fs.mkdirSync(path.join(root, 'web/src'), { recursive: true })
    for (const file of ['src/index.css', 'tailwind.config.js', 'postcss.config.js'])
      fs.copyFileSync(path.join(repo, 'web', file), path.join(root, 'web', file))
    fs.writeFileSync(
      path.join(root, 'web/src/check.svelte'),
      '<div class="bg-canvas text-ink">development</div>',
    )
    fs.writeFileSync(
      path.join(root, 'web/index.html'),
      '<html><head><link rel="stylesheet" href="/src/index.css"></head><body>development</body></html>',
    )
    fs.writeFileSync(
      path.join(root, 'web/vite.config.mjs'),
      `export default {server:{proxy:{'/api':'http://127.0.0.1:${p}'}}}`,
    )
    const run = invoke(root, ['dev', '--port', String(ui), '--no-open'])
    try {
      await until(() => run.output().includes('Colloq работает'), 20000)
      assert.equal((await fetch(`http://localhost:${ui}`)).status, 200)
      const styles = await fetch(`http://localhost:${ui}/src/index.css`)
      assert.equal(styles.status, 200, await styles.text())
      assert.doesNotMatch(
        run.output(),
        /Pre-transform error|class does not exist|content.*missing or empty/,
      )

      fs.appendFileSync(path.join(root, 'server/src/index.ts'), '\n// reload')
      await until(
        () => fs.readFileSync(path.join(root, 'events'), 'utf8').split('start').length >= 3,
      )
      assert.match(fs.readFileSync(path.join(root, 'events'), 'utf8'), /stop:0/)
      assert.doesNotMatch(fs.readFileSync(path.join(root, 'events'), 'utf8'), /cleanup/)
      run.child.kill('SIGINT')
      assert.equal(await run.done, 130, run.output())
      assert.match(fs.readFileSync(path.join(root, 'events'), 'utf8'), /cleanup/)
      assert.equal(fs.existsSync(path.join(root, '.colloq/local-session.json')), false)
    } finally {
      run.child.kill('SIGTERM')
      await run.done
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'terminal hangup shuts down a foreground session instead of orphaning its server',
  { timeout: 15000 },
  async () => {
    const root = fixture(await port()),
      run = invoke(root, ['run', '--no-open'])
    try {
      await until(() => run.output().includes('Colloq работает'))
      run.child.kill('SIGHUP')
      assert.equal(await run.done, 129, run.output())
      assert.match(fs.readFileSync(path.join(root, 'events'), 'utf8'), /stop:1/)
      assert.match(fs.readFileSync(path.join(root, 'events'), 'utf8'), /cleanup/)
      assert.equal(fs.existsSync(path.join(root, '.colloq/local-session.json')), false)
    } finally {
      if (fs.existsSync(path.join(root, '.colloq/local-session.json'))) {
        const receipt = JSON.parse(
          fs.readFileSync(path.join(root, '.colloq/local-session.json'), 'utf8'),
        )
        if (receipt.serverPid)
          try {
            process.kill(-receipt.serverPid, 'SIGTERM')
          } catch {}
      }
      run.child.kill('SIGTERM')
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)
