import { TEST_ROOT } from './_env.mts'
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, rm, mkdir, writeFile, readFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { PREPARATION_PYTHON } from '../server/src/dependencies/preparation-python.ts'
import { prepareDependencies, cleanupPreparationResources } from '../server/src/dependencies/preparation.ts'
import type { PreparationRequest } from '../server/src/dependencies/preparation-contract.ts'

const label = 'ru.colloq.dependency-preparation=' + createHash('sha256').update(path.join(TEST_ROOT, 'data')).digest('hex').slice(0, 16)
const enabled = process.env.COLLOQ_DEPENDENCY_DOCKER_TEST === '1'
const workDirs: string[] = []
let imageDigest = '', basePackages: PreparationRequest['basePackages'] = []
if (enabled) {
  delete process.env.DATA_HOST_DIR
  imageDigest = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', 'colloq-kernel:kaggle-base'], { encoding: 'utf8' }).trim()
  basePackages = JSON.parse(execFileSync('docker', ['run', '--rm', '--network=none', '--entrypoint=python', imageDigest, '-I', '-c', 'import importlib.metadata,json; print(json.dumps([{"name":d.metadata["Name"],"version":d.version} for d in importlib.metadata.distributions() if d.metadata["Name"]]))'], { encoding: 'utf8' }))
}
async function request(requirementsText: string, extra: Partial<PreparationRequest> = {}) {
  const workDir = await mkdtemp(path.join(process.cwd(), '.dependency-test-'))
  workDirs.push(workDir)
  return { id: 'integration', imageDigest, basePackages, requirementsText, workDir, maxDownloadBytes: 8 * 1024 * 1024, maxInstalledBytes: 16 * 1024 * 1024, wallSeconds: 90, signal: new AbortController().signal, ...extra }
}
after(async () => { if (enabled) await cleanupPreparationResources(); for (const dir of workDirs) await rm(dir, { recursive: true, force: true }) })

test('Docker: public wheel with transitive dependencies resolves and verifies offline', { skip: !enabled, timeout: 120000 }, async () => {
  const job = await request('python-slugify==8.0.4')
  const stages: string[] = []
  job.onProgress = update => {
    stages.push(update.state)
    if (!update.normalizedRequirements) return
    const container = execFileSync('docker', ['ps', '--filter', `label=${label}`, '--filter', 'name=colloq-dep-resolve-', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim()
    const details = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0]
    assert.equal(details.HostConfig.ReadonlyRootfs, true)
    assert.equal(details.Mounts.length, 2)
    assert.ok(details.Mounts.every((mount: { Destination: string }) => ['/input', '/wheels'].includes(mount.Destination)))
    const network = Object.keys(details.NetworkSettings.Networks)[0]
    const networkDetails = JSON.parse(execFileSync('docker', ['network', 'inspect', network], { encoding: 'utf8' }))[0]
    assert.equal(networkDetails.Internal, true)
    assert.equal(networkDetails.Options['com.docker.network.bridge.gateway_mode_ipv4'], 'isolated')
    const probe = `import socket
for address in [('1.1.1.1',443), ('169.254.169.254',80), ('172.17.0.1',80)]:
    try:
        connection = socket.create_connection(address, timeout=1)
    except OSError: pass
    else:
        connection.close(); raise AssertionError('direct egress allowed')
for target in ['example.com:443','127.0.0.1:443','host.docker.internal:443','pypi.org:80','pypi.org.evil.test:443']:
    with socket.create_connection(('pypi-proxy',3128), timeout=3) as connection:
        connection.sendall(('CONNECT ' + target + ' HTTP/1.1\\r\\nHost: ' + target + '\\r\\n\\r\\n').encode())
        assert b'403 Forbidden' in connection.recv(4096), target
print('network boundaries verified')`
    const result = execFileSync('docker', ['run', '--rm', '--network', network, '--read-only', '--cap-drop=ALL', '--entrypoint=python', imageDigest, '-I', '-c', probe], { encoding: 'utf8', timeout: 20000 })
    assert.match(result, /network boundaries verified/)
  }
  const result = await prepareDependencies(job)
  assert.ok(result.packages.some(item => item.name === 'python-slugify'))
  assert.ok(result.packages.some(item => item.name === 'text-unidecode'))
  assert.ok(result.downloadBytes > 0)
  assert.ok(result.installedBytes > 0)
  assert.ok(result.lock.includes('--hash=sha256:'))
  assert.deepEqual(new Set(stages), new Set(['resolving', 'downloading', 'verifying']))
  assert.deepEqual((await readdir(path.join(job.workDir, 'wheels'))).sort(), result.packages.map(item => item.fileName).sort())
  await rm(job.workDir, { recursive: true, force: true })
})

test('Docker: packages already in base require no additional wheels', { skip: !enabled, timeout: 120000 }, async () => {
  const existing = basePackages.find(item => item.name.toLowerCase() === 'numpy')!
  const job = await request(`${existing.name}==${existing.version}`)
  const result = await prepareDependencies(job)
  assert.deepEqual(result.packages, [])
  assert.equal(result.downloadBytes, 0)
  assert.equal(result.lock, '')
  assert.equal(result.installedBytes, 0)
})

test('Docker: cancellation tears down both containers and the private network', { skip: !enabled, timeout: 30000 }, async () => {
  const controller = new AbortController()
  const job = await request('python-slugify', { signal: controller.signal })
  job.onProgress = update => { if (update.normalizedRequirements) controller.abort() }
  await assert.rejects(prepareDependencies(job), { code: 'cancelled' })
  const names = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}', '--filter', `label=${label}`], { encoding: 'utf8' })
  assert.equal(names.trim(), '')
  assert.deepEqual(await readdir(job.workDir), [])
})


test('Docker: failed lookups distinguish unknown packages from incompatible wheels', { skip: !enabled, timeout: 120000 }, async () => {
  const missing = await request('colloq-package-that-does-not-exist-9284538==1.0')
  await assert.rejects(prepareDependencies(missing), { code: 'package_not_found' })
  const noWheel = await request('python-slugify==0.0.1')
  await assert.rejects(prepareDependencies(noWheel), { code: 'wheel_unavailable' })
})

test('Docker: wheel bytes and timeout limits fail closed with resource cleanup', { skip: !enabled, timeout: 120000 }, async () => {
  const small = await request('python-slugify==8.0.4', { maxDownloadBytes: 100 })
  await assert.rejects(prepareDependencies(small), { code: 'download_limit' })
  const timed = await request('python-slugify==8.0.4', { wallSeconds: 0.05 })
  await assert.rejects(prepareDependencies(timed), { code: 'timeout' })
})


test('Docker: verification checks wheel metadata without executing installed .pth hooks', { skip: !enabled, timeout: 30000 }, async () => {
  const job = await request('demo==1.0')
  const wheels = path.join(job.workDir, 'wheels'), input = path.join(job.workDir, 'input')
  await mkdir(wheels, { mode: 0o755 }); await mkdir(input, { mode: 0o755 })
  const file = path.join(wheels, 'demo-1.0-py3-none-any.whl')
  execFileSync('python3', ['-c', `import sys, zipfile
files = {
'demo.pth': "import pathlib; pathlib.Path('/tmp/pth-executed').touch()",
'demo-1.0.dist-info/METADATA': 'Metadata-Version: 2.1\\nName: demo\\nVersion: 1.0\\n',
'demo-1.0.dist-info/WHEEL': 'Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n',
}
files['demo-1.0.dist-info/RECORD'] = '\\n'.join(name + ',,' for name in files) + '\\ndemo-1.0.dist-info/RECORD,,'
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
    for name, content in files.items(): archive.writestr(name, content)
`, file])
  const bytes = await readFile(file)
  await chmod(file, 0o444)
  const manifest = { normalizedRequirements: ['demo==1.0'], packages: [{ name: 'demo', version: '1.0', fileName: path.basename(file), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }], downloadBytes: bytes.length }
  await writeFile(path.join(input, 'request.json'), JSON.stringify({ ...job, resolved: manifest }), { mode: 0o644 })
  const code = `__name__ = 'test_helper'\n${PREPARATION_PYTHON}\nverify(json.loads(pathlib.Path('/input/request.json').read_text()))\nassert not pathlib.Path('/tmp/pth-executed').exists(), 'wheel startup hook was executed during verification'`
  const result = execFileSync('docker', ['run', '--rm', '--read-only', '--network=none', '--cap-drop=ALL', '--user=1000:1000', '--memory=256m', '--tmpfs', '/tmp:rw,exec,size=67108864', '--mount', `type=bind,src=${wheels},dst=/wheels,readonly`, '--mount', `type=bind,src=${input},dst=/input,readonly`, '--entrypoint=python', imageDigest, '-I', '-c', code], { encoding: 'utf8', timeout: 20000 })
  assert.match(result, /verified/)
})

test('Docker: restart sweep removes instance orphans and preserves other instance networks', { skip: !enabled, timeout: 30000 }, async () => {
  const suffix = createHash('sha256').update(TEST_ROOT).digest('hex').slice(0, 12)
  const orphan = `colloq-dep-test-orphan-${suffix}`, network = `colloq-dep-test-net-${suffix}`, unrelated = `colloq-dep-test-other-${suffix}`
  try {
    execFileSync('docker', ['network', 'create', '--internal', '--label', label, network])
    execFileSync('docker', ['network', 'create', '--internal', '--label', 'ru.colloq.dependency-preparation=other-test-instance', unrelated])
    execFileSync('docker', ['run', '-d', '--name', orphan, '--label', label, '--read-only', '--network=none', '--cap-drop=ALL', '--memory=128m', '--entrypoint=python', imageDigest, '-I', '-c', 'import time; time.sleep(60)'])
    await cleanupPreparationResources()
    assert.equal(execFileSync('docker', ['ps', '-aq', '--filter', `label=${label}`], { encoding: 'utf8' }).trim(), '')
    assert.equal(execFileSync('docker', ['network', 'ls', '-q', '--filter', `label=${label}`], { encoding: 'utf8' }).trim(), '')
    assert.ok(execFileSync('docker', ['network', 'inspect', unrelated], { encoding: 'utf8' }).includes(unrelated))
  } finally {
    for (const args of [['rm', '-f', orphan], ['network', 'rm', network], ['network', 'rm', unrelated]]) {
      try { execFileSync('docker', args, { stdio: 'ignore' }) } catch {}
    }
  }
})
