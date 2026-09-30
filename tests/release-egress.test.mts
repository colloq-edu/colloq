/**
 * The k3s installer's outbound and network settings (scripts/release.py).
 *
 * What an operator writes into instance.env must either reach the app and the
 * policies or be reported: a campus proxy, CA or package mirror that silently
 * never arrived looks exactly like one that does not work. And the package
 * proxy's network policy must open the mirror, which a NetworkPolicy can only
 * do by address and port. Names are avoided here (addresses and localhost), so
 * nothing asks a real DNS server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const script = new URL('../scripts/release.py', import.meta.url).pathname
const image = (letter: string) => `ghcr.io/example/colloq@sha256:${letter.repeat(64)}`
const release = { schemaVersion: 1, version: '0.9.0', sourceCommit: 'a'.repeat(40),
  k3sVersion: 'v1.34.1+k3s1', appImage: image('b'), runtimeImage: image('c'),
  dataSchemaVersion: 1, compatibleDataSchemaVersions: [1],
  catalog: { schemaVersion: 1, release: '0.9.0', defaultEnvironment: 'base',
    environments: [{ name: 'base', image: image('d'), gpu: false }] } }
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBcampusCA\n-----END CERTIFICATE-----\n'

function run(command: 'render' | 'config', env: string | null, extraFiles: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-release-egress-'))
  try {
    const file = path.join(dir, 'release.json')
    fs.writeFileSync(file, JSON.stringify(release))
    for (const [name, text] of Object.entries(extraFiles)) fs.writeFileSync(path.join(dir, name), text)
    const args = [script, command, '--release', file]
    if (env !== null) {
      fs.writeFileSync(path.join(dir, 'instance.env'), env.replaceAll('$DIR', dir))
      args.push('--env-file', path.join(dir, 'instance.env'))
    }
    return spawnSync('python3', args, { encoding: 'utf8' })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
const items = (stdout: string) => JSON.parse(stdout).items as any[]
const find = (list: any[], kind: string, name: string) => list.find((x) => x.kind === kind && x.metadata.name === name)
const envOf = (deployment: any) => Object.fromEntries(deployment.spec.template.spec.containers[0].env.map((e: any) => [e.name, e.value]))

test('the app Secret carries the outbound, inbound and room network settings; the rest is reported, not dropped in silence', () => {
  const settings = [
    'HTTPS_PROXY=http://proxy.campus.edu:3128', 'HTTP_PROXY=http://proxy.campus.edu:3128', 'NO_PROXY=.campus.edu',
    'https_proxy=http://proxy.campus.edu:3128', 'no_proxy=.campus.edu', 'NODE_EXTRA_CA_CERTS=/etc/ssl/campus.pem',
    'DEPENDENCY_INDEX_URL=https://nexus.campus.edu/simple', 'DEPENDENCY_FILES_HOSTS=files.campus.edu',
    'TRUSTED_PROXIES=10.0.0.0/8', 'SHARED_ADDRESSES=203.0.113.0/24', 'TRUST_CF_CONNECTING_IP=0', 'HSTS=0',
    'COLLOQ_ROOM_NETWORK=none', 'KERNEL_BLOCKED_CIDRS=203.0.113.0/24', 'PUBLIC_URL=https://colloq.campus.edu',
  ]
  const result = run('config', [...settings, 'RUNTIME_KERNEL_MEMORY=4Gi', 'KERNEL_MEM=8g', 'COLLOQ_HELPER_IMAGE=x', ''].join('\n'))
  assert.equal(result.status, 0, result.stderr)
  const data = JSON.parse(result.stdout).stringData
  assert.deepEqual(Object.keys(data).sort(), settings.map((line) => line.split('=')[0]).sort())
  // Reported on stderr, which kubectl never sees; the broker's own keys are known, not "ignored".
  assert.match(result.stderr, /warning: .*sets COLLOQ_HELPER_IMAGE, KERNEL_MEM, which the k3s installation does not use/)
  assert.ok(!/RUNTIME_KERNEL_MEMORY/.test(result.stderr), result.stderr)
  // A file of known keys (and comments) says nothing.
  const quiet = run('config', '# PUBLIC_URL=https://old.campus.edu\nPUBLIC_URL=https://colloq.campus.edu\nRUNTIME_KERNEL_MEMORY=4Gi\n')
  assert.equal(quiet.stderr, '')
  assert.deepEqual(JSON.parse(quiet.stdout).stringData, { PUBLIC_URL: 'https://colloq.campus.edu' })
})

test('without settings the proxy policy is exactly today\'s, and the broker gets no mirror', () => {
  const result = run('render', null)
  assert.equal(result.status, 0, result.stderr)
  const list = items(result.stdout)
  const egress = find(list, 'NetworkPolicy', 'competition-proxy-isolation').spec.egress
  assert.equal(egress.length, 2)
  assert.deepEqual(egress[1].ports, [{ protocol: 'TCP', port: 443 }])
  assert.equal(egress[1].to[0].ipBlock.cidr, '0.0.0.0/0')
  assert.equal('DEPENDENCY_INDEX_URL' in envOf(find(list, 'Deployment', 'colloq-runtime')), false)
  assert.equal(find(list, 'ConfigMap', 'colloq-extra-ca'), undefined)
})

test('a campus mirror opens the proxy policy to its addresses and ports; a public host on 443 needs nothing extra', () => {
  const result = run('render', 'DEPENDENCY_INDEX_URL=https://10.20.30.40:3141/root/pypi/+simple/\nDEPENDENCY_FILES_HOSTS=203.0.113.9:8443, 151.101.0.223,10.20.30.40:3141\n')
  assert.equal(result.status, 0, result.stderr)
  const list = items(result.stdout)
  const egress = find(list, 'NetworkPolicy', 'competition-proxy-isolation').spec.egress
  assert.equal(egress[1].to[0].ipBlock.cidr, '0.0.0.0/0', 'the general rule stays')
  assert.deepEqual(egress.slice(2), [
    { to: [{ ipBlock: { cidr: '10.20.30.40/32' } }], ports: [{ protocol: 'TCP', port: 3141 }] },
    { to: [{ ipBlock: { cidr: '203.0.113.9/32' } }], ports: [{ protocol: 'TCP', port: 8443 }] },
  ])
  // The broker passes the same two values to the proxy Pod, which enforces the names.
  const broker = envOf(find(list, 'Deployment', 'colloq-runtime'))
  assert.equal(broker.DEPENDENCY_INDEX_URL, 'https://10.20.30.40:3141/root/pypi/+simple/')
  assert.equal(broker.DEPENDENCY_FILES_HOSTS, '203.0.113.9:8443, 151.101.0.223,10.20.30.40:3141')
})

test('a mirror setting that cannot work stops the install before anything is stopped, with the reason', () => {
  for (const [line, reason] of [
    ['DEPENDENCY_INDEX_URL=http://10.20.30.40/simple', /https:\/\/ URL/],
    ['DEPENDENCY_INDEX_URL=https://user:pw@10.20.30.40/simple', /without credentials/],
    ['DEPENDENCY_INDEX_URL=https://localhost/simple', /pods may not be opened to/],
    ['DEPENDENCY_INDEX_URL=https://169.254.169.254/simple', /pods may not be opened to/],
    ['DEPENDENCY_FILES_HOSTS=files.campus.edu/wheels', /is not a host/],
    ['DEPENDENCY_FILES_HOSTS=files_campus.edu', /is not a host/],
    ['DEPENDENCY_FILES_HOSTS=10.1.2.3:99999', /is not a host/],
  ] as const) {
    const result = run('render', line + '\n')
    assert.notEqual(result.status, 0, line)
    assert.match(result.stderr, reason, line)
  }
})

test('COLLOQ_ROOM_NETWORK=none takes DNS away from rooms on k3s too; anything else keeps it', () => {
  const none = run('render', 'COLLOQ_ROOM_NETWORK=none\n')
  assert.equal(none.status, 0, none.stderr)
  assert.deepEqual(find(items(none.stdout), 'NetworkPolicy', 'room-isolation').spec.egress, [])
  for (const env of ['COLLOQ_ROOM_NETWORK=open\n', 'COLLOQ_ROOM_NETWORK=\n', '']) {
    const result = run('render', env)
    const egress = find(items(result.stdout), 'NetworkPolicy', 'room-isolation').spec.egress
    assert.deepEqual(egress[0].ports, [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }], env)
  }
})

test('the institution\'s CA reaches the app Pod as a mounted file, and only the app', () => {
  const result = run('render', 'NODE_EXTRA_CA_CERTS=$DIR/campus.pem\n', { 'campus.pem': PEM })
  assert.equal(result.status, 0, result.stderr)
  const list = items(result.stdout)
  assert.deepEqual(find(list, 'ConfigMap', 'colloq-extra-ca').data, { 'extra-ca.pem': PEM })
  const app = find(list, 'Deployment', 'colloq-app')
  assert.equal(envOf(app).NODE_EXTRA_CA_CERTS, '/etc/colloq-ca/extra-ca.pem')
  assert.ok(app.spec.template.spec.volumes.some((v: any) => v.name === 'extra-ca' && v.configMap.name === 'colloq-extra-ca'))
  assert.ok(app.spec.template.spec.containers[0].volumeMounts.some((m: any) => m.name === 'extra-ca' && m.mountPath === '/etc/colloq-ca' && m.readOnly))
  assert.equal(JSON.stringify(find(list, 'Deployment', 'colloq-runtime')).includes('extra-ca'), false)
  // A file that is not there, or not a certificate, stops the install.
  const missing = run('render', 'NODE_EXTRA_CA_CERTS=$DIR/absent.pem\n')
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /cannot be read on this node/)
  const junk = run('render', 'NODE_EXTRA_CA_CERTS=$DIR/junk.pem\n', { 'junk.pem': 'not a certificate' })
  assert.notEqual(junk.status, 0)
  assert.match(junk.stderr, /PEM bundle/)
})
