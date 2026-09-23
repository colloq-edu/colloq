/**
 * `colloq start --share`: замок изоляции, блок ссылки, метка host.sh, флаги.
 *
 * Всё здесь — чистые функции супервизора (cli/src/launch-share.ts и
 * launch-config.ts), без процессов и без сети. Как они собраны вместе —
 * супервизор, host.sh, туннель, Ctrl+C — проверяет стенд в
 * tests/local-launch-process.test.mts, а сам host.sh со своей меткой и своим
 * замком — tests/local-host-lease.test.mts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  parseShareMarker,
  publishRefusal,
  readClasses,
  refusalText,
  renderShareBlock,
  type ShareBlock,
} from '../cli/src/launch-share.js'
import { parseLaunchArgs } from '../cli/src/launch-config.js'

/* ------------------------------------------------------------ замок */

const ISOLATED = { ok: true, kernel: true, isolation: 'docker' }

test('gate: a local class with Docker and a confirming server may go online', () => {
  assert.equal(publishRefusal({ env: {} }), null, 'before the start only settings are judged')
  assert.equal(
    publishRefusal({ env: { KERNEL_BACKEND: 'docker' }, dockerReachable: true, health: ISOLATED }),
    null,
  )
  // Брокер — тоже изоляция: у каждой комнаты свой под (k3s).
  assert.equal(
    publishRefusal({
      env: { KERNEL_BACKEND: 'broker' },
      health: { ...ISOLATED, isolation: 'broker' },
    }),
    null,
  )
})

test('gate: every way to lose room isolation is a refusal that names it', () => {
  const cases: Array<[Parameters<typeof publishRefusal>[0], RegExp]> = [
    [{ env: { KERNEL_ISOLATION: 'off' } }, /KERNEL_ISOLATION=off/],
    [{ env: { KERNEL_ISOLATION: ' OFF ' } }, /KERNEL_ISOLATION=off/],
    [{ env: { KERNEL_BACKEND: 'test' } }, /KERNEL_BACKEND=test does not give every room/],
    [{ env: {}, dockerReachable: false }, /Docker is not responding/],
    [{ env: {}, dockerReachable: true, health: null }, /does not confirm/],
    [{ env: {}, dockerReachable: true, health: { ok: true, kernel: true } }, /does not confirm/],
    [
      { env: {}, dockerReachable: true, health: { ...ISOLATED, isolation: null } },
      /does not confirm/,
    ],
    [
      { env: {}, dockerReachable: true, health: { ...ISOLATED, isolation: 'broker' } },
      /reports room isolation "broker", not docker/,
    ],
  ]
  for (const [check, pattern] of cases) {
    const said = publishRefusal(check)
    assert.ok(said, JSON.stringify(check))
    assert.match(said, pattern, JSON.stringify(check))
  }
})

test('gate: the refusal says why it matters and where the class is now', () => {
  const text = refusalText('Docker is not responding', 'http://localhost:3000')
  assert.match(text, /^Not published: Docker is not responding\./)
  assert.match(text, /anyone who has it run code on this computer/)
  assert.match(text, /container of its own/)
  assert.match(text, /The class keeps running locally: http:\/\/localhost:3000$/)
  assert.doesNotMatch(refusalText('x'), /keeps running locally/)
})

/* ------------------------------------------------------------ метка */

test('marker: only the exact line from host.sh is taken', () => {
  assert.deepEqual(parseShareMarker('@colloq-share ok https://a-b-c.trycloudflare.com'), {
    url: 'https://a-b-c.trycloudflare.com',
    verified: true,
  })
  assert.deepEqual(parseShareMarker('@colloq-share unverified https://x.trycloudflare.com/'), {
    url: 'https://x.trycloudflare.com',
    verified: false,
  })
  for (const line of [
    '',
    'https://a.trycloudflare.com',
    '@colloq-share ok http://a.trycloudflare.com',
    '@colloq-share maybe https://a.trycloudflare.com',
    '@colloq-share ok https://a.trycloudflare.com/admin/t/secret',
    '  @colloq-share ok https://a.trycloudflare.com',
  ])
    assert.equal(parseShareMarker(line), null, line)
})

/* ------------------------------------------------------------ блок */

const BASE: ShareBlock = {
  url: 'https://orange-bird.trycloudflare.com',
  teacher: 'https://orange-bird.trycloudflare.com/admin/t/Tok_en-1',
  local: 'http://localhost:3000',
  classes: [],
  total: 0,
  verified: true,
  detached: false,
  relayDomain: '',
}

const text = (block: Partial<ShareBlock>): string => renderShareBlock({ ...BASE, ...block }).join('\n')

test('block: no class yet — the panel on the public address and what to do there', () => {
  const out = text({})
  assert.match(out, /Colloq is online at https:\/\/orange-bird\.trycloudflare\.com/)
  assert.match(out, /There is no class yet\. Create one in the panel above and copy its link/)
  assert.doesNotMatch(out, /\/s\/[a-z0-9]/)
})

test('block: the teacher link on the public address carries the token, like Jupyter', () => {
  for (const out of [text({}), text({ classes: [{ id: 'a', name: 'A' }], total: 1 })]) {
    assert.match(out, /Your panel on this address \(the link signs you in — keep it to yourself\):/)
    assert.match(out, /^ {2}│ {3}https:\/\/orange-bird\.trycloudflare\.com\/admin\/t\/Tok_en-1$/m)
    // Ссылка входа — одна, и она выше ссылок для студентов.
    assert.equal(out.match(/\/admin\/t\//g)?.length, 2, 'the link and the warning that names /admin/t/…')
  }
  const one = text({ classes: [{ id: 'k3mnp7qr', name: 'L' }], total: 1 })
  assert.ok(one.indexOf('/admin/t/Tok_en-1') < one.indexOf('/s/k3mnp7qr'))
})

test('block: one class — exactly one link to give', () => {
  const out = text({ classes: [{ id: 'k3mnp7qr', name: 'Linear algebra' }], total: 1 })
  assert.match(out, /Give your students this link:/)
  assert.match(out, /https:\/\/orange-bird\.trycloudflare\.com\/s\/k3mnp7qr {3}Linear algebra/)
  assert.equal(out.match(/\/s\/[a-z0-9]/g)?.length, 1)
})

test('block: several classes — newest first, the rest counted, names made safe', () => {
  const out = text({
    classes: [
      { id: 'aaaa2222', name: 'Week 3\u001b[2J wiped' },
      { id: 'bbbb3333', name: 'x'.repeat(80) },
      { id: 'cccc4444', name: 'Statistics' },
    ],
    total: 5,
  })
  assert.match(out, /the link of the class you teach \(newest first\)/)
  assert.match(out, /… and 2 more: the panel lists every class/)
  // ESC из имени не доходит до терминала, длинное имя обрезано.
  assert.doesNotMatch(out, /\u001b/)
  assert.match(out, /Week 3 \[2J wiped/)
  assert.match(out, /x{47}…/)
})

test('block: always the /admin/ warning, the lifetime, the new address and Russia', () => {
  for (const out of [text({}), text({ classes: [{ id: 'a', name: 'A' }], total: 1 })]) {
    assert.match(out, /Never share a link with \/admin\/ in it \(\/admin\/t\/…, \/admin\/k\/…\)/)
    assert.match(out, /Students only ever get \/s\/… links/)
    assert.match(out, /lives while this terminal is open: Ctrl\+C closes it/)
    assert.match(out, /new address on every start: send the new link each time/)
    assert.match(out, /Cloudflare addresses do not open from Russia/)
    assert.match(out, /colloq start --host <name> with RELAY_\* in \.env/)
    assert.doesNotMatch(out, /\u001b\[/, 'the block goes to the log too: no colours')
  }
})

test('block: an unverified check, a detached run and a relay each change their line', () => {
  assert.match(text({ verified: false }), /did not get through — usually the DNS/)
  assert.doesNotMatch(text({ verified: true }), /did not get through/)
  assert.doesNotMatch(text({ verified: null }), /did not get through/)
  assert.match(text({ detached: true }), /lives until colloq stop/)
  assert.doesNotMatch(text({ detached: true }), /Ctrl\+C/)
  assert.match(text({ relayDomain: 'colloq.ru' }), /colloq start --host <name>\.colloq\.ru$/m)
})

/* ------------------------------------------------------------ база */

test('classes come from the database: newest first, archived ones left out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-share-db-'))
  try {
    const db = new Database(path.join(dir, 'colloq.db'))
    db.exec(
      'CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, archived_at INTEGER)',
    )
    const add = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)')
    add.run('old22222', 'Old', 1, null)
    add.run('arch3333', 'Archived', 5, 6)
    add.run('new44444', 'New', 9, null)
    add.run('mid55555', 'Mid', 4, null)
    add.run('odd id!', 'Broken id', 10, null)
    db.close()
    const { classes, total } = await readClasses(dir, 2)
    assert.deepEqual(
      classes.map((item) => item.id),
      ['new44444'],
      'the newest row with an id unfit for a URL is dropped',
    )
    assert.equal(total, 4)
    assert.deepEqual(
      (await readClasses(dir)).classes.map((item) => item.name),
      ['New', 'Mid'],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('no database or a foreign one reads as "no class yet", never as a failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-share-db-'))
  try {
    assert.deepEqual(await readClasses(dir), { classes: [], total: 0 })
    fs.writeFileSync(path.join(dir, 'colloq.db'), 'not a database')
    assert.deepEqual(await readClasses(dir), { classes: [], total: 0 })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------ флаги */

test('flags: --share is a flag of run and dev, never together with --host', () => {
  assert.equal(parseLaunchArgs(['run', '--share']).share, true)
  assert.equal(parseLaunchArgs(['dev', '--share', '--no-open']).share, true)
  assert.equal(parseLaunchArgs(['run', '--share', '--detach']).detach, true)
  assert.equal(parseLaunchArgs(['run']).share, undefined)
  assert.throws(
    () => parseLaunchArgs(['run', '--share', '--host', 'class.example.ru']),
    /--share and --host do not work together/,
  )
  assert.throws(
    () => parseLaunchArgs(['run', '--host', 'class.example.ru', '--share']),
    /do not work together/,
  )
  // Служебное слово для host.sh: найти или скачать cloudflared.
  assert.equal(parseLaunchArgs(['cloudflared']).action, 'cloudflared')
})
